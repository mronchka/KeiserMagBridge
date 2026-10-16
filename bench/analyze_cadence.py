"""Cadence-from-the-crank-magnet test: line up Bike Test Panel clicks with the
board's 50 Hz raw stream, count crank turns from the field, and test
per-turn averaging.

Usage: py -3 bench/analyze_cadence.py LOGFILE EVENTS_DIR

Turn counting: each crank turn moves the field once around a closed loop.
Within a window, the field is centred (on the window mean, or a ~1-turn
moving mean when the lever may move), projected onto the loop's plane (top
two principal directions) and the angle around the centre is unwrapped;
total angle / 360 = turns. Each crossing of a whole turn is one revolution
boundary, which gives per-turn cadence and per-turn averages.
"""
import glob
import json
import math
import re
import statistics as st
import sys

LOG, EVDIR = sys.argv[1], sys.argv[2]

# ---------------------------------------------------------------- load
R = re.compile(r"^\s*([\d.]+)\s+R,(\d+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)")
CLK = re.compile(r"^\s*([\d.]+)\s+### clock (\d+)")
samples, clocks = [], []
for line in open(LOG, encoding="utf-8"):
    m = R.match(line)
    if m:
        v = [float(x) for x in m.groups()]
        samples.append({"rel": v[0], "ms": v[1], "raw": v[2:5], "ema": v[5:8]})
        continue
    m = CLK.match(line)
    if m:
        clocks.append((float(m[1]), int(m[2])))

events = []
for f in glob.glob(EVDIR + "/*.json"):
    d = json.load(open(f, encoding="utf-8"))
    events.append(d.get("data", d))
events.sort(key=lambda e: e["ts"])


def linfit(xs, ys):
    mx, my = st.mean(xs), st.mean(ys)
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sum((x - mx) ** 2 for x in xs)
    return my - b * mx, b


# log-relative seconds -> epoch ms (from the logger's clock lines)
a1, b1 = linfit([c[0] for c in clocks], [c[1] for c in clocks])
# board ms -> epoch ms (the log's read times jitter; the fit averages it out)
a2, b2 = linfit([s["ms"] for s in samples], [a1 + b1 * s["rel"] for s in samples])
resid = [a1 + b1 * s["rel"] - (a2 + b2 * s["ms"]) for s in samples]
for s in samples:
    s["t"] = (a2 + b2 * s["ms"]) / 1000.0          # epoch seconds, board-timed
print(f"Clock alignment: board clock vs PC clock rate {b2:.6f}; log read jitter "
      f"median {st.median(abs(r) for r in resid):.0f} ms, so click times map to samples to ~0.1 s.")
gaps = [samples[i + 1]["ms"] - samples[i]["ms"] for i in range(len(samples) - 1)]
print(f"Samples: {len(samples)}, spacing median {st.median(gaps):.0f} ms, longest gap {max(gaps):.0f} ms\n")


def window(t0, t1):
    return [s for s in samples if t0 <= s["t"] <= t1]


def mean3(vs):
    return [sum(v[k] for v in vs) / len(vs) for k in range(3)]


def sub(a, b):
    return [x - y for x, y in zip(a, b)]


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def norm(a):
    return math.sqrt(dot(a, a))


def pca(vectors):
    """Eigenvectors of the 3x3 covariance, largest first (Jacobi)."""
    m = mean3(vectors)
    X = [sub(v, m) for v in vectors]
    A = [[sum(x[i] * x[j] for x in X) / len(X) for j in range(3)] for i in range(3)]
    V = [[1.0 if i == j else 0.0 for j in range(3)] for i in range(3)]
    for _ in range(80):
        p, q = max(((i, j) for i in range(3) for j in range(i + 1, 3)), key=lambda ij: abs(A[ij[0]][ij[1]]))
        if abs(A[p][q]) < 1e-12:
            break
        th = 0.5 * math.atan2(2 * A[p][q], A[q][q] - A[p][p])
        c, s = math.cos(th), math.sin(th)
        for k in range(3):
            akp, akq = A[k][p], A[k][q]
            A[k][p], A[k][q] = c * akp - s * akq, s * akp + c * akq
        for k in range(3):
            apk, aqk = A[p][k], A[q][k]
            A[p][k], A[q][k] = c * apk - s * aqk, s * apk + c * aqk
        for k in range(3):
            vkp, vkq = V[k][p], V[k][q]
            V[k][p], V[k][q] = c * vkp - s * vkq, s * vkp + c * vkq
    ev = sorted(((A[i][i], [V[k][i] for k in range(3)]) for i in range(3)), key=lambda e: -e[0])
    return ev


