"""Build the embedded data for dashboard/index.html from tonight's magnetometer logs.

Run:  py -3 dashboard\\build_data.py

Parses the two bench logs, computes every number shown on the dashboard and
writes one JSON file per dataset to dashboard/data/<id>.json plus
dashboard/data/datasets.json (id, title, description). Plain Python only.
"""
import json
import math
import random
import re
import statistics as st
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOGS = HERE.parent / "bench" / "logs"
MAIN_LOG = LOGS / "2026-10-15_spot1_below_magnet.log"
BENCH_LOG = LOGS / "2026-10-15_bench_fridge_magnet.log"

LINE = re.compile(r"^\s*([\d.]+)\s+B=\(\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)\)uT(\s*SAT)?")

# Reference line from the clean sweep (given): lever fully down / fully up.
D = (-62.9, 58.6, -128.9)
F = (73.7, 34.5, -85.1)

CHAIN_WIN = (302.5, 338.0)    # clean up-sweep -> reference chain
CHAIN_STEP = 4.0              # uT of path length between chain points
PATH_FLAG = 8.0               # off-chain threshold (uT) for the path-following health flag
GAP = (851.73, 1077.36)       # stream toggled off


# ---------------------------------------------------------------- vector helpers
def sub(a, b): return (a[0] - b[0], a[1] - b[1], a[2] - b[2])
def add(a, b): return (a[0] + b[0], a[1] + b[1], a[2] + b[2])
def mul(a, k): return (a[0] * k, a[1] * k, a[2] * k)
def dot(a, b): return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
def norm(a): return math.sqrt(dot(a, a))
def unit(a): n = norm(a); return (a[0] / n, a[1] / n, a[2] / n)
def r1(v): return round(v, 1)
def r2(v): return round(v, 2)
def rv(a, d=1): return [round(c, d) for c in a]


def parse(path):
    rows = []
    sat = 0
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        m = LINE.match(line)
        if m:
            rows.append((float(m[1]), (float(m[2]), float(m[3]), float(m[4]))))
            if m[5]:
                sat += 1
    return rows, sat


def window(rows, t0, t1):
    return [r for r in rows if t0 <= r[0] <= t1]


def mean_vec(rows):
    n = len(rows)
    return (sum(r[1][0] for r in rows) / n, sum(r[1][1] for r in rows) / n, sum(r[1][2] for r in rows) / n)


def pct(vals, p):
    v = sorted(vals)
    k = (len(v) - 1) * p / 100
    lo, hi = math.floor(k), math.ceil(k)
    return v[lo] + (v[hi] - v[lo]) * (k - lo)


# ---------------------------------------------------------------- straight-line method
U = unit(sub(F, D))
LINE_LEN = norm(sub(F, D))


def straight(b):
    d = sub(b, D)
    s = dot(d, U)
    off = math.sqrt(max(0.0, dot(d, d) - s * s))
    return s, off


