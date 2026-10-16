"""v3.2 calibration tests: closed-loop simulated riders through fw_model.Firmware
(the host port of KeiserMagBridge_v3_2.ino), plus the check on real calibrations.

Usage: py -3 bench/tests/test_fw_v32.py

The rider reacts to the board's state like a person would: after each prompt
they move the lever (at a finite speed) until the "console" changes gear, stop
a little past that point, and keep pedalling. The console is modelled with
its own stickiness: going up it changes at up[i], coming down at up[i] - h.
The field is the real crank waveform (synth.py) on a curved lever path.

  A. full up + down calibration, 5 riders: points where the rider stopped,
     in order, turns per point, nothing flagged by the check
  B. gear display vs the console on a random lever walk: v3.2 (down pass)
     against the same calibration without its down points (v3.1 behaviour)
  C. a slow rider (2.5 s before moving): no point saved before the lever moved
  D. overshoot (up and down pass): the board goes back to that point by itself
  E. the check on the real 2026-10-16 calibration (gears 20 and 22 known bad)
     and on the hand-corrected version
  F. #G (use the guess), #P/#W (load points), #R (redo one point by pedalling)
  G. 's' mid-down-pass, undo at the first down point, v4 calibration loads
Exit code 1 if a hard check fails.
"""
import math
import os
import random
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fw_model as fw  # noqa: E402
import synth  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
fails = []


def check(cond, msg):
    print(("  PASS " if cond else "  FAIL ") + msg)
    if not cond:
        fails.append(msg)


print(synth.TEMPLATE_INFO)
LEV, BASE = synth.LEV, synth.BASE
# a second direction, square to the lever, to bend the path
_c = [LEV[1] * synth.CK["u"][2] - LEV[2] * synth.CK["u"][1],
      LEV[2] * synth.CK["u"][0] - LEV[0] * synth.CK["u"][2],
      LEV[0] * synth.CK["u"][1] - LEV[1] * synth.CK["u"][0]]
_n = math.sqrt(fw.dot3(_c, _c))
PERP = [x / _n for x in _c]


def field_at(L):
    """Lever position L (uT along the path) -> field, on a gently curved path."""
    bend = 0.002 * L * L
    return [BASE[j] + L * LEV[j] + bend * PERP[j] for j in range(3)]


def along(b):
    return fw.dot3([b[j] - BASE[j] for j in range(3)], LEV)


# Gear edges along the lever (uT from the bottom), spaced like the real bike's
# steps (2026-10-16, gears 20/22/23 corrected): edge i is where gear i+1 starts.
STEPS = [17.8, 15.7, 13.0, 2.35, 4.7, 2.8, 3.05, 5.5, 5.65, 4.3, 6.3, 3.7, 2.55, 7.0, 3.2, 3.8, 5.2, 3.9,
         1.8, 1.8, 3.8, 3.8, 6.0]
UP_EDGE = [0.0]
for s_ in STEPS:
    UP_EDGE.append(UP_EDGE[-1] + s_)                      # 24 values: points 1..24
TOP_L = UP_EDGE[-1] + 4.0


class Console:
    """The Keiser console's gear, with its own stickiness h (uT) at each edge."""

    def __init__(self, h):
        self.h, self.g = h, 1

    def update(self, L):
        while self.g < 24 and L >= UP_EDGE[self.g]:
            self.g += 1
        while self.g > 1 and L < UP_EDGE[self.g - 1] - self.h[self.g - 1]:
            self.g -= 1
        return self.g


class Sim:
    """Closed loop: samples at the board's clock, a rider policy, the console."""

    def __init__(self, f, rpm=70, noise=0.3, seed=1, speed=4.0, h=None, react_s=0.6):
        self.f, self.rpm, self.noise = f, rpm, noise
        self.rnd = random.Random(seed)
        self.speed = speed                                   # uT/s lever speed
        self.h = h or [0.0] + [0.4 + 0.4 * self.rnd.random() for _ in range(23)] + [0.0]
        self.console = Console(self.h)
        self.L = 0.0
        self.target = 0.0
        self.k, self.phase = 0, self.rnd.random()
        self.react_s = react_s
        self.stops = {}                                      # (pass, point index) -> where the rider stopped

    def step(self):
        t_ms = fw.tick_millis(self.k)
        if self.k:
            dt = (t_ms - fw.tick_millis(self.k - 1)) / 1000.0
            self.phase += self.rpm / 60.0 * dt
            d = self.target - self.L
            mv = self.speed * dt
            self.L = self.target if abs(d) <= mv else self.L + math.copysign(mv, d)
        self.console.update(self.L)
        c = synth.crank_at(self.phase)
        base = field_at(self.L)
        raw = [base[j] + c[j] + self.rnd.gauss(0, self.noise) for j in range(3)]
        self.f.ms_now = t_ms
        self.f.process_sample(t_ms, raw)
        self.k += 1
        return t_ms

    def run(self, seconds, policy=None):
        end = fw.tick_millis(self.k) + seconds * 1000
        while fw.tick_millis(self.k) < end:
            self.step()
            if policy and policy(self):
                return True
        return False


