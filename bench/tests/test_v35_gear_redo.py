"""v3.5 (issue #87): redo a whole gear by taps, '#R,g,<gear>'.

Usage: py -3 bench/tests/test_v35_gear_redo.py [--quick]

Each case starts from a fresh press-mode calibration of the simulated bike, then drives the lever by hand
(no rider policy): move, wait for the turns, tap ('n').
  G1  gear 10, all four taps: pass g1 -> g2 -> g3 -> g4, C,10 and C,down,11 where the lever was, saved
      together (one E,ok,saved / K), the stored calibration has both new points, flag I while measuring,
      never flag B
  G2  a tap in the wrong place: stage 1 tapped while still in gear 10 -> N,notmoved, stays g1; in gear 9 it
      moves on. Stage 3 tapped while still in gear 10 -> N,notmoved
  G3  the ends: gear 1 starts at g3 and saves only down point 2; gear 24 does g1, g2 and saves up point 24
  G4  'x' half way: A line, the stored calibration unchanged
  G5  'u': cancels a tap being measured; between stages goes back one (U line), then the redo still finishes
  G6  auto-capture mode: a gear redo still waits for the taps
  G7  '#V' -> E,ok,v3.5; '#H,0' / '#H,1' -> E,ok,text,off / on; '#R,g,25' refused
Exit code 1 if a check fails.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fw_model as fw  # noqa: E402
import riders as R  # noqa: E402
from riders import API  # noqa: E402

QUICK = "--quick" in sys.argv
ck = R.Checker("test_v35_gear_redo")
CAL_CACHE = {}


def calibrated(seed=1):
    """A finished press-mode calibration (the Result); cached per seed, copied per use."""
    if seed not in CAL_CACHE:
        r = R.run_cal(seed=seed, press=True, seconds=1500)
        assert r.saved(), "the calibration didn't save"
        CAL_CACHE[seed] = r.f.cal
    cal = R.copy_cal(CAL_CACHE[seed])
    f = fw.Firmware(cal=cal)
    f.crank["ok"] = bool(cal.get("crankOk"))
    sim = R.Sim(f, seed=seed + 500)
    sim.run(3.0)
    return f, sim


def lines_since(f, k):
    return [l for _, l in f.out[k:]]


class Drive:
    """Move the lever, wait, tap; record the S-line state after each step."""

    def __init__(self, f, sim):
        self.f, self.sim = f, sim
        self.passes, self.flags = [], set()
        self.flagsI = 0

    def wait(self, s):
        def pol(sim):
            fl = sim.f.flags()
            self.passes.append(sim.f.pass_name())
            if "B" in fl:
                self.flags.add("B")
            if "I" in fl:
                self.flagsI += 1
            return False
        self.sim.run(s, pol)

    def go(self, L, s=4.0):
        """Move the lever there, wait until it has arrived, then s more seconds of pedalling."""
        self.sim.move_to(L)
        for _ in range(80):
            self.wait(0.5)
            if not self.sim.moving and abs(self.sim.L - L) < 0.05:
                break
        self.wait(s)

    def tap(self, s=6.0):
        API.command(self.f, "n", "usb")
        self.wait(s)

    def seq(self):
        out = []
        for p in self.passes:
            if not out or out[-1] != p:
                out.append(p)
        return out


def stage_pos(sim, g, stage):
    E, h = sim.edges, sim.h
    if stage == 1:
        return 0.5 * (E[g - 2] + E[g - 1])          # the middle of gear g-1
    if stage == 2:
        return E[g - 1] + 0.2                       # just past where gear g first shows going up
    if stage == 3:
        return 0.5 * (E[g] + E[g + 1])              # the middle of gear g+1
    return E[g] - h[g] - 0.2                        # where gear g first shows coming down


# ====================================================================== G1
print("G1. Gear 10 by four taps")
f, sim = calibrated()
old_up, old_down = list(f.cal["pts"][9]), list(f.cal["down"][10])
d = Drive(f, sim)
k0 = len(f.out)
API.line(f, "R,g,10")
for st in (1, 2, 3, 4):
    d.go(stage_pos(sim, 10, st))
    d.tap()
out = lines_since(f, k0)
ck.check("E,ok,redo" in out, "G1 '#R,g,10' -> E,ok,redo")
ck.check(d.seq()[:5] == ["g1", "g2", "g3", "g4", "-"], f"G1 pass g1 -> g2 -> g3 -> g4 -> idle ({d.seq()})")
cu = [l for l in out if l.startswith("C,10,")]
cd = [l for l in out if l.startswith("C,down,11,")]
ck.check(len(cu) == 1 and len(cd) == 1, f"G1 one C,10 and one C,down,11 ({cu}, {cd})")
ck.check(out.count("E,ok,saved") == 1 and sum(1 for l in out if l.startswith("K,1")) == 1,
         f"G1 saved once, together ({out.count('E,ok,saved')} E,ok,saved)")
want_up = R.field_at(stage_pos(sim, 10, 2))
want_dn = R.field_at(stage_pos(sim, 10, 4))
got_up, got_dn = f.cal["pts"][9], f.cal["down"][10]
eu, ed = fw.dist3(got_up, want_up), fw.dist3(got_dn, want_dn)
ck.check(eu < 1.5 and ed < 1.5, f"G1 stored points where the lever was (up {eu:.2f}, down {ed:.2f} uT off)")
ck.check(fw.dist3(got_up, old_up) > 0 and fw.dist3(got_dn, old_down) > 0, "G1 the stored calibration has the new points")
ck.check(d.flagsI > 0 and "B" not in d.flags, f"G1 flag I while measuring ({d.flagsI} ticks), never B")
ck.check(f.calState == fw.CAL_IDLE and f.gearRedo == 0, "G1 ends idle")

# ====================================================================== G1b
print("\nG1b. Across the range: gears 2, 5, 10, 15, 20, 22 on two simulated bikes")
for seed in ((1,) if QUICK else (1, 2)):
    for g in (2, 5, 10, 15, 20, 22):
        f, sim = calibrated(seed)
        d = Drive(f, sim)
        k0 = len(f.out)
        API.line(f, "R,g,%d" % g)
        for st in (1, 2, 3, 4):
            d.go(stage_pos(sim, g, st))
            d.tap()
            if f.gearStage == st and f.gearRedo:                 # refused: tap once more there
                d.tap()
        out = lines_since(f, k0)
        done = f.gearRedo == 0 and any(l.startswith("K,1") for l in out)
        eu = fw.dist3(f.cal["pts"][g - 1], R.field_at(stage_pos(sim, g, 2)))
        ed = fw.dist3(f.cal["down"][g], R.field_at(stage_pos(sim, g, 4)))
        ck.check(done and eu < 1.5 and ed < 1.5,
                 f"G1b seed {seed} gear {g}: finished and saved, up {eu:.2f} / down {ed:.2f} uT from the lever "
                 f"(refusals {out.count('N,notmoved')})")

# ====================================================================== G2
print("\nG2. A tap in the wrong place")
f, sim = calibrated()
d = Drive(f, sim)
API.line(f, "R,g,10")
d.go(stage_pos(sim, 10, 2) + 1.0)                    # still in gear 10
k = len(f.out)
d.tap()
ck.check("N,notmoved" in lines_since(f, k) and f.gearStage == 1, f"G2 stage 1 tapped in gear 10: refused, stays g1 ({f.gearStage})")
d.go(stage_pos(sim, 10, 1))
d.tap()
ck.check(f.gearStage == 2, f"G2 tapped again in gear 9: on to g2 ({f.gearStage})")
d.go(stage_pos(sim, 10, 2))
d.tap()
ck.check(f.gearStage == 3, f"G2 up point measured: on to g3 ({f.gearStage})")
k = len(f.out)
d.tap()                                              # still in gear 10
ck.check("N,notmoved" in lines_since(f, k) and f.gearStage == 3, f"G2 stage 3 tapped in gear 10: refused ({f.gearStage})")
d.go(stage_pos(sim, 10, 3))
d.tap()
d.go(stage_pos(sim, 10, 4))
d.tap()
ck.check(f.calState == fw.CAL_IDLE and f.gearRedo == 0 and f.out[-1][1].startswith(("F,end", "F,")) or
         any(l.startswith("K,1") for l in lines_since(f, k)), "G2 still finishes and saves")

# ====================================================================== G3
print("\nG3. The ends: gear 1 and gear 24")
f, sim = calibrated()
d = Drive(f, sim)
k0 = len(f.out)
API.line(f, "R,g,1")
ck.check(f.gearStage == 3 and f.pass_name() == "g3", f"G3 gear 1 starts at g3 ({f.pass_name()})")
for st in (3, 4):
    d.go(stage_pos(sim, 1, st))
    d.tap()
out = lines_since(f, k0)
ck.check(any(l.startswith("C,down,2,") for l in out) and not any(l.startswith("C,1,") for l in out) and
         any(l.startswith("K,1") for l in out), f"G3 gear 1: down point 2 only, saved")
f, sim = calibrated()
d = Drive(f, sim)
k0 = len(f.out)
API.line(f, "R,g,24")
for st in (1, 2):
    d.go(stage_pos(sim, 24, st))
    d.tap()
out = lines_since(f, k0)
ck.check(any(l.startswith("C,24,") for l in out) and not any(l.startswith("C,down,") for l in out) and
         any(l.startswith("K,1") for l in out) and d.seq()[:3] == ["g1", "g2", "-"],
         f"G3 gear 24: g1, g2, up point 24 only, saved ({d.seq()[:4]})")

# ====================================================================== G4
print("\nG4. 'x' half way")
f, sim = calibrated()
before = R.copy_cal(f.cal)
d = Drive(f, sim)
API.line(f, "R,g,10")
for st in (1, 2):
    d.go(stage_pos(sim, 10, st))
    d.tap()
k = len(f.out)
API.command(f, "x", "usb")
out = lines_since(f, k)
same = all(fw.dist3(a, b) == 0 for a, b in zip(before["pts"], f.cal["pts"])) and \
    all(fw.dist3(a, b) == 0 for a, b in zip(before["down"], f.cal["down"]))
ck.check(any(l.startswith("A,") for l in out) and same and f.gearRedo == 0 and f.calState == fw.CAL_IDLE,
         f"G4 cancelled: A line, the stored calibration unchanged ({out[:2]}, unchanged {same})")

# ====================================================================== G5
print("\nG5. 'u' in a gear redo")
f, sim = calibrated()
d = Drive(f, sim)
API.line(f, "R,g,10")
d.go(stage_pos(sim, 10, 1))
API.command(f, "n", "usb")
d.wait(0.3)
API.command(f, "u", "usb")
ck.check(not f.pressArmed and f.gearStage == 1, f"G5 'u' cancels the tap being measured (armed {f.pressArmed}, stage {f.gearStage})")
d.tap()
d.go(stage_pos(sim, 10, 2))
d.tap()
ck.check(f.gearStage == 3, f"G5 on at g3 ({f.gearStage})")
k = len(f.out)
API.command(f, "u", "usb")
ck.check(f.gearStage == 2 and "U,9" in lines_since(f, k), f"G5 'u' between stages: back to g2, U,9 ({f.gearStage}, {lines_since(f, k)[:2]})")
d.go(stage_pos(sim, 10, 2))
d.tap()
d.go(stage_pos(sim, 10, 3))
d.tap()
d.go(stage_pos(sim, 10, 4))
d.tap()
ck.check(f.gearRedo == 0 and any(l.startswith("K,1") for l in lines_since(f, k)), "G5 the redo still finishes and saves")

# ====================================================================== G6
print("\nG6. Auto-capture mode: still by taps")
f, sim = calibrated()
API.line(f, "A,auto")
d = Drive(f, sim)
API.line(f, "R,g,10")
d.go(stage_pos(sim, 10, 1), 15.0)                    # no tap: nothing happens
ck.check(f.gearStage == 1, f"G6 no tap in gear 9: stays g1 ({f.gearStage})")
d.tap()
d.go(stage_pos(sim, 10, 2), 15.0)
ck.check(f.gearStage == 2 and not any(l.startswith("C,10,") for _, l in f.out[-60:]), "G6 at the up edge without a tap: nothing saved")
d.tap()
ck.check(f.gearStage == 3, f"G6 the tap measures it ({f.gearStage})")

# ====================================================================== G7
print("\nG7. Commands")
f = fw.Firmware()
API.line(f, "V")
API.line(f, "H,0")
API.line(f, "H,1")
o = [l for _, l in f.out]
ck.check("E,ok,v3.5" in o and "E,ok,text,off" in o and "E,ok,text,on" in o, f"G7 '#V' -> v3.5, '#H' off / on ({o[-3:]})")
f, sim = calibrated()
API.line(f, "R,g,25")
ck.check(f.out[-1][1] == "E,fail,no such gear" and f.gearRedo == 0, f"G7 '#R,g,25' refused ({f.out[-1][1]})")
ck.finish()
