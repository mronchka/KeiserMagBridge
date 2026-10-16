"""Simulate removing the Keiser crank-magnet effect, using the crank field
measured during the slow crank turn at spot 1 (2026-10-15 log).

Usage: py -3 bench/sim_crank.py bench/logs/2026-10-15_spot1_below_magnet.log

1. Builds C(angle): the crank's field vs crank angle, from the slow hand
   turn (pauses at 1/4 and 1/2 turn anchor the angle), as a 3-harmonic
   Fourier fit per axis.
2. Simulates 60 s of riding at 50 Hz: lever at a middle gear with one gear
   step at 30 s, cadence 85 rpm +/- 5 drifting, +/- 7 % speed wobble within
   each pedal stroke, 0.3 uT raw noise, and the sketch's median-5 + EMA.
3. Runs each correction method and reports the error in lever position
   (uT along the lever direction) after a pedalling calibration absorbs
   any constant offset.
"""
import math
import random
import re
import statistics as st
import sys

LOG = sys.argv[1]
SCALE_RUNS = [1.0, 0.1]            # crank amplitude: spot 1, and a 10x weaker spot

PAT = re.compile(r"^\s*([\d.]+)\s+B=\(\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\)uT")
rows = [(float(m[1]), (float(m[2]), float(m[3]), float(m[4])))
        for m in map(PAT.match, open(LOG, encoding="utf-8")) if m]


def mean(v):
    return [sum(c) / len(v) for c in zip(*v)]


def sub(a, b):
    return [x - y for x, y in zip(a, b)]


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


# ---------------------------------------------------------------- lever axis
D = mean([p for t, p in rows if 299 <= t <= 302])
F = mean([p for t, p in rows if 339 <= t <= 343])
LV = sub(F, D)
LN = math.sqrt(dot(LV, LV))
LU = [x / LN for x in LV]

# ---------------------------------------------------------------- crank model
# Angle anchors (log s -> degrees): pauses found at 1/4 and 1/2 turn.
ANCH = [(1587.5, 0), (1594.1, 90), (1595.5, 90), (1602.0, 180), (1605.0, 180), (1620.2, 360)]


def angle_at(t):
    for (t0, a0), (t1, a1) in zip(ANCH, ANCH[1:]):
        if t0 <= t <= t1:
            return a0 + (a1 - a0) * (t - t0) / (t1 - t0) if t1 > t0 else a0
    return None


samp = [(math.radians(angle_at(t)), p) for t, p in rows if 1587.5 <= t <= 1620.2]
c0 = mean([p for _, p in samp])
K = 3


def basis(th):
    out = [1.0]
    for k in range(1, K + 1):
        out += [math.cos(k * th), math.sin(k * th)]
    return out


def solve(A, b):
    n = len(b)
    M = [row[:] + [bv] for row, bv in zip(A, b)]
    for i in range(n):
        piv = max(range(i, n), key=lambda r: abs(M[r][i]))
        M[i], M[piv] = M[piv], M[i]
        for r in range(n):
            if r != i:
                f = M[r][i] / M[i][i]
                M[r] = [x - f * y for x, y in zip(M[r], M[i])]
    return [M[i][n] / M[i][i] for i in range(n)]


coef = []
for ax in range(3):
    X = [basis(th) for th, _ in samp]
    y = [p[ax] - c0[ax] for _, p in samp]
    A = [[sum(r[i] * r[j] for r in X) for j in range(len(X[0]))] for i in range(len(X[0]))]
    b = [sum(r[i] * yy for r, yy in zip(X, y)) for i in range(len(X[0]))]
    coef.append(solve(A, b))
fit_err = [math.dist([dot(basis(th), coef[a]) for a in range(3)], sub(p, c0)) for th, p in samp]


def crank_field(th, scale):
    b = basis(th)
    return [scale * (dot(b, coef[a]) - coef[a][0]) for a in range(3)]   # zero-mean loop


along = [dot(crank_field(math.radians(a), 1.0), LU) for a in range(360)]
print(f"Crank model from the slow turn: fit error median {st.median(fit_err):.1f} uT, "
      f"max {max(fit_err):.1f} uT (includes the 6 uT loop gap and hand movement).")