def moving_mean(vs, half):
    out, n = [], len(vs)
    pre = [[0.0, 0.0, 0.0]]
    for v in vs:
        pre.append([pre[-1][k] + v[k] for k in range(3)])
    for i in range(n):
        a, b = max(0, i - half), min(n, i + half + 1)
        out.append([(pre[b][k] - pre[a][k]) / (b - a) for k in range(3)])
    return out


def moving_median_1d(xs, half):
    out = []
    for i in range(len(xs)):
        seg = sorted(xs[max(0, i - half):i + half + 1])
        out.append(seg[len(seg) // 2])
    return out


def turns(win, plane=None, center_half=None):
    """Count crank turns as sharp dips along the crank's main direction.

    Each turn the magnet passes closest to the board once, giving a sharp dip
    (~-55 uT here). A dip is counted when the signal falls more than DIP uT
    below its baseline, and re-armed once it climbs back above half of that.
    Baseline: the window median (lever fixed) or a moving median (lever may move).
    Returns (turn count, dip times, plane, 1).
    """
    raws = [s["raw"] for s in win]
    if plane is None:
        ev = pca(raws)
        plane = (ev[0][1], ev[1][1], [math.sqrt(max(e[0], 0)) for e in ev])
    u = plane[0]
    sig = [dot(r, u) for r in raws]
    # orient so the sharp dip is negative: the dip is the larger excursion below the median
    med = sorted(sig)[len(sig) // 2]
    if (med - min(sig)) < (max(sig) - med):
        sig = [-x for x in sig]
    base = moving_median_1d(sig, center_half) if center_half else [sorted(sig)[len(sig) // 2]] * len(sig)
    rng = sorted(b - x for x, b in zip(sig, base))
    DIP = 0.5 * rng[int(0.995 * len(rng))]          # half the deepest dips
    armed, cross, best = True, [], None
    for s, x, b in zip(win, sig, base):
        d = b - x
        if armed and d > DIP:
            armed, best = False, (d, s["t"])
        elif not armed:
            if d > best[0]:
                best = (d, s["t"])
            if d < DIP / 2:
                cross.append(best[1])
                armed = True
    if not armed:
        cross.append(best[1])
    return float(len(cross)), cross, plane, 1


def ev_time(step, action, nth=0):
    hits = [e for e in events if e["step"] == step and e["action"] == action]
    return hits[nth]["ts"] / 1000.0 if len(hits) > nth else None


def last_pair(step):
    starts = [e for e in events if e["step"] == step and e["action"] == "start"]
    dones = [e for e in events if e["step"] == step and e["action"] == "done"]
    if not starts or not dones:
        return None
    t1 = dones[-1]["ts"] / 1000.0
    t0 = max(e["ts"] for e in starts if e["ts"] / 1000.0 < t1) / 1000.0
    return t0, t1, dones[-1]


# ---------------------------------------------------------------- 1. still
t0, t1, _ = last_pair("still")
w = window(t0, t1)
sd = [st.pstdev(s["raw"][k] for s in w) for k in range(3)]
print(f"1. Hands off ({t1 - t0:.1f} s): raw noise per axis {sd[0]:.2f}/{sd[1]:.2f}/{sd[2]:.2f} uT; "
      f"field ({', '.join(f'{x:.1f}' for x in mean3([s['raw'] for s in w]))}) uT")

# ---------------------------------------------------------------- 2. slow turns (defines the loop plane)
t0, t1, d = last_pair("slow10")
w = window(t0, t1)
n_slow, cross_slow, plane, sign = turns(w)
print(f"2. Slow turns by hand: you counted {d.get('counted')}; dips detected = {n_slow:.0f}")
swing = [dot(sub(s["raw"], mean3([q["raw"] for q in w])), plane[0]) for s in w]
print(f"   crank swing along its main direction: {max(swing) - min(swing):.1f} uT peak to peak")

# ---------------------------------------------------------------- 3/4. pedalling counts
for key, label in (("easy20", "Pedal easy"), ("fast30", "Pedal fast")):
    p = last_pair(key)
    if not p:
        continue
    t0, t1, d = p
    w = window(t0, t1)
    n, cross, _, _ = turns(w, plane=plane)
    n_own, cross_own, pl_own, _ = turns(w)
    per = [b - a for a, b in zip(cross_own, cross_own[1:])]
    rpm = [60 / x for x in per if x > 0]
    avg_rpm = 60 * (len(cross_own) - 1) / (cross_own[-1] - cross_own[0]) if len(cross_own) > 1 else float('nan')
    print(f"{'3' if key == 'easy20' else '4'}. {label}: you counted {d.get('counted')}, console ~{d.get('consoleRpm')} rpm; "
          f"window {t1 - t0:.1f} s.")
    print(f"   dips detected: {n_own:.0f} (direction from this step) / {n:.0f} (direction from the slow turns)")
    print(f"   cadence from dips: average {avg_rpm:.1f} rpm (first to last dip); per turn median {st.median(rpm):.1f}, "
          f"range {min(rpm):.0f}-{max(rpm):.0f} rpm over {len(rpm)} full turns")
    if d.get("counted"):
        print(f"   cadence from your count and the clicks: {60 * d['counted'] / (t1 - t0):.1f} rpm")

# ---------------------------------------------------------------- 6. coast
p = last_pair("coast")
if p:
    t0, t1, _ = p
    w = window(t0 - 0.5, t1)
    n, cross, _, _ = turns(w)
    per = [b - a for a, b in zip(cross, cross[1:])]
    print(f"6. Stop and coast ({t1 - t0:.1f} s): {n:.0f} turns while coasting; per-turn rpm "
          f"{', '.join(f'{60 / x:.0f}' for x in per)}")

# ---------------------------------------------------------------- 7. lever sweep -> lever direction
p = last_pair("sweep")
lever_dir = None
if p:
    t0, t1, _ = p
    w = window(t0, t1)
    ev = pca([s["raw"] for s in w])
    lever_dir = ev[0][1]
    proj = [dot(s["raw"], lever_dir) for s in w]
    print(f"7. Lever sweep: lever span along its main direction {max(proj) - min(proj):.1f} uT")

# ---------------------------------------------------------------- 5. gear changes: per-turn averaging
p = last_pair("shift")
if p:
    t0, t1, _ = p
    w = window(t0, t1)
    # loop centre must follow the lever, so centre on a ~1 s moving mean
    n, cross, _, _ = turns(w, plane=plane, center_half=75)
    if lever_dir is None:
        lever_dir = pca([s["raw"] for s in w])[0][1]
    # keep the lever direction pointing "up" (increasing during the sweep)
    print(f"5. Gear changes ({t1 - t0:.1f} s): {n:.0f} turns detected; "
          f"{len([e for e in events if e['step'] == 'shift' and e['action'] == 'shift'])} 'Shifted' clicks")
    revs = []
    for a, b in zip(cross, cross[1:]):
        seg = [s["raw"] for s in w if a <= s["t"] < b]
        if seg:
            revs.append(((a + b) / 2, dot(mean3(seg), lever_dir), 60 / (b - a)))
    ema = [(s["t"], dot(s["ema"], lever_dir)) for s in w]
    # plateaus: consecutive per-turn values within 1.5 uT of each other
    diffs = [abs(revs[i + 1][1] - revs[i][1]) for i in range(len(revs) - 1)]
    steps = [(revs[i + 1][0], revs[i + 1][1] - revs[i][1]) for i in range(len(revs) - 1) if abs(revs[i + 1][1] - revs[i][1]) >= 2.0]
    within = [x for x in diffs if x < 2.0]
    print(f"   per-turn averages: {len(revs)} turns; turn-to-turn change median {st.median(diffs):.2f} uT "
          f"(steady stretches: median {st.median(within):.2f}, 90th pct {sorted(within)[int(0.9 * len(within))]:.2f} uT)")
    print(f"   lever steps found (>= 2 uT between turns): {len(steps)}: "
          + ", ".join(f"{x:+.1f}" for _, x in steps))
    # compare with the sketch's own 130 ms smoothing over the same steady stretches
    ema_noise = []
    for i in range(len(revs) - 1):
        if abs(revs[i + 1][1] - revs[i][1]) < 2.0:
            seg = [v for t, v in ema if revs[i][0] <= t < revs[i + 1][0]]
            if len(seg) > 5:
                ema_noise.append(max(seg) - min(seg))
    print(f"   for comparison, the sketch's current smoothing swings {st.median(ema_noise):.1f} uT "
          f"(median, peak to peak) within each of those same turns")
    out = C = "C:/Projects/KeiserMagBridge/bench/logs/2026-10-15_cadence_test_turns.csv"
    with open(out, "w", encoding="utf-8") as f:
        f.write("t_epoch_s,lever_uT_turn_avg,rpm\n")
        for t, v, r in revs:
            f.write(f"{t:.3f},{v:.2f},{r:.1f}\n")
    print(f"   per-turn values written to {out}")
