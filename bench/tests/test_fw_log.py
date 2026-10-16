"""Replay the 2026-10-15 50 Hz bike log through the host model of
KeiserMagBridge_v3_1.ino (fw_model.py), one sample at a time in time order.

Usage: py -3 bench/tests/test_fw_log.py [LOG] [CLICKS_JSON]
Defaults: bench/logs/2026-10-15_cadence_test.log and ..._clicks.json

Checks:
  1. crank learning started at each panel step (as if 'c' were sent then)
  2. turn counts and cadence per step with the crank learned at fast30
  3. what happens around the lever move while stopped (log ~530-560 s)
  4. a full calibration run: 'c' at fast30, confirm, then auto-capture
     through the gear-change step (captures in order along the lever?)
  5. learning with the sketch's synthetic 20 ms clock vs real sample times
Exit code 1 if a hard check fails.
"""
import json
import math
import os
import re
import statistics as st
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fw_model as fw  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "logs", "2026-10-15_cadence_test.log")
CLICKS = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "..", "logs", "2026-10-15_cadence_test_clicks.json")

R = re.compile(r"^\s*([\d.]+)\s+R,(\d+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)")
CLK = re.compile(r"^\s*([\d.]+)\s+### clock (\d+)")
S, clocks = [], []
for line in open(LOG, encoding="utf-8"):
    m = R.match(line)
    if m:
        v = [float(x) for x in m.groups()]
        S.append({"rel": v[0], "ms": int(v[1]), "raw": v[2:5]})
        continue
    m = CLK.match(line)
    if m:
        clocks.append((float(m[1]), int(m[2])))


def linfit(xs, ys):
    mx, my = st.mean(xs), st.mean(ys)
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sum((x - mx) ** 2 for x in xs)
    return my - b * mx, b


# board ms -> wall clock (same mapping as replay_v3.py / replay_learn.py)
a1, b1 = linfit([c[0] for c in clocks], [c[1] for c in clocks])
a2, b2 = linfit([s["ms"] for s in S], [a1 + b1 * s["rel"] for s in S])
wall0 = clocks[0][1]
for s in S:
    s["t"] = (a2 + b2 * s["ms"]) / 1000.0
events = json.load(open(CLICKS, encoding="utf-8"))


def ms_at(wall_s):
    """board ms at a wall-clock time (s)."""
    return (wall_s * 1000.0 - a2) / b2


def rel(ms):
    """log-relative seconds (as printed in the log's first column) of a board ms."""
    return ((a2 + b2 * ms) - wall0) / 1000.0


def step_window(step):
    st_ = [e["ts"] / 1000 for e in events if e["step"] == step and e["action"] == "start"]
    dn = [e for e in events if e["step"] == step and e["action"] == "done"]
    if not st_ or not dn:
        return None
    t1 = dn[-1]["ts"] / 1000
    t0 = max(t for t in st_ if t < t1)
    return ms_at(t0), ms_at(t1), dn[-1]


fails = []


def check(cond, msg):
    print(("  PASS " if cond else "  FAIL ") + msg)
    if not cond:
        fails.append(msg)


def run(fwi, samples, hook=None):
    last_notify = None
    cads = []
    for s in samples:
        fwi.ms_now = s["ms"]
        fwi.process_sample(s["ms"], s["raw"])
        if last_notify is None or s["ms"] - last_notify >= fw.NOTIFY_PERIOD_MS:
            last_notify = s["ms"]
            fwi.update_power()
            cads.append((s["ms"], fwi.cadenceRpm, fwi.pedalling()))
        if hook:
            hook(fwi, s)
    return cads


# ------------------------------------------------------------------ 1. learning per step
print("1. Crank learning started at each step (firmware model; sketch's 20 ms synthetic clock)")
learned = {}
for step in ("still", "slow10", "easy20", "fast30", "shift", "coast", "sweep"):
    w = step_window(step)
    if not w:
        continue
    f = fw.Firmware()
    f.command('c')
    seg = [s for s in S if s["ms"] >= w[0]][:fw.LEARN_MAX_SAMPLES + 5]
    t_end = None
    for s in seg:
        f.ms_now = s["ms"]
        f.process_sample(s["ms"], s["raw"])
        if f.calState != fw.CAL_LEARN:
            t_end = (s["ms"] - w[0]) / 1000
            break
    L = [l for _, l in f.out if l.startswith("L,")]
    print(f"   {step:7s} -> {L[-1] if L else '(still learning)'}  after {t_end if t_end is not None else 0:.1f} s"
          f"  state={f.calState}")
    learned[step] = (f.calState, dict(f.crank), L[-1] if L else "")