print(f"Model swing along the lever direction: {max(along) - min(along):.1f} uT "
      f"(min {min(along):.1f}, max {max(along):.1f} around its mean).")
print(f"=> A calibration done while STOPPED could be off by anywhere from {min(along):.1f} to "
      f"{max(along):.1f} uT, depending on where the crank was parked.\n")


# ---------------------------------------------------------------- simulation
def simulate(scale, seed=1):
    rnd = random.Random(seed)
    dt, T = 0.001, 60.0
    th, t = 0.0, 0.0
    phiW = 1.0                         # Wahoo's "revolution done" angle (rad)
    raws, truths, thetas, times = [], [], [], []
    events = []                        # Wahoo revolution times
    revs = 0
    next_sample = 0.0
    while t < T:
        cad = 85 + 5 * math.sin(2 * math.pi * t / 20)
        w = 2 * math.pi * cad / 60 * (1 + 0.07 * math.cos(2 * th))
        th_new = th + w * dt
        if math.floor((th_new - phiW) / (2 * math.pi)) > math.floor((th - phiW) / (2 * math.pi)):
            revs += 1
            events.append((t + dt, revs))
        th = th_new
        t += dt
        if t >= next_sample:
            next_sample += 0.020
            s_true = 60.0 if t < 30 else 66.0           # one gear step at 30 s
            lever = [D[a] + LU[a] * s_true for a in range(3)]
            cf = crank_field(th, scale)
            raw = [lever[a] + cf[a] + rnd.gauss(0, 0.3) for a in range(3)]
            raws.append(raw); truths.append(s_true); thetas.append(th % (2 * math.pi)); times.append(t)
    return times, raws, truths, thetas, events, phiW


