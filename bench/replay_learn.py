"""Replay crank learning (firmware v3.1 with turn-based learning) on a 50 Hz
raw log, sample by sample, as the board does it: every 0.5 s re-learn the
crank from everything buffered so far, count the turns with the real
detector, and finish once there are enough regular turns (or give up at
the cap). Each Bike Test Panel step is tried as if calibration had been
started at the step's start.

Usage: py -3 bench/replay_learn.py LOGFILE CLICKS_JSON

The learning code mirrors crankLearn()/crankSample() in
KeiserMagBridge_v3_1.ino; the detector is the same as in replay_v3.py.
"""
import json
import math
import re
import statistics as st
import sys

LOG, CLICKS = sys.argv[1], sys.argv[2]

# ---------------------------------------------------------------- tunables (mirrored in the sketch)
SAMPLE_MS = 20
LEARN_MAX_SAMPLES = 750       # 15 s cap
LEARN_FIRST_PROBE = 100       # first look after 2 s
LEARN_PROBE_EVERY = 25        # then every 0.5 s
LEARN_TARGET_TURNS = 6        # full turns needed to finish early
LEARN_MIN_TURNS = 4           # at the cap, accept with at least this many
LEARN_REG_LO, LEARN_REG_HI = 0.75, 1.33  # a regular turn is within these x the median turn
LEARN_REG_SHARE = 0.75        # ... and at least this share of turns must be regular
LEARN_MAX_RPM = 160           # faster than this is a double count, not pedalling
MIN_DEPTH_UT = 8.0
DIP_FRAC, REARM_FRAC = 0.5, 0.25
REFRACT_MS, TIMEOUT_MS = 200, 3000
DEPTH_ADAPT, STALL_MIN_MS, Q_EMA_TAU_MS = 0.1, 1200, 1000

