"""Host model of KeiserMagBridge_v3_1.ino (sample pipeline, crank learning,
turn detector, calibration state machine, power, Zwift packet).

A line-by-line port of the sketch, written for review/testing only: every
function names the sketch function it mirrors. uint32 time arithmetic is
done with explicit 32-bit wrap (u32) so millis() wrap can be tested.
Floats are Python doubles (the board uses float32; differences are far
below the thresholds that matter here).

Not modelled: BLE, LEDs, speaker, diagnostics recording, flash.
"""
import math

M32 = 0xFFFFFFFF


def u32(x):
    return x & M32


# ----------------------------------------------------------------- constants (sketch lines 131-189)
SAMPLE_PERIOD_MS = 20
NOTIFY_PERIOD_MS = 500
EMA_ALPHA = 0.15
HYST_FRACTION = 0.20
GEAR_DWELL_MS = 150
CADENCE_TIMEOUT_MS = 3000
CAPTURE_SAMPLES = 32
MIN_SPAN_UT = 20.0
MIN_STEP_WARN_UT = 1.5
MIN_STEP_REJECT_UT = 0.3
FOLD_MARGIN_UT = 1.0
AUTO_STABLE_UT = 0.6
AUTO_STABLE_MS = 2000
AUTO_MIN_MOVE_UT = 1.0
OFFPATH_HOLD_UT = 8.0
OFFPATH_HOLD_MAX_MS = 2000
LEARN_MAX_SAMPLES = 750
LEARN_FIRST_PROBE = 100
LEARN_PROBE_EVERY = 25
LEARN_TARGET_TURNS = 6
LEARN_MIN_TURNS = 4
LEARN_REG_LO = 0.75
LEARN_REG_HI = 1.33
LEARN_REG_SHARE = 0.75
LEARN_MAX_RPM = 130.0
CRANK_MIN_DEPTH_UT = 8.0
DIP_FRAC = 0.5
REARM_FRAC = 0.25
REFRACT_MS = 200
STALL_MIN_MS = 1200
QEMA_TAU_MS = 1000.0
DEPTH_ADAPT = 0.1
TURN_AGREE_UT = 2.0
TURN_MOVE_UT = 1.0
SUSPECT_DRIFT_UT = 1.0
SUSPECT_CREEP_UT = 0.8
SUSPECT_DRIFT_SLOW_UT = 0.4
SETTLE_GIVEUP_MS = 15000
NUM_GEARS = 24

GEAR_EDGES = [0.00, 7.51, 11.40, 14.59, 18.57, 20.12, 23.32, 24.87,
              27.03, 29.53, 31.87, 34.20, 36.70, 39.72, 42.83, 46.03,
              49.14, 53.11, 56.99, 60.97, 66.49, 72.02, 78.41, 89.38, 100.00]
POWER90 = [20.9, 24.3, 27.7, 33.5, 40.4, 45.0, 54.3, 61.3,
           71.7, 84.4, 98.3, 118.0, 136.6, 163.3, 193.4, 225.9,
           261.9, 308.3, 360.5, 415.0, 497.4, 577.5, 671.5, 796.8, 878.0]
PC2, PB2, PA2 = -2.70E-03, 6.79E-03, 4.75E-05

CAL_IDLE, CAL_WAITING, CAL_CAPTURING, CAL_LEARN, CAL_CONFIRM, CAL_POINT_CHECK = range(6)