def sketch_filter(raws, alpha=0.15):
    out, buf, ema = [], [], None
    for r in raws:
        buf.append(r); buf = buf[-5:]
        med = [sorted(b[a] for b in buf)[len(buf) // 2] for a in range(3)]
        ema = med if ema is None else [e + alpha * (m - e) for e, m in zip(ema, med)]
        out.append(ema)
    return out


def proj(v):
    return dot(sub(v, D), LU)


def wahoo_reports(events, times):
    """1 Hz notifications: (receive time, cumulative revs, last event time)."""
    reps, k = [], 0
    for tr in [i * 1.0 for i in range(1, 61)]:
        while k < len(events) and events[k][0] <= tr:
            k += 1
        if k:
            reps.append((tr, events[k - 1][1], events[k - 1][0]))
    return reps


def score(name, est, truths, times, lag_ref=None):
    # A pedalling calibration absorbs a constant offset: learn it on 5-25 s.
    cal = [e - tr for e, tr, t in zip(est, truths, times) if 5 <= t <= 25 and e is not None]
    bias = st.mean(cal)
    err = [e - bias - tr for e, tr, t in zip(est, truths, times)
           if e is not None and 10 <= t <= 60 and not 30 <= t < 33]
    err.sort()
    p2p = err[int(0.99 * len(err))] - err[int(0.01 * len(err))]
    rms = math.sqrt(sum(e * e for e in err) / len(err))
    # step response: time after 30 s to reach 90 % of the 6 uT step
    lag = None
    for e, t in zip(est, times):
        if t >= 30 and e is not None and e - bias >= 60 + 0.9 * 6:
            lag = t - 30
            break
    lag_s = f"{lag:4.1f} s" if lag is not None else "  n/a"
    print(f"  {name:48s} error rms {rms:5.2f} uT, 1-99% spread {p2p:5.1f} uT (~{rms * 3.8:4.1f} W rms), "
          f"gear-change delay {lag_s}")


def autocorr_period(sig, fs=50.0, lo=0.5, hi=1.25):
    m = st.mean(sig)
    x = [v - m for v in sig]
    best, bl = -1e9, None
    for lag in range(int(lo * fs), int(hi * fs) + 1):
        c = sum(x[i] * x[i + lag] for i in range(len(x) - lag)) / (len(x) - lag)
        if c > best:
            best, bl = c, lag
    return bl / fs


V1 = [-0.97, -0.03, 0.23]              # main crank direction (from the slow turn)

for scale in SCALE_RUNS:
    times, raws, truths, thetas, events, phiW = simulate(scale)
    filt = sketch_filter(raws)
    meds = sketch_filter(raws, alpha=1.0)          # median only, no EMA
    label = "SPOT 1 (crank swing as measured)" if scale == 1.0 else "A SPOT WITH A 10x WEAKER CRANK EFFECT"
    print(f"=== {label} ===")

    # M0: sketch as-is
    score("Sketch smoothing only (130 ms)", [proj(v) for v in filt], truths, times)

    # M0b: heavy smoothing, 2 s EMA
    a2 = 0.020 / 2.0
    heavy = sketch_filter(raws, alpha=a2)
    score("Heavy smoothing only (2 s)", [proj(v) for v in heavy], truths, times)

    # M1: cadence from the swings (autocorrelation on main crank direction)
    sig = [dot(v, V1) for v in filt]
    cad_err = []
    period_at = {}
    for k in range(200, len(sig), 25):              # 4 s windows, every 0.5 s
        p = autocorr_period(sig[k - 200:k])
        t = times[k]
        true_cad = 85 + 5 * math.sin(2 * math.pi * t / 20)
        cad_err.append(60 / p - true_cad)
        period_at[k] = p
    print(f"  Cadence detected from the swings (4 s windows): error median {st.median(abs(e) for e in cad_err):.1f} rpm, "
          f"worst {max(abs(e) for e in cad_err):.1f} rpm")

    # M2: average over one revolution, timed by 1 Hz Wahoo reports
    reps = wahoo_reports(events, times)
    est2, j, cur, prev = [], 0, None, None
    for i, t in enumerate(times):
        while j < len(reps) and reps[j][0] <= t:
            tr, rv, te = reps[j]
            if prev and rv > prev[1]:
                per = (te - prev[2]) / (rv - prev[1])
                win = [proj(meds[q]) for q, tq in enumerate(times) if te - per <= tq <= te]
                if win:
                    cur = st.mean(win)
            prev = (tr, rv, te)
            j += 1
        est2.append(cur)
    score("Average over 1 pedal turn (Wahoo timing)", est2, truths, times)

    # M3: average over the last detected period, sliding (self-detected cadence)
    est3, p = [], None
    for i in range(len(times)):
        if i in period_at:
            p = period_at[i]
        if p is None:
            est3.append(None); continue
        n = max(1, round(p / 0.020))
        win = meds[max(0, i - n + 1):i + 1]
        est3.append(proj(mean(win)))
    score("Average over 1 pedal turn (cadence from swings)", est3, truths, times)

    # M4: predict and subtract from each RAW sample (before the median/EMA),
    # angle extrapolated from the last Wahoo report (model and Wahoo phase
    # assumed known exactly: best case).
    corr4, j, prev, last, ok4 = [], 0, None, None, []
    for i, t in enumerate(times):
        while j < len(reps) and reps[j][0] <= t:
            if prev and reps[j][1] > prev[1]:
                last = (reps[j][2], (reps[j][2] - prev[2]) / (reps[j][1] - prev[1]))
            prev = reps[j]
            j += 1
        ok4.append(last is not None)
        if last is None:
            corr4.append(raws[i]); continue
        te, per = last
        th_hat = phiW + 2 * math.pi * (t - te) / per
        corr4.append(sub(raws[i], crank_field(th_hat, scale)))
    est4 = [proj(v) if ok else None for v, ok in zip(sketch_filter(corr4), ok4)]
    score("Predict & subtract (angle from Wahoo, best case)", est4, truths, times)

    # M5: predict and subtract with the TRUE angle (the floor: noise only)
    corr5 = [sub(raws[i], crank_field(thetas[i], scale)) for i in range(len(times))]
    score("Predict & subtract with perfect angle (ideal)", [proj(v) for v in sketch_filter(corr5)], truths, times)
    print()
