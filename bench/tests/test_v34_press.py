"""v3.4 (issues #5, #6, #8): press to capture, and the three fixes from the 2026-10-17 bike calibration.

Usage: py -3 bench/tests/test_v34_press.py [--quick]

  P0  commands: '#V' -> E,ok,v3.5; '#A,press' / '#A,auto' -> E,ok,capture,<mode>; flags T / A; 'a' leaves press
  P1  press mode, normal riders at 55/75/90 rpm: 24 up + 22 down, in order, accurate, no go-back, no undo, few flags
  P2  press mode: every saved point follows a press (N,press) for that point; nothing saved by itself
  P3  press mode: flag I from the press until the point is saved
  P4  press mode: pauses mid-gear (still pedalling) are never saved (the auto-mode known limit, B7)
  P5  press mode: a refused press (N,notmoved) is saved by the next press there, never two points < 0.4 uT apart
  P6  auto mode, first calibration: a rider who waits ~9 s before shifting doesn't get the old gear saved again
      (saves partway through the slow move that follows are an auto-mode limit, as in v3.3: reported, not checked)
  P7  go back at most once per point per pass (the bike: gear 5 three times)
  P8  no N,stuck in any run
Exit code 1 if a check fails.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fw_model as fw  # noqa: E402
import riders as R  # noqa: E402
from riders import API  # noqa: E402

QUICK = "--quick" in sys.argv
SEEDS = (1,) if QUICK else (1, 2, 3)
ck = R.Checker("test_v34_press")
ALL = []                                          # every run, for P8


def run(label, **kw):
    r = R.run_cal(label=label, **kw)
    ALL.append(r)
    return r


def worst(r):
    e = sorted(x["err_hold"] for x in r.errors()) or [0.0]
    return e[len(e) // 2], e[-1]


def step_len(key):
    i = key if isinstance(key, int) else key[1]
    if isinstance(key, int):
        return R.UP_EDGE[i] - R.UP_EDGE[i - 1] if i > 0 else 99.0
    return R.UP_EDGE[i + 1] - R.UP_EDGE[i] if i < 23 else 99.0


def early_save(x):
    """Saved well short of where the rider meant to stop (as test_v33_sim.py)."""
    return x["err_stop"] is not None and x["err_stop"] > max(1.5, 0.4 * step_len(x["key"]))


def complete(r, tag):
    ck.check(r.saved() and len(r.ups()) == 24 and len(r.downs()) == 22,
             f"{tag}: saved, 24 up + 22 down ({r.saved()}, {len(r.ups())}, {len(r.downs())})")


# ====================================================================== P0
print("P0. Commands")
f = fw.Firmware()
API.line(f, "V")
API.line(f, "A,press")
ck.check(("E,ok,v3.5" in [l for _, l in f.out]) and ("E,ok,capture,press" in [l for _, l in f.out]),
         "P0 '#V' -> E,ok,v3.5 and '#A,press' -> E,ok,capture,press")
fl = f.flags()
ck.check("T" in fl and "A" not in fl, f"P0 press mode: flag T, no A ({fl})")
API.line(f, "A,auto")
fl = f.flags()
ck.check("A" in fl and "T" not in fl and f.out[-1][1] == "E,ok,capture,auto", f"P0 '#A,auto': flag A, no T ({fl}, {f.out[-1][1]})")
API.line(f, "A,bogus")
ck.check(f.out[-1][1].startswith("E,fail"), f"P0 '#A,bogus' refused ({f.out[-1][1]})")
API.line(f, "A,press")
API.command(f, "a", "usb")
ck.check("A" in f.flags() and "T" not in f.flags(), f"P0 'a' in press mode goes back to auto ({f.flags()})")

# ====================================================================== P1
print("\nP1. Press mode, normal riders")
flags_total = runs = 0
for rpm in ((75,) if QUICK else (55, 75, 90)):
    for seed in SEEDS:
        r = run(f"P1 {rpm} rpm s{seed}", seed=seed, rpm=rpm, press=True, seconds=1500)
        tag = f"P1 {rpm} rpm s{seed}"
        med, wst = worst(r)
        print(f"   {tag}: presses {sum(1 for _, w in r.rider.log if w.startswith('press'))}, N,notmoved {r.count('N,notmoved')}, "
              f"W {r.count('W,')}, go-backs {r.gobacks()}, undos {r.rider.undos}, flags {r.flags()}, hold error median {med:.2f} worst {wst:.2f}")
        complete(r, tag)
        ck.check(r.in_order(), f"{tag}: both passes in lever order")
        ck.check(wst <= 1.5, f"{tag}: every point within 1.5 lever-uT of where the rider pressed (worst {wst:.2f})")
        ck.check(r.gobacks() == 0 and r.rider.undos == 0, f"{tag}: no go-back, no undo ({r.gobacks()}, {r.rider.undos})")
        flags_total += len(r.flags())
        runs += 1
ck.check(flags_total / runs <= 0.2, f"P1: flags per clean calibration {flags_total}/{runs} (<= 0.2)")

# ====================================================================== P2, P3
print("\nP2/P3. Nothing saved without a press; flag I while measuring")
for seed in SEEDS:
    rk = dict(press=True, press_s=3.0, react_s=1.5)
    status = []
    r = R.run_cal(label=f"P2 s{seed}", seed=seed + 100, press=True, rider_kw=rk, seconds=1500)
    ALL.append(r)
    out = r.f.out
    unpressed = []
    pressed = False
    for _, l in out:
        if l == "N,press":
            pressed = True
        elif l.startswith(("U,", "N,notmoved")) or l.startswith("[") and "prompt" in l:
            pressed = pressed and not l.startswith(("U,", "N,notmoved"))
        elif l.startswith(("C,")) and not l.startswith("C,25"):
            if not pressed:
                unpressed.append(l)
            pressed = False
    ck.check(not unpressed, f"P2 s{seed}: every saved point followed a press ({len(unpressed)} without: {unpressed[:3]})")
    complete(r, f"P2 s{seed}")

# P3: drive one point by hand and read the flags
f = fw.Firmware()
sim = R.Sim(f, seed=7)
rider = R.Rider(sim, press=True)
sim.run(2.0)
sim.hash_line("A,press")
API.start(f, "usb")
seen = {"armed_I": 0, "armed": 0, "idle_I": 0, "idle": 0}


def pol(s):
    fl = s.f.flags()
    if s.f.calState == fw.CAL_WAITING:
        if s.f.pressArmed:
            seen["armed"] += 1
            seen["armed_I"] += "I" in fl
        else:
            seen["idle"] += 1
            seen["idle_I"] += "I" in fl
    return rider(s)


sim.run(400, pol)
ck.check(seen["armed"] > 0 and seen["armed_I"] == seen["armed"] and seen["idle_I"] == 0,
         f"P3 flag I exactly while measuring after a press ({seen})")

# ====================================================================== P4
print("\nP4. Mid-gear pauses in press mode")
for seed in SEEDS:
    cal = R.scaled_cal_at()
    r = run(f"P4 s{seed}", seed=seed + 70, cal=cal, press=True,
            rider_kw=dict(mid_pause=1.0, mid_s=(4.0, 6.0), mid_frac=(0.2, 0.6)), seconds=1800)
    mids = r.rider.mids
    saved_mid = []
    for x in r.errors():
        k = x["key"]
        sk = (fw.PASS_UP, k) if isinstance(k, int) else ((fw.PASS_DOWN, k[1]) if k[0] == 'd' else None)
        if sk in mids and abs(x["at"] - mids[sk][0]) < 1.0 and early_save(x):
            saved_mid.append(sk)
    ck.check(not saved_mid, f"P4 s{seed}: none of {len(mids)} mid-gear pauses saved ({saved_mid[:6]})")
    complete(r, f"P4 s{seed}")

# ====================================================================== P5
print("\nP5. A refused press, then a second press there")
for seed in SEEDS:
    r = run(f"P5 s{seed}", seed=seed + 30, press=True,
            rider_kw=dict(rests={(fw.PASS_UP, 11): 60.0, (fw.PASS_DOWN, 9): 60.0}), seconds=1800)
    complete(r, f"P5 s{seed}")
    ck.check(r.rider.undos == 0, f"P5 s{seed}: no undo needed ({r.rider.undos}; N,notmoved {r.count('N,notmoved')})")
    ups, downs = r.ups(), r.downs()
    close = [i for i in range(1, len(ups)) if fw.dist3(ups[i][1], ups[i - 1][1]) < fw.STEP_REJECT_UT]
    close += [("d", i) for i in range(1, len(downs)) if fw.dist3(downs[i][1], downs[i - 1][1]) < fw.STEP_REJECT_UT]
    ck.check(not close, f"P5 s{seed}: no two neighbouring points under {fw.STEP_REJECT_UT} uT apart ({close[:4]})")

# ====================================================================== P6
print("\nP6. Auto mode, first calibration: a long wait before shifting")
for seed in SEEDS:
    r = run(f"P6 s{seed}", seed=seed + 10, rider_kw=dict(react_s=9.0), seconds=1800)
    # the bike bug: the old gear saved again as the next point (0.75 uT from it, where the step was ~17)
    ups = r.ups()
    dups = [i + 1 for i in range(1, len(ups)) if fw.dist3(ups[i][1], ups[i - 1][1]) < 1.0
            and fw.dist3(R.field_at(R.UP_EDGE[i]), R.field_at(R.UP_EDGE[i - 1])) >= 2.0]
    ck.check(not dups, f"P6 s{seed}: the previous gear never saved again as the next point ({dups})")
    ck.check(r.in_order(), f"P6 s{seed}: in order")
    early = [(x["key"], round(x["err_stop"], 1)) for x in r.errors() if early_save(x)]
    ck.info(f"P6 s{seed}: saved partway through a slow move (auto mode, as v3.3; press mode has none): {early[:4]}")

# ====================================================================== P7
print("\nP7. Go back at most once per point per pass")


def always_over(rider, sim, ps, i):
    """Overshoot up point 10 every time it is prompted (3 times at most)."""
    if ps == fw.PASS_UP and i == 9 and rider.__dict__.setdefault("p7", 0) < 3:
        rider.p7 += 1
        stop = sim.edges[10] + 3.0
        sim.stops[(ps, i)] = stop
        sim.move_to(stop)
        rider.note(f"P7 overshoot {rider.p7}")
        return True
    return False


for press in (False, True):
    r = run(f"P7 {'press' if press else 'auto'}", seed=41, press=press, rider_kw=dict(on_prompt=always_over), seconds=1800)
    backs = [l for _, l in r.f.out if l == "U,9"]
    mode = "press" if press else "auto"
    ck.check(len(backs) <= 1, f"P7 {mode}: up point 10 gone back to at most once ({len(backs)}, N,behind {r.count('N,behind')})")
    ck.check(r.saved(), f"P7 {mode}: the calibration still saves")

# ====================================================================== P9
print("\nP9. Press mode on a new spot whose gear spacing isn't the profile (as B10b)")
for label, steps in (("low gears 4 uT", [4.0, 4.0, 4.0] + R.STEPS[3:]), ("reversed", R.STEPS[::-1])):
    for seed in SEEDS[:2]:
        r = run(f"P9 {label} s{seed}", seed=130 + seed, press=True, sim_kw=dict(steps=steps), seconds=1500)
        tag = f"P9 {label} s{seed}"
        complete(r, tag)
        ck.check(r.rider.undos == 0, f"{tag}: no undo ({r.rider.undos})")
        out = r.f.out
        worst_s, which = 0.0, None
        for j, (t, l) in enumerate(out):
            if l.startswith(("[UP point", "[DOWN point")):
                t_end = next((t2 for t2, l2 in out[j + 1:] if l2.startswith(("C,", "U,", "[UP point", "[DOWN point", "A,", "K,"))), r.f.ms_now)
                if (t_end - t) / 1000.0 > worst_s:
                    worst_s, which = (t_end - t) / 1000.0, l.split("]")[0][1:]
        ck.check(worst_s <= 30.0, f"{tag}: no point over 30 s from prompt to save (longest {worst_s:.0f} s at {which})")

# ====================================================================== P8
ck.check(all(x.count("N,stuck") == 0 for x in ALL), f"P8: no N,stuck in {len(ALL)} runs")
ck.finish()
