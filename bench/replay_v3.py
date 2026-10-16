"""Replay a 50 Hz raw log through the sketch-v3 turn detector, exactly as the
firmware will run it (one sample at a time, no look-ahead), to test and tune
it before porting.

Usage: py -3 bench/replay_v3.py LOGFILE EVENTS_DIR [learn_step]

  learn_step: which Bike Test Panel step to learn the crank from
              (default fast30; the first 10 s of it are used).
"""
import glob
import json
import math
import re
import statistics as st
import sys

LOG, EVDIR = sys.argv[1], sys.argv[2]
LEARN_STEP = sys.argv[3] if len(sys.argv) > 3 else "fast30"

# ---------------------------------------------------------------- tunables (mirrored in the sketch)
LEARN_MS = 10000          # crank learning window
LEARN_MIN_TURNS = 4       # must see at least this many dips while learning
MIN_DEPTH_UT = 8.0        # weaker than this: crank too far away to use
DIP_FRAC = 0.5            # dip starts when below baseline by this fraction of depth
REARM_FRAC = 0.25         # turn boundary when it climbs back above this fraction
REFRACT_MS = 200          # ignore dips closer than this (300 rpm)
TIMEOUT_MS = 3000         # no turn for this long -> not pedalling
DEPTH_ADAPT = 0.1         # slow tracking of the dip depth
STALL_MIN_MS = 1200       # no turn for max(2.5 x last period, this) -> resync baseline
Q_EMA_TAU_MS = 1000       # running mean of the crank signal, used while resyncing
AGREE_UT = 1.0            # auto-capture: 3 turns within this of each other
MOVE_UT = 1.0             # ... and this far from the previous captured point

# ---------------------------------------------------------------- load log + clicks (same as analyze_cadence)
R = re.compile(r"^\s*([\d.]+)\s+R,(\d+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)")
CLK = re.compile(r"^\s*([\d.]+)\s+### clock (\d+)")
S, clocks = [], []
for line in open(LOG, encoding="utf-8"):
    m = R.match(line)
    if m:
        v = [float(x) for x in m.groups()]
        S.append({"rel": v[0], "ms": v[1], "raw": v[2:5]})
        continue
    m = CLK.match(line)
    if m:
        clocks.append((float(m[1]), int(m[2])))


def linfit(xs, ys):
    mx, my = st.mean(xs), st.mean(ys)
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sum((x - mx) ** 2 for x in xs)
    return my - b * mx, b


a1, b1 = linfit([c[0] for c in clocks], [c[1] for c in clocks])
a2, b2 = linfit([s["ms"] for s in S], [a1 + b1 * s["rel"] for s in S])
for s in S:
    s["t"] = (a2 + b2 * s["ms"]) / 1000.0
events = sorted((json.load(open(f, encoding="utf-8")) for f in glob.glob(EVDIR + "/*.json")), key=lambda d: d["ts"])
events = [e.get("data", e) for e in events]


def pair(step):
    st_ = [e["ts"] / 1000 for e in events if e["step"] == step and e["action"] == "start"]
    dn = [e for e in events if e["step"] == step and e["action"] == "done"]
    if not dn:
        return None
    t1 = dn[-1]["ts"] / 1000
    return max(t for t in st_ if t < t1), t1, dn[-1]


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


