"""Tier C (bench/V3_3_PLAN.md section 6): the real 2026-10-16 logs through the v3.3 model.

Usage: py -3 bench/tests/test_v33_replay.py [--quick]

  C1  tolerances at this spot from real data: noise from the learning turns, from held points and from
      the 2026-10-15 'still' recording; settle learned on the v3.2b run.  Plan: agree ~2.0, drift ~1.0,
      behind >= 1.5 uT.
  C2  the check: the morning calibration flags exactly 20 and 22; the v3.2b final calibration flags 15
      and 18 plus no more than 2 others; clean simulated calibrations <= 0.1 flags each.
  C3  hold-still notices (W) on the v3.2b raw data with 0 vs 1 extra settling turn, and the cost.
  C4  v3.2b: gear 15 isn't saved early (the bike saved it 3.4 s after the prompt, 1.36 uT from gear 14,
      from lever drift): the model is put at the point-15 prompt with the bike's points 1-14 and fed the
      raw samples.
  C5  v3.2 attempt 1: the phone dropped during point 4 and the board saved it blind; a calibration
      started from the phone must pause until it reconnects.

The raw R stream (50 Hz) is replayed open loop.  The 2026-10-16 runs have no survey sweeps, so 'n' at
the cadence check is followed by 'n', 'n' (empty sweeps: spot stays 'same', expected steps from the
stored calibration).  Exit code 1 if a check fails.
"""
import math
import os
import re
import statistics as st
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fw_model as fw  # noqa: E402
import hil_replay as H  # noqa: E402
import riders as R  # noqa: E402
from riders import API  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
LOGS = os.path.join(HERE, "..", "logs")
QUICK = "--quick" in sys.argv
ck = R.Checker("test_v33_replay")
V33 = API.is_v33()
print(f"Model: {API.version()}")
if not V33:
    print("  (v3.2 model: the survey isn't there; the extra 'n's are ignored)")

LOG_B = os.path.join(LOGS, "2026-10-16_v3_2b.log")
LOG_A = os.path.join(LOGS, "2026-10-16_v3_2.log")
LOG_M = os.path.join(LOGS, "2026-10-16_v3_1.log")
_L = re.compile(r"^\s*([\d.]+)\s+(.*)$")


def log_lines(path):
    """(host t, text, board ms of the last R line before it)."""
    out, last = [], None
    for raw in open(path, encoding="utf-8", errors="replace"):
        m = _L.match(raw)
        if not m:
            continue
        t, text = float(m[1]), m[2].rstrip()
        if text.startswith("R,"):
            try:
                last = int(text.split(",")[1])
            except ValueError:
                pass
            continue
        out.append((t, text, last))
    return out


def captures_in(lines, t0=0, t1=1e12):
    up, dn = {}, {}
    for t, text, ms in lines:
        if not (t0 <= t <= t1):
            continue
        m = re.match(r"C,(down,)?(\d+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)$", text)
        if m:
            (dn if m[1] else up)[int(m[2])] = ([float(m[3]), float(m[4]), float(m[5])], t, ms)
    return up, dn


LB = log_lines(LOG_B)
SC_B = H.scenario_from_log(LOG_B)                  # whole v3.2b run, survey skipped
TB = [(t, int(x.split(",")[1]), [float(v) for v in x.split(",")[3:6]]) for t, x, _ in LB if x.startswith("T,")]


def replay(sc, factory=None, on_event=None):
    return H.run_model(sc, factory=factory, on_event=on_event, end_dump=False)


