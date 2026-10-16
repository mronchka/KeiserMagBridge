"""Method test bench: score different ways of turning raw magnetometer
readings into a lever position, on the same recordings.

Usage:
  py -3 bench/method_bench.py [LOG] [CLICKS] [--out DIR]
  defaults: bench/logs/2026-10-15_cadence_test.log + _clicks.json

Input: a 50 Hz raw USB log (R lines from the sketch's 'r' stream, with the
logger's "### clock" lines) and the Bike Test Panel clicks for it.

Every method turns the raw stream into an estimate of the field due to the
lever. All are scored on the same scale: lever position in uT along the
lever direction (the main direction of the lever sweep), 0 = the sweep's
lever-down reading.

Measures
- Precision: spread of a method's output while the lever is not moving
  (sd and 1-99 % spread), on a 0.1 s grid. Pedalling plateaus come from
  the gear-change step (stretches between shifts) and the easy / fast
  steps; "still" is the hands-off step.
- Resolution: the smallest lever change a method can tell apart from its
  own wobble, taken as 4 x its pedalling sd (about 95 % separation), and
  how many of the recorded gear steps are larger than that.
- Accuracy: bias of a method's average over a plateau against that
  plateau's reference. Reference = mean raw field over all whole pedal
  turns inside the plateau (many turns, so the crank magnet averages out).
  Note: the per-turn methods use the same turn boundaries, so their bias
  is near zero by construction; the test is how far the OTHER methods sit
  from this reference.
- Delay: time from the end of one plateau to the output reaching 90 % of
  the next plateau's reference.
- Stopped bias: after pedalling stops (coast step), how far each method's
  output moves from the last pedalling reference at the same lever.
- Turn counting: detected turns vs hand counts, and cadence vs console.
Each method is also run on the same data with simulated Bluetooth stalls
(the v3 firmware problem) to measure robustness.
"""
import argparse
import json
import math
import os
import random
import re
import statistics as st

# ============================================================== loading
R_RE = re.compile(r"^\s*([\d.]+)\s+R,(\d+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)")
CLK_RE = re.compile(r"^\s*([\d.]+)\s+### clock (\d+)")


def linfit(xs, ys):
    mx, my = st.mean(xs), st.mean(ys)
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sum((x - mx) ** 2 for x in xs)
    return my - b * mx, b


def load_log(path):
    samples, clocks = [], []
    for line in open(path, encoding="utf-8"):
        m = R_RE.match(line)
        if m:
            samples.append({"rel": float(m[1]), "ms": int(m[2]),
                            "raw": (float(m[3]), float(m[4]), float(m[5]))})
            continue
        m = CLK_RE.match(line)
        if m:
            clocks.append((float(m[1]), int(m[2])))
    a1, b1 = linfit([c[0] for c in clocks], [c[1] for c in clocks])
    a2, b2 = linfit([s["ms"] for s in samples], [a1 + b1 * s["rel"] for s in samples])
    for s in samples:
        s["t"] = (a2 + b2 * s["ms"]) / 1000.0        # epoch seconds, board-timed
    return samples


def load_clicks(path):
    return json.load(open(path, encoding="utf-8"))


def step_window(clicks, step):
    dn = [e for e in clicks if e["step"] == step and e["action"] == "done"]
    if not dn:
        return None
    t1 = dn[-1]["ts"] / 1000
    t0 = max(e["ts"] / 1000 for e in clicks if e["step"] == step and e["action"] == "start"
             and e["ts"] / 1000 < t1)
    return t0, t1, dn[-1]


# ============================================================== vector helpers
def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def mean3(vs):
    n = len(vs)
    return (sum(v[0] for v in vs) / n, sum(v[1] for v in vs) / n, sum(v[2] for v in vs) / n)


def main_dir(vs, seed=(1.0, 0.3, 0.2)):
    m = mean3(vs)
    C = [[sum((v[i] - m[i]) * (v[j] - m[j]) for v in vs) / len(vs) for j in range(3)] for i in range(3)]
    u = list(seed)
    for _ in range(60):
        w = [sum(C[i][j] * u[j] for j in range(3)) for i in range(3)]
        n = math.sqrt(dot(w, w))
        u = [x / n for x in w]
    return tuple(u)


# ============================================================== turn detector (mirrors sketch v3 / replay_v3.py)
LEARN_S, DIP_FRAC, REARM_FRAC, REFRACT_MS = 10.0, 0.5, 0.25, 200
TIMEOUT_MS, STALL_MIN_MS, QEMA_TAU_MS, DEPTH_ADAPT = 3000, 1200, 1000, 0.1


