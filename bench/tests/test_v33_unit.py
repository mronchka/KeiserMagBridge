"""Tier A (bench/V3_3_PLAN.md section 6): unit tests of the v3.3 model.

Usage: py -3 bench/tests/test_v33_unit.py [--quick]

  A1  derive_tolerances(): plan 2.2 formulas from noise / local step / settle; the floors
  A2  survey maths: path length with de-noising, move detection (same / shifted 1 uT / moved),
      on synthetic sweeps and on the recorded v3.2b per-turn stream
  A3  '#' line input: 20-byte fragments, \\r\\n, overflow, timeout, '#' mid-line, bad numbers,
      #M / #D / #J
  A4  calibration file v4 / v5 / v6: byte layouts packed with struct exactly as the C struct in
      the sketch (offsets from its own declarations, sizes against its static_asserts), round trip
      through the model's loader.  This proves the model's loader, not the board's (tier D does).
  A5  pause bookkeeping: give-up timers freeze while not pedalling; the first turn after a pause
      doesn't count towards agreement

Checks that need a v3.3 name SKIP with that name on the v3.2 model.
Exit code 1 if a check fails.
"""
import math
import os
import re
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fw_model as fw  # noqa: E402
import riders as R  # noqa: E402
from riders import API  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
QUICK = "--quick" in sys.argv
ck = R.Checker("test_v33_unit")
V33 = API.is_v33()
print(f"Model: {API.version()}")


def find(obj, *names):
    for n in names:
        v = getattr(obj, n, None)
        if v is not None:
            return v, n
    return None, None


# ====================================================================== A1
print("\nA1. derive_tolerances(): the plan 2.2 table")
NOISE_FLOOR = 0.15


def plan_tol(noise, step, settle, spot="same"):
    """Plan 2.2, as written (the reference for A1)."""
    n = max(noise, NOISE_FLOOR)
    f = 0.4 if spot == "same" else 0.25
    return dict(
        agree=max(2.5 * n, 1.0),
        drift=max(1.2 * n, 0.6), creep=max(1.0 * n, 0.5), slow=max(0.5 * n, 0.25),
        move=max(4 * n, f * step), along=0.5 * max(4 * n, f * step),
        behind=max(4 * n, 2 * settle, 0.3 * step),
        rise=max(2 * n, 0.25 * step),
        edge=0.07 * step,
        prior=max(4 * n, 0.5 * step),
        offpath=max(8.0, 15 * n),
        minspan=15 * n, stepwarn=3 * n, stepreject=1.0 * n, fold=max(1.0, 1.5 * n),
    )


# names the model may use for each plan quantity (first match wins)
TOL_KEYS = dict(
    agree=("agree", "turnAgree", "TURN_AGREE"), drift=("drift", "suspectDrift"), creep=("creep", "suspectCreep"),
    slow=("slow", "driftSlow", "suspectDriftSlow"), move=("move", "minMove", "turnMove"),
    along=("along", "turnAlong"), behind=("behind",), rise=("rise", "backRise"), edge=("edge", "edgeBias"),
    prior=("prior",), offpath=("offpath", "offPathHold", "offPath"), minspan=("minspan", "minSpan"),
    stepwarn=("stepwarn", "minStepWarn", "stepWarn"), stepreject=("stepreject", "minStepReject", "stepReject"),
    fold=("fold", "foldMargin"),
)


def tol_get(tol, key):
    for k in TOL_KEYS[key]:
        if k in tol:
            return tol[k]
    return None


def model_tol(noise, step, settle, spot):
    """derive_tolerances() as the model's constants say it should be (fw_model K_* / *_MIN)."""
    n = max(noise, fw.NOISE_FLOOR_UT)
    f = fw.MOVE_FRAC_SAME if spot == "same" else fw.MOVE_FRAC_NEW
    return dict(agree=max(fw.K_AGREE * n, fw.AGREE_MIN), drift=max(fw.K_DRIFT * n, fw.DRIFT_MIN),
                creep=max(fw.K_CREEP * n, fw.CREEP_MIN), slow=max(fw.K_SLOW * n, fw.SLOW_MIN),
                move=min(max(fw.K_MOVE * n, f * step), getattr(fw, "MOVE_CAP_FRAC", 1e9) * step), behind=max(fw.K_BEHIND * n, 2 * settle, fw.BEHIND_MIN,
                                                              fw.BEHIND_FRAC * step),
                rise=max(fw.K_RISE * n, fw.RISE_FRAC * step), offpath=max(fw.OFFPATH_HOLD_UT, fw.K_OFFHOLD * n),
                minspan=max(fw.SPAN_MIN, fw.K_SPAN * n), stepwarn=fw.K_STEP_WARN * n,
                stepreject=(fw.K_STEP_REJECT * n if hasattr(fw, 'K_STEP_REJECT') else fw.STEP_REJECT_UT),
                fold=max(fw.FOLD_MIN, fw.K_FOLD * n))


if not V33:
    ck.skip("A1: needs Firmware.derive_tolerances() / Firmware.tol")