# ====================================================================== C1
print("\nC1. Tolerances at this spot from the real data")
f_b = replay(SC_B)
noise_line = [l for _, l in f_b.out if l.startswith("Noise")]
z_line = [l for _, l in f_b.out if l.startswith("Z,")]
n_learn = float(noise_line[0].split()[1]) if noise_line else None
ck.info(f"v3.2b replay: {noise_line[:1]} {z_line[:1]}; settle ring {[round(x, 2) for x in getattr(f_b, 'settleRing', [])]}")
# held-point noise: consecutive bike turns (T lines) in the 3 turns before each up/down capture
up_b, dn_b = captures_in(LB, 0, 802)
cap_t = sorted([v[1] for v in up_b.values()] + [v[1] for v in dn_b.values()])
held = []
for tc in cap_t:
    w = [b for t, _, b in TB if tc - 3.2 <= t <= tc + 0.05]
    held += [fw.dist3(a, b) for a, b in zip(w, w[1:])]
n_held = st.median(held) if held else None
learnT = [b for t, _, b in TB if t < 94]
n_learnT = st.median([fw.dist3(a, b) for a, b in zip(learnT, learnT[1:])])
# 2026-10-15 'still' step through the model (lever still, pedalling)
import synth  # noqa: E402

dd, nturn = [], 0
for step in ("slow10", "easy20", "fast30"):                      # pedalling, lever left alone
    det = synth.live_fw()
    synth.feed(det, [(ms, raw) for ms, raw, _ in synth.window(step)], notify=False)
    av = [b[3] for b in det.boundaries if b[1] == 2]
    dd += [fw.dist3(a, b) for a, b in zip(av, av[1:])]
    nturn += len(av)
n_still = st.median(dd) if len(dd) > 2 else None
av = [0] * nturn
ck.info(f"noise (median |d| of consecutive turn averages): model's survey {n_learn}, bike learning turns "
        f"{n_learnT:.2f}, held points before captures {n_held:.2f} ({len(held)} pairs), 2026-10-15 lever left alone "
        f"{n_still if n_still is None else round(n_still, 2)} ({len(av)} turns)")
# settle on the bike: along-path offset of the 2 turns after each capture, against the pass direction
settles = []
pts_seq = sorted([(v[1], v[0], 'u', k) for k, v in up_b.items()] + [(v[1], v[0], 'd', k) for k, v in dn_b.items()])
for (t, b, ps, k), nxt in zip(pts_seq, pts_seq[1:]):
    prev = [x for x in pts_seq if x[0] < t and x[2] == ps]
    if not prev:
        continue
    d = [b[j] - prev[-1][1][j] for j in range(3)]
    n_ = math.sqrt(fw.dot3(d, d))
    if n_ < 0.5:
        continue
    d = [x / n_ for x in d]
    w = [bb for tt, _, bb in TB if t < tt <= t + 2.6][:2]
    if w:
        settles.append(max(0.0, -min(fw.dot3([x[j] - b[j] for j in range(3)], d) for x in w)))
settle_b = st.median(settles[-6:]) if settles else 0.0
ck.info(f"bike settle after saves: median {st.median(settles):.2f}, p90 {sorted(settles)[int(0.9 * len(settles))]:.2f}, "
        f"max {max(settles):.2f} uT over {len(settles)} saves (plan: 0.1-0.8)")
if not V33:
    ck.skip("C1: derive_tolerances() needs the v3.3 model")