def learn_crank(raws):
    u = main_dir(raws)
    p = sorted(dot(r, u) for r in raws)
    n = len(p)
    med = p[n // 2]
    below, above = med - p[n // 100], p[n - 1 - n // 100] - med
    sign = 1 if below >= above else -1
    return {"u": u, "sign": sign, "depth": max(below, above),
            "base": st.mean(sign * dot(r, u) for r in raws)}


def detect_turns(samples, crank):
    """Run the sketch's detector over samples. Returns (boundary times, full turns).
    A full turn is (t_end, period_s, avg_raw, n_samples)."""
    u, sign = crank["u"], crank["sign"]
    depth = crank["depth"]
    base = qema = crank["base"]
    armed, dip_max, dip_start = True, 0.0, 0
    have_b, last_b, last_per, last_ms = False, 0, 1000, None
    acc, accq, n = [0.0, 0.0, 0.0], 0.0, 0
    bounds, turns = [], []
    for s in samples:
        ms, raw = s["ms"], s["raw"]
        q = sign * dot(raw, u)
        acc = [acc[0] + raw[0], acc[1] + raw[1], acc[2] + raw[2]]
        accq += q
        n += 1
        dt = 20 if last_ms is None else ms - last_ms
        last_ms = ms
        qema += min(1.0, dt / QEMA_TAU_MS) * (q - qema)
        if not have_b or ms - last_b > max(2.5 * last_per, STALL_MIN_MS):
            base = qema
            if not armed and ms - dip_start > TIMEOUT_MS:
                armed = True
        d = base - q
        if armed:
            if d > DIP_FRAC * depth and (not have_b or ms - last_b >= REFRACT_MS):
                armed, dip_max, dip_start = False, d, ms
            continue
        dip_max = max(dip_max, d)
        if d >= REARM_FRAC * depth:
            continue
        armed = True
        depth += DEPTH_ADAPT * (dip_max - depth)
        depth = min(max(depth, 0.5 * crank["depth"]), 2 * crank["depth"])
        bounds.append(s["t"])
        if have_b and ms - last_b <= TIMEOUT_MS and n:
            turns.append((s["t"], (ms - last_b) / 1000.0, (acc[0] / n, acc[1] / n, acc[2] / n), n))
            base = accq / n
            last_per = ms - last_b
        have_b, last_b = True, ms
        acc, accq, n = [0.0, 0.0, 0.0], 0.0, 0
    return bounds, turns


# ============================================================== methods
# Each method takes the sample list and returns a list of (t, field_estimate)
# "update points"; the output is held between updates.
def m_sketch_smoothing(samples, ctx):
    """v1/v2 sketch: median of 5 + EMA (alpha 0.15 per 20 ms, ~130 ms)."""
    out, buf, ema = [], [], None
    for s in samples:
        buf = (buf + [s["raw"]])[-5:]
        med = tuple(sorted(b[k] for b in buf)[len(buf) // 2] for k in range(3))
        ema = med if ema is None else tuple(e + 0.15 * (m - e) for e, m in zip(ema, med))
        out.append((s["t"], ema))
    return out


def m_ema(tau_s):
    def f(samples, ctx):
        out, ema, last = [], None, None
        for s in samples:
            dt = 0.02 if last is None else s["t"] - last
            last = s["t"]
            a = min(1.0, dt / tau_s)
            ema = s["raw"] if ema is None else tuple(e + a * (r - e) for e, r in zip(ema, s["raw"]))
            out.append((s["t"], ema))
        return out
    f.__doc__ = f"Plain smoothing, {tau_s:g} s time constant."
    return f


def m_boxcar(win_s):
    def f(samples, ctx):
        out, q, acc = [], [], [0.0, 0.0, 0.0]
        for s in samples:
            q.append(s)
            acc = [a + r for a, r in zip(acc, s["raw"])]
            while q[-1]["t"] - q[0]["t"] > win_s:
                old = q.pop(0)
                acc = [a - r for a, r in zip(acc, old["raw"])]
            out.append((s["t"], tuple(a / len(q) for a in acc)))
        return out
    f.__doc__ = f"Moving average over the last {win_s:g} s."
    return f


def m_per_turn(k_turns):
    def f(samples, ctx):
        _, turns = detect_turns(samples, ctx["crank"])
        out, hist = [], []
        for t, per, avg, n in turns:
            hist = (hist + [(avg, n)])[-k_turns:]
            tot = sum(w for _, w in hist)
            out.append((t, tuple(sum(a[k] * w for a, w in hist) / tot for k in range(3))))
        return out
    f.__doc__ = ("Average over each pedal turn (sketch v3)" if k_turns == 1
                 else f"Average over the last {k_turns} pedal turns")
    return f


def m_crank_blind(samples, ctx):
    """Sketch smoothing, then ignore the crank's main direction."""
    return m_sketch_smoothing(samples, ctx)          # projection handled in scoring


METHODS = [
    ("sketch_now", "Sketch v1/v2 smoothing (130 ms)", m_sketch_smoothing, "lever"),
    ("ema_1s", "Plain smoothing, 1 s", m_ema(1.0), "lever"),
    ("ema_2s", "Plain smoothing, 2 s", m_ema(2.0), "lever"),
    ("box_2s", "Moving average, 2 s", m_boxcar(2.0), "lever"),
    ("crank_blind", "Smoothing + crank-blind direction", m_crank_blind, "blind"),
    ("turn_1", "Per-turn average (v3)", m_per_turn(1), "lever"),
    ("turn_2", "Average of last 2 turns", m_per_turn(2), "lever"),
    ("turn_3", "Average of last 3 turns", m_per_turn(3), "lever"),
]


# ============================================================== simulated Bluetooth stalls
def with_stalls(samples, block_ms=80, every_ms=250, seed=1):
    rnd = random.Random(seed)
    out, nxt, blk_end = [], samples[0]["ms"], -1
    for s in samples:
        if s["ms"] >= nxt:
            blk_end = s["ms"] + block_ms * rnd.uniform(0.5, 1.5)
            nxt += every_ms
        if s["ms"] < blk_end:
            continue
        out.append(s)
    return out


# ============================================================== scoring helpers
def held_on_grid(updates, t0, t1, dt=0.1):
    """Output value (held) at each grid time in [t0, t1]."""
    vals, j = [], 0
    t = t0
    while t <= t1:
        while j + 1 < len(updates) and updates[j + 1][0] <= t:
            j += 1
        if updates and updates[j][0] <= t:
            vals.append(updates[j][1])
        t += dt
    return vals


def pctl(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, max(0, int(p * len(xs))))]


# ============================================================== main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("log", nargs="?", default="bench/logs/2026-10-15_cadence_test.log")
    ap.add_argument("clicks", nargs="?", default="bench/logs/2026-10-15_cadence_test_clicks.json")
    ap.add_argument("--out", default="bench/results")
    args = ap.parse_args()
    samples = load_log(args.log)
    clicks = load_clicks(args.clicks)
    win = lambda step: step_window(clicks, step)

    # ---- reference frame: lever direction and zero from the sweep
    t0, t1, _ = win("sweep")
    sweep = [s["raw"] for s in samples if t0 <= s["t"] <= t1]
    L = main_dir(sweep)
    pS = [dot(r, L) for r in sweep]
    if pS[-1] < pS[0] and max(pS) - pS[0] < pS[0] - min(pS):
        pass
    # orient "up" so the gear-change step (all upshifts) increases
    ts0, ts1, _ = win("shift")
    sh = [s["raw"] for s in samples if ts0 <= s["t"] <= ts1]
    if dot(sh[-1], L) < dot(sh[0], L):
        L = tuple(-x for x in L)
    D = min(sweep, key=lambda r: dot(r, L))
    pos = lambda b: dot(sub(b, D), L)
    span = max(pos(r) for r in sweep) - min(pos(r) for r in sweep)

    # ---- crank model learned like the sketch: first 10 s of fast pedalling
    tf0, tf1, _ = win("fast30")
    crank = learn_crank([s["raw"] for s in samples if tf0 <= s["t"] <= tf0 + LEARN_S])
    ctx = {"crank": crank}
    # crank-blind scoring direction: lever direction with the crank's main
    # direction removed, rescaled so a lever move reads the same size
    u1 = crank["u"]
    w = sub(L, tuple(dot(L, u1) * x for x in u1))
    w_scale = dot(w, L)                                   # = 1 - (L.u1)^2
    pos_blind = lambda b: dot(sub(b, D), w) / w_scale

    # ---- reference plateaus from whole turns (no stalls)
    _, ref_turns = detect_turns(samples, crank)
    SETTLE_TURNS = 3                     # every method gets the same settling allowance
    def plateaus_in(t_a, t_b, max_jump=1.5, min_turns=SETTLE_TURNS + 3):
        tw = [x for x in ref_turns if t_a <= x[0] <= t_b]
        groups, cur = [], []
        for x in tw:
            if cur and abs(pos(x[2]) - pos(cur[-1][2])) >= max_jump:
                groups.append(cur)
                cur = []
            cur.append(x)
        if cur:
            groups.append(cur)
        out = []
        for g in groups:
            if len(g) < min_turns:
                continue
            inner = g[1:-1]                               # drop edge turns
            tot = sum(x[3] for x in inner)
            ref = tuple(sum(x[2][k] * x[3] for x in inner) / tot for k in range(3))
            out.append({"t0": g[SETTLE_TURNS][0],          # scored from here (after settling)
                        "t1": g[-2][0],                   # to the end of the last kept turn
                        "t_last": g[-1][0],               # last turn before the next jump
                        "ref": ref, "turns": len(inner),
                        "rpm": st.median(60 / x[1] for x in inner)})
        return out

    pl_shift = plateaus_in(ts0, ts1)
    te0, te1, de = win("easy20")
    pl_easy = plateaus_in(te0, te1, max_jump=3.0)
    pl_fast = plateaus_in(tf0, tf1, max_jump=3.0)
    steps = [pos(b["ref"]) - pos(a["ref"]) for a, b in zip(pl_shift, pl_shift[1:])]
    tst0, tst1, _ = win("still")
    tc0, tc1, _ = win("coast")

    print(f"Lever direction from the sweep: span {span:.1f} uT. Crank learned: depth {crank['depth']:.1f} uT.")
    print(f"Reference plateaus: {len(pl_shift)} in the gear-change step "
          f"({min(p['rpm'] for p in pl_shift):.0f}-{max(p['rpm'] for p in pl_shift):.0f} rpm), "
          f"{len(pl_easy)} easy, {len(pl_fast)} fast.")
    print(f"Gear steps between plateaus: {len(steps)}, from {min(abs(x) for x in steps):.1f} "
          f"to {max(abs(x) for x in steps):.1f} uT (median {st.median(abs(x) for x in steps):.1f}).\n")

    # ---- run every method, clean and with stalls
    stalled = with_stalls(samples)
    rows = []
    for key, label, fn, scale in METHODS:
        P = pos_blind if scale == "blind" else pos
        for cond, data in (("clean", samples), ("stalls", stalled)):
            ups = [(t, P(b)) for t, b in fn(data, ctx)]
            r = {"method": key, "label": label, "condition": cond}

            def plateau_stats(pls):
                sds, p2ps, biases = [], [], []
                for p in pls:
                    vals = held_on_grid(ups, p["t0"], p["t1"])
                    if len(vals) < 10:
                        continue
                    ref = P(p["ref"])
                    sds.append(st.pstdev(vals))
                    p2ps.append(pctl(vals, 0.99) - pctl(vals, 0.01))
                    biases.append(st.mean(vals) - ref)
                return sds, p2ps, biases

            sds, p2ps, biases = plateau_stats(pl_shift)
            r["sd_ped"] = st.median(sds) if sds else float("nan")
            r["p2p_ped"] = st.median(p2ps) if p2ps else float("nan")
            r["bias_abs_med"] = st.median(abs(b) for b in biases) if biases else float("nan")
            r["bias_abs_max"] = max(abs(b) for b in biases) if biases else float("nan")
            for name, pls in (("easy", pl_easy), ("fast", pl_fast)):
                s2, _, _ = plateau_stats(pls)
                r[f"sd_{name}"] = st.median(s2) if s2 else float("nan")
            # still (hands off, not pedalling)
            vals = held_on_grid(ups, tst0 + 5, tst1 - 1)
            r["sd_still"] = st.pstdev(vals) if len(vals) > 5 else float("nan")
            # resolution
            r["resolution"] = 4 * r["sd_ped"]
            r["steps_resolved"] = sum(1 for x in steps if abs(x) >= r["resolution"])
            r["steps_total"] = len(steps)
            # delay: from the last turn before a jump to 90 % of the way to
            # the next plateau; only for steps this method can resolve
            lags = []
            for a, b in zip(pl_shift, pl_shift[1:]):
                ra, rb = P(a["ref"]), P(b["ref"])
                if abs(rb - ra) < r["resolution"]:
                    continue
                target = ra + 0.9 * (rb - ra)
                for t, v in ups:
                    if t <= a["t_last"]:
                        continue
                    if t > b["t1"]:
                        break
                    if (rb > ra and v >= target) or (rb < ra and v <= target):
                        lags.append(t - a["t_last"])
                        break
            r["delay_med"] = st.median(lags) if lags else float("nan")
            # stopped bias: last pedalling turns before the coast stop vs
            # the output once the crank has been still for a few seconds
            steady = [x for x in ref_turns if tc0 - 12 <= x[0] <= tc0]   # pedalling before 'stop'
            after = [x for x in ref_turns if tc0 < x[0] <= tc1 + 5]
            if steady:
                tot = sum(x[3] for x in steady)
                ref_c = P(tuple(sum(x[2][k] * x[3] for x in steady) / tot for k in range(3)))
                stop_t = (after or steady)[-1][0]                       # last turn while coasting
                vals = held_on_grid(ups, stop_t + 3, min(tc1 + 5, stop_t + 8))
                r["stopped_bias"] = (st.mean(vals) - ref_c) if vals else float("nan")
            else:
                r["stopped_bias"] = float("nan")
            rows.append(r)

    # ---- turn counting
    print("Turn counting (sketch v3 detector):")
    for cond, data in (("clean", samples), ("stalls", stalled)):
        b, turns = detect_turns(data, crank)
        parts = []
        for step in ("slow10", "easy20", "fast30"):
            a0, a1, d = win(step)
            bw = [t for t in b if a0 <= t <= a1]
            rpm = 60 * (len(bw) - 1) / (bw[-1] - bw[0]) if len(bw) > 1 else float("nan")
            parts.append(f"{step}: {len(bw) - 1} turns (counted {d.get('counted')}), "
                         f"{rpm:.1f} rpm (console {d.get('consoleRpm', '-')})")
        print(f"  {cond:6s} " + "; ".join(parts))
    print()

    # ---- table
    hdr = ("Method", "Cond", "Wobble sd ped", "Spread ped", "sd easy", "sd fast", "sd still",
           "Resolution", "Steps", "Bias med", "Bias max", "Delay", "Stopped bias")
    fmt = "{:<36} {:<6} {:>8} {:>8} {:>7} {:>7} {:>8} {:>8} {:>6} {:>8} {:>8} {:>6} {:>8}"
    print(fmt.format(*hdr))
    for r in rows:
        print(fmt.format(r["label"][:36], r["condition"], f"{r['sd_ped']:.2f}", f"{r['p2p_ped']:.1f}",
                         f"{r['sd_easy']:.2f}", f"{r['sd_fast']:.2f}", f"{r['sd_still']:.2f}",
                         f"{r['resolution']:.1f}", f"{r['steps_resolved']}/{r['steps_total']}",
                         f"{r['bias_abs_med']:.2f}", f"{r['bias_abs_max']:.2f}",
                         (f"{r['delay_med']:.1f}s" if r["delay_med"] == r["delay_med"] else "n/a"), f"{r['stopped_bias']:+.1f}"))
    print("\nAll values in uT of lever position, except Steps (gear steps larger than the resolution) "
          "and Delay (seconds).")

    os.makedirs(args.out, exist_ok=True)
    base = os.path.join(args.out, "method_bench_" + os.path.basename(args.log).replace(".log", ""))
    with open(base + ".csv", "w", encoding="utf-8") as f:
        keys = list(rows[0].keys())
        f.write(",".join(keys) + "\n")
        for r in rows:
            f.write(",".join(str(r[k]) if not isinstance(r[k], float) else f"{r[k]:.4f}" for k in keys) + "\n")
    with open(base + "_steps.csv", "w", encoding="utf-8") as f:
        f.write("plateau,t0,t1,turns,rpm,ref_pos_uT,step_from_previous_uT\n")
        prev = None
        for i, p in enumerate(pl_shift):
            v = pos(p["ref"])
            f.write(f"{i + 1},{p['t0']:.2f},{p['t1']:.2f},{p['turns']},{p['rpm']:.1f},{v:.2f},"
                    f"{'' if prev is None else f'{v - prev:.2f}'}\n")
            prev = v
    print(f"Results written to {base}.csv and {base}_steps.csv")


if __name__ == "__main__":
    main()