# ---------------------------------------------------------------- 1. crank learning (firmware: cal state 3)
def learn(samples):
    n = len(samples)
    m = [sum(s[k] for s in samples) / n for k in range(3)]
    C = [[sum((s[i] - m[i]) * (s[j] - m[j]) for s in samples) / n for j in range(3)] for i in range(3)]
    u = [1.0, 0.3, 0.2]                       # power iteration -> main direction
    for _ in range(50):
        v = [sum(C[i][j] * u[j] for j in range(3)) for i in range(3)]
        nv = math.sqrt(dot(v, v))
        u = [x / nv for x in v]
    p = sorted(dot(s, u) for s in samples)
    med = p[n // 2]
    below, above = med - p[int(0.01 * n)], p[int(0.99 * n)] - med
    sign = 1 if below >= above else -1        # q = sign * p dips downward
    depth = max(below, above)
    return u, sign, depth


# ---------------------------------------------------------------- 2. streaming detector (firmware: every raw sample)
class Detector:
    def __init__(self, u, sign, depth, baseline):
        self.u, self.sign, self.depth = u, sign, depth
        self.baseline = baseline
        self.armed = True
        self.dip_max = 0.0
        self.dip_start_ms = 0
        self.last_boundary_ms = None
        self.last_period_ms = 1000.0
        self.q_ema = baseline
        self.last_ms = None
        self.sum = [0.0, 0.0, 0.0]
        self.sumq = 0.0
        self.n = 0
        self.turns = []                       # (t, period_s, avg_raw)
        self.dips = []                        # every turn boundary, incl. after pauses

    def sample(self, t, ms, raw):
        q = self.sign * dot(raw, self.u)
        self.sum = [a + b for a, b in zip(self.sum, raw)]
        self.sumq += q
        self.n += 1
        dt = 20.0 if self.last_ms is None else ms - self.last_ms
        self.last_ms = ms
        self.q_ema += (dt / Q_EMA_TAU_MS) * (q - self.q_ema)
        # Stalled (stopped, or the lever moved a lot): judge dips against the
        # running mean instead of the last turn's mean, and re-arm.
        stall_ms = max(2.5 * self.last_period_ms, STALL_MIN_MS)
        if self.last_boundary_ms is None or ms - self.last_boundary_ms > stall_ms:
            self.baseline = self.q_ema
            if not self.armed and ms - self.dip_start_ms > TIMEOUT_MS:
                self.armed = True             # a 'dip' this long is a level shift, not a dip
        d = self.baseline - q
        if self.armed:
            ok_gap = self.last_boundary_ms is None or ms - self.last_boundary_ms >= REFRACT_MS
            if d > DIP_FRAC * self.depth and ok_gap:
                self.armed, self.dip_max, self.dip_start_ms = False, d, ms
            return None
        self.dip_max = max(self.dip_max, d)
        if d < REARM_FRAC * self.depth:       # climbed back out of the dip: turn boundary
            self.armed = True
            self.dips.append(t)
            self.depth += DEPTH_ADAPT * (self.dip_max - self.depth)
            out = None
            if self.last_boundary_ms is not None and ms - self.last_boundary_ms <= TIMEOUT_MS:
                avg = [x / self.n for x in self.sum]
                self.baseline = self.sumq / self.n
                out = (t, (ms - self.last_boundary_ms) / 1000.0, avg)
                self.last_period_ms = ms - self.last_boundary_ms
                self.turns.append(out)
            self.last_boundary_ms = ms
            self.sum, self.sumq, self.n = [0.0, 0.0, 0.0], 0.0, 0
            return out
        return None


# ---------------------------------------------------------------- run
lp = pair(LEARN_STEP)
learn_win = [s for s in S if lp[0] <= s["t"] <= lp[0] + LEARN_MS / 1000]
u, sign, depth = learn([s["raw"] for s in learn_win])
base0 = st.mean(sign * dot(s["raw"], u) for s in learn_win)
det = Detector(u, sign, depth, base0)
# learning acceptance: count dips in the learning window with a throwaway detector
probe = Detector(u, sign, depth, base0)
for s in learn_win:
    probe.sample(s["t"], s["ms"], s["raw"])
ok = depth >= MIN_DEPTH_UT and len(probe.turns) + 1 >= LEARN_MIN_TURNS
print(f"Learned from '{LEARN_STEP}' (first {LEARN_MS / 1000:.0f} s): direction "
      f"({', '.join(f'{x:.2f}' for x in u)}), polarity {sign:+d}, dip depth {depth:.1f} uT, "
      f"{len(probe.turns) + 1} dips seen -> {'ACCEPTED' if ok else 'REJECTED'}\n")

for s in S:                                   # the whole session, continuously
    det.sample(s["t"], s["ms"], s["raw"])
turns = det.turns

for key, label in (("slow10", "Slow by hand"), ("easy20", "Pedal easy"), ("fast30", "Pedal fast"), ("coast", "Coast")):
    p = pair(key)
    if not p:
        continue
    t0, t1, d = p
    dw = [t for t in det.dips if t0 <= t <= t1]
    tw = [x for x in turns if t0 <= x[0] <= t1]
    rpm = [60 / x[1] for x in tw]
    first_last = (60 * (len(dw) - 1) / (dw[-1] - dw[0])) if len(dw) > 1 else float("nan")
    print(f"{label:13s} counted {str(d.get('counted', '-')):>3}: dips {len(dw):3d} "
          f"(= {len(dw) - 1} full turns between first and last)  average {first_last:5.1f} rpm  "
          f"reported per-turn {min(rpm) if rpm else 0:.0f}-{max(rpm) if rpm else 0:.0f} rpm  console {d.get('consoleRpm', '-')}")

# ---------------------------------------------------------------- gear changes: per-turn values + auto-capture
p = pair("sweep")
sw = [s["raw"] for s in S if p[0] <= s["t"] <= p[1]]
m = [sum(r[k] for r in sw) / len(sw) for k in range(3)]
C = [[sum((r[i] - m[i]) * (r[j] - m[j]) for r in sw) / len(sw) for j in range(3)] for i in range(3)]
L = [1.0, 0.0, 0.0]
for _ in range(50):
    v = [sum(C[i][j] * L[j] for j in range(3)) for i in range(3)]
    nv = math.sqrt(dot(v, v))
    L = [x / nv for x in v]
t0, t1, _ = pair("shift")
tw = [x for x in turns if t0 <= x[0] <= t1]
lev = [dot(x[2], L) for x in tw]
lev = [v - min(lev) for v in lev] if lev and lev[-1] > lev[0] else [max(lev) - v for v in lev]
steady = [abs(b - a) for a, b in zip(lev, lev[1:]) if abs(b - a) < 2.0]
print(f"\nGear changes: {len(tw)} turns; steady turn-to-turn change median {st.median(steady):.2f} uT, "
      f"90th pct {sorted(steady)[int(0.9 * len(steady))]:.2f} uT; lever moved {lev[-1] - lev[0]:+.1f} uT")

# auto-capture simulation (firmware: calibration point waiting state)
caps, last_cap, hist = [], None, []
for x in tw:
    hist = (hist + [x[2]])[-3:]
    if len(hist) < 3:
        continue
    spread = max(math.dist(a, b) for a in hist for b in hist)
    mean = [sum(h[k] for h in hist) / 3 for k in range(3)]
    if spread <= AGREE_UT and (last_cap is None or math.dist(mean, last_cap) >= MOVE_UT):
        caps.append((x[0] - t0, dot(mean, L)))
        last_cap, hist = mean, []
print(f"Auto-capture would take {len(caps)} points during the gear changes "
      f"(you made about 20 lever moves): at "
      + ", ".join(f"{c[0]:.0f}s" for c in caps))
vals = [c[1] for c in caps]
print("  captured lever positions (uT, in order): " + ", ".join(f"{v - min(vals):.1f}" for v in vals))