else:
    rows = []
    for label, n in (("survey (learning turns)", n_learn), ("held points", n_held), ("2026-10-15 lever alone", n_still)):
        if n is None:
            continue
        g = fw.Firmware(cal=H.copy_cal(SC_B["initial_cal"]))
        API.set_noise(g, n, settle=settle_b, spot="same")
        t = g.tol
        ls = st.median([x for x in g.expStep[1:24] if x > 0])
        rows.append((label, n, t["agree"], t["drift"], g.tol_behind(ls), t["behindMin"], g.tol_move(ls)))
        ck.info(f"  noise {n:.2f} ({label}): agree {t['agree']:.2f}, drift {t['drift']:.2f}, creep {t['creep']:.2f}, "
                f"behind {t['behindMin']:.2f} (at the median step {ls:.1f}: {g.tol_behind(ls):.2f}), "
                f"move {g.tol_move(ls):.2f}, rise {g.tol_rise(ls):.2f}, settle {t['settle']:.2f}")
    lab, n, agree, drift, behind_med, behind_min, _ = rows[0]
    ck.check(1.5 <= agree <= 2.5, f"C1 survey noise {n:.2f}: agree {agree:.2f} ~ 2.0 (1.5-2.5; v3.2 tuned 2.0)")
    ck.check(0.7 <= drift <= 1.3, f"C1 survey noise {n:.2f}: drift {drift:.2f} ~ 1.0 (0.7-1.3; v3.2 tuned 1.0)")
    ck.check(behind_med >= 1.5, f"C1 survey noise {n:.2f}: behind at the median step {behind_med:.2f} >= 1.5 uT "
             f"(the bike's settles reach {max(settles):.1f}; minimum over steps {behind_min:.2f})")
    # what the bike's 12 go-backs would have needed: largest settle-back that triggered one
    ck.info(f"C1: the v3.2b go-backs came from settles up to {sorted(settles)[-2]:.2f} uT; behindMin {behind_min:.2f} "
            f"covers {sum(1 for s in settles if s < behind_min)}/{len(settles)} of the bike's settles")

# ====================================================================== C2
print("\nC2. The check on the real calibrations")
LM = log_lines(LOG_M)
up_m, _ = captures_in(LM, 1100, 1e12)
crank = dict(crankOk=1, crankSign=synth.CK["sign"], crankU=list(synth.CK["u"]), crankDepth=synth.CK["depth"],
             crankBase=synth.CK["base"])
real_m = [up_m[i][0] for i in range(1, 26)]


def flagged(pts, down=None, mask=0, noise=None):
    cal = dict(pts=[list(p) for p in pts], **crank)
    if down is not None:
        cal["down"] = [list(p) for p in down]
        cal["downMask"] = mask
    if noise is not None:
        cal["noiseUT"] = noise
    g = fw.Firmware(cal=cal)
    return sorted({(p, n) for p, n, _, _ in g.suspects}), g.suspects


for noise in (None, n_learn, n_held):
    if noise is None and noise is not n_learn and V33 is False:
        pass
    fl, sus = flagged(real_m, noise=noise)
    tag = f"noise {'default (v4/v5 file)' if noise is None else round(noise, 2)}"
    if noise is None:
        ck.check(fl == [('u', 20), ('u', 22)], f"C2 morning calibration ({tag}): flags exactly 20 and 22 -> {fl}")
    else:
        ck.info(f"C2 morning calibration ({tag}): {fl}")
    if not V33:
        break
up_f = [up_b[i][0] for i in range(1, 26)]
down_f = [[0.0, 0.0, 0.0]] * 25
mask_f = 0
for k, v in dn_b.items():
    down_f[k - 1] = v[0]
    mask_f |= 1 << (k - 1)
for noise in ((n_learn, n_held, None) if V33 else (None,)):
    fl, sus = flagged(up_f, down_f, mask_f, noise)
    pts = sorted({n for _, n in fl})
    tag = f"noise {'default' if noise is None else round(noise, 2)}"
    msg = (f"C2 v3.2b final calibration ({tag}): flags 15, <= 3 flags in all -> {len(sus)} flags "
           f"({', '.join(f'{p}{n} {w}' for p, n, w, _ in sus)})")
    if noise == n_learn or not V33:
        ck.check(15 in pts and len(sus) <= 3, msg)
    else:
        ck.info(msg)
fe = [l for t, l, _ in LB if l.startswith("F,") and 800 < t < 803]
ck.info(f"C2: the bike (v3.2) flagged {len(fe) - 1} lines: {' '.join(l.split(',')[1] + l.split(',')[2] for l in fe[:-1])}")
n_clean = 3 if QUICK else 8
tot = 0
for seed in range(1, n_clean + 1):
    r = R.run_cal(seed=200 + seed, rpm=(55, 75, 90, 65)[seed % 4], sim_kw=dict(creep_p=0.0))   # no faults
    tot += len(r.flags())
    ck.info(f"C2 clean simulated calibration seed {200 + seed}: {r.f_end()} {r.flags()}")
