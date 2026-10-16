"""Stress tests for the v3.1 turn detector, crank learning and calibration
state machine, on synthetic signals built from the real crank waveform.

Usage: py -3 bench/tests/test_fw_stress.py [LOG]

The crank's field over one turn (3-D, vs crank phase) is averaged from the
fast30 step of the 2026-10-15 log; the lever direction comes from its sweep
step. Synthetic rides then replay that waveform at any cadence, with
0.3 uT noise, sample times as the board makes them (20 ticks of 1/1024 s),
and faults injected. Everything runs through fw_model.Firmware, the host
port of KeiserMagBridge_v3_1.ino.
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
print(f"Template: {len(bnd) - 1} turns of fast30; crank dip {min(qt):.1f} uT below the turn mean, "
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


# ------------------------------------------------------------------ A. cadence sweep
print("A. Cadence 20-180 rpm: live counting (crank learned at fast30) and learning at that cadence")
for rpm in (20, 30, 40, 60, 80, 100, 120, 140, 160, 180):
    smp, truth = ride(30, rpm, seed=rpm)
    f = live_fw()
    cads = feed(f, smp)
    nb = len(f.boundaries)
    c = [x for x in cads[6:] if x > 0]
    med = st.median(c) if c else 0
    _, L = learn_on(ride(16, rpm, seed=rpm + 1)[0])
    print(f"   {rpm:3d} rpm: true turns {len(truth):3d}, boundaries {nb:3d}, cadence median {med:6.1f}   learn: {L}")
    if rpm <= 160:
        check(abs(nb - len(truth)) <= 1, f"{rpm} rpm: turn count within 1")
        check(abs(med - rpm) <= 0.03 * rpm + 0.5, f"{rpm} rpm: cadence within 3 %")

# ------------------------------------------------------------------ B. dropped samples
print("\nB. Dropped samples at 80 rpm (queue full / loop stalled): gaps every 7 s")
for gap in (0.1, 0.3, 1.0, 2.6, 5.0):
    smp, truth = ride(60, 80, seed=3, drop=lambda t, g=gap: (t % 7.0) > 3.0 and (t % 7.0) < 3.0 + g)
    f = live_fw()
    cads = feed(f, smp)
    pers = [b[2] for b in f.boundaries if b[1] == 2]
    bad = [p for p in pers if abs(60000 / p - 80) > 8]
    print(f"   gap {gap:3.1f} s: true {len(truth)}, boundaries {len(f.boundaries)}, "
          f"turns with wrong period {len(bad)} ({', '.join(str(p) for p in bad[:6])}), "
          f"max cadence {max(cads):.0f}")
    check(len(f.boundaries) <= len(truth) + 1, f"gap {gap}s: no extra (phantom) turns")

# ------------------------------------------------------------------ C. timestamp wrap
print("\nC. millis() wrap during a 40 s ride at 80 rpm")
ref, truth = ride(40, 80, seed=5)
fr = live_fw()
feed(fr, ref)
for name, t0 in (("2^32 wrap", (1 << 32) - 20000), ("tick wrap at 4194304000 ms (real board)", None)):
    if t0 is not None:
        smp = [(fw.u32(ms + t0), raw) for ms, raw in ref]
    else:
        W = 4194304000          # tick2ms(2^32 ticks): millis() jumps from 4194303999 to 0
        smp = [((ms + W - 20000) % W, raw) for ms, raw in ref]
    f = live_fw()
    cads = feed(f, smp)
    pk = []
    for i in range(1, 1 + len(smp) // 25):
        pass
    diff = len(f.boundaries) - len(fr.boundaries)
    per_bad = [b[2] for b in f.boundaries if b[1] == 2 and abs(b[2] - 750) > 60]
    print(f"   {name}: boundaries {len(f.boundaries)} (no wrap {len(fr.boundaries)}), full-turn periods off: "
          f"{per_bad[:4]}, results=1 (pause) count {sum(1 for b in f.boundaries if b[1] == 1)}")
    if t0 is not None:
        check(diff == 0 and not per_bad, "2^32 wrap: identical turn detection")
# Zwift crank event time across the wrap
f = live_fw()
f.selfRevs = 10
evs = []
for ms in ((1 << 32) - 1500, (1 << 32) - 750, 0 + 0, 750):
    f.selfEventMs = fw.u32(ms)
    f.ms_now = f.selfEventMs
    evs.append(int.from_bytes(f.power_packet()[6:8], "little"))
d = [(b - a) & 0xFFFF for a, b in zip(evs, evs[1:])]
print(f"   Zwift event-time steps for 750 ms turns across the 2^32 ms wrap: {d} (768 expected)")

# ------------------------------------------------------------------ D. back-pedalling
print("\nD. Forward 80 rpm 15 s, then backwards 60 rpm 15 s")
smp1, tr1 = ride(15, 80, seed=7)
last_ms = smp1[-1][0]
smp2, tr2 = ride(15, -60, seed=8, t0_ms=last_ms + 20, phase0=0.3)
f = live_fw()
feed(f, smp1 + smp2)
nb2 = sum(1 for b in f.boundaries if b[0] > last_ms)
print(f"   backwards: true turns {len(tr2) if tr2 else 15}, boundaries {nb2}")
check(abs(nb2 - 15) <= 1, "back-pedalling: one boundary per turn")

# ------------------------------------------------------------------ E. sudden lever moves mid-turn
print("\nE. Lever jumps mid-turn while pedalling 75 rpm (move takes 0.3 s)")
for jump in (5, 15, 30, -15, -30, -60):
    def lev(t, j=jump):
        return 0.0 if t < 10.0 else (j if t > 10.3 else j * (t - 10.0) / 0.3)
    smp, truth = ride(25, 75, seed=9, lever_fn=lev)
    f = live_fw()
    feed(f, smp)
    tb = [b[0] / 1000 for b in f.boundaries]
    after = [t for t in tb if t > 10.0]
    missed = sum(1 for t in truth if t > 10 and not any(abs(t - x) < 0.3 for x in tb))
    extra = sum(1 for x in tb if x > 10 and not any(abs(x - t) < 0.3 for t in truth))
    print(f"   jump {jump:+4d} uT: true turns after {sum(1 for t in truth if t > 10)}, boundaries after "
          f"{len(after)}, missed {missed}, extra {extra}, first boundary after the move at "
          f"{min((t for t in tb if t > 10.3), default=float('nan')) - 10.3:+.2f} s")

# lever moves along the crank axis itself (worst case): a level shift down looks like a dip
print("   lever shift along the crank axis (worst case):")
for jump in (-40, -20, 20, 40):
    def ext(phase, j=jump):
        return [0.0, 0.0, 0.0]

    def lev2(t, j=jump):
        return 0.0
    smp, truth = ride(25, 75, seed=10)
    ax = [CK["sign"] * CK["u"][k] for k in range(3)]
    smp = [(ms, [raw[k] + (jump * ax[k] if ms / 1000 > 10.0 else 0.0) for k in range(3)]) for ms, raw in smp]
    f = live_fw()
    feed(f, smp)
    tb = [b[0] / 1000 for b in f.boundaries]
    missed = sum(1 for t in truth if t > 10 and not any(abs(t - x) < 0.3 for x in tb))
    extra = sum(1 for x in tb if x > 10 and not any(abs(x - t) < 0.3 for t in truth))
    print(f"     shift {jump:+4d} uT along q: missed {missed}, extra {extra} of {sum(1 for t in truth if t > 10)} turns")

# calibration: a lever move mid-turn must not be captured as a point
print("   calibration while the lever creeps/jumps: are captured points real lever positions?")
f = fw.Firmware()
f.command('c')
seq, _ = ride(8, 70, seed=11)
feed(f, seq, notify=False)
check(f.calState == fw.CAL_CONFIRM, "learning on synthetic 70 rpm -> cadence check")
f.command('n')
levels = [0, 6, 12, 18, 24]


def lev3(t):
    i = int(t // 6)
    base = levels[min(i, len(levels) - 1)]
    nxt = levels[min(i + 1, len(levels) - 1)]
    x = t - 6 * i
    return base + (nxt - base) * min(1.0, max(0.0, (x - 4.0) / 1.5))   # hold 4 s, move over 1.5 s
smp, _ = ride(30, 70, seed=12, t0_ms=seq[-1][0] + 20, lever_fn=lev3)
feed(f, smp, notify=False)
pts = [fw.dot3([c[2][k] - BASE[k] for k in range(3)], LEV) for c in f.captures]
print(f"     lever held at {levels}, moved 1.5 s each: captured {len(pts)} points at "
      + ", ".join(f"{p:.1f}" for p in pts))
check(all(min(abs(p - l) for l in levels) < 1.0 for p in pts), "every captured point is a held lever position (within 1 uT)")
f2 = fw.Firmware()
f2.command('c')
feed(f2, seq, notify=False)
f2.command('n')


def creep(t):
    return 0.6 * t                       # rider moves "UP slowly": 0.6 uT/s, never holds
smp, _ = ride(30, 70, seed=13, t0_ms=seq[-1][0] + 20, lever_fn=creep)
feed(f2, smp, notify=False)
print(f"     lever creeping 0.6 uT/s (never held): {len(f2.captures)} points captured while moving: "
      + ", ".join(f"{fw.dot3([c[2][k] - BASE[k] for k in range(3)], LEV):.1f}" for c in f2.captures))

# ------------------------------------------------------------------ F. weak dips
print("\nF. Weak crank dips (crank far from the board): learning at 70 rpm, then live counting")
for scale in (0.05, 0.1, 0.15, 0.2, 0.3, 0.5):
    f, L = learn_on(ride(16, 70, scale=scale, seed=21)[0])
    extra = ""
    if f.crank["ok"]:
        g = fw.Firmware(cal=dict(pts=None, crankOk=1, crankSign=f.crank["sign"], crankU=f.crank["u"],
                                 crankDepth=f.crank["depth"], crankBase=f.crank["base"]))
        g.calValid = False
        smp, truth = ride(30, 70, scale=scale, seed=22)
        feed(g, smp)
        extra = f"  live: {len(g.boundaries)} boundaries for {len(truth)} turns"
    print(f"   x{scale:4.2f} (dip ~{scale * -min(qt):4.1f} uT): {L}{extra}")

# ------------------------------------------------------------------ G. irregular / late / stopped learning
print("\nG. Learning edge cases")
cases = {
    "ramp 40->110 rpm over 15 s": dict(rpm_fn=lambda t: 40 + 70 * t / 15),
    "jittery 70 rpm (+-30 % per 0.5 s)": dict(rpm_fn=lambda t: 70 * (1 + 0.3 * math.sin(t * 12.9) * math.cos(t * 3.1))),
    "still 6 s then 70 rpm": dict(rpm_fn=lambda t: 0 if t < 6 else 70),
    "70 rpm 4 s then stops": dict(rpm_fn=lambda t: 70 if t < 4 else 0),
    "no pedalling at all": dict(rpm_fn=lambda t: 0),
    "lever moved during learning (+30 uT at 3 s)": dict(rpm=70, lever_fn=lambda t: 0 if t < 3 else 30),
}
for name, kw in cases.items():
    kw.setdefault("rpm", 70)
    _, L = learn_on(ride(16, seed=31, **kw)[0])
    print(f"   {name:45s} -> {L}")

# ------------------------------------------------------------------ H. double dip / the 160 rpm cap
print("\nH. A second dip per turn (second magnet / double-lobed dip): does the 160 rpm cap catch it?")
for rpm in (50, 60, 70, 80, 90):
    for gain in (0.8, 1.0):
        def echo(phase, g=gain):
            return [g * x for x in crank_at(phase + 0.5)]
        f, L = learn_on(ride(16, rpm, seed=41, extra=echo)[0])
        print(f"   {rpm} rpm, echo x{gain}: {L}")

# ------------------------------------------------------------------ I. state machine
print("\nI. Calibration state machine: every command in every state")
names = {0: "IDLE", 1: "WAITING", 2: "CAPTURING", 3: "LEARN", 4: "CONFIRM"}
learn_smp, _ = ride(8, 70, seed=51)
steady, _ = ride(6, 70, seed=52, t0_ms=learn_smp[-1][0] + 20)
still, _ = ride(6, 0, seed=53, t0_ms=learn_smp[-1][0] + 20)


def make(state, crank_mode=True):
    f = fw.Firmware()
    if state == fw.CAL_IDLE:
        return f
    f.command('c')
    if state == fw.CAL_LEARN:
        feed(f, learn_smp[:50], notify=False)
        return f
    if crank_mode:
        feed(f, learn_smp, notify=False)
        if state == fw.CAL_CONFIRM:
            return f
        f.command('n')
        return f
    feed(f, ride(16, 0, seed=54)[0], notify=False)     # learning fails -> hold-still method
    if state == fw.CAL_CAPTURING:
        f.command('a')                                    # auto off so we can capture by hand
        feed(f, still[:150], notify=False)
        f.command('n')
    return f


rows = []
for st_ in (fw.CAL_IDLE, fw.CAL_LEARN, fw.CAL_CONFIRM, fw.CAL_WAITING, fw.CAL_CAPTURING):
    for mode in ((True, False) if st_ == fw.CAL_WAITING else (st_ != fw.CAL_CAPTURING,)):
        for cmd in ("c", "n", "l", "u", "x", "short", "long"):
            f = make(st_, mode)
            if f.calState != st_:
                rows.append(f"   setup for {names[st_]} failed (got {names[f.calState]})")
                continue
            n0 = len(f.out)
            ok_before = f.crank["ok"]
            if cmd == "short":
                f.short_press()
            elif cmd == "long":
                f.long_press()
            else:
                f.command(cmd)
            lines = [l for _, l in f.out[n0:]]
            rows.append(f"   {names[st_]:9s}{'' if st_ != fw.CAL_WAITING else (' crank' if mode else ' still'):6s} "
                        f"{cmd:5s} -> {names[f.calState]:9s} crank.ok {int(ok_before)}->{int(f.crank['ok'])}  "
                        + " | ".join(lines)[:90])
print("\n".join(rows))

# abort restores the previous calibration's crank
prev = dict(pts=[[float(i), 0.0, 0.0] for i in range(25)], crankOk=1, crankSign=CK["sign"],
            crankU=CK["u"], crankDepth=CK["depth"], crankBase=CK["base"])
for when in ("learn", "confirm", "waiting"):
    f = fw.Firmware(cal=dict(prev))
    f.command('c')
    if when != "learn":
        feed(f, ride(16, 70, seed=61, scale=0.5)[0], notify=False)
    if when == "waiting":
        f.command('n')
    f.command('x')
    check(f.crank["ok"] and f.crank["depth"] == CK["depth"] and f.crank["u"] == CK["u"],
          f"abort during {when}: previous crank restored")
# undo in crank mode back to step 0, and 'u' at CONFIRM
f = make(fw.CAL_CONFIRM)
f.command('u')
check(f.calState == fw.CAL_CONFIRM, "'u' at the cadence check is ignored")

# ------------------------------------------------------------------ J. Zwift packet
print("\nJ. Cycling Power Measurement packet")
f = live_fw()
f.calValid = True
f.cal["pts"] = [[0.0, 0.0, float(i)] for i in range(25)]
f.resistance = 50.0
f.selfRevs, f.selfEventMs, f.selfPeriods, f.ms_now = 1234, 100000, [750, 750], 100500
f.update_power()
pkt = f.power_packet()
print(f"   80 rpm at resistance 50: {pkt.hex(' ')} -> flags 0x{pkt[0] | pkt[1] << 8:04x}, "
      f"{int.from_bytes(pkt[2:4], 'little', signed=True)} W, revs {int.from_bytes(pkt[4:6], 'little')}, "
      f"evt {int.from_bytes(pkt[6:8], 'little')}")
check(pkt[0] == 0x20 and len(pkt) == 8, "flags = crank revolution data present, 8 bytes")
f.ms_now = 104000
f.update_power()
pkt = f.power_packet()
check(int.from_bytes(pkt[2:4], 'little') == 0 and f.cadenceRpm == 0, "stopped > 3 s: 0 W, 0 rpm, revs/evt frozen")

print("\nRESULT:", "all checks passed" if not fails else f"{len(fails)} check(s) failed: " + "; ".join(fails))
sys.exit(1 if fails else 0)