class Rider:
    """Follows the prompts: 'first shows gear N' -> stop just past that point."""

    def __init__(self, sim, overshoot=(0.1, 0.4), slow=0.0):
        self.sim, self.over, self.slow = sim, overshoot, slow
        self.key = None
        self.since = 0
        self.confirmed = False

    def __call__(self, sim):
        f = sim.f
        now = fw.tick_millis(sim.k)
        if f.calState == fw.CAL_CONFIRM:
            if not self.confirmed:
                self.confirmed = True
                self.confirm_at = now + 1000
            elif now >= self.confirm_at:
                f.command('n')
            return False
        if f.calState == fw.CAL_IDLE:
            return True
        key = (f.calPass, f.calStep, f.calState)
        if key != self.key:
            self.key, self.since = key, now
            self.planned = False
        if self.planned or now - self.since < (self.slow or sim.react_s) * 1000:
            return False
        self.planned = True
        o = sim.rnd.uniform(*self.over)
        i = f.calStep
        if f.calPass == fw.PASS_UP:
            stop = 0.0 if i == 0 else UP_EDGE[i] + o
        else:                                                  # coming down to where gear i first shows
            stop = UP_EDGE[i] - sim.h[i] - o
        sim.target = stop
        sim.stops[(f.calPass, i)] = stop
        return False


def new_cal_fw():
    f = fw.Firmware()
    f.command('c')
    return f


def calibrate(seed, rpm=70, **kw):
    f = new_cal_fw()
    sim = Sim(f, rpm=rpm, seed=seed)
    rider = Rider(sim, **kw)
    sim.run(400, rider)
    return f, sim


# ------------------------------------------------------------------ A. full calibration
print("\nA. Full up + down calibration by simulated riders (70 rpm unless shown)")
turns_per_point = []
for seed, rpm in ((1, 70), (2, 55), (3, 85), (4, 45), (5, 100)):
    f, sim = calibrate(seed, rpm)
    Ks = [l for _, l in f.out if l.startswith(("K,", "A,"))]
    Fend = [l for _, l in f.out if l.startswith("F,end")]
    Fs = [l for _, l in f.out if l.startswith("F,") and not l.startswith("F,end")]
    ups = [c for c in f.captures if isinstance(c[1], int)]
    downs = [c for c in f.captures if isinstance(c[1], tuple) and c[1][0] == 'd']
    err_up = [abs(along(p) - sim.stops[(fw.PASS_UP, i)]) for _, i, p in ups if (fw.PASS_UP, i) in sim.stops]
    err_dn = [abs(along(p) - sim.stops[(fw.PASS_DOWN, i[1])]) for _, i, p in downs]
    pos_up = [along(p) for _, _, p in ups]
    pos_dn = [along(p) for _, _, p in downs]
    ws = sum(1 for _, l in f.out if l.startswith("W,"))
    # turns from "lever arrived" to capture
    print(f"   seed {seed} {rpm} rpm: {Ks[-1] if Ks else 'no K'}; {Fend[-1] if Fend else ''} {' '.join(Fs)}; "
          f"{len(ups)} up + {len(downs)} down points; worst |error| up {max(err_up):.2f} down "
          f"{max(err_dn) if err_dn else 0:.2f} uT; W {ws}")
    check(Ks and Ks[-1].startswith("K,1"), f"seed {seed}: calibration saved")
    check(len(ups) == 24 and len(downs) == 22, f"seed {seed}: 24 up + 22 down points")
    check(all(b > a for a, b in zip(pos_up, pos_up[1:])) and all(b < a for a, b in zip(pos_dn, pos_dn[1:])),
          f"seed {seed}: both passes in lever order")
    check(max(err_up) < 0.6 and max(err_dn) < 0.6, f"seed {seed}: every point within 0.6 uT of where the rider stopped")
    check(Fend and Fend[-1] == "F,end,0", f"seed {seed}: the check flags nothing on a clean calibration")
    # time per point: from the lever arriving to the capture
    caps = [(c[0], c[1]) for c in f.captures]