ck.check(tot / n_clean <= 0.2, f"C2: clean simulated calibrations flag {tot}/{n_clean} = {tot / n_clean:.2f} each (<= 0.2)")

# ====================================================================== C3
print("\nC3. Hold-still notices on the v3.2b raw data: 0 vs 1 extra settling turn")


class Extra1(fw.Firmware):
    """One more agreeing turn before the check turn (v3.1 had 3 + check; v3.2/3.3 have 2 + check)."""

    def cal_on_turn(self, avg):
        super().cal_on_turn(avg)
        if getattr(self, "pendingCap", False) and getattr(self, "agreeRun", 3) < 3:
            self.pendingCap = False


def w_stats(f):
    lines = [l for _, l in f.out]
    caps = [c for c in f.captures]
    return dict(W=sum(1 for l in lines if l.startswith("W,")), C=sum(1 for l in lines if l.startswith("C,")),
                U=sum(1 for l in lines if l.startswith("U,")), P=sum(1 for l in lines if l.startswith("P,")),
                K=sum(1 for l in lines if l.startswith("K,1")), caps=caps)


s0 = w_stats(f_b)
f_b1 = replay(SC_B, factory=Extra1)
s1 = w_stats(f_b1)
bike_w = sum(1 for _, l, _ in LB if l.startswith("W,") and l.count(",") == 3)


def acc(stats):
    """|capture - the bike's final point| for the up points the model saved (last capture of each)."""
    last = {}
    for ms, key, p in stats["caps"]:
        if isinstance(key, int):
            last[key] = p
    e = [fw.dist3(p, up_f[k]) for k, p in last.items() if k < 24]
    return (st.median(e) if e else float("nan")), len(last)


a0, n0 = acc(s0)
a1, n1 = acc(s1)
ck.info(f"C3 bike (v3.2): {bike_w} W lines")
ck.info(f"C3 model, 0 extra turns: W {s0['W']}, C {s0['C']}, U {s0['U']}, P {s0['P']}, saved {s0['K']}; "
        f"{n0} up points, median |point - bike's final| {a0:.2f} uT")
ck.info(f"C3 model, 1 extra turn:  W {s1['W']}, C {s1['C']}, U {s1['U']}, P {s1['P']}, saved {s1['K']}; "
        f"{n1} up points, median |point - bike's final| {a1:.2f} uT")
better = 1 if (s1["W"] < s0["W"] and not a1 > a0 + 0.2) else 0
ck.info(f"C3 pick: {better} extra settling turn(s) (fewer W without losing accuracy)" if better else
        "C3 pick: 0 extra settling turns (one more turn doesn't reduce W enough, or costs accuracy)")
ck.check(s0["W"] < bike_w, f"C3: v3.3 gives fewer hold-still notices than the bike's v3.2 run ({s0['W']} < {bike_w})")

# ====================================================================== C4
print("\nC4. v3.2b: gear 15 isn't saved early")
c14 = [(t, text, ms) for t, text, ms in LB if text.startswith("C,14,")]
c15 = [(t, text, ms) for t, text, ms in LB if text.startswith("C,15,")]
t14, txt14, ms14 = c14[0]                          # 235.70 s: the prompt for 15 comes with it
t15, txt15, _ = c15[0]                             # 239.52 s on the bike
p14 = [float(x) for x in txt14.split(",")[2:5]]
p15b = [float(x) for x in txt15.split(",")[2:5]]
bike_pts = {i: up_b_i for i, up_b_i in []}
pts_at = {}
for t, text, _ in LB:
    if t > t14:
        break
    m = re.match(r"C,(\d+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)$", text)
    if m:
        pts_at[int(m[1])] = [float(m[2]), float(m[3]), float(m[4])]
