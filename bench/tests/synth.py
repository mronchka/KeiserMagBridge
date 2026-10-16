"""Synthetic rides built from the real crank waveform (shared by the v3.2 tests).

Same construction as test_fw_stress.py: the crank's field over one turn is
averaged from the fast30 step of the 2026-10-15 log, the lever direction comes
from its sweep step, and ride() replays that at any cadence with noise and the
board's sample clock. Importing this module builds the template (a few seconds).
"""
import json
import math
import os
import random
import re
import statistics as st
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fw_model as fw  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "logs", "2026-10-15_cadence_test.log")
CLICKS = os.path.join(HERE, "..", "logs", "2026-10-15_cadence_test_clicks.json")
fails = []


def check(cond, msg):
    print(("  PASS " if cond else "  FAIL ") + msg)
    if not cond:
        fails.append(msg)


# ------------------------------------------------------------------ template from the real log
R = re.compile(r"^\s*([\d.]+)\s+R,(\d+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)")
CLK = re.compile(r"^\s*([\d.]+)\s+### clock (\d+)")
S, clocks = [], []
for line in open(LOG, encoding="utf-8"):
    m = R.match(line)
    if m:
        v = [float(x) for x in m.groups()]
        S.append((int(v[1]), v[2:5], v[0]))
        continue
    m = CLK.match(line)
    if m:
        clocks.append((float(m[1]), int(m[2])))
mx = st.mean(c[0] for c in clocks)
my = st.mean(c[1] for c in clocks)
b1 = sum((c[0] - mx) * (c[1] - my) for c in clocks) / sum((c[0] - mx) ** 2 for c in clocks)
a1 = my - b1 * mx
ev = json.load(open(CLICKS, encoding="utf-8"))


def window(step):
    t1 = [e["ts"] for e in ev if e["step"] == step and e["action"] == "done"][-1]
    t0 = max(e["ts"] for e in ev if e["step"] == step and e["action"] == "start" and e["ts"] < t1)
    return [s for s in S if t0 <= a1 + b1 * s[2] <= t1]


fast = window("fast30")
learner = fw.Firmware()
learner.command('c')
for ms, raw, _ in fast:
    learner.ms_now = ms
    learner.process_sample(ms, raw)
    if learner.calState != fw.CAL_LEARN:
        break
CK = dict(learner.crank)
det = fw.Firmware(cal=dict(pts=None, crankOk=1, crankSign=CK["sign"], crankU=CK["u"],
                           crankDepth=CK["depth"], crankBase=CK["base"]))
det.calValid = False
for ms, raw, _ in fast:
    det.ms_now = ms
    det.process_sample(ms, raw)
bnd = [b[0] for b in det.boundaries if b[1] == 2]
NB = 100
acc = [[0.0, 0.0, 0.0] for _ in range(NB)]
cnt = [0] * NB
for t0, t1 in zip(bnd, bnd[1:]):
    for ms, raw, _ in fast:
        if t0 <= ms < t1:
            k = int(NB * (ms - t0) / (t1 - t0))
            for j in range(3):
                acc[k][j] += raw[j]
            cnt[k] += 1
TPL = [[acc[k][j] / cnt[k] for j in range(3)] if cnt[k] else None for k in range(NB)]
for k in range(NB):                                   # fill any empty bin
    if TPL[k] is None:
        TPL[k] = TPL[k - 1]
BASE = [st.mean(TPL[k][j] for k in range(NB)) for j in range(3)]
CRANK = [[TPL[k][j] - BASE[j] for j in range(3)] for k in range(NB)]
sw = [s[1] for s in window("sweep")]
m = [st.mean(r[k] for r in sw) for k in range(3)]
C = [[sum((r[i] - m[i]) * (r[j] - m[j]) for r in sw) / len(sw) for j in range(3)] for i in range(3)]
LEV = [1.0, 0.0, 0.0]
for _ in range(60):
    v = [sum(C[i][j] * LEV[j] for j in range(3)) for i in range(3)]
    n = math.sqrt(fw.dot3(v, v))
    LEV = [x / n for x in v]
qt = [CK["sign"] * fw.dot3(c, CK["u"]) for c in CRANK]
TEMPLATE_INFO = (f"Template: {len(bnd) - 1} turns of fast30; crank dip {min(qt):.1f} uT below the turn mean, "
      f"learned depth {CK['depth']:.1f} uT; lever axis . crank axis = {fw.dot3(LEV, CK['u']):+.2f}\n")


def crank_at(phase, scale=1.0):
    x = (phase % 1.0) * NB
    k = int(x)
    f = x - k
    a, b = CRANK[k], CRANK[(k + 1) % NB]
    return [scale * (a[j] + f * (b[j] - a[j])) for j in range(3)]


def ride(seconds, rpm, lever=0.0, scale=1.0, noise=0.3, t0_ms=0, seed=1, phase0=0.5,
         rpm_fn=None, lever_fn=None, drop=None, extra=None, k0=0):
    """Samples (ms, raw) at the board's 20-tick rate. rpm_fn/lever_fn(t) override rpm/lever.
    drop(t) -> True drops that sample (queue full). extra(phase) adds a field (3-vector).
    Returns samples and the true turn-boundary times (phase crossing 0, i.e. just after the dip)."""
    rnd = random.Random(seed)
    out, truth = [], []
    phase = phase0
    k = k0
    t_prev = None
    while True:
        ms_rel = fw.tick_millis(k) - fw.tick_millis(k0)
        if ms_rel > seconds * 1000:
            break
        t = ms_rel / 1000.0
        if t_prev is not None:
            r = rpm_fn(t) if rpm_fn else rpm
            newp = phase + r / 60.0 * (t - t_prev)
            if math.floor(newp) > math.floor(phase):
                truth.append(t)
            phase = newp
        t_prev = t
        lv = lever_fn(t) if lever_fn else lever
        c = crank_at(phase, scale)
        raw = [BASE[j] + lv * LEV[j] + c[j] + rnd.gauss(0, noise) for j in range(3)]
        if extra:
            e = extra(phase)
            raw = [raw[j] + e[j] for j in range(3)]
        ms = fw.u32(t0_ms + ms_rel)
        if not (drop and drop(t)):
            out.append((ms, raw))
        k += 1
    return out, truth


def live_fw():
    f = fw.Firmware(cal=dict(pts=None, crankOk=1, crankSign=CK["sign"], crankU=CK["u"],
                             crankDepth=CK["depth"], crankBase=CK["base"]))
    f.calValid = False
    return f


def feed(f, samples, notify=True):
    cads, last = [], None
    for ms, raw in samples:
        f.ms_now = ms
        f.process_sample(ms, raw)
        if notify and (last is None or fw.u32(ms - last) >= 500):
            last = ms
            f.update_power()
            cads.append(f.cadenceRpm)
    return cads


def learn_on(samples):
    f = fw.Firmware()
    f.command('c')
    for ms, raw in samples:
        f.ms_now = ms
        f.process_sample(ms, raw)
        if f.calState != fw.CAL_LEARN:
            break
    L = [l for _, l in f.out if l.startswith("L,")]
    return f, (L[-1] if L else "(still learning: ran out of samples)")