# ---------------------------------------------------------------- follow-the-path method
def build_chain(pts, step):
    """Resample a 3-D polyline every `step` uT of path length."""
    cum = [0.0]
    for i in range(1, len(pts)):
        cum.append(cum[-1] + norm(sub(pts[i], pts[i - 1])))
    total = cum[-1]
    out = []
    n = int(total // step)
    targets = [k * step for k in range(n + 1)]
    if total - targets[-1] > 0.5:
        targets.append(total)
    j = 0
    for tgt in targets:
        while j < len(cum) - 2 and cum[j + 1] < tgt:
            j += 1
        seg = cum[j + 1] - cum[j]
        f = 0.0 if seg == 0 else (tgt - cum[j]) / seg
        f = min(max(f, 0.0), 1.0)
        out.append(add(pts[j], mul(sub(pts[j + 1], pts[j]), f)))
    return out, total


def chain_arcs(chain):
    arcs = [0.0]
    for i in range(1, len(chain)):
        arcs.append(arcs[-1] + norm(sub(chain[i], chain[i - 1])))
    return arcs


def follow(b, chain, arcs):
    """Arc length to the nearest point on the chain, and distance to it."""
    best = (1e18, 0.0)
    for i in range(len(chain) - 1):
        a, c = chain[i], chain[i + 1]
        seg = sub(c, a)
        L2 = dot(seg, seg)
        f = 0.0 if L2 == 0 else min(max(dot(sub(b, a), seg) / L2, 0.0), 1.0)
        p = add(a, mul(seg, f))
        d = norm(sub(b, p))
        if d < best[0]:
            best = (d, arcs[i] + f * (arcs[i + 1] - arcs[i]))
    # Past either end, carry on along the end direction (as the straight line does),
    # so a reading beyond the calibrated ends gets a position below 0 or above 100 %.
    k = min(2, len(chain) - 1)
    for end, inner, arc0, sign in ((chain[0], chain[k], 0.0, -1.0), (chain[-1], chain[-1 - k], arcs[-1], 1.0)):
        dvec = unit(sub(end, inner))
        proj = dot(sub(b, end), dvec)
        if proj > 0:
            d = norm(sub(b, add(end, mul(dvec, proj))))
            if d < best[0]:
                best = (d, arc0 + sign * proj)
    return best[1], best[0]


# ---------------------------------------------------------------- load
rows, sat_main = parse(MAIN_LOG)
bench, sat_bench = parse(BENCH_LOG)

up_pts = [r[1] for r in window(rows, *CHAIN_WIN)]
CHAIN, CHAIN_RAW_LEN = build_chain(up_pts, CHAIN_STEP)
ARCS = chain_arcs(CHAIN)
CHAIN_LEN = ARCS[-1]


def both(b):
    s, off = straight(b)
    a, dist = follow(b, CHAIN, ARCS)
    return s, off, a, dist


def summary(vals):
    return {"mean": r2(st.mean(vals)), "sd": r2(st.pstdev(vals)), "min": r1(min(vals)), "max": r1(max(vals)), "n": len(vals)}


out = {"meta": {}}

# ---------------------------------------------------------------- full timeline
tl = []
prev_t = None
for t, b in rows:
    s, off = straight(b)
    if prev_t is not None and t - prev_t > 30:
        tl.append(None)  # gap marker
    tl.append([r2(t), r1(s), r1(off), r1(norm(b))])
    prev_t = t
out["timeline"] = tl
out["meta"].update({
    "n_readings": len(rows), "t_first": rows[0][0], "t_last": rows[-1][0],
    "sat_main": sat_main, "sat_bench": sat_bench,
    "gap": [GAP[0], GAP[1]], "gap_len": r1(GAP[1] - GAP[0]),
    "rate_hz": r2((len(rows) - 1) / ((rows[-1][0] - rows[0][0]) - (GAP[1] - GAP[0]))),
    "D": D, "F": F, "line_len": r1(LINE_LEN), "u": rv(U, 3),
    "chain_len": r1(CHAIN_LEN), "chain_n": len(CHAIN), "chain_step": CHAIN_STEP,
    "path_flag": PATH_FLAG,
})

# ---------------------------------------------------------------- events (for bands and colours)
EVENTS = [
    # id, t0, t1, label, group
    ("connect", 146, 175, "Board connected at the bike", "other"),
    ("sweep1", 175, 272, "First lever sweep (not done properly)", "other"),
    ("clean", 299, 403, "Clean sweep", "sweep"),
    ("still", 405, 490, "Lever down, still", "other"),
    ("tomid", 490, 507, "Lever to a middle gear", "other"),
    ("pedal1", 507, 620, "Pedalling, middle gear", "crank"),
    ("stop1", 620, 736, "Stopped, sitting", "other"),
    ("pedal2", 736, 780, "Pedalling easy, then fast", "crank"),
    ("stop2", 780, 812, "Stopped", "other"),
    ("repeat", 1136, 1255, "Repeat test (pedal, crank by hand, sit, lean)", "crank"),
    ("handsoff", 1380, 1431, "Hands-off check", "crank"),
    ("crank", 1583, 1633, "Slow crank revolution", "crank"),
    ("later", 1640, 2134, "Later lever positions (not in the notes)", "other"),
]
out["events"] = [{"id": e[0], "t0": e[1], "t1": e[2], "label": e[3], "group": e[4]} for e in EVENTS]

# ---------------------------------------------------------------- noise
still = window(rows, 1440, 1580)   # long hands-off lever-down hold, nobody touching anything
noise_axes = [st.pstdev([r[1][k] for r in still]) for k in range(3)]
noise_s = st.pstdev([straight(r[1])[0] for r in still])
still2 = window(rows, 430, 486)
noise_axes2 = [st.pstdev([r[1][k] for r in still2]) for k in range(3)]
out["noise"] = {"win": [1440, 1580], "sd_xyz": rv(noise_axes, 2), "sd_s": r2(noise_s),
                "win2": [430, 486], "sd_xyz2": rv(noise_axes2, 2),
                "rms_axis": r2(math.sqrt(sum(v * v for v in noise_axes) / 3))}

# ---------------------------------------------------------------- clean sweep
hold_down = mean_vec(window(rows, 299, 302))
hold_top = mean_vec(window(rows, 338, 344))
hold_bot = mean_vec(window(rows, 392, 400.9))
sweep_vec = sub(hold_top, hold_down)
up_rows = window(rows, *CHAIN_WIN)
dn_rows = window(rows, 344, 392)

def monotonic_violations(vals, increasing, tol):
    bad = 0
    best = vals[0]
    for v in vals[1:]:
        if increasing:
            if v < best - tol: bad += 1
            best = max(best, v)
        else:
            if v > best + tol: bad += 1
            best = min(best, v)
    return bad

up_s = [straight(r[1])[0] for r in up_rows]
dn_s = [straight(r[1])[0] for r in dn_rows]
up_off = [straight(r[1])[1] for r in up_rows]
dn_off = [straight(r[1])[1] for r in dn_rows]
sweep_rows = window(rows, 299, 403)

# fraction of change per quarter of up-sweep time (proxy for lever travel: lever moved slowly and steadily)
t0, t1 = 302.5, 338.0
def s_at(t):
    best = min(up_rows, key=lambda r: abs(r[0] - t))
    return straight(best[1])[0]
q_edges = [t0 + (t1 - t0) * k / 4 for k in range(5)]
q_s = [s_at(t) for t in q_edges]
q_frac = [(q_s[k + 1] - q_s[k]) / (q_s[4] - q_s[0]) for k in range(4)]
# same for the down sweep (time reversed: quarter nearest the bottom = last quarter of time)
t0d, t1d = 344.0, 392.0
def s_at_dn(t):
    best = min(dn_rows, key=lambda r: abs(r[0] - t))
    return straight(best[1])[0]
qd_edges = [t0d + (t1d - t0d) * k / 4 for k in range(5)]
qd_s = [s_at_dn(t) for t in qd_edges]
qd_frac = [(qd_s[k] - qd_s[k + 1]) / (qd_s[0] - qd_s[4]) for k in range(4)]  # from top towards bottom

out["sweep"] = {
    "hold_down": rv(hold_down), "hold_top": rv(hold_top), "hold_bottom_after": rv(hold_bot),
    "span": r1(norm(sweep_vec)), "span_s": r1(straight(hold_top)[0] - straight(hold_down)[0]),
    "bottom_shift": r1(norm(sub(hold_bot, hold_down))),
    "max_off_sweep": r1(max(straight(r[1])[1] for r in sweep_rows)),
    "max_off_up": r1(max(up_off)), "max_off_dn": r1(max(dn_off)),
    "up_violations": monotonic_violations(up_s, True, 0.5),
    "dn_violations": monotonic_violations(dn_s, False, 0.5),
    "up_quarter_frac": [r2(v) for v in q_frac],
    "dn_quarter_frac_top_to_bottom": [r2(v) for v in qd_frac],
    "series": [[r2(t), r1(straight(b)[0]), r1(straight(b)[1])] for t, b in sweep_rows],
    "up": [[r1(straight(r[1])[0]), r1(straight(r[1])[1])] for r in up_rows],
    "dn": [[r1(straight(r[1])[0]), r1(straight(r[1])[1])] for r in dn_rows],
    "s_down": r1(straight(hold_down)[0]), "s_top": r1(straight(hold_top)[0]),
}

# ---------------------------------------------------------------- pedalling vs stopped
segs = [("Pedalling, middle gear", 507, 620, "pedal"), ("Stopped, sitting", 620, 736, "stop"),
        ("Pedalling easy, then fast", 736, 780, "pedal"), ("Stopped", 780, 812, "stop")]
ped = []
for name, a, b, kind in segs:
    ss = [straight(r[1])[0] for r in window(rows, a + 2, b - 2)]
    ped.append({"name": name, "t0": a, "t1": b, "kind": kind, "mean": r1(st.mean(ss)), "sd": r2(st.pstdev(ss)),
                "min": r1(min(ss)), "max": r1(max(ss))})
out["pedal"] = {
    "segments": ped,
    "rise1": r1(ped[0]["mean"] - ped[1]["mean"]),
    "rise2": r1(ped[2]["mean"] - ped[3]["mean"]),
    "series": [[r2(t), r1(straight(b)[0])] for t, b in window(rows, 486, 815)],
}

# ---------------------------------------------------------------- repeat test (1136-1255)
rep = window(rows, 1136, 1255)
rep_off = [straight(r[1])[1] for r in rep]
rep_still = window(rows, 1210, 1228)
out["repeat"] = {"off_min": r1(min(rep_off)), "off_max": r1(max(rep_off)),
                 "series": [[r2(t), r1(straight(b)[0]), r1(straight(b)[1])] for t, b in window(rows, 1130, 1262)]}

# ---------------------------------------------------------------- hands-off check
ho_d1 = mean_vec(window(rows, 1388, 1399))
ho_up = mean_vec(window(rows, 1405.5, 1408.7))
ho_d2 = mean_vec(window(rows, 1416, 1431))
ho_vec = sub(ho_up, ho_d1)
off_d = sub(ho_d1, hold_down)
off_u = sub(ho_up, hold_top)
off_mean = mul(add(off_d, off_u), 0.5)
cosang = dot(unit(ho_vec), unit(sweep_vec))
out["handsoff"] = {
    "down1": rv(ho_d1), "up": rv(ho_up), "down2": rv(ho_d2),
    "lever_vec": rv(ho_vec), "lever_len": r1(norm(ho_vec)),
    "sweep_vec": rv(sweep_vec), "sweep_len": r1(norm(sweep_vec)),
    "angle_deg": r1(math.degrees(math.acos(min(1.0, cosang)))),
    "offset_down": rv(off_d), "offset_down_len": r1(norm(off_d)),
    "offset_up": rv(off_u), "offset_up_len": r1(norm(off_u)),
    "offset_mean": rv(off_mean), "offset_mean_len": r1(norm(off_mean)),
    "offset_along_line": r1(dot(off_mean, U)),
    "series": [[r2(t), r1(straight(b)[0]), r1(straight(b)[1])] for t, b in window(rows, 1378, 1436)],
}

# ---------------------------------------------------------------- slow crank revolution
cr = window(rows, 1583, 1633)
cr0 = mean_vec(window(rows, 1583, 1587))
cr_end = mean_vec(window(rows, 1625, 1633))
dev = [(t, norm(sub(b, cr0)), b) for t, b in cr]
peak = max(dev, key=lambda v: v[1])
peak_vec = sub(peak[2], cr0)
# closest approach to the clean sweep's lever-down hold
near = min(cr, key=lambda r: norm(sub(r[1], hold_down)))
out["crank"] = {
    "start": rv(cr0), "end": rv(cr_end), "return_err": r1(norm(sub(cr_end, cr0))),
    "peak": r1(peak[1]), "peak_t": r2(peak[0]), "peak_vec": rv(peak_vec),
    "peak_along_line": r1(dot(peak_vec, U)),
    "peak_across_line": r1(math.sqrt(max(0, norm(peak_vec) ** 2 - dot(peak_vec, U) ** 2))),
    "nearest_sweep_bottom": r1(norm(sub(near[1], hold_down))), "nearest_t": r2(near[0]),
    "series": [[r2(t), r1(norm(sub(b, cr0))), r1(straight(b)[0]), r1(straight(b)[1])] for t, b in window(rows, 1578, 1640)],
}

# ---------------------------------------------------------------- bench fridge magnet test
b_still = window(bench, 18.2, 19.5)
b_rest = mean_vec(b_still)
b_dev = [(t, norm(sub(b, b_rest))) for t, b in bench]
out["bench"] = {"rest": rv(b_rest), "max": r1(max(v[1] for v in b_dev)),
                "series": [[r2(t), r1(v)] for t, v in b_dev], "n": len(bench),
                "x": [[r2(t), r1(b[0]), r1(b[1]), r1(b[2])] for t, b in bench]}

# ---------------------------------------------------------------- field-space scatter (s vs off)
def group_of(t):
    for e in EVENTS:
        if e[1] <= t < e[2]:
            if e[0] == "clean":
                return "sweep"
            return "crank" if e[4] == "crank" else "other"
    return "other"
scat = {"sweep": [], "crank": [], "other": []}
for t, b in rows:
    s, off = straight(b)
    scat[group_of(t)].append([r1(s), r1(off)])
out["scatter"] = scat

# ---------------------------------------------------------------- part E: straight-line vs follow-the-path
# (i) sensitivity of each chain segment
sens = []
for i in range(len(CHAIN) - 1):
    seg = sub(CHAIN[i + 1], CHAIN[i])
    c = dot(unit(seg), U)
    sens.append([r1((ARCS[i] + ARCS[i + 1]) / 2 / CHAIN_LEN * 100), r1(c * 100)])
sens_vals = [v[1] for v in sens]
# smoothed version (segments of ~12 uT) to separate shape from 0.2 uT noise
sens12 = []
for i in range(0, len(CHAIN) - 3, 1):
    seg = sub(CHAIN[i + 3], CHAIN[i])
    sens12.append([r1((ARCS[i] + ARCS[i + 3]) / 2 / CHAIN_LEN * 100), r1(dot(unit(seg), U) * 100)])

# (ii) down-sweep consistency
dn = []
for t, b in dn_rows:
    s, off, a, dist = both(b)
    dn.append([r2(t), r1(s / LINE_LEN * 100), r1(a / CHAIN_LEN * 100), r1(off), r2(dist)])
dn_offline = [v[3] for v in dn]
dn_offchain = [v[4] for v in dn]
# also: the up-sweep itself (in-sample) and the first improper sweep
up_offchain = [follow(r[1], CHAIN, ARCS)[1] for r in up_rows]

def dist_summary(v):
    return {"median": r2(pct(v, 50)), "p95": r2(pct(v, 95)), "max": r2(max(v)), "mean": r2(st.mean(v))}

# health thresholds: straight-line can't flag below the sweep's own max off-line distance
line_flag = math.ceil(max(straight(r[1])[1] for r in sweep_rows) + 2.0)

# (iii) known-truth cases
CASES = [
    ("Clean sweep, bottom hold after the down-sweep", 392, 400.9, 0.0),
    ("Lever down, still, after the sweep", 410, 486, 0.0),
    ("Hands-off: lever down (1st)", 1388, 1399, 0.0),
    ("Hands-off: lever up", 1405.5, 1408.7, 100.0),
    ("Hands-off: lever down (2nd)", 1416, 1431, 0.0),
    ("Slow crank revolution (lever down)", 1583, 1633, 0.0),
]
cases = []
for name, a, b, truth in CASES:
    w = window(rows, a, b)
    vals = [both(r[1]) for r in w]
    s_pct = [v[0] / LINE_LEN * 100 for v in vals]
    p_pct = [v[2] / CHAIN_LEN * 100 for v in vals]
    s_err = [p - truth for p in s_pct]
    p_err = [p - truth for p in p_pct]
    s_err_c = [min(max(p, 0), 100) - truth for p in s_pct]
    offl = [v[1] for v in vals]
    offc = [v[3] for v in vals]
    worst = lambda e: max(e, key=abs)
    cases.append({
        "name": name, "t0": a, "t1": b, "truth": truth, "n": len(w),
        "line_err_pct_mean": r1(st.mean(s_err)), "line_err_pct_worst": r1(worst(s_err)),
        "line_err_ut_worst": r1(worst(s_err) / 100 * LINE_LEN),
        "line_err_clamped_worst": r1(worst(s_err_c)),
        "path_err_pct_mean": r1(st.mean(p_err)), "path_err_pct_worst": r1(worst(p_err)),
        "path_err_ut_worst": r1(worst(p_err) / 100 * CHAIN_LEN),
        "offline_min": r1(min(offl)), "offline_max": r1(max(offl)), "offline_med": r1(pct(offl, 50)),
        "offchain_min": r1(min(offc)), "offchain_max": r1(max(offc)), "offchain_med": r1(pct(offc, 50)),
        "line_flag_frac": r2(sum(1 for v in offl if v > line_flag) / len(offl)),
        "path_flag_frac": r2(sum(1 for v in offc if v > PATH_FLAG) / len(offc)),
    })

# crank revolution traced through both methods over time
crank_methods = []
for t, b in window(rows, 1578, 1640):
    s, off, a, dist = both(b)
    crank_methods.append([r2(t), r1(s / LINE_LEN * 100), r1(a / CHAIN_LEN * 100), r1(off), r1(dist)])

# whole-session flag rates (excluding the clean sweep, which defines both references)
def session_flag_rates():
    res = {}
    for gid in ("other", "crank"):
        pass
    tot = {"line": 0, "path": 0, "n": 0}
    by = {}
    for t, b in rows:
        if 299 <= t <= 403:
            continue
        s, off, a, dist = both(b)
        g = group_of(t)
        d = by.setdefault(g, {"line": 0, "path": 0, "n": 0})
        d["n"] += 1
        d["line"] += off > line_flag
        d["path"] += dist > PATH_FLAG
    return {k: {"line": r2(v["line"] / v["n"]), "path": r2(v["path"] / v["n"]), "n": v["n"]} for k, v in by.items()}

# (iv) simulated strongly curved path
random.seed(20261015)
def sim_path(p):
    """Field path for lever position p in [0,1]: a 3-D arc that turns through 250 degrees."""
    th = math.radians(-35 + 250 * p)
    R = 60.0
    return (R * math.cos(th), R * math.sin(th), 18.0 * p)
def noisy(v, sd=0.2):
    return tuple(c + random.gauss(0, sd) for c in v)
cal_pts = [noisy(sim_path(k / 24)) for k in range(25)]           # 25 calibration points
sim_D, sim_F = cal_pts[0], cal_pts[-1]
sim_U = unit(sub(sim_F, sim_D))
sim_len = norm(sub(sim_F, sim_D))
sim_arcs = chain_arcs(cal_pts)
sim = []
for k in range(101):
    p = k / 100
    b = noisy(sim_path(p))
    s = dot(sub(b, sim_D), sim_U)
    a, dist = follow(b, cal_pts, sim_arcs)
    sim.append([k, r1(s / sim_len * 100), r1(a / sim_arcs[-1] * 100), r2(dist)])
sim_line = [v[1] for v in sim]
# where does the straight-line estimate fold back?
sl_max_i = max(range(len(sim_line)), key=lambda i: sim_line[i])
sl_min_i = min(range(len(sim_line)), key=lambda i: sim_line[i])
path_viol = monotonic_violations([v[2] for v in sim], True, 1.0)
line_viol = monotonic_violations(sim_line, True, 1.0)
# example of ambiguity: lever 10% vs the later position with the same straight-line reading
def twin(i, later):
    """Another lever position whose straight-line reading matches lever position i."""
    cand = range(i + 6, 101) if later else range(0, i - 5)
    j = min(cand, key=lambda j: abs(sim_line[j] - sim_line[i]))
    return [i, j, sim_line[i], sim_line[j]]
amb = [twin(5, True), twin(95, False)]
# cal-time check the sketch would do: are the 25 calibration projections increasing?
cal_s = [dot(sub(c, sim_D), sim_U) for c in cal_pts]
cal_viol = sum(1 for i in range(1, 25) if cal_s[i] <= cal_s[i - 1])

out["compare"] = {
    "chain": [rv(c, 1) for c in CHAIN],
    "chain_scatter": [[r1(straight(c)[0]), r1(straight(c)[1])] for c in CHAIN],
    "sens": sens, "sens12": sens12,
    "sens_min": r1(min(sens_vals)), "sens_max": r1(max(sens_vals)), "sens_mean": r1(st.mean(sens_vals)),
    "sens12_min": r1(min(v[1] for v in sens12)), "sens12_max": r1(max(v[1] for v in sens12)),
    "path_ratio": r1(CHAIN_LEN / LINE_LEN * 100),
    "dn": dn,
    "dn_offline": dist_summary(dn_offline), "dn_offchain": dist_summary(dn_offchain),
    "up_offchain": dist_summary(up_offchain),
    "dn_pos_diff_max": r1(max(abs(v[1] - v[2]) for v in dn)),
    "line_flag": line_flag,
    "cases": cases,
    "crank_methods": crank_methods,
    "session_flags": session_flag_rates(),
    "sim": sim, "sim_cal": [[k * 100 / 24, r1(cal_s[k] / sim_len * 100)] for k in range(25)],
    "sim_line_peak": [sl_max_i, sim_line[sl_max_i]], "sim_line_trough": [sl_min_i, sim_line[sl_min_i]],
    "sim_path_violations": path_viol, "sim_line_violations": line_viol,
    "sim_cal_violations": cal_viol, "sim_ambiguity": amb,
    "sim_curve": [[r1(sim_path(k / 100)[0]), r1(sim_path(k / 100)[1])] for k in range(101)],
    "sim_cal_xy": [[r1(c[0]), r1(c[1])] for c in cal_pts],
    "sim_turn_deg": 250, "sim_radius": 60, "sim_len": r1(sim_arcs[-1]),
    "sim_max_offchain": r2(max(v[3] for v in sim)),
}

# ---------------------------------------------------------------- phone-dictated readings
PHONE = [
    ("Lever down", "first taping", (-83.0, 46.0, -118.3)),
    ("Lever up", "first taping", (36.0, 27.2, -78.8)),
    ("Lever down again", "first taping", (-98.4, 49.5, -117.8)),
    ("Up 1", "re-taped", (34.6, 29.6, -66.7)),
    ("Up 2", "re-taped", (32.3, 29.1, -66.1)),
    ("Up 3", "re-taped", (31.1, 29.2, -65.2)),
    ("Down 1", "re-taped", (-115.0, 49.8, -111.3)),
    ("Down 2", "re-taped", (-117.9, 50.3, -110.4)),
    ("Down 3", "re-taped", (-114.3, 50.2, -112.3)),
    ("Gear 5", "re-taped", (-54.2, 32.4, -106.1)),
    ("Gear 6", "re-taped", (-47.6, 31.7, -105.9)),
    ("Gear 7", "re-taped", (-41.3, 30.3, -104.6)),
    ("Gear 8", "re-taped", (-0.8, 35.4, -89.1)),
    ("Gear 8 again", "re-taped", (2.4, 34.9, -90.1)),
    ("Gear 8, third", "re-taped", (-61.4, 30.4, -94.8)),
]
pd_ = [p[2] for p in PHONE if p[1] == "re-taped" and p[0].startswith("Down")]
pu_ = [p[2] for p in PHONE if p[1] == "re-taped" and p[0].startswith("Up")]
PD = tuple(sum(v[k] for v in pd_) / 3 for k in range(3))
PF = tuple(sum(v[k] for v in pu_) / 3 for k in range(3))
PU = unit(sub(PF, PD))
PL = norm(sub(PF, PD))
phone = []
for name, grp, b in PHONE:
    d = sub(b, PD)
    s = dot(d, PU)
    off = math.sqrt(max(0, dot(d, d) - s * s))
    phone.append({"name": name, "group": grp, "b": list(b), "pos_pct": r1(s / PL * 100), "off": r1(off)})
def phone_pos(n): return next(p for p in phone if p["name"] == n)["pos_pct"]
out["phone"] = {
    "rows": phone, "down_mean": rv(PD), "up_mean": rv(PF), "span": r1(PL),
    "up_spread": r1(max(norm(sub(a, b)) for a in pu_ for b in pu_)),
    "down_spread": r1(max(norm(sub(a, b)) for a in pd_ for b in pd_)),
    "step56": r1(phone_pos("Gear 6") - phone_pos("Gear 5")),
    "step67": r1(phone_pos("Gear 7") - phone_pos("Gear 6")),
    "step78": r1(phone_pos("Gear 8") - phone_pos("Gear 7")),
    "g8_spread": r1(phone_pos("Gear 8 again") - phone_pos("Gear 8, third")),
    "jump78_ut": r1(norm(sub(PHONE[12][2], PHONE[11][2]))),
    "step67_ut": r1(norm(sub(PHONE[11][2], PHONE[10][2]))),
}

# ---------------------------------------------------------------- export datasets (dashboard/data/*.json)
DATA_DIR = HERE / "data"
DATA_DIR.mkdir(exist_ok=True)
DATASETS = []


def write_ds(ds_id, title, description, rows_out):
    (DATA_DIR / f"{ds_id}.json").write_text(json.dumps(rows_out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    DATASETS.append({"id": ds_id, "title": title, "description": description})


# Event table: session-level events (numbered as in the session notes) and the phases inside them.
# band: how the timeline shades it ("sweep", "crank", "other", "gap" or "" = not drawn on the timeline)
EVENT_TABLE = [
    # id, number, label, t_start, t_end, group, level, parent, band, note
    ("first", 1, "Connected; first lever sweep", 146, 272, "other", "session", "", "other",
     "Board connected over USB at the bike; the first sweep was not done properly."),
    ("clean", 2, "Clean sweep", 299, 403, "sweep", "session", "", "sweep",
     "Lever down, slowly up, hold, slowly down, hold. Defines the reference line and path."),
    ("gears", 3, "Lever down, then pedalling vs stopped", 405, 812, "other", "session", "", "other",
     "Lever down and still, moved to a middle gear, then pedalling and stopping in turn."),
    ("repeat", 4, "Repeat test", 1136, 1255, "crank", "session", "", "crank",
     "Lever set, pedalled to the gear, stood still, cranked by hand, sat on the saddle, leaned."),
    ("handsoff", 5, "Hands-off check", 1380, 1431, "crank", "session", "", "crank",
     "Phone and keys away; lever down, up, down, about ten seconds each."),
    ("crank", 6, "Slow crank revolution", 1583, 1633, "crank", "session", "", "crank",
     "Lever fixed fully down; crank turned once, slowly, by hand."),
    ("later", None, "Later lever positions", 1640, 2134, "other", "session", "", "other",
     "Lever held at a few other positions; not described in the session notes."),
    ("gap", None, "Stream off (no data)", GAP[0], GAP[1], "gap", "session", "", "gap",
     "Live data was toggled off by accident; nothing was recorded."),
    ("sweep1", None, "First sweep", 175, 272, "other", "phase", "first", "", ""),
    ("clean_hold_down", None, "Hold down", 299, 302, "sweep", "phase", "clean", "", ""),
    ("clean_up", None, "Slowly up", 302, 338, "sweep", "phase", "clean", "",
     "The up-sweep from 302.5 s to 338 s becomes the reference chain."),
    ("clean_hold_top", None, "Hold top", 338, 344, "sweep", "phase", "clean", "", ""),
    ("clean_down", None, "Slowly down", 344, 392, "sweep", "phase", "clean", "",
     "Independent pass used to test both methods."),
    ("clean_hold_bottom", None, "Hold bottom", 392, 403, "sweep", "phase", "clean", "", ""),
    ("still", None, "Lever down, still", 405, 490, "other", "phase", "gears", "", ""),
    ("tomid", None, "Lever to a middle gear", 490, 507, "other", "phase", "gears", "", ""),
    ("pedal1", None, "Pedalling, middle gear", 507, 620, "crank", "phase", "gears", "crank", "Crank magnet check."),
    ("stop1", None, "Stopped, sitting", 620, 736, "other", "phase", "gears", "", ""),
    ("pedal2", None, "Pedalling easy, then fast", 736, 780, "crank", "phase", "gears", "crank",
     "About 20 s easy, then 20 s fast."),
    ("stop2", None, "Stopped", 780, 812, "other", "phase", "gears", "", ""),
    ("rep_set", None, "Lever moved and set", 1146, 1162, "crank", "phase", "repeat", "", ""),
    ("rep_pedal", None, "Pedalled to the set gear", 1162, 1196, "crank", "phase", "repeat", "", ""),
    ("rep_still", None, "Stood still", 1196, 1204, "crank", "phase", "repeat", "", ""),
    ("rep_hand", None, "Cranked by hand", 1204, 1208, "crank", "phase", "repeat", "", "Followed by a sudden jump."),
    ("rep_sit", None, "Sat on the saddle", 1228, 1236, "crank", "phase", "repeat", "", "Another jump."),
    ("rep_lean", None, "Leaning drift", 1236, 1255, "crank", "phase", "repeat", "", ""),
    ("ho_down1", None, "Lever down", 1386, 1398, "crank", "phase", "handsoff", "", ""),
    ("ho_up", None, "Lever up", 1402, 1408, "crank", "phase", "handsoff", "", ""),
    ("ho_down2", None, "Lever down", 1414, 1431, "crank", "phase", "handsoff", "", ""),
]
ev_rows = [{"id": e[0], "number": e[1], "label": e[2], "t_start": e[3], "t_end": e[4], "group": e[5],
            "level": e[6], "parent": e[7], "band": e[8], "note": e[9]} for e in EVENT_TABLE]
write_ds("events", "Session events timeline",
         "Event and phase windows (log seconds) from the session notes, used to label the charts; phases sit inside their numbered session event.",
         ev_rows)


def event_of(t):
    best = ""
    for e in EVENT_TABLE:
        if e[6] == "phase" and e[3] <= t < e[4]:
            return e[0]
        if e[6] == "session" and e[3] <= t < e[4]:
            best = e[0]
    return best


sess = []
for t, b in rows:
    s, off = straight(b)
    sess.append({"t": t, "x": b[0], "y": b[1], "z": b[2], "mag": r1(norm(b)), "s": r2(s), "off": r2(off),
                 "pos_pct": r1(s / LINE_LEN * 100), "sat": 0, "event": event_of(t), "group": group_of(t)})
write_ds("session_readings", "Spot 1 magnetometer readings",
         "Every field line of the spot-1 log (x, y, z in µT) with position s along the clean-sweep line, distance off that line, |B| and the event it falls in.",
         sess)

write_ds("bench_readings", "Bench fridge-magnet test",
         "Every field line of the bench log, with change = distance in µT from the resting field (mean of 18.2–19.5 s).",
         [{"t": t, "x": b[0], "y": b[1], "z": b[2], "change": r1(norm(sub(b, b_rest)))} for t, b in bench])

# clean sweep passes, both drawn from lever-down (0 %) to lever-up (100 %) progress
passes = []
for name, rws in (("up", up_rows), ("down", dn_rows)):
    tA, tB = rws[0][0], rws[-1][0]
    for t, b in rws:
        prog = (t - tA) / (tB - tA) * 100
        if name == "down":
            prog = 100 - prog
        s, off = straight(b)
        passes.append({"pass": name, "t": t, "progress_pct": r1(prog), "s": r2(s), "off": r2(off)})
write_ds("sweep_passes", "Clean sweep passes",
         "Readings from the clean up-pass (302.5–338 s) and down-pass (344–392 s), with progress through each pass measured in time from the lever-down end.",
         passes)

write_ds("pedalling_segments", "Pedalling vs stopped segments",
         "Mean, spread and range of position s for each pedalling and stopped stretch (2 s trimmed off each end).",
         [{"name": p["name"], "kind": p["kind"], "t_start": p["t0"], "t_end": p["t1"], "mean_s": p["mean"],
           "sd_s": p["sd"], "min_s": p["min"], "max_s": p["max"]} for p in ped])

chain_rows = []
for i, c in enumerate(CHAIN):
    s, off = straight(c)
    chain_rows.append({"idx": i, "x": r2(c[0]), "y": r2(c[1]), "z": r2(c[2]), "arc": r2(ARCS[i]),
                       "arc_pct": r1(ARCS[i] / CHAIN_LEN * 100), "s": r2(s), "off_line": r2(off)})
write_ds("reference_chain", "Follow-the-path reference chain",
         "The clean up-sweep (302.5–338 s) resampled every 4 µT of path length: the calibrated path used by the follow-the-path method.",
         chain_rows)

sens_rows = [{"window_ut": 4, "pos_pct": v[0], "straight_pct": v[1], "path_pct": 100.0} for v in sens]
sens_rows += [{"window_ut": 12, "pos_pct": v[0], "straight_pct": v[1], "path_pct": 100.0} for v in sens12]
write_ds("method_sensitivity", "Method sensitivity along lever",
         "For each step of the reference chain, the share of real field change each method turns into position change (straight line = cosine of the angle to the line), over 4 µT and smoother 12 µT steps.",
         sens_rows)

write_ds("method_downsweep", "Methods on the down-sweep",
         "Each down-sweep reading (344–392 s) located by both methods: position in % of range and distance from the reference (off-line vs off-chain).",
         [{"t": v[0], "s": r2(v[1] * LINE_LEN / 100), "line_pct": v[1], "path_pct": v[2], "off_line": v[3], "off_chain": v[4]} for v in dn])

write_ds("method_known_truth", "Methods on known lever positions",
         f"Readings where the lever position is mechanically known (fully down = 0 %, fully up = 100 %): each method's position error, health signal, and the share of readings its health flag catches (straight line > {line_flag} µT, path > {PATH_FLAG:g} µT).",
         [{"case": cs["name"], "t_start": cs["t0"], "t_end": cs["t1"], "truth_pct": cs["truth"], "n": cs["n"],
           "line_err_pct_mean": cs["line_err_pct_mean"], "line_err_pct_worst": cs["line_err_pct_worst"],
           "line_err_ut_worst": cs["line_err_ut_worst"],
           "path_err_pct_mean": cs["path_err_pct_mean"], "path_err_pct_worst": cs["path_err_pct_worst"],
           "path_err_ut_worst": cs["path_err_ut_worst"],
           "off_line_med": cs["offline_med"], "off_line_max": cs["offline_max"],
           "off_chain_med": cs["offchain_med"], "off_chain_max": cs["offchain_max"],
           "line_flag_share": cs["line_flag_frac"], "path_flag_share": cs["path_flag_frac"]} for cs in cases])

crank_tr = []
for t, b in window(rows, 1578, 1640):
    s, off, a, dist = both(b)
    crank_tr.append({"t": t, "change": r1(norm(sub(b, cr0))), "s": r2(s), "off_line": r2(off),
                     "line_pct": r1(s / LINE_LEN * 100), "path_pct": r1(a / CHAIN_LEN * 100), "off_chain": r2(dist)})
write_ds("crank_revolution", "Slow crank revolution trace",
         "Readings around the slow crank turn (lever fully down): change from the starting reading, and both methods' position and health signal.",
         crank_tr)

write_ds("method_simulated", "Simulated curved path: estimates",
         "SIMULATED, not measured: a field path turning through 250° (radius 60 µT) with 0.2 µT noise; 101 test readings located by both methods after a 25-point calibration.",
         [{"lever_pct": v[0], "line_pct": v[1], "path_pct": v[2], "off_chain": v[3]} for v in sim])
sim_geo = [{"kind": "path", "lever_pct": k, "px": c[0], "py": c[1], "line_pct": None}
           for k, c in enumerate(out["compare"]["sim_curve"])]
sim_geo += [{"kind": "calibration", "lever_pct": r1(k * 100 / 24), "px": c[0], "py": c[1],
             "line_pct": out["compare"]["sim_cal"][k][1]} for k, c in enumerate(out["compare"]["sim_cal_xy"])]
write_ds("simulated_path", "Simulated curved path: shape",
         "SIMULATED, not measured: the noise-free simulated field path (top view, µT) and its 25 noisy calibration points with their straight-line positions.",
         sim_geo)

phone_order = ["Down 1", "Down 2", "Down 3", "Gear 5", "Gear 6", "Gear 7", "Gear 8", "Gear 8 again", "Gear 8, third",
               "Up 1", "Up 2", "Up 3", "Lever down", "Lever up", "Lever down again"]
write_ds("phone_readings", "Phone-dictated readings",
         "Readings read aloud from the phone before tonight's log (first taping, then re-taped); position and off-line distance use their own line from the mean re-taped down to the mean re-taped up reading.",
         [{"order": phone_order.index(p["name"]), "label": p["name"], "set": p["group"], "x": p["b"][0], "y": p["b"][1],
           "z": p["b"][2], "pos_pct": p["pos_pct"], "off": p["off"]} for p in phone])

H = out
hs = H["sweep"]; hh = H["handsoff"]; hc = H["crank"]; cmp_ = H["compare"]; ph = H["phone"]
ped_peak1 = r1(ped[0]["max"] - ped[1]["mean"]); ped_peak2 = r1(ped[2]["max"] - ped[3]["mean"])
CRIT_SPAN, CRIT_CRANK = 100.0, 1.5
headline = [
    {"metric": "lever_span", "label": "Lever span", "value": hs["span"], "unit": "µT", "status": "pass", "limit": CRIT_SPAN,
     "note": "Field change from lever fully down to fully up on the clean sweep."},
    {"metric": "crank_swing", "label": "Crank-magnet swing", "value": hc["peak"], "unit": "µT", "status": "fail", "limit": CRIT_CRANK,
     "note": "Largest change during one slow crank turn with the lever fixed."},
    {"metric": "crank_share", "label": "Crank swing vs lever range", "value": r1(hc["peak"] / hs["span"] * 100), "unit": "%", "status": "", "limit": None,
     "note": "Crank-magnet swing divided by the lever span."},
    {"metric": "noise", "label": "Resting noise", "value": H["noise"]["sd_s"], "unit": "µT", "status": "", "limit": None,
     "note": "Standard deviation of position s while nothing moved (1440–1580 s)."},
    {"metric": "pedal_shift", "label": "Pedalling shift", "value": out["pedal"]["rise1"], "unit": "µT", "status": "", "limit": None,
     "note": "Mean position while pedalling minus mean while stopped, middle gear."},
    {"metric": "offpath_baseline", "label": "Off-line baseline", "value": hs["max_off_sweep"], "unit": "µT", "status": "", "limit": None,
     "note": "Largest distance from the straight reference line during the clean sweep."},
]
write_ds("headline", "Spot 1 headline figures",
         "The headline figures for spot 1, each computed from the logs, with the pass limit where one applies (span at least 100 µT, crank effect at most 1.5 µT).",
         headline)


def F_(metric, label, value, unit="µT", note="", vec=None):
    row = {"metric": metric, "label": label, "value": value, "unit": unit, "note": note,
           "vx": None, "vy": None, "vz": None}
    if vec is not None:
        row["vx"], row["vy"], row["vz"] = vec[0], vec[1], vec[2]
    return row


nz = H["noise"]
fx = [
    F_("spot", "Mounting spot", 1, "", "below the resistance magnets"),
    F_("n_readings", "Field readings in the spot-1 log", H["meta"]["n_readings"], ""),
    F_("rate_hz", "Average reading rate", H["meta"]["rate_hz"], "per s"),
    F_("t_first", "First reading", H["meta"]["t_first"], "s"),
    F_("t_last", "Last reading", H["meta"]["t_last"], "s"),
    F_("gap_start", "Stream off from", GAP[0], "s"),
    F_("gap_end", "Stream back on at", GAP[1], "s"),
    F_("gap_len", "Stream off for", H["meta"]["gap_len"], "s"),
    F_("sat_count", "Saturated readings (both logs)", sat_main + sat_bench, ""),
    F_("noise_sd_s", "Resting noise along the line", nz["sd_s"]),
    F_("noise_sd_x", "Resting noise, x", nz["sd_xyz"][0]),
    F_("noise_sd_y", "Resting noise, y", nz["sd_xyz"][1]),
    F_("noise_sd_z", "Resting noise, z", nz["sd_xyz"][2]),
    F_("ref_down", "Reference lever-down reading D", None, "µT", "given", D),
    F_("ref_up", "Reference lever-up reading F", None, "µT", "given", F),
    F_("line_len", "Length of the straight reference line", r1(LINE_LEN)),
    F_("chain_len", "Length of the reference chain", r1(CHAIN_LEN)),
    F_("chain_n", "Points in the reference chain", len(CHAIN), ""),
    F_("chain_step", "Spacing of chain points", CHAIN_STEP),
    F_("sketch_cal_points", "Calibration points in the current sketch", 25, "", "gear 1–24 edges"),
    F_("path_ratio", "Path length vs straight line", r1(CHAIN_LEN / LINE_LEN * 100), "%"),
    F_("sweep_span", "Clean-sweep lever span", hs["span"]),
    F_("sweep_hold_down", "Clean sweep, lever-down hold", None, "µT", "299–302 s", hs["hold_down"]),
    F_("sweep_hold_top", "Clean sweep, lever-up hold", None, "µT", "338–344 s", hs["hold_top"]),
    F_("sweep_hold_bottom_after", "Clean sweep, bottom hold after the down pass", None, "µT", "392–401 s", hs["hold_bottom_after"]),
    F_("sweep_bottom_shift", "Bottom hold after vs before the sweep", hs["bottom_shift"]),
    F_("sweep_max_off", "Clean sweep, largest off-line distance", hs["max_off_sweep"]),
    F_("sweep_up_reversals", "Up-pass reversals larger than 0.5 µT", hs["up_violations"], ""),
    F_("sweep_dn_reversals", "Down-pass reversals larger than 0.5 µT", hs["dn_violations"], ""),
    F_("sweep_q1", "Up pass: share of change in the first quarter of travel", r1(hs["up_quarter_frac"][0] * 100), "%"),
    F_("sweep_q4", "Up pass: share of change in the last quarter of travel", r1(hs["up_quarter_frac"][3] * 100), "%"),
    F_("s_down", "Position s of the lever-down hold", hs["s_down"]),
    F_("s_top", "Position s of the lever-up hold", hs["s_top"]),
    F_("pedal_rise1", "Middle gear: pedalling minus stopped (mean)", out["pedal"]["rise1"]),
    F_("pedal_rise2", "Easy/fast: pedalling minus stopped (mean)", out["pedal"]["rise2"]),
    F_("pedal_peak1", "Middle gear: highest pedalling reading above stopped mean", ped_peak1),
    F_("pedal_peak2", "Easy/fast: highest pedalling reading above stopped mean", ped_peak2),
    F_("pedal_sd1", "Wobble while pedalling, middle gear (sd)", ped[0]["sd"]),
    F_("pedal_sd2", "Wobble while pedalling easy/fast (sd)", ped[2]["sd"]),
    F_("repeat_off_min", "Repeat test: smallest off-line distance", out["repeat"]["off_min"]),
    F_("repeat_off_max", "Repeat test: largest off-line distance", out["repeat"]["off_max"]),
    F_("ho_lever_len", "Hands-off lever change (up minus down)", hh["lever_len"], "µT", "", hh["lever_vec"]),
    F_("ho_sweep_len", "Clean-sweep lever change", hh["sweep_len"], "µT", "", hh["sweep_vec"]),
    F_("ho_angle", "Angle between the two lever changes", hh["angle_deg"], "°"),
    F_("ho_offset", "Hands-off offset vs clean sweep (mean of down and up)", hh["offset_mean_len"], "µT", "", hh["offset_mean"]),
    F_("ho_offset_down", "Offset at lever down", hh["offset_down_len"]),
    F_("ho_offset_up", "Offset at lever up", hh["offset_up_len"]),
    F_("ho_offset_along", "Part of the offset along the lever line", hh["offset_along_line"]),
    F_("crank_peak", "Crank turn: largest change", hc["peak"], "µT", "", hc["peak_vec"]),
    F_("crank_peak_t", "Crank turn: time of largest change", hc["peak_t"], "s"),
    F_("crank_return", "Crank turn: end vs start", hc["return_err"]),
    F_("crank_along", "Crank peak change along the lever line", hc["peak_along_line"]),
    F_("crank_across", "Crank peak change across the lever line", hc["peak_across_line"]),
    F_("crank_nearest_bottom", "Crank turn: closest approach to the clean-sweep lever-down reading", hc["nearest_sweep_bottom"]),
    F_("crank_nearest_t", "Crank turn: time of closest approach", hc["nearest_t"], "s"),
    F_("bench_rest", "Bench resting field", None, "µT", "18.2–19.5 s", H["bench"]["rest"]),
    F_("bench_max", "Bench: largest change", H["bench"]["max"]),
    F_("sens_mean", "Straight line keeps, average over the path", cmp_["sens_mean"], "%"),
    F_("sens_min4", "Straight line keeps, lowest 4 µT step", cmp_["sens_min"], "%"),
    F_("sens_min12", "Straight line keeps, lowest 12 µT step", cmp_["sens12_min"], "%"),
    F_("sens_max12", "Straight line keeps, highest 12 µT step", cmp_["sens12_max"], "%"),
    F_("dn_offline_med", "Down-sweep off-line, median", cmp_["dn_offline"]["median"]),
    F_("dn_offline_p95", "Down-sweep off-line, 95th percentile", cmp_["dn_offline"]["p95"]),
    F_("dn_offline_max", "Down-sweep off-line, largest", cmp_["dn_offline"]["max"]),
    F_("dn_offchain_med", "Down-sweep off-chain, median", cmp_["dn_offchain"]["median"]),
    F_("dn_offchain_p95", "Down-sweep off-chain, 95th percentile", cmp_["dn_offchain"]["p95"]),
    F_("dn_offchain_max", "Down-sweep off-chain, largest", cmp_["dn_offchain"]["max"]),
    F_("up_offchain_max", "Up-sweep off-chain, largest (in-sample)", cmp_["up_offchain"]["max"]),
    F_("dn_pos_diff_max", "Down-sweep: largest difference between the two positions", cmp_["dn_pos_diff_max"], "%"),
    F_("line_flag", "Straight-line health alarm", line_flag, "µT", "clean-sweep maximum + 2 µT, rounded up"),
    F_("path_flag", "Path health alarm", PATH_FLAG, "µT"),
    F_("sim_turn", "Simulated path turns through", 250, "°"),
    F_("sim_noise", "Simulated noise", 0.2),
    F_("sim_line_reversals", "Simulated: straight-line reversals", cmp_["sim_line_violations"], ""),
    F_("sim_path_reversals", "Simulated: path-following reversals", cmp_["sim_path_violations"], ""),
    F_("sim_cal_reversals", "Simulated: calibration steps that go backwards on the line", cmp_["sim_cal_violations"], ""),
    F_("sim_twin_a", "Simulated lever position A", cmp_["sim_ambiguity"][0][0], "%"),
    F_("sim_twin_b", "Simulated lever position with the same straight-line reading as A", cmp_["sim_ambiguity"][0][1], "%"),
    F_("sim_twin_val", "Straight-line reading at A", cmp_["sim_ambiguity"][0][2], "%"),
    F_("sim_max_offchain", "Simulated: largest off-chain distance", cmp_["sim_max_offchain"]),
    F_("phone_span", "Phone readings: re-taped lever span", ph["span"]),
    F_("phone_step56", "Phone: gear 5 to 6", ph["step56"], "%"),
    F_("phone_step67", "Phone: gear 6 to 7", ph["step67"], "%"),
    F_("phone_step78", "Phone: gear 7 to 8", ph["step78"], "%"),
    F_("phone_jump78_ut", "Phone: gear 7 to 8 change", ph["jump78_ut"]),
    F_("phone_g8_spread", "Phone: gear 8 again minus gear 8 third", ph["g8_spread"], "%"),
    F_("crit_span", "Pass: lever span at least", CRIT_SPAN),
    F_("crit_crank", "Pass: crank effect at most", CRIT_CRANK),
]
write_ds("findings", "Spot 1 computed findings",
         "Every other number quoted on the dashboard, computed from the logs by build_data.py (vectors in vx, vy, vz).",
         fx)

(DATA_DIR / "datasets.json").write_text(json.dumps(DATASETS, indent=1, ensure_ascii=False), encoding="utf-8")
for ds in DATASETS:
    p = DATA_DIR / f"{ds['id']}.json"
    print(f"  {ds['id']:22s} {len(json.loads(p.read_text(encoding='utf-8'))):5d} rows {p.stat().st_size/1024:7.1f} KB")


# ---------------------------------------------------------------- console report
def show(k, v): print(f"{k:28s} {v}")
c = out["compare"]
show("readings / rate", (out["meta"]["n_readings"], out["meta"]["rate_hz"]))
show("SAT main/bench", (sat_main, sat_bench))
show("noise", out["noise"])
for k in ("hold_down", "hold_top", "hold_bottom_after", "span", "span_s", "bottom_shift", "max_off_sweep",
          "max_off_up", "max_off_dn", "up_violations", "dn_violations", "up_quarter_frac", "dn_quarter_frac_top_to_bottom"):
    show("sweep." + k, out["sweep"][k])
show("pedal", [(p["name"], p["mean"], p["sd"], p["min"], p["max"]) for p in ped])
show("pedal rises", (out["pedal"]["rise1"], out["pedal"]["rise2"]))
show("repeat off", (out["repeat"]["off_min"], out["repeat"]["off_max"]))
show("handsoff", {k: v for k, v in out["handsoff"].items() if k != "series"})
show("crank", {k: v for k, v in out["crank"].items() if k != "series"})
show("bench", (out["bench"]["rest"], out["bench"]["max"]))
show("chain", (CHAIN_LEN, len(CHAIN), CHAIN_RAW_LEN))
show("sens raw min/max/mean", (c["sens_min"], c["sens_max"], c["sens_mean"]))
show("sens 12uT min/max", (c["sens12_min"], c["sens12_max"]))
show("dn off-line", c["dn_offline"])
show("dn off-chain", c["dn_offchain"])
show("up off-chain", c["up_offchain"])
show("dn pos diff max", c["dn_pos_diff_max"])
show("line flag", line_flag)
for cs in cases:
    print("  ", {k: v for k, v in cs.items()})
show("session flags", c["session_flags"])
show("sim", (c["sim_line_peak"], c["sim_line_trough"], c["sim_path_violations"], c["sim_line_violations"],
             c["sim_cal_violations"], c["sim_ambiguity"], c["sim_max_offchain"], c["sim_len"]))
show("phone", {k: v for k, v in out["phone"].items() if k != "rows"})
for p in phone:
    print("  ", p)
