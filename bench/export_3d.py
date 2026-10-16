"""Export field-space points from the 2026-10-15 50 Hz recording for the 3D view.

Usage: py -3 bench/export_3d.py LOG CLICKS_JSON OUT_JSON

Writes:
  gear:  the clean lever sweep (crank parked), ~400 points, each with its
         position along the lever (0 = fully down, 1 = fully up)
  crank: 3 complete pedal turns at the fast step, each point with its phase
         in the turn (0 = the sharp dip, when the magnet passes the board)
  slow:  1 complete slow hand turn (lever down)
  turns: per-turn averages during the gear changes, with lever position
  axes:  the crank's main direction and the lever's main direction
"""
import json
import math
import re
import statistics as st
import sys

LOG, CLICKS, OUT = sys.argv[1:4]

R = re.compile(r"^\s*([\d.]+)\s+R,(\d+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)")
CLK = re.compile(r"^\s*([\d.]+)\s+### clock (\d+)")
S, clocks = [], []
for line in open(LOG, encoding="utf-8"):
    m = R.match(line)
    if m:
        S.append({"rel": float(m[1]), "ms": int(m[2]), "raw": [float(m[3]), float(m[4]), float(m[5])]})
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
clicks = json.load(open(CLICKS, encoding="utf-8"))


def pair(step):
    st_ = [c["ts"] / 1000 for c in clicks if c["step"] == step and c["action"] == "start"]
    dn = [c["ts"] / 1000 for c in clicks if c["step"] == step and c["action"] == "done"]
    t1 = dn[-1]
    return max(t for t in st_ if t < t1), t1


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def main_dir(vs):
    n = len(vs)
    m = [sum(v[k] for v in vs) / n for k in range(3)]
    C = [[sum((v[i] - m[i]) * (v[j] - m[j]) for v in vs) / n for j in range(3)] for i in range(3)]
    u = [1.0, 0.3, 0.2]
    for _ in range(60):
        w = [sum(C[i][j] * u[j] for j in range(3)) for i in range(3)]
        nw = math.sqrt(dot(w, w))
        u = [x / nw for x in w]
    return u


r1 = lambda v: [round(x, 1) for x in v]

# ---------------------------------------------------------------- gear path (lever sweep, crank parked)
t0, t1 = pair("sweep")
sweep = [s for s in S if t0 <= s["t"] <= t1]
L = main_dir([s["raw"] for s in sweep])
pos = [dot(s["raw"], L) for s in sweep]
lo, hi = min(pos), max(pos)
if pos[0] > pos[len(pos) // 2]:           # make "up" the direction away from the start
    L = [-x for x in L]
    pos = [-p for p in pos]
    lo, hi = min(pos), max(pos)
step = max(1, len(sweep) // 400)
gear = [{"p": r1(s["raw"]), "lev": round((v - lo) / (hi - lo), 3)} for s, v in list(zip(sweep, pos))[::step]]

# ---------------------------------------------------------------- crank turns: dips along the crank direction
def turns_in(t0, t1, moving=False):
    w = [s for s in S if t0 <= s["t"] <= t1]
    u = main_dir([s["raw"] for s in w])
    q = [dot(s["raw"], u) for s in w]
    med = sorted(q)[len(q) // 2]
    if med - min(q) < max(q) - med:      # the sharp dip goes negative
        u = [-x for x in u]
        q = [-x for x in q]
        med = -med
    depth = med - sorted(q)[len(q) // 100]
    # lever moving: judge each dip against a moving median (~2.4 s) instead
    base = [sorted(q[max(0, i - 60):i + 61])[len(q[max(0, i - 60):i + 61]) // 2] for i in range(len(q))]         if moving else [med] * len(q)
    if moving:
        depth = sorted(b - x for x, b in zip(q, base))[int(0.99 * len(q))]
    dips, armed, best = [], True, None
    for i, x in enumerate(q):
        d = base[i] - x
        if armed and d > 0.5 * depth:
            armed, best = False, (d, i)
        elif not armed:
            if d > best[0]:
                best = (d, i)
            if d < 0.25 * depth:
                dips.append(best[1])
                armed = True
    return w, dips, u


fw, fdips, crank_u = turns_in(*pair("fast30"))
crank = []
for k in range(3):                         # 3 complete turns from the middle of the step
    a, b = fdips[10 + k], fdips[11 + k]
    for i in range(a, b):
        crank.append({"p": r1(fw[i]["raw"]), "ph": round((i - a) / (b - a), 3), "turn": k})

sw, sdips, _ = turns_in(*pair("slow10"))
a, b = sdips[3], sdips[4]
slow_step = max(1, (b - a) // 120)
slow = [{"p": r1(sw[i]["raw"]), "ph": round((i - a) / (b - a), 3)} for i in range(a, b, slow_step)]

# ---------------------------------------------------------------- per-turn averages during the gear changes
gw, gdips, _ = turns_in(*pair("shift"), moving=True)
turns = []
for a, b in zip(gdips, gdips[1:]):
    seg = [gw[i]["raw"] for i in range(a, b)]
    avg = [sum(v[k] for v in seg) / len(seg) for k in range(3)]
    turns.append({"p": r1(avg), "lev": round((dot(avg, L) - lo) / (hi - lo), 3),
                  "rpm": round(60 / (gw[b]["t"] - gw[a]["t"]), 1)})

out = {"gear": gear, "crank": crank, "slow": slow, "turns": turns,
       "axes": {"lever": [round(x, 4) for x in L], "crank": [round(x, 4) for x in crank_u]},
       "lever_span_uT": round(hi - lo, 1)}
json.dump(out, open(OUT, "w"), separators=(",", ":"))
print(f"gear {len(gear)}, crank {len(crank)} ({len(fdips)} dips in fast step), slow {len(slow)}, "
      f"turn averages {len(turns)}, lever span {hi - lo:.1f} uT; "
      f"angle crank vs lever {math.degrees(math.acos(abs(dot(L, crank_u)))):.0f} deg")