R = re.compile(r"^\s*([\d.]+)\s+R,(\d+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)")
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
events = json.load(open(CLICKS, encoding="utf-8"))


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def learn(samples):
    """crankLearn(): main direction, polarity, depth, then count turns with the detector."""
    n = len(samples)
    m = [sum(s[k] for s in samples) / n for k in range(3)]
    C = [[sum((s[i] - m[i]) * (s[j] - m[j]) for s in samples) / n for j in range(3)] for i in range(3)]
    u = [1.0, 0.3, 0.2]
    for _ in range(50):
        v = [sum(C[i][j] * u[j] for j in range(3)) for i in range(3)]
        nv = math.sqrt(dot(v, v))
        if nv <= 0:
            return None
        u = [x / nv for x in v]
    p = sorted(dot(s, u) for s in samples)
    med = p[n // 2]
    below, above = med - p[n // 100], p[n - 1 - n // 100] - med
    sign = 1 if below >= above else -1
    depth = max(below, above)
    base = sum(sign * dot(s, u) for s in samples) / n
    det = Detector(u, sign, depth, base)
    periods = []
    for i, s in enumerate(samples):
        r = det.sample(1 + i * SAMPLE_MS, s)
        if r:
            periods.append(r)
    turns = len(periods)
    medp = sorted(periods)[turns // 2] if periods else 0     # same pick as the firmware
    regular = sum(1 for x in periods if LEARN_REG_LO * medp <= x <= LEARN_REG_HI * medp)
    return {"depth": depth, "turns": turns, "regular": regular, "medp": medp,
            "rpm": 60000 / medp if medp else 0}


class Detector:
    """crankSample(); returns the full-turn period in ms, or None."""

    def __init__(self, u, sign, depth, base):
        self.u, self.sign, self.depth0, self.depth = u, sign, depth, depth
        self.baseline = self.q_ema = base
        self.armed, self.have, self.dip_max = True, False, 0.0
        self.dip_start = self.last_b = self.last_ms = 0
        self.last_period = 1000.0
        self.sumq, self.n = 0.0, 0

    def sample(self, ms, raw):
        q = self.sign * dot(raw, self.u)
        self.sumq += q
        self.n += 1
        dt = ms - self.last_ms if self.last_ms else SAMPLE_MS
        self.last_ms = ms
        self.q_ema += min(1.0, dt / Q_EMA_TAU_MS) * (q - self.q_ema)
        stall = max(2.5 * self.last_period, STALL_MIN_MS)
        if not self.have or ms - self.last_b > stall:
            self.baseline = self.q_ema
            if not self.armed and ms - self.dip_start > TIMEOUT_MS:
                self.armed = True
        d = self.baseline - q
        if self.armed:
            if d > DIP_FRAC * self.depth and (not self.have or ms - self.last_b >= REFRACT_MS):
                self.armed, self.dip_max, self.dip_start = False, d, ms
            return None
        self.dip_max = max(self.dip_max, d)
        if d >= REARM_FRAC * self.depth:
            return None
        self.armed = True
        self.depth += DEPTH_ADAPT * (self.dip_max - self.depth)
        self.depth = min(max(self.depth, 0.5 * self.depth0), 2.0 * self.depth0)
        out = None
        if self.have and ms - self.last_b <= TIMEOUT_MS and self.n > 0:
            self.baseline = self.sumq / self.n
            out = ms - self.last_b
            self.last_period = out
        self.have, self.last_b = True, ms
        self.sumq, self.n = 0.0, 0
        return out


def verdict(r, final):
    if r is None:
        return False, "no signal"
    if r["depth"] < MIN_DEPTH_UT:
        return False, f"dip too shallow ({r['depth']:.1f} uT)"
    need = LEARN_MIN_TURNS if final else LEARN_TARGET_TURNS
    if r["turns"] < need:
        return False, f"only {r['turns']} turns"
    if r["regular"] < LEARN_REG_SHARE * r["turns"]:
        return False, f"irregular ({r['regular']} of {r['turns']} turns regular)"
    if r["rpm"] > LEARN_MAX_RPM:
        return False, f"too fast ({r['rpm']:.0f} rpm): counting twice per turn?"
    return True, "ok"


def run(samples):
    """Returns (ok, seconds, result, reason, progress) as the board would end learning."""
    progress = []
    last = min(len(samples), LEARN_MAX_SAMPLES)
    for n in range(LEARN_FIRST_PROBE, last + 1, LEARN_PROBE_EVERY):
        r = learn(samples[:n])
        final = n + LEARN_PROBE_EVERY > last
        ok, why = verdict(r, final)
        progress.append((n * SAMPLE_MS / 1000, r["turns"] if r else 0, r["rpm"] if r else 0,
                         r["depth"] if r else 0, r["regular"] if r else 0))
        if ok or final:
            return ok, n * SAMPLE_MS / 1000, r, why, progress
    return False, 0, None, "too short", progress


def step_start(step):
    st_ = [e["ts"] / 1000 for e in events if e["step"] == step and e["action"] == "start"]
    return st_[-1] if st_ else None


print(f"{'start of':10s} {'result':8s} {'after':>6s} {'turns':>5s} {'rpm':>5s} {'depth':>6s}  reason / console")
for step in ("still", "slow10", "easy20", "fast30", "shift", "coast", "sweep"):
    t0 = step_start(step)
    if t0 is None:
        continue
    win = [s["raw"] for s in S if t0 <= s["t"] <= t0 + LEARN_MAX_SAMPLES * SAMPLE_MS / 1000]
    ok, secs, r, why, prog = run(win)
    con = next((e.get("consoleRpm") for e in events if e["step"] == step and e.get("consoleRpm")), "")
    print(f"{step:10s} {'ACCEPT' if ok else 'reject':8s} {secs:5.1f}s {r['turns'] if r else 0:5d} "
          f"{r['rpm'] if r else 0:5.0f} {r['depth'] if r else 0:6.1f}  {why}{'  console ' + con if con else ''}")
    print("           s:turns/regular@depth ", " ".join(f"{t:.0f}:{k}/{g}@{d:.0f}" for t, k, _, d, g in prog[::2]))

# ---------------------------------------------------------------- fault injection: a second dip per turn
# Adds a delayed copy of the fast30 signal (an "echo" of the crank dip, `frac` of a
# turn later, `gain` x as deep), as a second magnet or a double-lobed dip would.
print("\nFault injection on fast30 (~84 rpm): a second dip per turn")
t0 = step_start("fast30")
w = [s["raw"] for s in S if t0 <= s["t"] <= t0 + LEARN_MAX_SAMPLES * SAMPLE_MS / 1000]
mean = [st.mean(s[k] for s in w) for k in range(3)]
for frac, gain in ((0.4, 1.0), (0.5, 0.8), (0.5, 1.0)):
    lag = round(0.71 * frac * 1000 / SAMPLE_MS)        # one turn is ~0.71 s here
    echo = [[w[i][k] + (gain * (w[i - lag][k] - mean[k]) if i >= lag else 0) for k in range(3)]
            for i in range(len(w))]
    ok, secs, r, why, _ = run(echo)
    print(f"  echo at {frac:.1f} turn x{gain:.1f}: {'ACCEPT' if ok else 'reject'} after {secs:4.1f}s, "
          f"{r['turns']} turns, {r['rpm']:.0f} rpm  {why}")