else:
    for noise, step, settle, spot in ((0.05, 5.0, 0.1, "same"), (0.5, 5.0, 0.4, "same"), (0.8, 6.2, 0.6, "new"),
                                      (2.0, 15.0, 1.5, "same"), (0.5, 1.1, 0.2, "same")):
        f = fw.Firmware()
        API.set_noise(f, noise, settle=settle, spot=spot, exp_step=step)
        t = f.tol
        got = dict(agree=t["agree"], drift=t["drift"], creep=t["creep"], slow=t["slow"], move=f.tol_move(step),
                   behind=f.tol_behind(step), rise=f.tol_rise(step), offpath=t["offHold"], minspan=t["minSpan"],
                   stepwarn=t["stepWarn"], stepreject=t["stepReject"], fold=t["fold"])
        want = model_tol(noise, step, settle, spot)
        bad = {k: (round(got[k], 3), round(want[k], 3)) for k in want if abs(got[k] - want[k]) > 1e-6}
        ck.check(not bad, f"A1 noise {noise}, step {step}, settle {settle}, {spot}: every tolerance as its formula "
                          f"{bad if bad else ''}")
        plan = plan_tol(noise, step, settle, spot)
        dev = {k: f"{got[k]:.2f} (plan {plan[k]:.2f})" for k in ("agree", "drift", "move", "behind", "rise")
               if abs(got[k] - plan[k]) > 0.05 * max(plan[k], 0.1)}
        if dev:
            ck.info(f"A1 noise {noise}, step {step}: differs from the plan 2.2 table: {dev}")
        ck.check(t["noise"] >= fw.NOISE_FLOOR_UT - 1e-9, f"A1 noise {noise}: noise floored at 0.15 ({t['noise']:.2f})")
        ck.check(got["move"] <= getattr(fw, "MOVE_CAP_FRAC", 1.0) * step + 1e-9,
                 f"A1 step {step}: must-move {got['move']:.2f} capped at {getattr(fw, 'MOVE_CAP_FRAC', 1.0)} x step")
    f = fw.Firmware()
    API.set_noise(f, 0.0, exp_step=4.0)
    ck.check(f.tol["agree"] >= fw.AGREE_MIN and f.tol["drift"] >= fw.DRIFT_MIN and f.tol["creep"] >= fw.CREEP_MIN,
             f"A1: noise 0 -> the floors (agree {f.tol['agree']:.2f}, drift {f.tol['drift']:.2f}, creep {f.tol['creep']:.2f})")
    g = fw.Firmware(cal=R.scaled_cal_at())
    ck.check(abs(g.tol["noise"] - fw.NOISE_DEFAULT_UT) < 1e-9, f"A1: a v5 calibration (no noise stored) loads with "
             f"noise {g.tol['noise']:.2f} = default {fw.NOISE_DEFAULT_UT}")
    cal6 = R.scaled_cal_at()
    cal6["noiseUT"] = 0.42
    g = fw.Firmware(cal=cal6)
    ck.check(abs(g.tol["noise"] - 0.42) < 1e-9, f"A1: a v6 calibration loads its noise ({g.tol['noise']:.2f})")
    ck.check(all(abs(g.expStep[i] - fw.dist3(cal6["pts"][i], cal6["pts"][i - 1])) < 1e-6 for i in range(1, 24)),
             "A1: on load the expected steps are the stored calibration's")


# ====================================================================== A2
print("\nA2. Survey maths: path length, de-noising, move detection")


def path_len_ref(pts, noise):
    """Plan 2.1: chained distance, dropping points closer than 2 x noise to the last kept one."""
    if not pts:
        return 0.0
    kept, L = [pts[0]], 0.0
    for p in pts[1:]:
        d = fw.dist3(p, kept[-1])
        if d >= 2 * noise:
            L += d
            kept.append(p)
    return L


def true_len(L0, L1, n=400):
    pts = [R.field_at(L0 + (L1 - L0) * i / n) for i in range(n + 1)]
    return sum(fw.dist3(a, b) for a, b in zip(pts, pts[1:]))


# recorded: the v3.2b down pass (629-798 s) is a slow sweep down with holds, no go-backs
LOG32B = os.path.join(ROOT, "bench", "logs", "2026-10-16_v3_2b.log")
T, CD = [], {}
for line in open(LOG32B, encoding="utf-8"):
    m = re.match(r"^\s*([\d.]+)\s+T,(\d+),(\d+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)", line)
    if m:
        T.append((float(m[1]), [float(m[4]), float(m[5]), float(m[6])]))
    m = re.match(r"^\s*([\d.]+)\s+C,down,(\d+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\s*$", line)
    if m and float(m[1]) < 802:
        CD[int(m[2])] = [float(m[3]), float(m[4]), float(m[5])]