check(learned["fast30"][0] == fw.CAL_CONFIRM, "learning at fast30 (~84 rpm) succeeds -> cal state 4")
check(learned["easy20"][0] == fw.CAL_CONFIRM, "learning at easy20 (~35 rpm) succeeds -> cal state 4")
check(learned["still"][0] == fw.CAL_WAITING and "shallow" in learned["still"][2],
      "learning while still is refused ('dip too shallow') -> hold-still fallback")

# ------------------------------------------------------------------ 2. live turn counting
print("\n2. Live detector over the whole log, crank learned at fast30 (as if loaded from a saved calibration)")
ck = learned["fast30"][1]
cal = dict(pts=None, crankOk=1, crankSign=ck["sign"], crankU=ck["u"], crankDepth=ck["depth"], crankBase=ck["base"])
f = fw.Firmware(cal=cal)
f.calValid = False          # no gear path in this test: only turns/cadence
f.crank["ok"] = True
cads = run(f, S)
expect = {"slow10": (10, None), "easy20": (20, 35), "fast30": (30, 84)}
for step in ("slow10", "easy20", "fast30", "coast"):
    w = step_window(step)
    b = [x for x in f.boundaries if w[0] <= x[0] <= w[1]]
    full = [x for x in b if x[1] == 2]
    c = [x[1] for x in cads if w[0] + 3000 <= x[0] <= w[1] and x[2]]
    med = st.median(c) if c else 0
    print(f"   {step:7s} boundaries {len(b):3d} (full turns {len(full):3d})  counted by rider "
          f"{w[2].get('counted', '-')}, cadence median {med:5.1f} rpm (console {w[2].get('consoleRpm', '-')})"
          f"  range {min(c) if c else 0:.0f}-{max(c) if c else 0:.0f}")
    if step in expect:
        n, con = expect[step]
        check(abs(len(b) - n) <= 1 or abs(len(full) - n) <= 1, f"{step}: turns counted within 1 of {n}")
        if con:
            check(abs(med - con) <= 0.06 * con, f"{step}: median cadence within 6 % of console {con}")

# ------------------------------------------------------------------ 3. lever moved while stopped
print("\n3. Around the end of the gear-change step / lever moved while stopped (log 520-570 s)")
lo, hi = [x for x in S if 520 <= rel(x["ms"]) <= 570][0]["ms"], [x for x in S if rel(x["ms"]) <= 570][-1]["ms"]
bs = [x for x in f.boundaries if lo <= x[0] <= hi]
print("   boundaries at log s: " + ", ".join(f"{rel(x[0]):.1f}{'' if x[1] == 2 else '*'}" for x in bs)
      + "   (* = first after a pause)")
ped = [(rel(x[0]), x[2]) for x in cads if lo <= x[0] <= hi]
runs, cur = [], None
for t, p in ped:
    if cur is None or cur[1] != p:
        cur = [t, p, t]
        runs.append(cur)
    cur[2] = t
print("   pedalling flag: " + "; ".join(f"{r[0]:.1f}-{r[2]:.1f} {'R' if r[1] else '-'}" for r in runs))
coast = step_window("coast")
first_after = [x for x in f.boundaries if x[0] >= coast[0]]
if first_after:
    print(f"   first boundary after coast start: +{(first_after[0][0] - coast[0]) / 1000:.2f} s")

# ------------------------------------------------------------------ 4. full calibration run
print("\n4. Calibration run: 'c' at fast30 start, confirm 1.5 s after the cadence check, then auto-capture")
f = fw.Firmware()
w = step_window("fast30")
state = {"sent_c": False, "confirm_at": None}


def hook(fwi, s):
    if not state["sent_c"] and s["ms"] >= w[0]:
        fwi.command('c')
        state["sent_c"] = True
    if fwi.calState == fw.CAL_CONFIRM and state["confirm_at"] is None:
        state["confirm_at"] = s["ms"] + 1500
    if state["confirm_at"] and fwi.calState == fw.CAL_CONFIRM and s["ms"] >= state["confirm_at"]:
        fwi.command('n')
    # v3.3: the survey's sweep comes next; this recording has none, so tap through it
    while fwi.calState == fw.CAL_SURVEY:
        fwi.command('n')
    # couldn't settle for 15 s (cal state 5): the rider captures anyway after 1.5 s
    if fwi.calState == fw.CAL_POINT_CHECK:
        if state.get("check_at") is None:
            state["check_at"] = s["ms"] + 1500
        elif s["ms"] >= state["check_at"]:
            fwi.command('n')
            state["check_at"] = None