ck.info(f"C4 bike: C,14 at {t14:.2f} s {p14}; C,15 at {t15:.2f} s, {fw.dist3(p14, p15b):.2f} uT from 14")
state = dict(done=False)


def inject(f, ev):
    if state["done"] or ev[0] < ms14:
        return
    state["done"] = True
    for i in range(1, 15):
        f.calRaw[i - 1] = list(pts_at[i])
    f.calState = fw.CAL_WAITING
    f.calPass = fw.PASS_UP
    f.calStep = 14
    f.calRedo = False
    f.paused = False
    f.cal_prompt()
    state["noise"] = f.tol.get("noise") if V33 else None
    state["out0"] = len(f.out)


win = dict(SC_B, events=[e for e in SC_B["events"] if e[0] <= ms14 + 9000])
f4 = replay(win, on_event=inject)
after = [l for _, l in f4.out[state.get("out0", 0):]]
c15m = [l for l in after if l.startswith("C,15,")]
ck.info(f"C4 model from the point-15 prompt (noise {state.get('noise')}): {after[:8]}")
if c15m:
    p = [float(x) for x in c15m[0].split(",")[2:5]]
    d = fw.dist3(p, p14)
    ck.check(d >= 2.0, f"C4: the model's point 15 is {d:.2f} uT from point 14 (the bike's early save: "
                       f"{fw.dist3(p14, p15b):.2f}); want >= 2.0")
else:
    ck.check(True, "C4: the model doesn't save point 15 while the lever only drifts (no C,15 in the next 9 s)")
if V33:
    g = f4
    st_ = g.cal_local_step() if g.calStep == 14 and g.calPass == fw.PASS_UP else None
    ck.info(f"C4: expected step 14->15 {g.expStep[14]:.2f} uT, must move {g.tol_move(g.expStep[14]):.2f}")

# ====================================================================== C5
print("\nC5. v3.2 attempt 1: phone dropped during point 4 (392.9-401.6 s)")
LA = log_lines(LOG_A)
sc_a = H.scenario_from_log(LOG_A, 340, 441)
ev = sc_a["events"]
for t, text, ms in LA:
    if 340 <= t <= 441 and text.startswith("[BLE] App disconnected"):
        ev.append([ms, "P", 0])
    elif 340 <= t <= 441 and text.startswith("[BLE] App connected"):
        ev.append([ms, "P", 1])
ev.sort(key=lambda e: (e[0], 0 if e[1] == "S" else 1))
ms_off = [e[0] for e in ev if e[1] == "P" and e[2] == 0][0]
ms_on = [e[0] for e in ev if e[1] == "P" and e[2] == 1][0]
if not V33:
    ck.skip("C5: pause on phone disconnect needs the v3.3 model")
else:
    g = fw.Firmware(cal=H.copy_cal(SC_B["initial_cal"]))
    paused_seen = []
    for e in ev:
        ms, kind, x = e
        if kind == "S":
            g.ms_now = ms
            g.process_sample(ms, x)
            if ms_off < ms < ms_on:
                paused_seen.append(g.paused)
        elif kind == "C":
            g.command(x, "ble")                       # the calibration was started from the phone
        elif kind == "P":
            g.phone_connected(bool(x))
    caps = [(ms, k) for ms, k, _ in g.captures if ms_off < ms < ms_on]
    ck.check(bool(paused_seen) and all(paused_seen[50:]), f"C5: paused while the phone was away "
             f"({sum(paused_seen)}/{len(paused_seen)} samples)")
    ck.check(not caps, f"C5: nothing saved while the phone was away ({caps})")
    ck.info(f"C5 model lines: {[l for _, l in g.out if l.startswith(('C,', 'Paused', 'Resumed', 'Z,', 'A,'))][:12]}")

ck.finish()