dnT = [b for t, b in T if 629 <= t <= 798]
lrn = [b for t, b in T if t < 94]
noise_rec = sorted(fw.dist3(a, b) for a, b in zip(lrn, lrn[1:]))[(len(lrn) - 1) // 2]
truth = sum(fw.dist3(CD[i], CD[i - 1]) for i in range(23, 2, -1))
ref2 = path_len_ref(dnT, noise_rec)
ref4 = path_len_ref(dnT, 2 * noise_rec)
ck.info(f"A2 recorded: {len(dnT)} down-pass turns, noise {noise_rec:.2f}: de-noised (2 x noise) {ref2:.1f} uT, "
        f"(4 x noise) {ref4:.1f}, raw chain {sum(fw.dist3(a, b) for a, b in zip(dnT, dnT[1:])):.1f}; "
        f"the down points 23->2 chain {truth:.1f}")
ck.check(abs(ref2 / truth - 1) <= 0.30, f"A2 recorded: plan de-noising gives {ref2 / truth - 1:+.0%} on a held sweep "
         "(limit +-30 %; a steady survey sweep should do better)")
sweep_len = getattr(fw.Firmware, "sweep_len", None)
if sweep_len is None:
    ck.skip("A2: the model has no Firmware.sweep_len(points, noise)")
else:
    L, far, end = sweep_len(dnT, noise_rec)
    ck.check(abs(L - ref2) < 1e-6, f"A2: model sweep_len {L:.1f} = the plan's de-noising {ref2:.1f}")
    pts = [R.field_at(x) for x in [0.1 * i for i in range(0, 1300)]]
    L, far, end = sweep_len(pts, 0.15)
    ck.check(abs(L - true_len(0, 129.9)) < 0.5, f"A2 synthetic noise-free sweep: {L:.1f} vs {true_len(0, 129.9):.1f}")
    import random as _r
    rnd = _r.Random(3)
    for per_turn, lim in ((5.0, 0.05), (1.6, 0.10), (0.8, None)):
        n_t = int(128 / per_turn)
        noisy = [[x + rnd.gauss(0, 0.3) for x in R.field_at(per_turn * i)] for i in range(0, n_t + 1)]
        L, far, end = sweep_len(noisy, 0.5)
        tl_ = true_len(0, per_turn * n_t)
        msg = (f"A2 synthetic sweep, {per_turn} uT per turn ({n_t} turns), 0.3 uT per axis, noise 0.5: "
               f"{L:.1f} vs {tl_:.1f} ({L / tl_ - 1:+.0%})")
        if lim is None:
            ck.info(msg + " [a very slow sweep overestimates L]")
        else:
            ck.check(abs(L / tl_ - 1) < lim, msg + f" within {lim:.0%}")
    back = pts[:900] + pts[900:600:-1]
    L, far, end = sweep_len(back, 0.15)
    ck.info(f"A2 sweep that turns back 30 uT before the end: far {far:.1f}, end {end:.1f} (folded when far - end > "
            f"max(3, 0.15 L))")

if not V33:
    ck.skip("A2: survey through the flow (Z line) needs the v3.3 model")
else:
    tl = true_len(0.0, R.PEDAL_TOP)
    _c = [R.LEV[1] * R.PERP[2] - R.LEV[2] * R.PERP[1], R.LEV[2] * R.PERP[0] - R.LEV[0] * R.PERP[2],
          R.LEV[0] * R.PERP[1] - R.LEV[1] * R.PERP[0]]
    NRM = [x / math.sqrt(fw.dot3(_c, _c)) for x in _c]          # square to the lever path's plane
    for label, cal, want in (("first", None, "first"), ("same", R.scaled_cal_at(), "same"),
                             ("shifted 1 uT", R.scaled_cal_at(shift=[1.0 * x for x in NRM]), "same"),
                             ("moved 4 uT across the path", R.scaled_cal_at(shift=[4.0 * x for x in NRM]), "new"),
                             ("moved 3 uT along the path", R.scaled_cal_at(shift=[3.0 * x for x in R.LEV]), "same"),
                             ("moved 8 uT", R.scaled_cal_at(shift=[5.0, -4.0, 4.5]), "new")):
        f = fw.Firmware(cal=cal)
        sim = R.Sim(f, seed=7)
        rider = R.Rider(sim)
        sim.run(2)
        API.start(f)
        sim.run(240, lambda s: rider(s) or bool([l for _, l in f.out if l.startswith("Z,")]))
        z = [l for _, l in f.out if l.startswith("Z,")]
        if not z:
            ck.check(False, f"A2 {label}: a Z line after the sweeps")
            continue
        p = z[-1].split(",")
        ck.check(p[3] == want, f"A2 {label}: spot={p[3]} (want {want}); {z[-1]}")
        if label == "first":
            ck.check(abs(float(p[2]) - tl) < 0.15 * tl, f"A2 synthetic sweep through the flow: path {float(p[2]):.1f} "
                     f"vs true {tl:.1f} uT (+-15 %)")
            ck.check(p[5] == "ok", f"A2 synthetic sweep: verdict ok ({p[5]})")
    # #M forces a new spot
    f = fw.Firmware(cal=R.scaled_cal_at())
    f.line("M", "usb")
    sim = R.Sim(f, seed=8)
    rider = R.Rider(sim)
    sim.run(2)
    API.start(f)
    sim.run(240, lambda s: rider(s) or bool([l for _, l in f.out if l.startswith("Z,")]))
    z = [l for _, l in f.out if l.startswith("Z,")]
    ck.check(bool(z) and z[-1].split(",")[3] == "new", f"A2 #M then a calibration at the same spot: spot=new ({z[-1:]})")
    # a weak signal (x0.08) is reported
    f = fw.Firmware()
    sim = R.Sim(f, seed=9, scale=0.08)
    rider = R.Rider(sim)
    sim.run(2)
    API.start(f)
    sim.run(240, lambda s: rider(s) or bool([l for _, l in f.out if l.startswith(("Z,", "A,"))]) or
            any(l.startswith("L,0") for _, l in f.out))
    z = [l for _, l in f.out if l.startswith(("Z,", "L,0", "A,"))]
    ck.info(f"A2 field x0.08 (lever span ~10 uT): {z[-2:]}")

# ====================================================================== A3
print("\nA3. '#' line input")


def lines_of(f):
    return [l for _, l in f.out]


def run_line(text):
    f = fw.Firmware(cal=R.scaled_cal_at())
    f.out.clear()
    try:
        API.line(f, text)
        return lines_of(f), None
    except Exception as e:  # noqa: BLE001
        return lines_of(f), e


for text, want in (("P,u,3,1.0,abc,2", "E,fail,bad number"), ("P,u,3,1.0,2.0,3x", "E,fail,bad number"),
                   ("P,u,3,1_0,2.0,3", "E,fail,bad number"),     # strtof stops at '_'; Python float takes it
                   ("P,u,3,1e1,-.5,+2", "E,ok,staged"), ("P,u,3, 1.0,2.0,3", "E,ok,staged"),
                   ("R,u,abc", "E,fail"), ("G,u,x", "E,fail"), ("R,u", "E,fail,unknown command"),
                   ("P,u,99,1,2,3", "E,fail,no such point"), ("", None), (",,,", None)):
    out, err = run_line(text)
    if want is None:
        ck.check(err is None and not out, f"A3 '#{text}': ignored (sketch: strtok finds no field) -> {out}"
                                          f"{' raised ' + repr(err) if err else ''}")
        continue
    ok = err is None and out and out[-1].startswith(want)
    ck.check(ok, f"A3 #{text}: '{want}...' -> {out[-1] if out else '(nothing)'}{' raised ' + repr(err) if err else ''}")
if V33:
    for text, want in (("M", "E,ok"), ("J,check,14,14,62", "J,check,14,14,62"), ("J,a,b,,c", "J,a,b,,c"),
                       ("D", "E,fail,down pass already done")):
        out, err = run_line(text)
        ck.check(err is None and any(l.startswith(want) for l in out), f"A3 #{text}: {want} -> {out[:3]}")
    half = R.scaled_cal_at()
    half["downMask"] = sum(1 << i for i in range(12, fw.DOWN_FIRST + 1))
    f = fw.Firmware(cal=half)
    f.line("D", "usb")
    ck.check(lines_of(f)[-2:-1] == ["E,ok,down"] and f.calPass == fw.PASS_DOWN and f.calStep == 11,
             f"A3 #D with down points 23..13 kept: resumes at down point 12 ({lines_of(f)[-2:]}, step {f.calStep + 1})")
    f = fw.Firmware()
    f.line("D", "usb")
    ck.check(lines_of(f)[-1].startswith("E,fail"), f"A3 #D without a calibration refused ({lines_of(f)[-1:]})")
    out, err = run_line("I")
    ck.check(err is None and out and out[-1].startswith("E,ok,inject"), f"A3 #I over USB: {out[-1:]}")
    f = fw.Firmware(cal=R.scaled_cal_at())
    f.line("I", "ble")
    ck.check(lines_of(f)[-1] == "E,fail,usb only", f"A3 #I over BLE refused ({lines_of(f)[-1:]})")
    f = fw.Firmware(cal=R.scaled_cal_at())
    f.line("S,100,1,2,3", "usb")
    ck.check(lines_of(f)[-1] == "E,fail,not injecting", f"A3 #S without #I refused ({lines_of(f)[-1:]})")
else:
    ck.skip("A3: #M / #D / #J / #I / #S need the v3.3 model")

inp = getattr(fw.Firmware, "input", None)
if inp is None:
    ck.skip("A3: byte-level input (Firmware.input(text, src)) not in the model")
else:
    def feed(f, chunks, src="ble", gap_ms=20):
        for c in chunks:
            f.ms_now += gap_ms
            f.input(c, src)

    msg = "#P,u,3,-50.25,38.125,-117.5\n"
    f = fw.Firmware(cal=R.scaled_cal_at())
    feed(f, [msg[i:i + 20] for i in range(0, len(msg), 20)])
    ck.check("E,ok,staged" in lines_of(f), f"A3: a {len(msg)}-byte #P in 20-byte writes is joined ({lines_of(f)[-1:]})")
    f = fw.Firmware(cal=R.scaled_cal_at())
    feed(f, list("#J,one by one\n"), gap_ms=60)
    ck.check("J,one by one" in lines_of(f), f"A3: one character per write, 60 ms apart ({lines_of(f)[-1:]})")
    f = fw.Firmware(cal=R.scaled_cal_at())
    feed(f, ["#J,hello\r\n"])
    ck.check(lines_of(f).count("J,hello") == 1 and not any(l.startswith("E,fail") for l in lines_of(f)),
             f"A3: CR LF ends the line once ({lines_of(f)})")
    f = fw.Firmware(cal=R.scaled_cal_at())
    feed(f, ["#J," + "x" * 80 + "\n", "#J,ok\n"])
    ck.check("E,fail,line too long" in lines_of(f) and "J,ok" in lines_of(f),
             f"A3: overflow refused, the next line is fine ({lines_of(f)[-2:]})")
    f = fw.Firmware(cal=R.scaled_cal_at())
    feed(f, ["#J," + "y" * 60 + "\n"])
    ck.check(lines_of(f) == ["J," + "y" * 60], "A3: a 63-character line (the buffer's limit) still works")
    f = fw.Firmware(cal=R.scaled_cal_at())
    feed(f, ["#J,half"], gap_ms=20)
    feed(f, ["c"], gap_ms=1600)                      # after the 1.5 s line timeout 'c' is a command again
    ck.check(f.calState != fw.CAL_IDLE and not any(l.startswith("J,") for l in lines_of(f)),
             "A3: half a line is dropped after 1.5 s; the next character is a command")
    f = fw.Firmware(cal=R.scaled_cal_at())
    feed(f, ["#J,half"], gap_ms=20)
    feed(f, ["\n"], gap_ms=1400)
    ck.check("J,half" in lines_of(f), "A3: 1.4 s between pieces is still one line")
    f = fw.Firmware(cal=R.scaled_cal_at())
    feed(f, ["#P,u,3,1.0#W\n"])
    ck.check(any(l.startswith("E,fail") for l in lines_of(f)) and not f.staging,
             f"A3: '#' inside a line is data, not a new command ({lines_of(f)})")
    f = fw.Firmware(cal=R.scaled_cal_at())
    feed(f, ["#J,c\n"])
    ck.check(f.calState == fw.CAL_IDLE, "A3: 'c' inside a # line is not a command")
    f = fw.Firmware(cal=R.scaled_cal_at())
    feed(f, ["#J,from"], src="ble")
    feed(f, ["c"], src="usb")
    feed(f, [" ble\n"], src="ble")
    ck.check(f.calState != fw.CAL_IDLE and "J,from ble" in lines_of(f),
             "A3: USB and BLE have their own line buffers ('c' on USB mid-BLE-line works)")
    f = fw.Firmware(cal=R.scaled_cal_at())
    feed(f, ["#J,dropped"], src="ble")
    f.phone_connected(False)
    f.phone_connected(True)
    feed(f, ["n\n"], src="ble")
    ck.check(not any(l.startswith("J,") for l in lines_of(f)), f"A3: a disconnect drops half a BLE line ({lines_of(f)})")

# ====================================================================== A4
print("\nA4. Calibration file v4 / v5 / v6: byte layouts as in the sketch")
SK32 = os.path.join(ROOT, "KeiserMagBridge_v3_2", "KeiserMagBridge_v3_2.ino")
SK33 = os.path.join(ROOT, "KeiserMagBridge_v3_3", "KeiserMagBridge_v3_3.ino")
CTYPES = {"uint32_t": ("I", 4), "int32_t": ("i", 4), "uint16_t": ("H", 2), "int16_t": ("h", 2),
          "uint8_t": ("B", 1), "int8_t": ("b", 1), "float": ("f", 4), "bool": ("?", 1), "char": ("c", 1)}


def sketch_consts(src):
    c = {}
    for m in re.finditer(r"(?:static\s+)?(?:const|constexpr)\s+\w+\s+(\w+)\s*=\s*([^;]+);", src):
        c[m[1]] = m[2]
    for m in re.finditer(r"#define\s+(\w+)\s+([^\n]+)", src):
        c[m[1]] = m[2]
    return c


def c_eval(expr, consts, depth=0):
    e = re.sub(r"//.*", "", expr).strip().rstrip("fFuUlL")
    for _ in range(6):
        e2 = re.sub(r"\b([A-Z_][A-Z0-9_]*)\b", lambda m: "(" + consts[m[1]].split("//")[0].strip() + ")"
                    if m[1] in consts else m[1], e)
        if e2 == e:
            break
        e = e2
    e = re.sub(r"(\d)[uUlLfF]+\b", r"\1", e)
    return int(eval(e, {"__builtins__": {}}))  # noqa: S307 - constants from our own sketch


def parse_struct(src, name="CalData"):
    """Fields of 'struct name {...};' with ARM EABI natural alignment: (fmt, [(field, offset, size, count)], size)."""
    m = re.search(r"struct\s+" + name + r"\s*\{(.*?)\};", src, re.S)
    if not m:
        return None
    consts = sketch_consts(src)
    off, fields, align_max, marks = 0, [], 1, {}
    for raw in m[1].split(";"):
        line = re.sub(r"//[^\n]*", "", raw).strip()
        if not line:
            continue
        mm = re.match(r"(\w+)\s+(\w+)((?:\s*\[[^\]]+\])*)$", line.replace("\n", " ").strip())
        if not mm:
            raise ValueError("can't parse struct field: " + line)
        ctype, fname, dims = mm[1], mm[2], mm[3]
        code, size = CTYPES[ctype]
        count = 1
        for d in re.findall(r"\[([^\]]+)\]", dims):
            count *= c_eval(d, consts)
        a = size
        align_max = max(align_max, a)
        pad = (-off) % a
        off += pad
        fields.append((fname, off, size, count, code))
        marks[fname] = off
        off += size * count
    total = off + ((-off) % align_max)
    return fields, total, marks


def layout_fmt(fields, upto=None):
    fmt, off = "<", 0
    for fname, o, size, count, code in fields:
        if upto is not None and o >= upto:
            break
        if o > off:
            fmt += f"{o - off}x"
        fmt += (f"{count}{code}" if count > 1 else code)
        off = o + size * count
    if upto is not None and upto > off:
        fmt += f"{upto - off}x"
    return fmt


def pack_cal(fields, total, values, upto=None):
    fmt = layout_fmt(fields, upto)
    flat = []
    for fname, o, size, count, code in fields:
        if upto is not None and o >= upto:
            break
        v = values[fname]
        if count > 1:
            v = [x for row in v for x in (row if isinstance(row, (list, tuple)) else [row])]
            assert len(v) == count, (fname, len(v), count)
            flat += v
        else:
            flat.append(v)
    b = struct.pack(fmt, *flat)
    n = upto if upto is not None else total
    return b + b"\0" * (n - len(b))


def static_asserts(src):
    return [(m[1].strip(), c_eval(m[2], sketch_consts(src)))
            for m in re.finditer(r"static_assert\s*\(\s*sizeof\s*\(\s*(\w+)\s*\)\s*==\s*([^,\)]+)", src)]


src32 = open(SK32, encoding="utf-8").read()
fields5, size5, marks5 = parse_struct(src32)
v4size = marks5["downMask"]
ck.check(size5 == 636 and v4size == 332, f"A4: v3.2 CalData = {size5} bytes, v4 part (offsetof downMask) = {v4size} "
         "(by hand: 4+2+2+300+1+1+2+12+4+4 = 332; + 4 + 300 = 636)")
cal = R.scaled_cal_at()
cal_vals = dict(magic=0x4B4D3343, version=5, reserved=0, pts=cal["pts"], crankOk=1, crankSign=cal["crankSign"],
                pad=0, crankU=cal["crankU"], crankDepth=cal["crankDepth"], crankBase=cal["crankBase"],
                downMask=cal["downMask"], down=cal["down"])
b5 = pack_cal(fields5, size5, cal_vals)
b4 = pack_cal(fields5, size5, dict(cal_vals, version=4), upto=v4size)
ck.check(len(b5) == 636 and len(b4) == 332, f"A4: packed v5 {len(b5)} bytes, v4 {len(b4)} bytes")
u = struct.unpack_from("<IHH", b5)
ck.check(u == (0x4B4D3343, 5, 0), "A4: header magic 'KM3C' + version at offsets 0 / 4")
ck.check(abs(struct.unpack_from("<f", b5, 8 + 4 * 3 * 7)[0] - cal["pts"][7][0]) < 1e-4,
         "A4: pts[7][0] at offset 8 + 84")

loader, lname = find(fw, "load_cal_bytes", "load_calibration", "unpack_cal", "cal_from_bytes")
if loader is None:
    loader, lname = find(fw.Firmware, "load_cal_bytes", "load_calibration", "load_bytes")
src33 = open(SK33, encoding="utf-8").read() if os.path.exists(SK33) else None
blobs = [("v4", b4, 0), ("v5", b5, cal["downMask"])]
if src33:
    p6 = parse_struct(src33)
    sa = static_asserts(src33)
    if p6:
        fields6, size6, marks6 = p6
        ck.info(f"A4: v3.3 CalData = {size6} bytes; fields after v5: " +
                ", ".join(f"{n}@{o}" for n, o, *_ in fields6 if o >= size5))
        for name, val in sa:
            if name == "CalData":
                ck.check(val == size6, f"A4: static_assert(sizeof(CalData) == {val}) matches the parsed layout ({size6})")
        if not sa:
            ck.info("A4: the v3.3 sketch has no static_assert on sizeof(CalData): please add one (plan 6 A4)")
        v6 = dict(cal_vals, version=6)
        extra = dict(noiseUT=0.42, stepScale=131.5, stickRatio=0.93, capRpm=[70 + i % 5 for i in range(25)],
                     downRpm=[60 + i % 7 for i in range(25)], spotId=0xC0FFEE11)
        for fname, o, size, count, code in fields6:
            if fname not in v6:
                v6[fname] = extra.get(fname, [0] * count if count > 1 else 0)
        try:
            b6 = pack_cal(fields6, size6, v6)
            blobs.append(("v6", b6, cal["downMask"]))
            ck.check(len(b6) == size6, f"A4: packed v6 {len(b6)} bytes")
            ck.check(marks6.get("downMask") == v4size, "A4: v6 keeps the v4/v5 prefix (downMask at 332)")
        except Exception as e:  # noqa: BLE001
            ck.check(False, f"A4: packing v6 failed: {e!r}")
else:
    ck.skip("A4: KeiserMagBridge_v3_3/KeiserMagBridge_v3_3.ino doesn't exist yet: v6 layout not checked")
if loader is None:
    ck.skip("A4: the model has no binary loader (fw.load_cal_bytes(bytes) -> cal dict or None): v4/v5/v6 round "
            "trip through the model not tested")
else:
    for tag, blob, mask in blobs:
        try:
            c = loader(blob)
            if isinstance(c, fw.Firmware):
                c = c.cal
            ok = c is not None and max(fw.dist3(a, b) for a, b in zip(c["pts"], cal["pts"])) < 1e-3 \
                and c.get("downMask", 0) == mask
            ck.check(ok, f"A4 {tag}: loads, points and downMask right ({lname})")
        except Exception as e:  # noqa: BLE001
            ck.check(False, f"A4 {tag}: loader raised {e!r}")
        if tag == "v4":
            try:
                ck.check(loader(blob[:-1]) is None, f"A4 {tag}: a file one byte short is refused")
                bad = bytearray(blob)
                bad[0] ^= 0xFF
                ck.check(loader(bytes(bad)) is None, f"A4 {tag}: a wrong magic is refused")
            except Exception as e:  # noqa: BLE001
                ck.check(False, f"A4: loader raised on a bad file: {e!r}")

pack_model = getattr(fw, "pack_cal", None)
if pack_model is None:
    ck.skip("A4: the model has no pack_cal(cal, version)")
else:
    m5 = pack_model(dict(cal), 5)
    ck.check(m5 == b5, "A4: the model's v5 bytes are identical to the C-struct layout packed here")
    m4 = pack_model(dict(cal), 4)
    ck.check(m4 == b4, "A4: the model's v4 bytes are identical to the C-struct layout packed here")
    c6 = dict(cal, noiseUT=0.42, stepScale=131.5, stickRatio=0.93, spotId=0xC0FFEE11,
              capRpm=[70 + i % 5 for i in range(25)], downRpm=[60 + i % 7 for i in range(25)])
    m6 = pack_model(c6, 6)
    ck.check(len(m6) == getattr(fw, "CAL_V6_SIZE", len(m6)), f"A4: v6 is {len(m6)} bytes (model CAL_V6_SIZE)")
    ck.check(m6[8:v4size] == m4[8:] and m6[v4size:size5] == m5[v4size:],
             "A4: v6 starts with the v5 layout unchanged (v4 and v5 readers see the same prefix)")
    u6 = fw.unpack_cal(m6) if hasattr(fw, "unpack_cal") else None
    if u6 is None:
        ck.check(False, "A4: the model loads its own v6 bytes")
    else:
        same = (abs(u6["noiseUT"] - 0.42) < 1e-6 and abs(u6["stepScale"] - 131.5) < 1e-4 and
                abs(u6["stickRatio"] - 0.93) < 1e-6 and u6["spotId"] == 0xC0FFEE11 and
                list(u6["capRpm"]) == c6["capRpm"] and list(u6["downRpm"]) == c6["downRpm"] and
                u6["downMask"] == cal["downMask"])
        ck.check(same, "A4 v6: noiseUT, stepScale, stickRatio, spotId, capRpm[25], downRpm[25] round-trip")
    u4 = fw.unpack_cal(b4)
    if u4:
        ck.check(u4["downMask"] == 0 and u4.get("noiseUT", 0) == 0 and abs(u4["stepScale"] - fw.path_len(u4["pts"])) < 1e-3
                 and u4.get("spotId"), "A4 v4: defaults for the missing fields (no down points, noise 0 = default, "
                                       "stepScale = path length, spotId from the points)")
        g = fw.Firmware(cal=u4)
        ck.check(abs(g.tol["noise"] - fw.NOISE_DEFAULT_UT) < 1e-9 and g.calValid,
                 f"A4 v4: loads and runs with the default noise {fw.NOISE_DEFAULT_UT}")
    bad = bytearray(m6)
    struct.pack_into("<H", bad, 4, 5)
    ck.check(fw.unpack_cal(bytes(bad)) is None, "A4: a v6-sized file that says version 5 is refused (as the sketch)")
    ck.check(fw.unpack_cal(m5 + b"\0") is None, "A4: a file of an unknown size is refused")
    if src33 is None:
        ck.info("A4: when KeiserMagBridge_v3_3.ino exists this test parses its CalData and checks the model's v6 "
                "format against it field by field")
    else:
        try:
            fields6, size6, marks6 = parse_struct(src33)
            mine = pack_cal(fields6, size6, dict(cal_vals, version=6, noiseUT=0.42, stepScale=131.5, stickRatio=0.93,
                                                 spotId=0xC0FFEE11, capRpm=c6["capRpm"], downRpm=c6["downRpm"],
                                                 **{n: 0 for n, *_ in fields6 if n.startswith(("pad", "reserved"))}))
            ck.check(mine == m6, f"A4: the model's v6 bytes are identical to the v3.3 sketch's CalData ({size6} bytes)")
        except Exception as e:  # noqa: BLE001
            ck.check(False, f"A4: v6 against the v3.3 sketch: {e!r}")

# ====================================================================== A5
print("\nA5. Pause bookkeeping: timers freeze, no beeps, the first turn after a pause doesn't count")
f = fw.Firmware()
sim = R.Sim(f, seed=55, settle=None, creep_p=0.0, wobble=0.0)
rider = R.Rider(sim)
sim.run(2)
API.start(f)
sim.run(60, lambda s: rider(s) or (f.calPass == fw.PASS_UP and f.calStep == 3 and f.calState == fw.CAL_WAITING))
# at point 4: creep so that the board says "hold still" (settleSince set), then stop pedalling for 25 s
rider.planned = True
sim.move_to(R.UP_EDGE[3] + 0.3)
sim.run(3)
sim.move_to(R.UP_EDGE[3] + 3.0, 0.9)                 # slow creep: W notices, settleSince starts
t_w = None
for _ in range(400):
    sim.run(0.1)
    if getattr(f, "settleSince", 0):
        t_w = sim.t()
        break
ck.check(t_w is not None, "A5: a creeping lever starts the hold-still timer (W)")
sim.move_to(sim.L)                                   # stop the lever, stop pedalling
sim.pedal = False
n_before = len(f.out)
sim.run(25)
lines_pause = [l for _, l in f.out[n_before:]]
ck.check(not any(l.startswith("P,") for l in lines_pause), f"A5: no 'keeps changing' (P) during a 25 s stop ({[l for l in lines_pause if l[:2] in ('P,', 'W,')]})")
if V33:
    ck.check(API.paused(f), "A5: paused flag set while not pedalling")
    ck.check("O" in API.flags(f), f"A5: status flag O while paused ({API.flags(f)})")
    beeps = getattr(f, "beeps", None)
    if beeps is not None:
        ck.check(not [b for b in beeps if b[0] >= (t_w or 0) * 1000 + 3500], "A5: no beeps while paused")
else:
    ck.skip("A5: paused flag / O needs the v3.3 model")
sim.pedal = True
caps0 = len(f.captures)
bnd0 = len(f.boundaries)
sim.run(3.5)
# turns after the pause: the first full one must not be used, so no capture before 4 full turns
sim.run(12, lambda s: len(f.captures) > caps0)
nt = sum(1 for b in f.boundaries[bnd0:] if b[1] == 2 and (not f.captures[caps0:] or b[0] <= f.captures[caps0][0]))
got = len(f.captures) > caps0
ck.check(got and not any(l.startswith("P,") for _, l in f.out[n_before:]), f"A5: the point is taken after the pause ({'yes' if got else 'no'})")
if got:
    ck.check(nt >= 4, f"A5: {nt} full turns after resuming before the save (the first one doesn't count: >= 4)")


# ====================================================================== A6
print("\nA6. Settle learning (plan 2.2: along-path offset of the 2 turns after each save, median of 6)")
if not V33:
    ck.skip("A6: needs the v3.3 model (settle_add / settleRing)")
else:
    f = fw.Firmware()
    learned = []
    _orig = f.settle_add

    def _sa(x, f=f):
        learned.append((f.calPass, f.calStep, x))
        _orig(x)
    f.settle_add = _sa
    seen_ready = []
    sim = R.Sim(f, seed=1, settle=None, creep_p=0.0, wobble=0.0)   # a lever that never settles back
    rider = R.Rider(sim)
    sim.run(2)
    API.start(f)

    def pol(s):
        if f.calState == fw.CAL_DOWN_READY and not seen_ready:
            seen_ready.append(f.settleTurns)
        return rider(s)
    sim.run(900, pol)
    big = [(("up", "down")[p] if p < 2 else p, st + 1, round(x, 2)) for p, st, x in learned if x > 1.0]
    ck.check(not big, f"A6: a lever that never settles back -> no settle over 1 uT is learned ({big})")
    ck.check(seen_ready == [0], f"A6: the settle watch of up point 24 is cancelled when the up pass ends "
                                f"(settleTurns at the 'Saved' checkpoint: {seen_ready})")
    ck.check(f.tol["behindMin"] <= max(fw.K_BEHIND * f.tol["noise"], fw.BEHIND_MIN) + 1e-6,
             f"A6: behind stays at its noise value ({f.tol['behindMin']:.2f}; settle {f.tol['settle']:.2f})")
    # a go-back: the rider's deliberate move back after an overshoot isn't a settle either
    f = fw.Firmware()
    learned2 = []
    _o2 = f.settle_add
    f.settle_add = lambda x, f=f: (learned2.append((f.calPass, f.calStep, x)), _o2(x))
    sim = R.Sim(f, seed=41, settle=None, creep_p=0.0, wobble=0.0)
    rider = R.Rider(sim, overshoot_at={(fw.PASS_UP, 9)})
    sim.run(2)
    API.start(f)
    sim.run(900, rider)
    big = [(p, st + 1, round(x, 2)) for p, st, x in learned2 if x > 1.0]
    ck.info(f"A6: overshoot at up point 10 (no settling lever): learned settles over 1 uT {big}; "
            f"behindMin at the end {f.tol['behindMin']:.2f}")


# ====================================================================== A7
print("\nA7. The survey's noise estimate on one lever (same bike, 16 riders): how much it varies")
if not V33:
    ck.skip("A7: needs the v3.3 survey")
else:
    est = []
    for seed in range(1, 9 if QUICK else 17):
        f = fw.Firmware()
        sim = R.Sim(f, seed=seed, rpm=75)
        rider = R.Rider(sim)
        sim.run(2)
        API.start(f)
        sim.run(60, lambda s: rider(s) or (f.calState == fw.CAL_SURVEY and f.survPhase != fw.SURV_NOISE))
        est.append(f.tol["noise"])
    g = fw.Firmware(cal=R.scaled_cal_at())
    sim = R.Sim(g, seed=99, rpm=75)
    sim.run(200)
    live = [b[3] for b in g.boundaries if b[1] == 2]
    truth = sorted(fw.dist3(a, b) for a, b in zip(live, live[1:]))[(len(live) - 2) // 2]
    lo, hi = min(est), max(est)
    ck.info(f"A7: noise estimates {sorted(round(x, 2) for x in est)}; the same lever over {len(live)} turns: {truth:.2f}")
    ck.info(f"A7: agree then ranges {max(fw.K_AGREE * lo, fw.AGREE_MIN):.2f}-{max(fw.K_AGREE * hi, fw.AGREE_MIN):.2f} uT "
            f"(smallest gear steps 1.8 uT)")
    ck.check(hi / lo <= 2.0, f"A7: the estimate varies x{hi / lo:.1f} between riders on one lever (want <= x2: "
                             f"{fw.NOISE_TURNS} turns are too few, or clamp it)")


# ====================================================================== A8
def fmt_lim(v):
    if isinstance(v, (list, tuple)):
        v = [x for x in v if x]
        return f"{min(v):.2f}-{max(v):.2f}" if v else "?"
    return "?" if v is None else f"{v:.2f}"


print("\nA8. The check at a weak field: in-order points with 0.54 uT steps aren't 'behind'")
for label, shift21, noise in (("exact, noise 0.5", 0.0, 0.5), ("exact, noise 0.15", 0.0, 0.15),
                              ("point 21 0.18 uT low (step 0.36, in order)", -0.18, 0.5)):
    c = R.scaled_cal_at(scale=0.3)
    c["noiseUT"] = noise
    if shift21:
        c["pts"][20] = [c["pts"][20][k] + shift21 * R.LEV[k] for k in range(3)]
    steps = [fw.dist3(c["pts"][i], c["pts"][i - 1]) for i in range(1, 24)]
    g = fw.Firmware(cal=c)
    behind = [(p, n) for p, n, w, _ in g.suspects if w == "behind"]
    ck.check(not behind, f"A8 x0.3 ({label}; smallest step {min(steps):.2f} uT): no 'behind' flags {behind} "
                         f"(order limit {fmt_lim(getattr(g, 'chkLim', {}).get('order'))})")
    ck.info(f"A8 x0.3 ({label}): all flags {[(p, n, w) for p, n, w, _ in g.suspects]}")
# the synthetic top: 0.3 x the 23->24 step must not be refused as 'the same' at a weak field
for scale in (0.3, 0.5):
    c = R.scaled_cal_at(scale=scale)
    p = [list(x) for x in c["pts"]]
    g = fw.Firmware(cal=c)
    g.noiseUT = 0.76
    g.derive_tolerances()
    fw.Firmware.synth_top(p)
    ok, span, mn, at, msg = g.cal_validate(p)
    ck.check(ok, f"A8 x{scale}, noise 0.76: a clean up pass validates (smallest step {mn:.2f} at {at}; {msg or 'ok'})")

ck.finish()