def dot3(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def dist3(a, b):
    return math.sqrt(sum((a[k] - b[k]) ** 2 for k in range(3)))


def constrain(x, lo, hi):
    return lo if x < lo else hi if x > hi else x


def dist_to_segment(b, a, c):
    seg = [c[k] - a[k] for k in range(3)]
    rel = [b[k] - a[k] for k in range(3)]
    L2 = dot3(seg, seg)
    u = dot3(rel, seg) / L2 if L2 > 0 else 0
    u = constrain(u, 0.0, 1.0)
    d = [rel[k] - u * seg[k] for k in range(3)]
    return math.sqrt(dot3(d, d)), u


def interp_table(x, y, xq):
    if xq <= x[0]:
        return y[0]
    if xq >= x[-1]:
        return y[-1]
    for i in range(1, len(x)):
        if xq < x[i]:
            f = (xq - x[i - 1]) / (x[i] - x[i - 1])
            return y[i - 1] + f * (y[i] - y[i - 1])
    return y[-1]


class Firmware:
    """State of the sketch's globals plus the functions that touch them."""

    def __init__(self, cal=None, millis0=0):
        self.out = []                    # (ms, line) printed by the board
        self.ms_now = millis0            # millis() as loop() sees it
        # crank params (struct CrankParams)
        self.crank = dict(ok=False, sign=1, u=[1.0, 0.0, 0.0], depth=0.0, base=0.0)
        self.cal = cal                   # dict like CalData or None
        self.calValid = cal is not None
        # signal chain
        self.medianBuf = [[0.0] * 5 for _ in range(3)]
        self.medianIdx = 0
        self.medianFill = 0
        self.fieldUT = [0.0, 0.0, 0.0]
        self.emaSeeded = False
        self.saturated = False
        self.resistance = 0.0
        self.offPath = 0.0
        self.offPathHold = False
        self.offPathSince = 0
        self.stableGear = 1
        self.pendingGear = 1
        self.pendingSince = 0
        self.powerW = 0.0
        self.cadenceRpm = 0.0
        # cal state machine
        self.calState = CAL_IDLE
        self.calStep = 0
        self.calRaw = [[0.0, 0.0, 0.0] for _ in range(NUM_GEARS + 1)]
        self.capSum = [0.0, 0.0, 0.0]
        self.capCount = 0
        self.autoCapture = True
        self.stabRef = [0.0, 0.0, 0.0]
        self.stabSince = 0
        self.stabPct = 0
        self.learnBuf = []
        self.learnCount = 0
        self.learnLast = dict(ok=False, turns=0, regular=0, rpm=0.0, depth=0.0, why="no signal")
        # turn detector
        self.crArmed = True
        self.crHaveBoundary = False
        self.crDipMax = 0.0
        self.crDepth = 0.0
        self.crBaseline = 0.0
        self.crQEma = 0.0
        self.crSumQ = 0.0
        self.crSum = [0.0, 0.0, 0.0]
        self.crN = 0
        self.crDipStartMs = 0
        self.crLastBoundaryMs = 0
        self.crLastMs = 0
        self.crLastPeriodMs = 1000
        # self-reported turns
        self.selfRevs = 0
        self.selfEventMs = 0
        self.selfPeriods = [0, 0]
        self.turnHist = []
        # instrumentation (not in the sketch)
        self.boundaries = []             # (ms, result, period)
        self.captures = []               # (ms, step, point)
        self.learn_probes = []           # (learnCount, LearnResult)
        self.load_crank_from_cal()

    # ------------------------------------------------------------- output
    def log(self, line):
        self.out.append((self.ms_now, line))

    def millis(self):
        return self.ms_now

    # ------------------------------------------------------------- crank detector
    def crank_reset(self, base):                                       # crankReset()
        self.crArmed = True
        self.crHaveBoundary = False
        self.crDipMax = 0.0
        self.crDepth = self.crank["depth"]
        self.crBaseline = self.crQEma = base
        self.crSum = [0.0, 0.0, 0.0]
        self.crSumQ = 0.0
        self.crN = 0
        self.crLastMs = 0
        self.crLastPeriodMs = 1000

    def crank_sample(self, now, raw):                                  # crankSample()
        c = self.crank
        q = c["sign"] * dot3(raw, c["u"])
        for k in range(3):
            self.crSum[k] += raw[k]
        self.crSumQ += q
        self.crN += 1
        dt = float(u32(now - self.crLastMs)) if self.crLastMs else float(SAMPLE_PERIOD_MS)
        self.crLastMs = now
        self.crQEma += min(1.0, dt / QEMA_TAU_MS) * (q - self.crQEma)
        stall = max(int(2.5 * self.crLastPeriodMs) & M32, STALL_MIN_MS)
        if not self.crHaveBoundary or u32(now - self.crLastBoundaryMs) > stall:
            self.crBaseline = self.crQEma
            if not self.crArmed and u32(now - self.crDipStartMs) > CADENCE_TIMEOUT_MS:
                self.crArmed = True
        d = self.crBaseline - q
        if self.crArmed:
            gapOk = not self.crHaveBoundary or u32(now - self.crLastBoundaryMs) >= REFRACT_MS
            if d > DIP_FRAC * self.crDepth and gapOk:
                self.crArmed = False
                self.crDipMax = d
                self.crDipStartMs = now
            return 0, None, None
        self.crDipMax = max(self.crDipMax, d)
        if d >= REARM_FRAC * self.crDepth:
            return 0, None, None
        self.crArmed = True
        self.crDepth += DEPTH_ADAPT * (self.crDipMax - self.crDepth)
        self.crDepth = constrain(self.crDepth, 0.5 * c["depth"], 2.0 * c["depth"])
        result, avg, per = 1, None, None
        if self.crHaveBoundary and u32(now - self.crLastBoundaryMs) <= CADENCE_TIMEOUT_MS and self.crN > 0:
            avg = [self.crSum[k] / self.crN for k in range(3)]
            self.crBaseline = self.crSumQ / self.crN
            per = u32(now - self.crLastBoundaryMs)
            self.crLastPeriodMs = per
            result = 2
        self.crHaveBoundary = True
        self.crLastBoundaryMs = now
        self.crSum = [0.0, 0.0, 0.0]
        self.crSumQ = 0.0
        self.crN = 0
        return result, avg, per

    def crank_learn(self, n, atCap, times=None):                     # crankLearn()
        """times: None = the sketch's synthetic 1 + i*20 ms; else real sample times."""
        r = dict(ok=False, turns=0, regular=0, rpm=0.0, depth=0.0, why="no signal")
        buf = self.learnBuf
        m = [sum(buf[i][k] for i in range(n)) / n for k in range(3)]
        C = [[sum((buf[i][a] - m[a]) * (buf[i][b] - m[b]) for i in range(n)) / n for b in range(3)]
             for a in range(3)]
        u = [1.0, 0.3, 0.2]
        for _ in range(50):
            v = [C[a][0] * u[0] + C[a][1] * u[1] + C[a][2] * u[2] for a in range(3)]
            nv = math.sqrt(dot3(v, v))
            if nv <= 0:
                return r
            u = [x / nv for x in v]
        P = sorted(dot3(buf[i], u) for i in range(n))
        med = P[n // 2]
        below, above = med - P[n // 100], P[n - 1 - n // 100] - med
        c = self.crank
        c["sign"] = 1 if below >= above else -1
        c["depth"] = max(below, above)
        c["u"] = list(u)
        c["base"] = sum(c["sign"] * dot3(buf[i], u) for i in range(n)) / n
        maxTurns = LEARN_MAX_SAMPLES // 10
        self.crank_reset(c["base"])
        per_list = []
        for i in range(n):
            t = (1 + (i * 20 * 1000) // 1024) if times is None else times[i]
            res, _, per = self.crank_sample(t, buf[i])
            if res == 2 and len(per_list) < maxTurns:
                per_list.append(min(per, 65535))
        self.crank_reset(c["base"])
        turns = len(per_list)
        r["depth"] = c["depth"]
        r["turns"] = min(turns, 255)
        if turns > 0:
            per_list.sort()
            medPer = float(per_list[turns // 2])
            regular = sum(1 for p in per_list if LEARN_REG_LO * medPer <= p <= LEARN_REG_HI * medPer)
            r["regular"] = min(regular, 255)
            r["rpm"] = 60000.0 / medPer
        if r["depth"] < CRANK_MIN_DEPTH_UT:
            r["why"] = "dip too shallow"
        elif turns < (LEARN_MIN_TURNS if atCap else LEARN_TARGET_TURNS):
            r["why"] = "too few turns"
        elif r["regular"] < LEARN_REG_SHARE * turns:
            r["why"] = "irregular turns"
        elif r["rpm"] > LEARN_MAX_RPM:
            r["why"] = "too fast - counting twice per turn?"
        else:
            r["ok"], r["why"] = True, "ok"
        return r

    def load_crank_from_cal(self):                                    # loadCrankFromCal()
        c = self.crank
        c["ok"] = bool(self.calValid and self.cal and self.cal.get("crankOk"))
        if not c["ok"]:
            return
        c["sign"] = self.cal["crankSign"]
        c["u"] = list(self.cal["crankU"])
        c["depth"] = self.cal["crankDepth"]
        c["base"] = self.cal["crankBase"]
        self.crank_reset(c["base"])

    def pedalling(self):                                               # pedalling()
        return self.crank["ok"] and self.selfRevs > 0 and u32(self.millis() - self.selfEventMs) <= CADENCE_TIMEOUT_MS

    def self_cadence(self):                                            # selfCadence()
        if not self.pedalling() or not self.selfPeriods[0]:
            return 0.0
        p = (self.selfPeriods[0] + self.selfPeriods[1]) // 2 if self.selfPeriods[1] else self.selfPeriods[0]
        return 60000.0 / p

    # ------------------------------------------------------------- calibration
    def stab_reset(self):
        self.stabRef = list(self.fieldUT)
        self.stabSince = self.millis()
        self.stabPct = 0

    def cal_prompt(self):
        self.log(f"[CAL {self.calStep + 1}/25] prompt{' (redo)' if getattr(self, 'calRedo', False) else ''}")
        self.turnHist = []
        self.pendingCap = False
        self.settleSince = 0
        self.stab_reset()

    def cal_learn_start(self):
        self.calState = CAL_LEARN
        self.calStep = 0
        self.learnCount = 0
        self.learnBuf = []
        self.learn_times = []
        self.crank["ok"] = False
        self.stabPct = 0
        self.learnLast = dict(ok=False, turns=0, regular=0, rpm=0.0, depth=0.0, why="no signal")
        self.selfPeriods = [0, 0]

    def cal_start(self):
        self.log("=== Calibration started")
        self.cal_learn_start()

    def cal_relearn(self):
        if self.calState != CAL_CONFIRM and not (self.calState == CAL_WAITING and self.calStep == 0):
            return
        self.log("Learning the crank again.")
        self.cal_learn_start()

    def cal_learn_done(self):
        r = self.learnLast
        self.crank["ok"] = r["ok"]
        self.log("L,%d,%u,%.0f,%.1f,%s" % (1 if r["ok"] else 0, r["turns"], r["rpm"], r["depth"], r["why"]))
        if r["ok"]:
            self.calState = CAL_CONFIRM
            self.stabPct = 100
            return
        self.calState = CAL_WAITING
        self.cal_prompt()

    def cal_learn_probe(self):
        atCap = self.learnCount + LEARN_PROBE_EVERY > LEARN_MAX_SAMPLES
        self.learnLast = self.crank_learn(self.learnCount, atCap,
                                          self.learn_times if getattr(self, "learn_real_time", False) else None)
        self.learn_probes.append((self.learnCount, dict(self.learnLast)))
        self.stabPct = 100 if self.learnLast["ok"] else min(95, self.learnLast["turns"] * 100 // LEARN_TARGET_TURNS)
        if self.learnLast["ok"] or atCap:
            self.cal_learn_done()

    def cal_confirm(self):
        if self.calState != CAL_CONFIRM:
            return
        self.log("Cadence confirmed")
        self.calState = CAL_WAITING
        self.cal_prompt()

    def cal_abort(self, why):
        self.calState = CAL_IDLE
        self.load_crank_from_cal()
        self.log("A," + why)

    def cal_reject(self, msg, span, minStep, minStepAt):
        self.calState = CAL_IDLE
        self.load_crank_from_cal()
        self.log("K,0,%.1f,%.2f,%d,%s" % (span, minStep, minStepAt, msg))

    def cal_finish(self):
        self.calState = CAL_IDLE
        span, minStep, minStepAt = 0.0, 1e9, 1
        for i in range(1, NUM_GEARS + 1):
            step = dist3(self.calRaw[i], self.calRaw[i - 1])
            span += step
            if step < minStep:
                minStep, minStepAt = step, i
        if span < MIN_SPAN_UT:
            return self.cal_reject("signal too small", span, minStep, minStepAt)
        if minStep < MIN_STEP_REJECT_UT:
            return self.cal_reject("points %d and %d are the same - did the lever move?" % (minStepAt, minStepAt + 1),
                                   span, minStep, minStepAt)
        for k in range(NUM_GEARS + 1):
            for j in range(NUM_GEARS):
                if k - 2 <= j <= k + 1:
                    continue
                d, _ = dist_to_segment(self.calRaw[k], self.calRaw[j], self.calRaw[j + 1])
                if d < FOLD_MARGIN_UT:
                    return self.cal_reject("path folds back: point %d is %.1f uT from gear %d's segment" % (k + 1, d, j + 1),
                                           span, minStep, minStepAt)
        c = self.crank
        self.cal = dict(pts=[list(p) for p in self.calRaw], crankOk=1 if c["ok"] else 0, crankSign=c["sign"],
                        crankU=list(c["u"]), crankDepth=c["depth"], crankBase=c["base"])
        self.calValid = True
        self.stableGear = self.pendingGear = 1
        self.log("K,1,%.1f,%.2f,%d,saved" % (span, minStep, minStepAt))

    def cal_on_sample(self, b):
        if self.calState != CAL_CAPTURING:
            return
        if self.saturated:
            return self.cal_abort("magnetometer saturated - move the board farther away")
        for k in range(3):
            self.capSum[k] += b[k]
        self.capCount += 1
        if self.capCount < CAPTURE_SAMPLES:
            return
        self.cal_store_point([self.capSum[k] / CAPTURE_SAMPLES for k in range(3)])

    def cal_store_point(self, b):
        self.calRedo = False
        self.pendingCap = False
        self.settleSince = 0
        self.calRaw[self.calStep] = list(b)
        self.log("C,%d,%.1f,%.1f,%.1f" % (self.calStep + 1, b[0], b[1], b[2]))
        self.captures.append((self.millis(), self.calStep, list(b)))
        self.calStep += 1
        if self.calStep > NUM_GEARS:
            return self.cal_finish()
        self.calState = CAL_WAITING
        self.cal_prompt()

    def turn_hist_mean(self):
        n = len(self.turnHist)
        return [sum(h[k] / n for h in self.turnHist) if n else 0.0 for k in range(3)]

    def cal_on_turn(self, avg):
        if self.calState != CAL_WAITING or not self.crank["ok"]:
            return
        self.lastTurnAvg = list(avg)
        if getattr(self, "settleSince", 0) and u32(self.millis() - self.settleSince) >= SETTLE_GIVEUP_MS:
            self.calState = CAL_POINT_CHECK
            self.pendingCap = False
            self.stabPct = 0
            self.log("P,%d" % (self.calStep + 1))
            return
        if getattr(self, "pendingCap", False):
            self.pendingCap = False
            drift = dot3([avg[k] - self.pendingMean[k] for k in range(3)], self.pendingDir)
            suspect = self.calStep > 0 and (drift >= SUSPECT_DRIFT_UT or
                                            (self.pendingCreep >= SUSPECT_CREEP_UT and drift >= SUSPECT_DRIFT_SLOW_UT))
            if not suspect:
                return self.cal_store_point(self.pendingMean)
            if not getattr(self, "settleSince", 0):
                self.settleSince = self.millis() or 1
            self.log("W,%d,%.1f,%.1f" % (self.calStep + 1, drift, self.pendingCreep))
            self.turnHist = [list(avg)]
            self.stabPct = 34
            return
        if len(self.turnHist) == 3:
            self.turnHist = self.turnHist[1:]
        self.turnHist.append(list(avg))
        while len(self.turnHist) > 1:
            spread = max(dist3(a, b) for i, a in enumerate(self.turnHist) for b in self.turnHist[i + 1:])
            if spread <= TURN_AGREE_UT:
                break
            self.turnHist = self.turnHist[1:]
        mean = self.turn_hist_mean()
        moved = self.calStep == 0 or dist3(mean, self.calRaw[self.calStep - 1]) >= TURN_MOVE_UT
        self.stabPct = min(100, len(self.turnHist) * 34) if moved else 0
        if moved and self.autoCapture and len(self.turnHist) == 3:
            self.pendingMean = list(mean)
            if self.calStep > 0:
                d = [mean[k] - self.calRaw[self.calStep - 1][k] for k in range(3)]
                n = math.sqrt(dot3(d, d))
                self.pendingDir = [x / n if n > 0 else 0.0 for x in d]
                c = [self.turnHist[2][k] - self.turnHist[0][k] for k in range(3)]
                self.pendingCreep = dot3(c, self.pendingDir)
            else:
                self.pendingDir = [0.0, 0.0, 0.0]
                self.pendingCreep = 0.0
            self.pendingCap = True

    def cal_capture(self):
        if self.calState == CAL_CONFIRM:
            return self.cal_confirm()
        if self.calState == CAL_POINT_CHECK:                        # capture anyway
            b = self.turn_hist_mean() if self.turnHist else list(self.lastTurnAvg)
            return self.cal_store_point(b)
        if self.calState != CAL_WAITING:
            return
        if self.crank["ok"]:
            if not self.turnHist:
                self.log("N,noturn")
                return
            mean = self.turn_hist_mean()
            if self.calStep > 0 and dist3(mean, self.calRaw[self.calStep - 1]) < TURN_MOVE_UT:
                self.log("N,notmoved")
                return
            return self.cal_store_point(mean)
        if self.calStep > 0 and dist3(self.fieldUT, self.calRaw[self.calStep - 1]) < AUTO_MIN_MOVE_UT:
            self.log("N,notmoved")
            return
        self.capSum = [0.0, 0.0, 0.0]
        self.capCount = 0
        self.calState = CAL_CAPTURING

    def cal_undo(self):
        if self.calState == CAL_POINT_CHECK:
            self.calState = CAL_WAITING
            self.calRedo = True
            self.log("U,%d" % self.calStep)
            return self.cal_prompt()
        if self.calState != CAL_WAITING or self.calStep == 0:
            return
        self.calStep -= 1
        self.log("U,%d" % self.calStep)
        self.cal_prompt()

    def cal_auto_check(self):
        if self.crank["ok"]:
            return
        if self.calState != CAL_WAITING:
            self.stabPct = 0
            return
        if dist3(self.fieldUT, self.stabRef) > AUTO_STABLE_UT:
            return self.stab_reset()
        moved = self.calStep == 0 or dist3(self.fieldUT, self.calRaw[self.calStep - 1]) >= AUTO_MIN_MOVE_UT
        if not moved:
            self.stabSince = self.millis()
            self.stabPct = 0
            return
        held = u32(self.millis() - self.stabSince)
        self.stabPct = 100 if held >= AUTO_STABLE_MS else held * 100 // AUTO_STABLE_MS
        if self.autoCapture and held >= AUTO_STABLE_MS:
            self.cal_capture()

    # ------------------------------------------------------------- gear
    def locate_on_path(self, b):
        pts = self.cal["pts"]
        best, bestRes = 1e30, 0.0
        for i in range(NUM_GEARS):
            d, t = dist_to_segment(b, pts[i], pts[i + 1])
            if d < best:
                best = d
                bestRes = GEAR_EDGES[i] + t * (GEAR_EDGES[i + 1] - GEAR_EDGES[i])
        return bestRes, best

    def update_gear(self, b, now, useDwell):
        res, off = self.locate_on_path(b)
        self.offPath = off
        if off > OFFPATH_HOLD_UT:
            if not self.offPathHold:
                self.offPathHold, self.offPathSince = True, now
            if u32(now - self.offPathSince) < OFFPATH_HOLD_MAX_MS:
                return
        else:
            self.offPathHold = False
        self.resistance = res
        candidate = self.stableGear
        lo, hi = GEAR_EDGES[self.stableGear - 1], GEAR_EDGES[self.stableGear]
        band = HYST_FRACTION * (hi - lo)
        if self.resistance < lo - band or self.resistance >= hi + band:
            candidate = NUM_GEARS
            for g in range(1, NUM_GEARS + 1):
                if self.resistance < GEAR_EDGES[g]:
                    candidate = g
                    break
        if not useDwell:
            self.stableGear = self.pendingGear = candidate
            return
        if candidate == self.stableGear:
            self.pendingGear = self.stableGear
        elif candidate != self.pendingGear:
            self.pendingGear, self.pendingSince = candidate, now
        elif u32(now - self.pendingSince) >= GEAR_DWELL_MS:
            self.stableGear = candidate

    def on_turn_boundary(self, result, avg, periodMs, now):
        self.selfRevs = (self.selfRevs + 1) & 0xFFFF
        self.selfEventMs = now
        self.boundaries.append((now, result, periodMs, avg))
        if result != 2:
            self.selfPeriods = [0, 0]
            return
        self.selfPeriods = [periodMs, self.selfPeriods[0]]
        self.cal_on_turn(avg)
        if self.calValid and self.cal.get("crankOk"):
            self.update_gear(avg, now, False)

    # ------------------------------------------------------------- pipeline
    def process_sample(self, ms, raw, sat=False):                   # processSample()
        self.saturated = sat
        if self.calState == CAL_LEARN:
            if self.learnCount < LEARN_MAX_SAMPLES:
                self.learnBuf.append(list(raw))
                self.learn_times.append(ms)
                self.learnCount += 1
            if self.learnCount >= LEARN_FIRST_PROBE and (self.learnCount - LEARN_FIRST_PROBE) % LEARN_PROBE_EVERY == 0:
                self.cal_learn_probe()
        elif self.crank["ok"]:
            r, avg, per = self.crank_sample(ms, raw)
            if r:
                self.on_turn_boundary(r, avg, per, ms)
        for k in range(3):
            self.medianBuf[k][self.medianIdx] = raw[k]
        self.medianIdx = (self.medianIdx + 1) % 5
        if self.medianFill < 5:
            self.medianFill += 1
            return
        med = [sorted(self.medianBuf[k])[2] for k in range(3)]
        if not self.emaSeeded:
            self.fieldUT = list(med)
            self.emaSeeded = True
        else:
            for k in range(3):
                self.fieldUT[k] += EMA_ALPHA * (med[k] - self.fieldUT[k])
        if self.crank["ok"] or self.calState == CAL_LEARN:
            return
        self.cal_on_sample(self.fieldUT)
        self.cal_auto_check()
        if not self.calValid:
            return
        self.update_gear(self.fieldUT, ms, True)

    def update_power(self):                                            # updatePower()
        if self.calState == CAL_LEARN:
            cad = self.learnLast["rpm"]
        elif self.crank["ok"]:
            cad = self.self_cadence()
        else:
            cad = 0.0                                                    # no pod in these tests
        self.cadenceRpm = cad
        if not self.calValid or cad < 1.0 or self.calState == CAL_LEARN:
            self.powerW = 0.0
            return
        p90 = interp_table(GEAR_EDGES, POWER90, self.resistance)
        p = p90 * (PC2 + PB2 * cad + PA2 * cad * cad)
        self.powerW = constrain(p, 0.0, 2000.0)

    def power_packet(self):                                            # sendPowerMeasurement()
        if self.crank["ok"]:
            valid = self.selfRevs > 0
            revs = self.selfRevs
            evt = ((self.selfEventMs * 1024) // 1000) & 0xFFFF
        else:
            valid, revs, evt = False, 0, 0
        flags = 0x0020 if valid else 0
        watts = int(math.floor(self.powerW + 0.5)) if self.powerW >= 0 else -int(math.floor(-self.powerW + 0.5))
        b = [flags & 0xFF, flags >> 8, watts & 0xFF, (watts & 0xFFFF) >> 8]
        if valid:
            b += [revs & 0xFF, revs >> 8, evt & 0xFF, evt >> 8]
        return bytes(b)

    def command(self, ch):                                             # handleCommand()
        ch = ch.lower()
        if ch == 'c':
            if self.calState == CAL_IDLE:
                self.cal_start()
        elif ch == 'n':
            self.cal_capture()
        elif ch == 'l':
            self.cal_relearn()
        elif ch == 'u':
            self.cal_undo()
        elif ch == 'x':
            if self.calState != CAL_IDLE:
                self.cal_abort("cancelled by user")
        elif ch == 'a':
            self.autoCapture = not self.autoCapture

    def short_press(self):                                             # handleShortPress()
        if self.calState in (CAL_WAITING, CAL_CONFIRM, CAL_POINT_CHECK):
            self.cal_capture()

    def long_press(self):                                              # handleLongPress()
        if self.calState == CAL_IDLE:
            self.cal_start()
        else:
            self.cal_abort("cancelled by user")

    def status_fields(self):                                           # printStatus() (subset)
        return dict(gear=self.stableGear if self.calValid else 0, cad=self.cadenceRpm, cal=self.calState,
                    step=self.calStep, stab=self.stabPct,
                    lturns=self.learnLast["turns"] if self.calState == CAL_LEARN else 0)


def tick_millis(k):
    """millis() of the k-th sensor-task wake-up: 20 ticks of 1/1024 s, tick2ms()."""
    return (k * 20 * 1000) // 1024