run(f, S, hook)
Ls = [l for _, l in f.out if l.startswith(("L,", "K,", "A,"))]
print("   " + " | ".join(Ls))
Ws = [l for _, l in f.out if l.startswith("W,")]
Ps = [l for _, l in f.out if l.startswith("P,")]
print(f"   'hold the lever still' notices: {len(Ws)} on points {sorted(set(int(w.split(',')[1]) for w in Ws))}; "
      f"gave up after 15 s (redo / capture anyway): {len(Ps)} {' '.join(Ps)}")
# lever direction from the sweep step (as replay_v3.py)
sw = step_window("sweep")
swr = [s["raw"] for s in S if sw[0] <= s["ms"] <= sw[1]]
m = [sum(r[k] for r in swr) / len(swr) for k in range(3)]
C = [[sum((r[i] - m[i]) * (r[j] - m[j]) for r in swr) / len(swr) for j in range(3)] for i in range(3)]
Lv = [1.0, 0.0, 0.0]
for _ in range(50):
    v = [sum(C[i][j] * Lv[j] for j in range(3)) for i in range(3)]
    nv = math.sqrt(fw.dot3(v, v))
    Lv = [x / nv for x in v]
sh = step_window("shift")
caps = [c for c in f.captures if isinstance(c[1], int)]          # the up pass
downs = [c for c in f.captures if not isinstance(c[1], int)]
pos = [fw.dot3(p, Lv) for _, _, p in caps]
if pos and pos[-1] < pos[0]:
    pos = [-p for p in pos]
print(f"   {len(caps)} points captured; per step: " + ", ".join(
    f"{c[1] + 1}@{rel(c[0]):.0f}s" for c in caps))
print("   lever position of each point (uT from the first): " + ", ".join(f"{p - pos[0]:.1f}" for p in pos))
in_shift = [c for c in caps if sh[0] <= c[0] <= sh[1]]
# Only points captured while the gear-change step was running: after it the
# recording has the lever moved back down, which a real calibration wouldn't.
pos_shift = [p for p, c in zip(pos, caps) if c[0] <= sh[1]]
mono = all(b > a - 0.5 for a, b in zip(pos_shift, pos_shift[1:]))
print(f"   captured during the gear-change step: {len(in_shift)} (about 20 lever moves were made); "
      f"down-pass points after it: {len(downs)}")
print("   W lines (point, drift, creep): " + "  ".join(l[2:] for _, l in f.out if l.startswith("W,")))
check(15 <= len(in_shift) <= 25, "auto-capture takes roughly one point per lever move during the gear changes")
check(mono, "points captured up to the end of the gear-change step are in lever order (0.5 uT slack)")

# ------------------------------------------------------------------ 5. clock used inside crankLearn()
print("\n5. Learned rpm with the sketch's synthetic 20 ms clock vs the real sample clock")
for step in ("easy20", "fast30"):
    w = step_window(step)
    seg = [s for s in S if s["ms"] >= w[0]][:fw.LEARN_MAX_SAMPLES]
    real_dt = (seg[-1]["ms"] - seg[0]["ms"]) / (len(seg) - 1)
    out = []
    for real in (False, True):
        g = fw.Firmware()
        g.command('c')
        g.learn_real_time = real
        for s in seg:
            g.ms_now = s["ms"]
            g.process_sample(s["ms"], s["raw"])
            if g.calState != fw.CAL_LEARN:
                break
        out.append(g.learnLast["rpm"])
    print(f"   {step}: log sample spacing {real_dt:.2f} ms; learned rpm synthetic {out[0]:.1f}, real-time {out[1]:.1f}"
          f"  (console {w[2].get('consoleRpm', '-')}); on the board the spacing is 19.53 ms "
          f"(20 ticks of 1/1024 s) -> synthetic reads {100 * (1 - 19.53 / 20):.1f} % low")

print("\nRESULT:", "all checks passed" if not fails else f"{len(fails)} check(s) failed")
sys.exit(1 if fails else 0)