for seed in (11, 12, 13):
    f = new_cal_fw()
    sim = Sim(f, seed=seed, speed=50.0)                     # near-instant lever: measure turns after arrival
    sim.run(400, Rider(sim))
    t = [c[0] for c in f.captures]
    per = 60000.0 / sim.rpm
    gaps = [(b - a) / per for a, b in zip(t, t[1:])]
    turns_per_point += gaps
print(f"   turns from one capture to the next with an instant lever (0.6 s reaction + the turn the lever "
      f"moved in + 3): median {sorted(turns_per_point)[len(turns_per_point) // 2]:.1f}, "
      f"worst {max(turns_per_point):.1f}")
check(sorted(turns_per_point)[len(turns_per_point) // 2] <= 4.6,
      "about 3 turns per point once the lever stops (v3.1: 4, so about 5.6 here)")

# ------------------------------------------------------------------ B. gear display vs the console
print("\nB. Gear display vs the console on a random lever walk (after calibration)")
f, sim = calibrate(21)
cal_full = {k: (list(map(list, v)) if isinstance(v, list) and v and isinstance(v[0], list) else v)
            for k, v in f.cal.items()}
results = {}
for label, use_down in (("v3.2 (up + down)", True), ("up points only", False)):
    cal = dict(cal_full)
    if not use_down:
        cal["downMask"] = 0
    g = fw.Firmware(cal=cal)
    g.crank["ok"] = True
    s2 = Sim(g, seed=99, h=sim.h, speed=8.0)                 # brisk shifting, then a 3 s hold
    s2.console.g = 1
    rnd = random.Random(5)
    tally = {"mid": [0, 0], "edge": [0, 0]}
    for _ in range(200):                                     # 200 lever moves, each held 3 s
        if rnd.random() < 0.5:                               # somewhere inside a gear, clear of its edges
            g_ = rnd.randrange(1, 24)
            lo, hi = UP_EDGE[g_ - 1] + 0.8, UP_EDGE[g_] - 0.8 - s2.h[g_]
            if hi <= lo:
                continue
            tgt, kind = rnd.uniform(lo, hi), "mid"
        else:                                                # right next to an edge (where it's hard)
            tgt, kind = UP_EDGE[rnd.randrange(1, 24)] + rnd.uniform(-1.2, 1.2), "edge"
        s2.target = tgt
        s2.run(abs(tgt - s2.L) / s2.speed + 3.0)
        tally[kind][0] += g.stableGear == s2.console.g
        tally[kind][1] += 1
    results[label] = {k: a / n for k, (a, n) in tally.items()}
    print(f"   {label:24s}: shows the console's gear after {100 * results[label]['mid']:.0f} % of holds inside "
          f"a gear, {100 * results[label]['edge']:.0f} % of holds within 1.2 uT of an edge")
check(results["v3.2 (up + down)"]["mid"] >= 0.97, "v3.2: right gear for holds inside a gear (>= 97 %)")
check(results["v3.2 (up + down)"]["edge"] >= results["up points only"]["edge"] - 0.03,
      "the down pass doesn't make the gear display worse near the edges")

# ------------------------------------------------------------------ C. slow rider
print("\nC. A slow rider: 2.5 s before each lever move")
f = new_cal_fw()
sim = Sim(f, seed=31)
sim.run(500, Rider(sim, slow=2.5))
ups = [c for c in f.captures if isinstance(c[1], int)]
early = [i for _, i, p in ups if i > 0 and abs(along(p) - sim.stops.get((fw.PASS_UP, i), -99)) > 0.6]
print(f"   {len(ups)} up points; saved before the lever got there: {early or 'none'}")
check(not early, "no point saved before the rider moved the lever")

# ------------------------------------------------------------------ D. overshoot: the board redoes it by itself
print("\nD. Overshoot, then the board goes back to that point by itself (no undo from the rider)")


class Overshooter(Rider):
    """Overshoots one point past the next gear's edge, then follows the board's
    instructions: drop into the gear before (or above) it, then come back."""

    def __init__(self, sim, ps, step, **kw):
        super().__init__(sim, **kw)
        self.ps, self.step_, self.did, self.went_back = ps, step, False, False

    def __call__(self, sim):
        f = sim.f
        r = super().__call__(sim)
        if not self.did and f.calPass == self.ps and f.calStep == self.step_ and sim.stops.get((self.ps, self.step_)):
            self.did = True
            i = self.step_
            if self.ps == fw.PASS_UP:
                sim.target = UP_EDGE[i + 1] + 1.5               # past the next gear's edge
            else:
                sim.target = UP_EDGE[i - 1] - sim.h[i - 1] - 1.5
            sim.stops[(self.ps, i)] = sim.target
        if getattr(f, "backGate", False):
            i = f.calStep
            if f.calPass == fw.PASS_UP:                        # "shift DOWN into gear i"
                sim.target = 0.5 * (UP_EDGE[i - 1] + UP_EDGE[i])
            else:                                              # "shift UP into gear i+1"
                sim.target = 0.5 * (UP_EDGE[i] + UP_EDGE[i + 1])
            self.went_back = True
        elif self.went_back:
            self.went_back = False
            i = f.calStep
            sim.target = UP_EDGE[i] + 0.25 if f.calPass == fw.PASS_UP else UP_EDGE[i] - sim.h[i] - 0.25
            sim.stops[(f.calPass, i)] = sim.target
        return r


for ps, step, name in ((fw.PASS_UP, 9, "up point 10"), (fw.PASS_DOWN, 12, "down point 13")):
    f = new_cal_fw()
    sim = Sim(f, seed=41)
    sim.run(500, Overshooter(sim, ps, step))
    behind = [l for _, l in f.out if l == "N,behind"]
    us = [l for _, l in f.out if l.startswith("U,")]
    last = {}
    for _, i, p in f.captures:
        last[i] = p                                            # last capture of each point
    ups = [along(last[i]) for i in range(24) if i in last]
    dns = [along(last[('d', i)]) for i in range(fw.DOWN_FIRST, 0, -1) if ('d', i) in last]
    key = step if ps == fw.PASS_UP else ('d', step)
    want = UP_EDGE[step] if ps == fw.PASS_UP else UP_EDGE[step] - sim.h[step]
    got = along(last[key])
    in_order = all(b > a for a, b in zip(ups, ups[1:])) and all(b < a for a, b in zip(dns, dns[1:]))
    print(f"   {name}: N,behind x{len(behind)}, {' '.join(us)}; redone at {got:.1f} (console edge {want:.1f}); "
          f"{len(ups)} up + {len(dns)} down points, in order: {in_order}; "
          f"{'saved' if any(l.startswith('K,1') for _, l in f.out) else 'NOT saved'}")
    check(len(behind) == 1 and len(us) == 1, f"{name}: the board went back once by itself")
    check(abs(got - want) < 0.8 and in_order and len(ups) == 24 and len(dns) == 22,
          f"{name}: redone where the console first shows the gear; every point in order; calibration complete")

behind_clean = 0
for seed in (1, 2, 3):
    f, _ = calibrate(seed)
    behind_clean += sum(1 for _, l in f.out if l == "N,behind")
check(behind_clean == 0, "no going back on clean calibrations (3 riders)")

# ------------------------------------------------------------------ E. the check on real calibrations
print("\nE. The check on the real 2026-10-16 calibration")
LOG = os.path.join(HERE, "..", "logs", "2026-10-16_v3_1.log")
Cs = {}
for line in open(LOG, encoding="utf-8"):
    m = re.match(r"^\s*([\d.]+)\s+C,(\d+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)", line)
    if m and float(m[1]) > 1100:
        Cs[int(m[2])] = [float(m[3]), float(m[4]), float(m[5])]
real = [Cs[i] for i in range(1, 26)]
crank_cal = dict(crankOk=1, crankSign=synth.CK["sign"], crankU=synth.CK["u"], crankDepth=synth.CK["depth"],
                 crankBase=synth.CK["base"])
g = fw.Firmware(cal=dict(pts=[list(p) for p in real], **crank_cal))
sus = g.cal_check(False)
print("   flagged: " + "; ".join(f"{p}{n} {w} -> guess ({x[0]:.1f}, {x[1]:.1f}, {x[2]:.1f})" for p, n, w, x in sus))
check({(p, n) for p, n, _, _ in sus} == {('u', 20), ('u', 22)},
      "flags exactly gear 20 (taken early) and gear 22 (overshot)")
fixed = [list(p) for p in real]
fixed[19] = [25.4, 34.3, -103.5]
fixed[21] = [30.7, 35.9, -103.5]
fixed[22] = [34.3, 37.1, -103.6]
g2 = fw.Firmware(cal=dict(pts=fixed, **crank_cal))
check(not g2.cal_check(False), "the hand-corrected calibration passes the check")

# ------------------------------------------------------------------ F. edit commands
print("\nF. Edit commands")
g.line("G,u,20")
lines = [l for _, l in g.out]
check("E,ok,saved" in lines and any(l.startswith("K,1") for l in lines), "#G,u,20: saved (E,ok + K)")
check(('u', 20) not in {(p, n) for p, n, _, _ in g.suspects}, "#G,u,20: gear 20 no longer flagged")
check(g.cal["pts"][24] == real[24], "#G on gear 20 keeps the measured top (points 23/24 untouched)")
g.out.clear()
g.line("G,u,7")
check(g.out[-1][1].startswith("E,fail"), "#G for a point not in the check is refused")
h = fw.Firmware(cal=dict(pts=[list(p) for p in real], **crank_cal))
for i, p in ((20, fixed[19]), (22, fixed[21]), (23, fixed[22])):
    h.line("P,u,%d,%.1f,%.1f,%.1f" % (i, p[0], p[1], p[2]))
check(h.cal["pts"][19] == real[19], "#P only stages: nothing changes before #W")
h.line("W")
check(h.cal["pts"][19] == fixed[19] and h.cal["pts"][21] == fixed[21] and not h.suspects,
      "#W: the three corrected points are stored and the check is clean")
check(abs(h.cal["pts"][24][0] - (fixed[23][0] + fw.TOP_FRACTION * (fixed[23][0] - fixed[22][0]))) < 0.05,
      "#W: point 23 changed, so the top is worked out again from points 23 and 24")
bad = [list(p) for p in fixed]
bad[5] = list(bad[4])
k = fw.Firmware(cal=dict(pts=[list(p) for p in fixed], **crank_cal))
k.line("P,u,6,%.1f,%.1f,%.1f" % tuple(bad[5]))
k.line("W")
check(k.out[-1][1].startswith("E,fail") and k.cal["pts"][5] == fixed[5], "#W refuses a broken calibration, keeps the old one")

# #R: redo up point 12 by pedalling, on a simulated bike calibrated by seed 1
f, sim = calibrate(51)
true_edge = UP_EDGE[11]
sim.target = true_edge + 0.2                                   # ride up to the point first (not a redo yet)
sim.run(25)
f.out.clear()
f.line("R,u,12")
check(f.calPass == fw.PASS_FIX_UP and f.calState == fw.CAL_WAITING, "#R,u,12: redo started")
sim.run(6)                                                     # rider stays at the point: must not be taken
check(f.calState == fw.CAL_WAITING and not f.fixArmed, "redo: nothing taken before the lever has been below the point")
sim.target = UP_EDGE[10] + 0.3 * (UP_EDGE[11] - UP_EDGE[10])  # below: lower half of gear 11
sim.run(4)
check(f.fixArmed, "redo: armed once the lever went below")
sim.target = true_edge + 0.25
sim.run(8)
check(f.calState == fw.CAL_IDLE and abs(along(f.cal["pts"][11]) - (true_edge + 0.25)) < 0.6,
      "redo: point 12 re-measured where the rider stopped and saved")
check(any(l == "E,ok,saved" for _, l in f.out), "redo: E,ok + K + F after saving")

# ------------------------------------------------------------------ G. odds and ends
print("\nG. Skip, undo at the first down point, v4 calibration")
f = new_cal_fw()
sim = Sim(f, seed=61)
rider = Rider(sim)


def stop_mid_down(s):
    rider(s)
    if s.f.calPass == fw.PASS_DOWN and s.f.calStep == 15:
        s.f.command('s')
        return True
    return s.f.calState == fw.CAL_IDLE


sim.run(400, stop_mid_down)
check(f.calValid and bin(f.cal["downMask"]).count("1") == 7, "'s' at down point 16 saves 7 down points")
f = new_cal_fw()
sim = Sim(f, seed=62)
rider = Rider(sim)


def undo_first_down(s):
    rider(s)
    if s.f.calPass == fw.PASS_DOWN and s.f.calStep == fw.DOWN_FIRST:
        s.f.command('u')
        return True
    return False


sim.run(400, undo_first_down)
check(f.calPass == fw.PASS_UP and f.calStep == 23, "'u' at the first down point goes back to up point 24")
v4 = fw.Firmware(cal=dict(pts=[list(p) for p in fixed], **crank_cal))
check(v4.cal["downMask"] == 0 and max(fw.dist3(a, b) for a, b in zip(v4.pathPts, v4.cal["pts"])) < 1e-6,
      "a v4 calibration (no down points) uses its up points as the path")

# ------------------------------------------------------------------ H. the stronger check + the previous calibration
print("\nH. The check: pairs, off-path points, the previous calibration")
f, sim = calibrate(71)
base = {k: (list(map(list, v)) if isinstance(v, list) and v and isinstance(v[0], list) else v)
        for k, v in f.cal.items()}


def checked(pts=None, down=None, mask=None, prev=None):
    cal = dict(base)
    cal["pts"] = [list(p) for p in (pts or base["pts"])]
    cal["down"] = [list(p) for p in (down or base["down"])]
    cal["downMask"] = base["downMask"] if mask is None else mask
    g = fw.Firmware(cal=cal)
    if prev is not None:
        g.prev = [list(p) for p in prev]
        g.cal_check(False)
    return {(p, n): w for p, n, w, _ in g.suspects}, g


def moved(p, i, du):
    """p with point i moved du uT along the lever (+ = up)."""
    q = [list(x) for x in p]
    q[i] = [q[i][k] + du * LEV[k] for k in range(3)]
    return q


flags, _ = checked()
check(not flags, "clean up+down calibration: nothing flagged")
# a down point taken while the lever was still coming down (3 uT too high)
flags, g = checked(down=moved(base["down"], 14, +3.0))
print(f"   down point 15 taken 3 uT early: {flags} (about 2 uT along the path is the limit)")
check(('d', 15) in flags and len(flags) <= 2, "a down point taken early is flagged (and not its good neighbours)")
# an up point knocked sideways (off the path), spacing unchanged
side = [list(x) for x in base["pts"]]
side[9] = [side[9][k] + 2.5 * PERP[k] for k in range(3)]
flags, _ = checked(pts=side)
print(f"   up point 10 knocked 2.5 uT sideways: {flags}")
check(('u', 10) in flags, "an up point off the path is flagged even though its spacing is fine")
# up only, a mildly early point: invisible without the previous calibration...
up_only_bad = moved(base["pts"], 11, -2.5)
flags_np, _ = checked(pts=up_only_bad, mask=0)
shift = [0.4, -0.3, 0.2]
prev = [[p[k] + shift[k] for k in range(3)] for p in base["pts"]]
flags_p, g = checked(pts=up_only_bad, mask=0, prev=prev)
guess = [x[3] for x in g.suspects if x[0] == 'u' and x[1] == 12]
print(f"   up only, point 12 taken 2.5 uT early: without the previous calibration {flags_np or 'nothing'}; "
      f"with it {flags_p}; guess off by {fw.dist3(guess[0], base['pts'][11]):.2f} uT" if guess else "")
check(flags_p.get(('u', 12)) == "prior", "...the previous calibration (shifted 0.5 uT overall) catches it")
check(guess and fw.dist3(guess[0], base["pts"][11]) < 0.6, "...and its guess is within 0.6 uT of the true point")
flags_c, _ = checked(mask=0, prev=prev)
check(not flags_c, "a clean up-only calibration vs a shifted previous one: nothing flagged")
# the board was moved: the previous calibration is ignored, not used to flag everything
far = [[p[0] * 0.8 + 5.0, p[1] + 0.05 * p[0], p[2] - 6.0] for p in base["pts"]]
flags_m, _ = checked(mask=0, prev=far)
check(not any(w == "prior" for w in flags_m.values()), "board moved since the last calibration: no 'prior' flags")
# a new calibration keeps the old one as its prior
f2 = fw.Firmware(cal=dict(base))
f2.crank = dict(f.crank)
old_pts = [list(p) for p in f2.cal["pts"]]
f2.cal_commit(moved(base["pts"], 5, 0.3), base["down"], base["downMask"], True)
check(f2.prev == old_pts, "saving a new calibration keeps the one it replaces for the next check")

print("\nRESULT:", "all checks passed" if not fails else f"{len(fails)} check(s) failed: " + "; ".join(fails))
sys.exit(1 if fails else 0)
