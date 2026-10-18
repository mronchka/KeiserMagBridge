"""Host model of KeiserMagBridge_v3_3.ino (sample pipeline, crank learning,
turn detector, survey, calibration state machine, tolerances, the check,
pause, power, Zwift packet, '#' line input, calibration file layouts).

A line-by-line port of the sketch, written for review/testing only: every
function names the sketch function it mirrors. uint32 time arithmetic is
done with explicit 32-bit wrap (u32) so millis() wrap can be tested.
Floats are Python doubles (the board uses float32; differences are far
below the thresholds that matter here).

Not modelled: BLE timing, LEDs, speaker (beeps are logged in .beeps),
diagnostics recording, output pacing (loop_tail() sends everything at once,
in the same order).

v3.3 API (bench/V3_3_PLAN.md):
  f.tol, f.noise, f.settle, f.spot ('first' | 'same' | 'new'), f.derive_tolerances()
  f.step_no (1-6, 0 idle), f.paused, f.status_fields(), f.status_line()
  f.phone_connected(bool), f.command(ch, src='usb'|'ble'|'button'), f.line(text, src)
  f.input(text, src)  -- raw characters as handleInput() sees them ('#...\\n' lines)
  pack_cal(cal, version) / unpack_cal(bytes)  -- the CalData byte layouts v4/v5/v6
"""
import math
import re
import struct

M32 = 0xFFFFFFFF


def u32(x):
    return x & M32


# ----------------------------------------------------------------- constants (sketch "User configuration")
SAMPLE_PERIOD_MS = 20
NOTIFY_PERIOD_MS = 500
EMA_ALPHA = 0.15
GEAR_DWELL_MS = 150
CADENCE_TIMEOUT_MS = 3000
CAPTURE_SAMPLES = 32
MIN_SPAN_UT = 20.0               # v3.2 fixed values, kept for reference (v3.3: tol)
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
TURN_ALONG_UT = 0.5
TOP_FRACTION = 0.3
BACK_RISE_UT = 1.0
BEHIND_UT = 0.5
DOWN_FIRST = 22
EDGE_BIAS_UT = 0.25
STICK_DEFAULT_UT = 0.6
STICK_MIN_UT = 0.2
CHECK_ORDER_UT = 0.5
CHECK_OVERSHOOT = 1.6
CHECK_SHAPE_UT = 1.0
CHECK_SHAPE_FRAC = 0.12
CHECK_OFF_UT = 1.8
CHECK_PAIR_UT = 1.1
CHECK_PAIR_FRAC = 0.15
CHECK_PERP_UT = 1.8
CHECK_BLAME_RATIO = 1.6
CHECK_MIN_PAIRS = 5
CHECK_MAX_ROUNDS = 8
PRIOR_UT = 2.0
PRIOR_MAX = 6
MAX_SUSPECTS = 20
CHK_LAST = 23
PASS_UP, PASS_DOWN, PASS_FIX_UP, PASS_FIX_DOWN = 0, 1, 2, 3
SUSPECT_DRIFT_UT = 1.0
SUSPECT_CREEP_UT = 0.8
SUSPECT_DRIFT_SLOW_UT = 0.4
SETTLE_GIVEUP_MS = 15000
NUM_GEARS = 24
SATURATION_RAW = 26000
SATURATION_UT = SATURATION_RAW / 1711.0 * 100.0   # 16 gauss range: 1711 LSB/gauss
LINE_TIMEOUT_MS = 1500

# v3.3: survey, tolerances, steps, pause (sketch "v3.3" constants)
STEPS_TOTAL = 6
NOISE_FLOOR_UT = 0.15            # noise is never taken as less than this
NOISE_DEFAULT_UT = 0.6           # calibrations from v4/v5 (no noise stored); 2026-10-16 spot: 0.52-0.76
NOISE_MAX_UT = 2.5               # ...nor more (the lever moved during the noise turns)
NOISE_TURNS = 20                 # turn averages wanted for the noise (learning + cadence check + extra)
NOISE_MAX_TURNS = 32
NOISE_POOL = 64                  # changes between held turns: the noise is refined during the passes
NOISE_POOL_MIN = 8
NOISE_CAL_LO, NOISE_CAL_HI = 0.6, 1.6   # the survey's noise is kept within these x the stored calibration's
SETTLE_MAX_UT = 2.0              # a settle-back over min(SETTLE_MAX_FRAC x step, max(this, 4 noise)) is the
SETTLE_MAX_FRAC = 0.5            # rider moving, not the lever settling: not learned
MOVE_CAP_FRAC = 0.5              # move on never needs more than this x the expected step
K_NEAR, NEAR_FRAC = 6.0, 0.6     # same spot: a point must also be within max(this x noise, this x step)
NEAR_HOLD_TURNS = 10             # ...of where it was last time, unless held this many agreeing turns
SWEEP_MAX_TURNS = 120            # per direction
SAME_SPOT_UT = 1.5               # sweep's median distance from the stored path: same spot under max(this, 3 noise)
K_SAME_SPOT = 3.0
FOLD_SWEEP_UT = 3.0              # sweep folds back: its end is this (or 0.15 L) nearer the start than its farthest point
FOLD_SWEEP_FRAC = 0.15
SETTLE_SAVES = 6
BEHIND_HOLD_TURNS = 6
DISCONNECT_GIVEUP_MS = 300000
X_PERIOD_MS = 250
X_NOISE_TURNS = 8
# multipliers (tuned on the 2026-10-16 logs, bench/NOTES.md "v3.3")
K_AGREE, AGREE_MIN = 3.6, 1.0
K_DRIFT, DRIFT_MIN = 1.8, 0.6
K_CREEP, CREEP_MIN = 1.45, 0.5
K_SLOW, SLOW_MIN = 0.73, 0.25
K_MOVE = 1.8
MOVE_FRAC_SAME, MOVE_FRAC_NEW = 0.4, 0.25
K_BEHIND, BEHIND_FRAC, BEHIND_MIN = 4.0, 0.2, 0.5
K_BEHIND_HELD = 1.5
K_RISE, RISE_FRAC = 1.8, 0.15
EDGE_FRAC = 0.07
STICK_RATIO_DEFAULT = 1.0
K_OFFHOLD = 15.0
K_SPAN, SPAN_MIN = 15.0, 10.0
K_STEP_WARN = 2.5
STEP_REJECT_UT = 0.4             # points closer than this: the same (a fixed limit: small steps only warn)
K_FOLD, FOLD_MIN = 0.5, 0.5      # the path folds back within max(FOLD_MIN, K_FOLD x noise)
SOFT_HOLD_TURNS = 8              # new / first spot: held this long, the noise floor alone moves on
K_ORDER_STEP, K_SHAPE_STEP, K_OFF_STEP, K_PAIR_STEP = 0.25, 0.5, 0.9, 1.0   # check floors x the local step
K_PRIOR, PRIOR_FRAC = 6.0, 0.5
K_ORDER = 0.8
K_SHAPE = 1.7
K_OFF = 3.0
K_PAIR, PAIR_FRAC, PAIR_MIN = 2.0, 0.5, 2.0
PAIR_NEIGHBOURS = 6
PAIR_END_WIDEN = 1.5

SPOT_FIRST, SPOT_SAME, SPOT_NEW = 0, 1, 2
SPOT_NAMES = ("first", "same", "new")
SURV_NOISE, SURV_UP, SURV_DOWN = 0, 1, 2

# Relative step sizes of points 1->2 ... 23->24, from the hand-corrected
# 2026-10-16 calibration (127.8 uT): how a new spot's path length is shared out.
STEP_PROFILE = [17.78, 15.71, 13.00, 2.35, 4.72, 2.83, 3.05, 5.50, 5.65, 4.34, 6.34, 3.71,
                2.55, 6.97, 3.24, 3.76, 5.21, 3.88, 1.87, 1.77, 3.76, 3.80, 6.01]
_PS = sum(STEP_PROFILE)
STEP_PROFILE = [x / _PS for x in STEP_PROFILE]

GEAR_EDGES = [0.00, 7.51, 11.40, 14.59, 18.57, 20.12, 23.32, 24.87,
              27.03, 29.53, 31.87, 34.20, 36.70, 39.72, 42.83, 46.03,
              49.14, 53.11, 56.99, 60.97, 66.49, 72.02, 78.41, 89.38, 100.00]
POWER90 = [20.9, 24.3, 27.7, 33.5, 40.4, 45.0, 54.3, 61.3,
           71.7, 84.4, 98.3, 118.0, 136.6, 163.3, 193.4, 225.9,
           261.9, 308.3, 360.5, 415.0, 497.4, 577.5, 671.5, 796.8, 878.0]
PC2, PB2, PA2 = -2.70E-03, 6.79E-03, 4.75E-05

CAL_IDLE, CAL_WAITING, CAL_CAPTURING, CAL_LEARN, CAL_CONFIRM, CAL_POINT_CHECK, CAL_SURVEY, CAL_DOWN_READY = range(8)
COMMIT_NEW, COMMIT_EDIT, COMMIT_DOWN = 0, 1, 2

# ----------------------------------------------------------------- calibration file (struct CalData)
CAL_MAGIC = 0x4B4D3343
CAL_VERSION = 6
_V4 = "<IHH75fBbH5f"          # magic version reserved pts[25][3] crankOk crankSign pad crankU[3] depth base
_V5 = _V4 + "I75f"            # + downMask down[25][3]
_V6 = _V5 + "fffI25s25sH"     # + noiseUT stepScale stickRatio spotId capRpm[25] downRpm[25] pad2
CAL_V4_SIZE, CAL_V5_SIZE, CAL_V6_SIZE = struct.calcsize(_V4), struct.calcsize(_V5), struct.calcsize(_V6)
assert (CAL_V4_SIZE, CAL_V5_SIZE, CAL_V6_SIZE) == (332, 636, 704)


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


def st_median(v):
    v = sorted(v)
    n = len(v)
    return 0.0 if not n else (v[n // 2] if n % 2 else 0.5 * (v[n // 2 - 1] + v[n // 2]))


def to_deci(x):                                                       # toDeci()
    v = int(math.floor(x * 10.0 + 0.5)) if x >= 0 else -int(math.floor(-x * 10.0 + 0.5))
    return constrain(v, -32767, 32767)


def spot_hash(pts):                                                   # calSpotHash(): FNV-1a over the up points (0.1 uT)
    h = 0x811C9DC5
    for i in range(NUM_GEARS + 1):
        for k in range(3):
            for byte in struct.pack("<h", to_deci(pts[i][k])):
                h = ((h ^ byte) * 0x01000193) & M32
    return h or 1


def path_len(pts):
    return sum(dist3(pts[i], pts[i - 1]) for i in range(1, NUM_GEARS + 1))


def cal_defaults(cal):
    """Fields a v4/v5 calibration doesn't have get defaults (loadCalibration())."""
    z = [0.0, 0.0, 0.0]
    cal.setdefault("downMask", 0)
    cal.setdefault("down", [list(z) for _ in range(NUM_GEARS + 1)])
    cal.setdefault("noiseUT", 0.0)
    cal.setdefault("stickRatio", 0.0)
    cal.setdefault("capRpm", [0] * (NUM_GEARS + 1))
    cal.setdefault("downRpm", [0] * (NUM_GEARS + 1))
    pts = cal.get("pts")
    cal.setdefault("stepScale", path_len(pts) if pts else 0.0)
    cal.setdefault("spotId", spot_hash(pts) if pts else 0)
    cal.setdefault("version", CAL_VERSION)
    return cal


def pack_cal(cal, version=CAL_VERSION):
    """The bytes of /keiser_cal.bin for this cal (struct CalData, little-endian)."""
    c = cal_defaults(dict(cal))
    flat = lambda p: [float(x) for q in p for x in q]  # noqa: E731
    u = c.get("crankU") or [1.0, 0.0, 0.0]
    v = [CAL_MAGIC, version, 0] + flat(c["pts"]) + [int(c.get("crankOk", 0)), int(c.get("crankSign", 1)), 0] \
        + [float(x) for x in u] + [float(c.get("crankDepth") or 0.0), float(c.get("crankBase") or 0.0)]
    fmt = _V4
    if version >= 5:
        fmt = _V5
        v += [int(c["downMask"])] + flat(c["down"])
    if version >= 6:
        fmt = _V6
        v += [float(c["noiseUT"]), float(c["stepScale"]), float(c["stickRatio"]), int(c["spotId"]),
              bytes(int(constrain(x, 0, 255)) for x in c["capRpm"]),
              bytes(int(constrain(x, 0, 255)) for x in c["downRpm"]), 0]
    return struct.pack(fmt, *v)


def unpack_cal(b):                                                    # loadCalibration(): cal dict or None
    n = len(b)
    if n == CAL_V6_SIZE:
        fmt, want = _V6, 6
    elif n == CAL_V5_SIZE:
        fmt, want = _V5, 5
    elif n == CAL_V4_SIZE:
        fmt, want = _V4, 4
    else:
        return None
    v = struct.unpack(fmt, b)
    if v[0] != CAL_MAGIC or v[1] != want:
        return None
    pts = [list(v[3 + 3 * i:6 + 3 * i]) for i in range(25)]
    o = 78
    cal = dict(pts=pts, crankOk=v[o], crankSign=v[o + 1], crankU=list(v[o + 3:o + 6]),
               crankDepth=v[o + 6], crankBase=v[o + 7])
    o += 8
    if want >= 5:
        cal["downMask"] = v[o]
        cal["down"] = [list(v[o + 1 + 3 * i:o + 4 + 3 * i]) for i in range(25)]
        o += 76
    if want >= 6:
        cal["noiseUT"], cal["stepScale"], cal["stickRatio"], cal["spotId"] = v[o:o + 4]
        cal["capRpm"], cal["downRpm"] = list(v[o + 4]), list(v[o + 5])
    cal_defaults(cal)
    cal["version"] = CAL_VERSION
    return cal


def atoi(s):
    m = re.match(r"\s*([+-]?\d+)", s)
    return int(m[1]) if m else 0


_FLOAT = re.compile(r"\s*[+-]?((\d+\.?\d*|\.\d+)([eE][+-]?\d+)?|inf(inity)?|nan)$", re.I)


def strtof_ok(s):
    """strtof() accepted the whole field (end != start and *end == 0)."""
    return bool(_FLOAT.match(s))


class Firmware:
    """State of the sketch's globals plus the functions that touch them."""

    def __init__(self, cal=None, millis0=0):
        self.out = []                    # (ms, line) printed by the board
        self.beeps = []                  # (ms, name) notes played (none while paused)
        self.ms_now = millis0            # millis() as loop() sees it (clockMs())
        # crank params (struct CrankParams)
        self.crank = dict(ok=False, sign=1, u=[1.0, 0.0, 0.0], depth=0.0, base=0.0)
        self.cal = cal                   # dict like CalData or None
        self.calValid = cal is not None
        if cal is not None:
            cal_defaults(cal)
        self.pathPts = None
        self.edgeUpR = [0.0] * (NUM_GEARS + 1)
        self.edgeDownR = [0.0] * (NUM_GEARS + 1)
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
        self.calDown = [[0.0, 0.0, 0.0] for _ in range(NUM_GEARS + 1)]
        self.calDownMask = 0
        self.calPass = PASS_UP
        self.calRedo = False
        self.behindSent = False
        self.behindNow = False
        self.backGate = False
        self.backRising = False
        self.backMin = 0.0
        self.backUpOk = True
        self.fixArmed = False
        self.downGate = False            # '#D': the reading must be above the point first
        self.downStart = DOWN_FIRST      # where this down pass started (undo stops there)
        self.suspects = []
        self.prev = None                 # the previous calibration's up points (prevPts)
        self.staging = False
        self.capSum = [0.0, 0.0, 0.0]
        self.capCount = 0
        self.autoCapture = True
        self.stabRef = [0.0, 0.0, 0.0]
        self.stabSince = 0
        self.stabPct = 0
        self.learnBuf = []
        self.learn_times = []
        self.learnCount = 0
        self.learnLast = dict(ok=False, turns=0, regular=0, rpm=0.0, depth=0.0, why="no signal")
        self.turnHist = []
        self.pendingCap = False
        self.settleSince = 0
        self.forwardNow = False
        self.lastDist = 0.0
        self.downResumed = False          # this down pass was started with '#D'
        self.lastTurnAvg = [0.0, 0.0, 0.0]
        self.agreeRun = 0
        self.runSum, self.runN = 0.0, 0
        self.capRpm = [0] * (NUM_GEARS + 1)
        self.downRpm = [0] * (NUM_GEARS + 1)
        self.prevSaved = False           # this calibration already kept the old one as prev
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
        # survey (v3.3)
        self.survPhase = SURV_NOISE
        self.noiseBuf = []               # turn averages for the noise (learning, cadence check, extra)
        self.sweep = []                  # sweep turn averages (up, then down)
        self.sweepUpN = 0
        self.survSat = False
        self.survL = 0.0
        self.spotKind = SPOT_SAME if (self.calValid and cal.get("pts")) else SPOT_FIRST
        self.spotForced = False          # '#M'
        # tolerances (v3.3)
        self.noiseUT = 0.0
        self.settleRing = []
        self.settleRef = None
        self.settleDir = None
        self.settleTurns = 0
        self.settleWorst = 0.0
        self.settleStep = 0.0
        self.noisePool = []              # changes between consecutive held turns (survey + captures)
        self.expUp = None                # same spot: where each point was last time (up, down)
        self.expDown = None
        self.expDownMask = 0
        self.stuckSent = False
        self.expStep = [0.0] * (NUM_GEARS + 1)
        self.tol = {}
        # pause (v3.3)
        self.paused = False
        self.pauseStart = 0
        self.pauseSkip = 0
        self.lastTurnMs = 0
        self.calFromBle = False
        self.phoneConn = True            # a phone is connected (phone_connected())
        self.phoneLostMs = 0
        self.cmdSrc = "usb"
        # placement stream (v3.3)
        self.placeOn = False
        self.placeMin = None
        self.placeMax = None
        self.slowField = None
        self.hpMin = None
        self.hpMax = None
        self.hpStart = 0
        self.hpP2P = 0.0
        self.lastDip = 0.0
        self.peakAbs = 0.0
        self.lastX = None
        self.xTurns = []
        # injection (v3.3, '#I' / '#S')
        self.injecting = False
        # output from loop()
        self.checkPending = False
        self.inBuf = {"usb": dict(buf="", active=False, overflow=False, lastMs=0),
                      "ble": dict(buf="", active=False, overflow=False, lastMs=0)}
        # instrumentation (not in the sketch)
        self.boundaries = []             # (ms, result, period, avg)
        self.captures = []               # (ms, step, point)
        self.learn_probes = []           # (learnCount, LearnResult)
        self.load_crank_from_cal()
        if cal is not None and cal.get("pts"):           # setup(): the check, then the path, then the tolerances
            self.cal_check(False)
            self.build_path()
        self.derive_tolerances(from_cal=True)

    # ------------------------------------------------------------- output
    def log(self, line):
        self.out.append((self.ms_now, line))

    USB_ONLY = ("J,",)                                                 # Serial.print(): never to the phone

    def phone_out(self):
        """The lines the phone gets (f.out is everything, as USB sees it)."""
        return [(t, l) for t, l in self.out if not l.startswith(self.USB_ONLY)]

    def millis(self):
        return self.ms_now

    def beep(self, name):                                              # playNotes(): silent while paused
        if not self.paused:
            self.beeps.append((self.ms_now, name))

    # ------------------------------------------------------------- v3.3 properties
    @property
    def noise(self):
        return self.tol.get("noise", NOISE_DEFAULT_UT)

    @property
    def settle(self):
        return self.tol.get("settle", self.noise)

    @property
    def spot(self):
        return SPOT_NAMES[self.spotKind]

    @property
    def step_no(self):                                                 # calStepNo()
        s = self.calState
        if s == CAL_IDLE:
            return 1 if self.placeOn else 0
        if s in (CAL_LEARN, CAL_CONFIRM):
            return 2
        if s == CAL_SURVEY:
            return 2 if self.survPhase == SURV_NOISE else 3
        if s == CAL_DOWN_READY:
            return 4                                                     # the up pass is done: its checkpoint
        if self.calPass == PASS_UP:
            return 4
        if self.calPass == PASS_DOWN:
            return 5
        return 6

    # ------------------------------------------------------------- tolerances
    def derive_tolerances(self, from_cal=False):                     # deriveTolerances()
        """from_cal: (on load / after an edit) noise and expected steps come from the stored calibration."""
        cal = self.cal if (self.calValid and self.cal and self.cal.get("pts")) else None
        if from_cal:
            self.noiseUT = (cal["noiseUT"] if cal and cal.get("noiseUT", 0) > 0 else NOISE_DEFAULT_UT)
            self.settleRing = []
            if cal:
                for i in range(1, NUM_GEARS):
                    self.expStep[i] = dist3(self.up_for_path(i), self.up_for_path(i - 1))
            else:
                self.expStep = [0.0] * (NUM_GEARS + 1)
        n = max(NOISE_FLOOR_UT, self.noiseUT)
        settle = st_median(self.settleRing) if self.settleRing else n
        t = self.tol = {}
        t["noise"] = n
        t["settle"] = settle
        t["agree"] = max(K_AGREE * n, AGREE_MIN)
        t["drift"] = max(K_DRIFT * n, DRIFT_MIN)
        t["creep"] = max(K_CREEP * n, CREEP_MIN)
        t["slow"] = max(K_SLOW * n, SLOW_MIN)
        t["moveMin"] = K_MOVE * n
        t["moveFrac"] = MOVE_FRAC_SAME if self.spotKind == SPOT_SAME else MOVE_FRAC_NEW
        t["behindMin"] = max(K_BEHIND * n, 2 * settle, BEHIND_MIN)
        t["behindFrac"] = BEHIND_FRAC
        t["behindHeld"] = max(K_BEHIND_HELD * n, 2 * settle, BEHIND_MIN)
        t["riseMin"] = K_RISE * n
        t["riseFrac"] = RISE_FRAC
        t["edgeFrac"] = EDGE_FRAC
        t["stickRatio"] = cal["stickRatio"] if cal and cal.get("stickRatio", 0) > 0 else STICK_RATIO_DEFAULT
        t["offHold"] = max(OFFPATH_HOLD_UT, K_OFFHOLD * n)
        t["minSpan"] = max(SPAN_MIN, K_SPAN * n)
        t["stepWarn"] = K_STEP_WARN * n
        t["stepReject"] = STEP_REJECT_UT
        t["fold"] = max(FOLD_MIN, K_FOLD * n)
        t["sameSpot"] = max(SAME_SPOT_UT, K_SAME_SPOT * n)
        t["expStep"] = list(self.expStep)
        return t

    def tol_move(self, step):                                          # tolMove()
        frac = MOVE_FRAC_SAME if self.calPass == PASS_DOWN else self.tol["moveFrac"]
        m = max(self.tol["moveMin"], frac * step)
        return min(m, MOVE_CAP_FRAC * step) if step > 0 else m

    def noise_add(self, *ds):                                          # noiseAdd(): held turns of a capture
        for x in ds:
            self.noisePool.append(x)
        self.noisePool = self.noisePool[-NOISE_POOL:]
        if len(self.noisePool) >= NOISE_POOL_MIN:
            self.noiseUT = constrain(st_median(self.noisePool), NOISE_FLOOR_UT, NOISE_MAX_UT)
            self.derive_tolerances()

    def tol_behind(self, step):                                        # tolBehind()
        return max(self.tol["behindMin"], self.tol["behindFrac"] * step)

    def tol_rise(self, step):                                          # tolRise()
        return max(self.tol["riseMin"], self.tol["riseFrac"] * step)

    def settle_add(self, x):                                           # settleAdd()
        self.settleRing.append(x)
        if len(self.settleRing) > SETTLE_SAVES:
            self.settleRing.pop(0)
        self.derive_tolerances()

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

    def learn_time(self, i):
        return 1 + (i * 20 * 1000) // 1024

    def crank_learn(self, n, atCap, times=None):                     # crankLearn()
        """times: None = the sketch's synthetic 1 + i*19.53 ms; else real sample times."""
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
            t = self.learn_time(i) if times is None else times[i]
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

    def learn_noise_turns(self, n):                                    # learnNoiseTurns()
        """The learned crank's full turns in the learning buffer -> noiseBuf (lever still)."""
        self.noiseBuf = []
        self.crank_reset(self.crank["base"])
        times = self.learn_times if getattr(self, "learn_real_time", False) else None
        for i in range(n):
            t = self.learn_time(i) if times is None else times[i]
            res, avg, _ = self.crank_sample(t, self.learnBuf[i])
            if res == 2 and len(self.noiseBuf) < NOISE_MAX_TURNS:
                self.noiseBuf.append(avg)
        self.crank_reset(self.crank["base"])

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
        tag = {PASS_UP: "UP", PASS_DOWN: "DOWN", PASS_FIX_UP: "REDO-UP", PASS_FIX_DOWN: "REDO-DOWN"}[self.calPass]
        self.log(f"[{tag} point {self.calStep + 1}] prompt{' (redo)' if self.calRedo else ''}")
        self.turnHist = []
        self.pendingCap = False
        self.settleSince = 0
        self.stuckSent = False
        self.behindSent = False
        self.backGate = False
        self.backRising = False
        self.behindNow = False
        self.agreeRun = 0
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
        self.staging = False
        self.calRedo = False
        self.calPass = PASS_UP
        self.calDownMask = 0
        self.backUpOk = True
        self.calFromBle = self.cmdSrc == "ble"
        self.prevSaved = False
        self.capRpm = [0] * (NUM_GEARS + 1)
        self.downRpm = [0] * (NUM_GEARS + 1)
        self.settleRing = []
        self.settleTurns = 0
        self.survL = 0.0
        self.paused = False
        self.pauseSkip = 0
        self.expUp, self.expDown, self.expDownMask = None, None, 0
        self.cal_learn_start()

    def cal_relearn(self):
        if self.calState != CAL_CONFIRM and not (self.calState == CAL_WAITING and self.calPass == PASS_UP
                                                 and self.calStep == 0):
            return
        self.log("Learning the crank again.")
        self.cal_learn_start()

    def cal_learn_done(self):
        r = self.learnLast
        self.crank["ok"] = r["ok"]
        self.log("L,%d,%u,%.0f,%.1f,%s" % (1 if r["ok"] else 0, r["turns"], r["rpm"], r["depth"], r["why"]))
        if r["ok"]:
            self.learn_noise_turns(self.learnCount)
            self.beep("learned")
            self.calState = CAL_CONFIRM
            self.stabPct = 100
            self.lastTurnMs = self.millis()
            return
        # hold-still method: no survey, no pause; tolerances from the stored calibration (or defaults)
        self.derive_tolerances(from_cal=True)
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

    def cal_confirm(self):                                             # calConfirm(): on to the survey
        if self.calState != CAL_CONFIRM:
            return
        self.log("Cadence confirmed")
        self.beep("capture")
        self.calState = CAL_SURVEY
        self.calStep = 0                                               # S step field: 0 noise, 1 up, 2 down
        self.sweep = []
        self.sweepUpN = 0
        self.survSat = False
        self.stabPct = 0
        if len(self.noiseBuf) >= NOISE_TURNS:
            self.survey_noise_done()
        else:
            self.survPhase = SURV_NOISE
            self.log("[SURVEY noise] keep pedalling, lever still")

    # ------------------------------------------------------------- survey (v3.3)
    def survey_noise_done(self):                                       # surveyNoiseDone()
        B = self.noiseBuf
        d = [dist3(a, b) for a, b in zip(B, B[1:])]
        # second differences / sqrt(3): the same size for a still lever, but a lever
        # moved steadily during these turns cancels out of them
        d2 = [math.sqrt(sum((B[i + 1][k] - 2 * B[i][k] + B[i - 1][k]) ** 2 for k in range(3)) / 3.0)
              for i in range(1, len(B) - 1)]
        stored = self.cal["noiseUT"] if self.calValid and self.cal and self.cal.get("noiseUT", 0) > 0 else 0.0
        self.noisePool = []
        if len(d2) >= 2:
            # both kinds together (twice the samples) unless the lever moved steadily
            # (the first differences then come out larger): then the second only
            m1, m2 = st_median(d), st_median(d2)
            pool = d + d2 if m1 <= 1.5 * m2 else d2
            n = st_median(pool)
            if stored:                                                  # one rider's few turns vary a lot
                n = constrain(n, NOISE_CAL_LO * stored, NOISE_CAL_HI * stored)
            self.noiseUT = constrain(n, NOISE_FLOOR_UT, NOISE_MAX_UT)
            if m1 <= 1.5 * m2:
                self.noisePool = d[-NOISE_POOL:]
        else:
            self.noiseUT = stored or NOISE_DEFAULT_UT
        self.settleRing = []
        self.derive_tolerances()
        self.log("Noise %.2f uT from %d turns." % (self.noiseUT, len(self.noiseBuf)))
        self.survPhase = SURV_UP
        self.calStep = 1
        self.stabPct = 0
        self.log("[SURVEY up] lever down, then slowly up as far as you can pedal, then Next")

    def survey_on_turn(self, avg):                                     # surveyOnTurn()
        if self.survPhase == SURV_NOISE:
            if len(self.noiseBuf) < NOISE_MAX_TURNS:
                self.noiseBuf.append(list(avg))
            self.stabPct = min(100, len(self.noiseBuf) * 100 // NOISE_TURNS)
            if len(self.noiseBuf) >= NOISE_TURNS:
                self.survey_noise_done()
            return
        lim = SWEEP_MAX_TURNS if self.survPhase == SURV_UP else self.sweepUpN + SWEEP_MAX_TURNS
        if len(self.sweep) < lim:
            self.sweep.append(list(avg))

    def survey_next(self):                                             # surveyNext(): 'n' / button A
        if self.survPhase == SURV_NOISE:
            self.survey_noise_done()
        elif self.survPhase == SURV_UP:
            self.sweepUpN = len(self.sweep)
            self.survPhase = SURV_DOWN
            self.calStep = 2
            self.log("[SURVEY down] slowly back down to the bottom, then Next")
        else:
            self.survey_done()

    @staticmethod
    def sweep_len(pts, n):                                             # sweepLen(): chained, lightly de-noised
        if not pts:
            return 0.0, 0.0, 0.0
        L, last, start = 0.0, pts[0], pts[0]
        far = 0.0
        for p in pts[1:]:
            d = dist3(p, last)
            if d >= 2 * n:
                L += d
                last = p
                far = max(far, dist3(p, start))
        return L, far, dist3(last, start)

    def survey_done(self):                                             # surveyDone()
        n = self.tol["noise"]
        up, dn = self.sweep[:self.sweepUpN], self.sweep[self.sweepUpN:]
        Lu, far, end = self.sweep_len(up, n)
        Ld, _, _ = self.sweep_len(dn, n)
        L = max(Lu, Ld)
        folded = Lu > 0 and far - end > max(FOLD_SWEEP_UT, FOLD_SWEEP_FRAC * Lu)
        verdict = "saturated" if self.survSat else "weak" if L < K_SPAN * n else "folded" if folded else "ok"
        offMed = -1.0
        haveCal = self.calValid and self.cal and self.cal.get("pts")
        if not haveCal:
            self.spotKind = SPOT_FIRST
        elif self.spotForced:
            self.spotKind = SPOT_NEW
        else:
            self.spotKind = SPOT_SAME
            if len(self.sweep) >= 3:
                offMed = st_median([self.locate(self.pathPts, b)[1] for b in self.sweep])
                if offMed >= self.tol["sameSpot"]:
                    self.spotKind = SPOT_NEW
        self.survL = L
        self.expUp, self.expDown, self.expDownMask = None, None, 0
        if self.spotKind == SPOT_SAME:                                 # where each point was last time
            self.expUp = [list(self.up_for_path(i)) for i in range(NUM_GEARS)]
            flagged = {pt - 1 for _, pt, _, _ in self.suspects}
            self.expDownMask = self.cal["downMask"] & ~sum(1 << i for i in flagged)
            self.expDown = [list(x) for x in self.cal["down"]]
        if self.spotKind == SPOT_SAME:
            for i in range(1, NUM_GEARS):
                self.expStep[i] = dist3(self.up_for_path(i), self.up_for_path(i - 1))
        else:
            self.expStep = [0.0] + [L * STEP_PROFILE[i - 1] for i in range(1, NUM_GEARS)] + [0.0]
        self.derive_tolerances()
        self.log("Z,%.2f,%.1f,%s,%.1f,%s" % (n, L, self.spot, offMed, verdict))
        self.calState = CAL_WAITING
        self.calPass = PASS_UP
        self.calStep = 0
        self.cal_prompt()

    def cal_abort(self, why):
        fixing = self.calPass in (PASS_FIX_UP, PASS_FIX_DOWN)
        self.backGate = False
        self.calState = CAL_IDLE
        self.calPass = PASS_UP
        self.paused = False
        if fixing:
            self.log("A," + why)
            return
        self.load_crank_from_cal()
        self.derive_tolerances(from_cal=True)
        self.log("A," + why)
        self.beep("fail")

    def cal_reject(self, msg, span, minStep, minStepAt):
        self.calState = CAL_IDLE
        self.paused = False
        self.load_crank_from_cal()
        self.log("K,0,%.1f,%.2f,%d,%s" % (span, minStep, minStepAt, msg))
        self.beep("fail")

    @staticmethod
    def gear_width(g):
        return GEAR_EDGES[g] - GEAR_EDGES[g - 1]

    @staticmethod
    def synth_top(p):                                                 # synthTop()
        f = TOP_FRACTION
        p[NUM_GEARS] = [p[NUM_GEARS - 1][k] + f * (p[NUM_GEARS - 1][k] - p[NUM_GEARS - 2][k]) for k in range(3)]

    def cal_validate(self, p):                                        # calValidate(): (ok, span, minStep, at, msg)
        t = self.tol
        span, minStep, minStepAt = 0.0, 1e9, 1
        for i in range(1, NUM_GEARS + 1):
            step = dist3(p[i], p[i - 1])
            span += step
            if step < minStep:
                minStep, minStepAt = step, i
        if span < t["minSpan"]:
            return False, span, minStep, minStepAt, "signal too small"
        if minStep < t["stepReject"]:
            return (False, span, minStep, minStepAt,
                    "points %d and %d are the same - did the lever move?" % (minStepAt, minStepAt + 1))
        for k in range(NUM_GEARS + 1):
            for j in range(NUM_GEARS):
                if k - 2 <= j <= k + 1:
                    continue
                d, _ = dist_to_segment(p[k], p[j], p[j + 1])
                if d < t["fold"]:
                    return (False, span, minStep, minStepAt,
                            "path folds back: point %d is %.1f uT from gear %d's segment" % (k + 1, d, j + 1))
        return True, span, minStep, minStepAt, ""

    @staticmethod
    def local_step(p, i):                                             # localStep(): mean of the two steps at point i
        a = dist3(p[i], p[i - 1]) if i >= 1 else None
        b = dist3(p[i + 1], p[i]) if i + 1 <= NUM_GEARS else None
        if a is None:
            return b
        if b is None:
            return a
        return 0.5 * (a + b)

    def stick_ratio_from_pairs(self, up, down, mask):                 # stickRatioFromPairs(): 0 = too few pairs
        r = []
        for i in range(1, NUM_GEARS):
            if not (mask >> i) & 1:
                continue
            t = self.unit_dir(up, i - 1, i + 1)
            ls = self.local_step(up, i)
            if ls <= 0:
                continue
            h = dot3([up[i][k] - down[i][k] for k in range(3)], t) - 2 * EDGE_FRAC * ls
            r.append(h / ls)
        return max(0.05, st_median(r)) if len(r) >= CHECK_MIN_PAIRS else 0.0

    def cal_commit(self, up, down, mask, mode):                       # calCommit()
        if mode is True:
            mode = COMMIT_NEW
        elif mode is False:
            mode = COMMIT_EDIT
        p = [list(x) for x in up]
        if mode != COMMIT_NEW and self.calValid and p[NUM_GEARS - 2:NUM_GEARS] == self.cal["pts"][NUM_GEARS - 2:NUM_GEARS]:
            p[NUM_GEARS] = list(self.cal["pts"][NUM_GEARS])
        else:
            self.synth_top(p)
        upChanged = (mode == COMMIT_NEW or not self.calValid or not self.cal.get("pts")
                     or p[:NUM_GEARS] != self.cal["pts"][:NUM_GEARS])
        ok, span, minStep, minStepAt, msg = self.cal_validate(p)
        if not ok and upChanged and mode != COMMIT_DOWN:                # down points never re-judge the up path
            if mode == COMMIT_NEW:
                self.cal_reject(msg, span, minStep, minStepAt)
            else:
                self.log("E,fail," + msg)
            return False
        old = self.cal if (self.calValid and self.cal and self.cal.get("pts")) else None
        if mode == COMMIT_NEW and old and not self.prevSaved and self.spotKind == SPOT_SAME:
            self.prev = [list(x) for x in old["pts"]]                # savePrev()
            self.prevSaved = True
        if mode == COMMIT_NEW and self.spotKind == SPOT_NEW:
            self.prev = None                                          # forgetPrev(): a new spot has no prior
        if mode == COMMIT_NEW:
            self.spotForced = False                                   # '#M' applies to this calibration only
        c = self.crank
        new = dict(old) if (old and mode != COMMIT_NEW) else {}
        new.update(pts=p, down=[list(x) for x in down], downMask=mask & (((1 << NUM_GEARS) - 1) & ~1))
        if mode == COMMIT_NEW:
            new.update(crankOk=1 if c["ok"] else 0, crankSign=c["sign"], crankU=list(c["u"]),
                       crankDepth=c["depth"], crankBase=c["base"],
                       noiseUT=self.tol["noise"], stepScale=self.survL if self.survL > 0 else span,
                       spotId=(old["spotId"] if old and self.spotKind == SPOT_SAME and old.get("spotId")
                               else spot_hash(p)),
                       stickRatio=(old.get("stickRatio", 0.0) if old and self.spotKind == SPOT_SAME else 0.0),
                       capRpm=list(self.capRpm), downRpm=[0] * (NUM_GEARS + 1))
        elif mode == COMMIT_DOWN:
            new["downRpm"] = list(self.downRpm)
            r = self.stick_ratio_from_pairs(p, down, new["downMask"])
            if r > 0:
                new["stickRatio"] = r
        cal_defaults(new)
        self.cal = new
        self.calValid = True
        self.suspects = []
        self.build_path()
        self.checkPending = True                                      # the check runs from loop()
        self.derive_tolerances()
        self.stableGear = self.pendingGear = 1
        self.staging = False
        if mode == COMMIT_EDIT:
            self.log("E,ok,saved")
            self.beep("capture")
        else:
            self.beep("saved")
        self.log("K,1,%.1f,%.2f,%d,saved" % (span, minStep, minStepAt))
        return True

    def cal_finish(self):                                              # calFinish(): the up pass is complete
        ok = self.cal_commit(self.calRaw, self.calDown, 0, COMMIT_NEW)
        if not ok:
            return
        if not self.crank["ok"]:
            self.calState = CAL_IDLE
            self.calPass = PASS_UP
            return
        self.settleTurns = 0
        self.calState = CAL_DOWN_READY                                # checkpoint: 'n' comes back down
        self.calPass = PASS_DOWN
        self.calStep = DOWN_FIRST
        self.downStart = DOWN_FIRST
        self.downGate = False
        self.calDownMask = 0
        self.stabPct = 0
        self.log("[UP PASS SAVED] 'n' to come back down now, 's' to stop here")

    def cal_finish_down(self):                                         # calFinishDown(): save the down points so far
        self.calState = CAL_IDLE
        self.calPass = PASS_UP
        self.paused = False
        self.cal_commit(self.calRaw, self.calDown, self.calDownMask, COMMIT_DOWN)

    def cal_down_begin(self, step, gate):                              # calDownBegin()
        self.settleTurns = 0
        self.downResumed = gate
        self.calPass = PASS_DOWN
        self.calStep = step
        self.downStart = step
        self.downGate = gate
        self.fixArmed = False
        self.calRedo = False
        self.calState = CAL_WAITING
        self.lastTurnMs = self.millis()
        self.paused = False
        self.cal_prompt()

    def cal_down_start(self):                                          # calDownStart(): '#D'
        if self.calState != CAL_IDLE:
            return self.log("E,fail,busy calibrating")
        if not self.calValid or not self.cal.get("crankOk") or not self.crank["ok"]:
            return self.log("E,fail,needs a saved calibration made while pedalling")
        i = DOWN_FIRST
        while i >= 1 and (self.cal["downMask"] >> i) & 1:
            i -= 1
        if i < 1:
            return self.log("E,fail,down pass already done")
        self.calRaw = [list(x) for x in self.cal["pts"]]
        self.calDown = [list(x) for x in self.cal["down"]]
        self.calDownMask = self.cal["downMask"]
        self.downRpm = list(self.cal["downRpm"])
        self.staging = False
        self.calFromBle = self.cmdSrc == "ble"
        self.spotKind = SPOT_SAME
        self.expUp, self.expDown, self.expDownMask = None, None, 0
        self.derive_tolerances(from_cal=True)
        self.log("E,ok,down")
        self.cal_down_begin(i, True)

    def cal_fix_store(self, b):                                       # calFixStore()
        down = self.calPass == PASS_FIX_DOWN
        self.calState = CAL_IDLE
        self.calPass = PASS_UP
        self.paused = False
        if down:
            self.log("C,down,%d,%.1f,%.1f,%.1f" % (self.calStep + 1, b[0], b[1], b[2]))
            self.calDown[self.calStep] = list(b)
            self.calDownMask |= 1 << self.calStep
        else:
            self.log("C,%d,%.1f,%.1f,%.1f" % (self.calStep + 1, b[0], b[1], b[2]))
            self.calRaw[self.calStep] = list(b)
        self.captures.append((self.millis(), ('rd' if down else 'ru', self.calStep), list(b)))
        self.cal_commit(self.calRaw, self.calDown, self.calDownMask, COMMIT_EDIT)

    def cal_fix_start(self, down, point):                             # calFixStart()
        if self.calState != CAL_IDLE:
            return self.log("E,fail,busy calibrating")
        if not self.calValid or not self.cal.get("crankOk") or not self.crank["ok"]:
            return self.log("E,fail,needs a saved calibration made while pedalling")
        i = point - 1
        if i < 1 or i > (DOWN_FIRST if down else NUM_GEARS - 1):
            return self.log("E,fail,no such point")
        self.calRaw = [list(x) for x in self.cal["pts"]]
        self.calDown = [list(x) for x in self.cal["down"]]
        self.calDownMask = self.cal["downMask"]
        self.staging = False
        self.calPass = PASS_FIX_DOWN if down else PASS_FIX_UP
        self.calStep = i
        self.calRedo = False
        self.fixArmed = False
        self.calFromBle = self.cmdSrc == "ble"
        self.spotKind = SPOT_SAME
        self.expUp, self.expDown, self.expDownMask = None, None, 0
        self.derive_tolerances(from_cal=True)
        self.calState = CAL_WAITING
        self.lastTurnMs = self.millis()
        self.paused = False
        self.log("E,ok,redo")
        self.cal_prompt()

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

    def settle_start(self, b, redone):                                 # settleStart(): watch the next 2 turns
        ref = self.cal_prev_ref()
        self.settleTurns = 0
        last = self.calStep == (NUM_GEARS - 1 if self.calPass == PASS_UP else 1)
        if ref is None or not self.crank["ok"] or last or redone:        # the rider moves on at once / went back
            return
        v = [b[k] - ref[0][k] for k in range(3)]
        n = math.sqrt(dot3(v, v))
        if n <= 0:
            return
        self.settleRef, self.settleDir = list(b), [x / n for x in v]
        self.settleTurns, self.settleWorst, self.settleStep = 2, 1e9, n

    def cal_store_point(self, b):
        redone = self.calRedo or not self.backUpOk
        self.backUpOk = True
        self.calRedo = False
        self.pendingCap = False
        self.settleSince = 0
        if self.calPass in (PASS_FIX_UP, PASS_FIX_DOWN):
            return self.cal_fix_store(b)
        rpm = int(constrain(self.self_cadence() + 0.5, 0, 255))
        self.settle_start(b, redone)
        if self.calPass == PASS_DOWN:
            self.calDown[self.calStep] = list(b)
            self.calDownMask |= 1 << self.calStep
            self.downRpm[self.calStep] = rpm
            self.log("C,down,%d,%.1f,%.1f,%.1f" % (self.calStep + 1, b[0], b[1], b[2]))
            self.captures.append((self.millis(), ('d', self.calStep), list(b)))
            self.downGate = False                                      # '#D': shifted up once, that's enough
            if self.calValid and self.cal.get("pts"):                # kept at once (power loss): saveCalibration()
                self.cal["down"][self.calStep] = list(b)
                self.cal["downMask"] |= 1 << self.calStep
                self.cal["downRpm"][self.calStep] = rpm
            self.calStep -= 1
            if self.calStep < 1:
                return self.cal_finish_down()
        else:
            self.calRaw[self.calStep] = list(b)
            self.capRpm[self.calStep] = rpm
            self.log("C,%d,%.1f,%.1f,%.1f" % (self.calStep + 1, b[0], b[1], b[2]))
            self.captures.append((self.millis(), self.calStep, list(b)))
            if self.calStep == NUM_GEARS - 1:
                self.synth_top(self.calRaw)
                ok, span, minStep, minStepAt, msg = self.cal_validate(self.calRaw)
                if not ok:
                    return self.cal_reject(msg, span, minStep, minStepAt)
                t = self.calRaw[NUM_GEARS]
                self.log("C,%d,%.1f,%.1f,%.1f" % (NUM_GEARS + 1, t[0], t[1], t[2]))
                return self.cal_finish()
            else:
                self.calStep += 1
        self.beep("capture")
        self.calState = CAL_WAITING
        self.cal_prompt()

    def turn_hist_mean(self):
        n = len(self.turnHist)
        return [sum(h[k] / n for h in self.turnHist) if n else 0.0 for k in range(3)]

    def cal_prev_ref(self):                                           # calPrevRef(): (prev, dir) or None
        if self.calPass == PASS_UP:
            if self.calStep == 0:
                return None
            prev = self.calRaw[self.calStep - 1]
            a = b = None
            if self.calStep >= 2:
                a, b = self.calRaw[max(self.calStep - 4, 0)], self.calRaw[self.calStep - 1]
        elif self.calPass == PASS_DOWN:
            j = self.calStep + 1
            prev = self.calDown[j] if (self.calDownMask >> j) & 1 else self.calRaw[min(j, NUM_GEARS - 1)]
            a, b = self.calRaw[min(self.calStep + 2, NUM_GEARS - 1)], self.calRaw[max(self.calStep - 1, 0)]
        else:
            return None
        d = None
        if a is not None:
            v = [b[k] - a[k] for k in range(3)]
            n = math.sqrt(dot3(v, v))
            if n > 0:
                d = [x / n for x in v]
        return prev, d

    def cal_local_step(self):                                          # calLocalStep(): the step into this point
        i = self.calStep
        if self.calPass == PASS_UP:
            return self.expStep[i] if 1 <= i < NUM_GEARS else 0.0
        if self.calPass == PASS_DOWN:
            return dist3(self.calRaw[min(i + 1, NUM_GEARS - 1)], self.calRaw[i])
        if self.pathPts is None:
            return 0.0
        j = i - 1 if self.calPass == PASS_FIX_UP else i + 1
        return dist3(self.pathPts[i], self.pathPts[j])

    def cal_near_stored(self, mean, d, step):                         # calNearStored()
        """Same spot: the reading has got to within max(K_NEAR noise, NEAR_FRAC step) of where this
        point was last time (along the pass), so a pause part-way through a gear isn't taken."""
        if not d or self.agreeRun >= NEAR_HOLD_TURNS:
            return True
        i = self.calStep
        if self.calPass == PASS_UP and self.expUp is not None and 1 <= i < NUM_GEARS:
            e = self.expUp[i]
        elif self.calPass == PASS_DOWN and self.expDown is not None and (self.expDownMask >> i) & 1:
            e = self.expDown[i]
        else:
            return True
        a = dot3([mean[k] - e[k] for k in range(3)], d)
        return a >= -max(K_NEAR * self.tol["noise"], NEAR_FRAC * step)

    def cal_moved_on(self, mean, agreeing, manual=False):             # calMovedOn()
        self.behindNow = False
        self.forwardNow = False
        ref = self.cal_prev_ref()
        if ref is None:
            return True
        prev, d = ref
        v = [mean[k] - prev[k] for k in range(3)]
        dist = math.sqrt(dot3(v, v))
        along = dot3(v, d) if d else dist
        step = self.cal_local_step()
        move = self.tol_move(step)
        if agreeing:                                                   # the run of agreeing turns: its mean
            if self.agreeRun <= 2:
                self.runSum, self.runN = 0.0, 0
            self.runSum += along
            self.runN += 1
        held = (agreeing and self.agreeRun >= BEHIND_HOLD_TURNS and self.runN > 0
                and self.runSum / self.runN <= -self.tol["behindHeld"])
        self.behindNow = bool(d) and agreeing and (along <= -self.tol_behind(step) or held)
        self.forwardNow = along >= self.tol["noise"]
        self.lastDist = dist
        floor = self.tol["moveMin"]
        if manual:                                                     # 'n': the noise floor alone
            return dist >= floor and along >= 0.5 * floor
        if (self.spotKind != SPOT_SAME and self.calPass == PASS_UP and self.agreeRun >= SOFT_HOLD_TURNS
                and dist >= floor and along >= 0.5 * floor):
            return True                                                # the expected step is only a guess here
        return dist >= move and along >= 0.5 * move and self.cal_near_stored(mean, d, step)

    def cal_back_up(self):                                            # calBackUp(): True if it went back
        down = self.calPass == PASS_DOWN
        can = self.backUpOk and (self.calStep < self.downStart if down else self.calStep >= 2)
        if not can:
            if not self.behindSent:
                self.behindSent = True
                self.log("N,behind")
            return False
        bad = self.calStep + 1 if down else self.calStep - 1
        self.backOld = list(self.calDown[bad] if down else self.calRaw[bad])
        if down:
            self.calDownMask &= ~(1 << bad)
            if self.calValid and self.cal.get("pts"):
                self.cal["downMask"] &= ~(1 << bad)
        self.calStep = bad
        self.settleTurns = 0
        self.log("N,behind")
        self.log(("U,%d,d" if down else "U,%d") % self.calStep)
        self.beep("undo")
        self.calRedo = True
        self.cal_prompt()
        self.backGate = True
        self.backUpOk = False
        return True

    def cal_back_along(self, avg):                                    # calBackAlong()
        ref = self.cal_prev_ref()
        if ref is None:
            return 0.0
        prev = ref[0]
        span = [self.backOld[k] - prev[k] for k in range(3)]
        L = math.sqrt(dot3(span, span))
        return dot3([avg[k] - prev[k] for k in range(3)], span) / L if L > 0 else 0.0

    def cal_back_rise(self, avg):                                     # calBackRise()
        a = self.cal_back_along(avg)
        self.backMin = min(self.backMin, a)
        if a < self.backMin + self.tol_rise(self.cal_local_step()):
            self.turnHist = []
            self.pendingCap = False
            self.stabPct = 0
            return False
        self.backRising = False
        return True

    def cal_back_gate(self, avg):                                     # calBackGate()
        ref = self.cal_prev_ref()
        if ref is None:
            self.backGate = False
            return True
        prev = ref[0]
        span = [self.backOld[k] - prev[k] for k in range(3)]
        L = math.sqrt(dot3(span, span))
        if L <= 0:
            self.backGate = False
            return True
        if dot3([avg[k] - prev[k] for k in range(3)], span) / L <= 0.5 * L:
            self.backGate = False
            self.backRising = True
            self.backMin = dot3([avg[k] - prev[k] for k in range(3)], span) / L
            self.turnHist = []
            self.pendingCap = False
        self.stabPct = 0
        return False

    def cal_travel_dir(self, mean):                                   # calTravelDir()
        if self.calPass in (PASS_FIX_UP, PASS_FIX_DOWN):
            i = self.calStep
            j = i - 1 if self.calPass == PASS_FIX_UP else i + 1
            v = [self.pathPts[i][k] - self.pathPts[j][k] for k in range(3)]
        else:
            ref = self.cal_prev_ref()
            if ref is None:
                return [0.0, 0.0, 0.0]
            v = [mean[k] - ref[0][k] for k in range(3)]
        n = math.sqrt(dot3(v, v))
        return [x / n for x in v] if n > 0 else [0.0, 0.0, 0.0]

    def cal_fix_gate(self, avg):                                      # calFixGate() (also '#D')
        r, _ = self.locate(self.pathPts, avg)
        i = self.calStep
        if self.calPass == PASS_FIX_UP:
            past = r < 0.5 * (GEAR_EDGES[i - 1] + GEAR_EDGES[i])
        else:
            past = r > 0.5 * (GEAR_EDGES[i] + GEAR_EDGES[i + 1])
        if past:
            self.fixArmed = True
            self.turnHist = []
            self.pendingCap = False
            self.stabPct = 0
            return False
        if not self.fixArmed:
            self.stabPct = 0
            return False
        return True

    def cal_on_turn(self, avg):
        # survey and noise turns (v3.3)
        if self.calState == CAL_CONFIRM and self.crank["ok"]:
            if len(self.noiseBuf) < NOISE_MAX_TURNS:
                self.noiseBuf.append(list(avg))
            return
        if self.calState == CAL_SURVEY:
            if not self.paused:
                self.survey_on_turn(avg)
            return
        if self.calState != CAL_WAITING or not self.crank["ok"]:
            return
        if self.paused:                                              # phone gone: turns don't count
            self.turnHist = []
            self.pendingCap = False
            return
        if self.pauseSkip:                                           # the first turn after a pause
            self.pauseSkip -= 1
            self.turnHist = []
            self.pendingCap = False
            return
        self.lastTurnAvg = list(avg)
        if self.settleTurns:                                         # learn how far the lever settles back
            a = dot3([avg[k] - self.settleRef[k] for k in range(3)], self.settleDir)
            self.settleWorst = min(self.settleWorst, a)
            self.settleTurns -= 1
            x = max(0.0, -self.settleWorst)
            if not self.settleTurns and x <= min(SETTLE_MAX_FRAC * self.settleStep, max(SETTLE_MAX_UT, 4 * self.tol["noise"])):
                self.settle_add(x)                                     # (more than that: the rider moved)
        fixing = self.calPass in (PASS_FIX_UP, PASS_FIX_DOWN)
        if (fixing or (self.calPass == PASS_DOWN and self.downGate)) and not self.cal_fix_gate(avg):
            return
        if self.backGate and not self.cal_back_gate(avg):
            return
        if self.backRising and not self.cal_back_rise(avg):
            return
        t = self.tol
        if self.settleSince and u32(self.millis() - self.settleSince) >= SETTLE_GIVEUP_MS:
            self.calState = CAL_POINT_CHECK
            self.pendingCap = False
            self.stabPct = 0
            self.log("P,%d" % (self.calStep + 1))
            self.beep("fail")
            return
        if self.pendingCap:
            self.pendingCap = False
            drift = dot3([avg[k] - self.pendingMean[k] for k in range(3)], self.pendingDir)
            self.pendingCreep = dot3([avg[k] - self.pendingFirst[k] for k in range(3)], self.pendingDir)
            hasDir = any(self.pendingDir)
            suspect = hasDir and (drift >= t["drift"] or
                                  (self.pendingCreep >= t["creep"] and drift >= t["slow"]))
            if not suspect:
                n = len(self.turnHist)
                m = [(self.pendingMean[k] * n + avg[k]) / (n + 1) for k in range(3)]
                if dist3(avg, self.pendingMean) <= t["agree"] and self.cal_moved_on(m, False):
                    self.stabPct = 100
                    h = self.turnHist
                    if len(h) == 2:                                    # 3 held turns: refine the noise
                        self.noise_add(dist3(h[1], h[0]), dist3(avg, h[1]))
                    return self.cal_store_point(m)
            else:
                if not self.settleSince:
                    self.settleSince = self.millis() or 1
                    self.beep("undo")
                self.log("W,%d,%.1f,%.1f" % (self.calStep + 1, drift, self.pendingCreep))
                self.turnHist = [list(avg)]
                self.agreeRun = 1
                self.stabPct = 34
                return
        if len(self.turnHist) == 2:
            self.turnHist = self.turnHist[1:]
        self.turnHist.append(list(avg))
        while len(self.turnHist) > 1:
            spread = max(dist3(a, b) for i, a in enumerate(self.turnHist) for b in self.turnHist[i + 1:])
            if spread <= t["agree"]:
                break
            self.turnHist = self.turnHist[1:]
        self.agreeRun = self.agreeRun + 1 if len(self.turnHist) == 2 else 1
        mean = self.turn_hist_mean()
        moved = self.cal_moved_on(mean, len(self.turnHist) >= 2)
        if self.behindNow and self.calPass in (PASS_UP, PASS_DOWN) and self.cal_back_up():
            return
        self.stabPct = (67 if len(self.turnHist) >= 2 else 34) if moved else 0
        if (not moved and not self.behindNow and self.agreeRun >= BEHIND_HOLD_TURNS and not self.stuckSent
                and self.calPass in (PASS_UP, PASS_DOWN)
                and self.lastDist <= (0.5 * self.cal_local_step() or self.tol["moveMin"])):
            self.stuckSent = True                                      # held, neither on nor behind: a hint, once
            self.log("N,stuck")
        if moved and self.autoCapture and len(self.turnHist) == 2:
            self.pendingMean = list(mean)
            self.pendingDir = self.cal_travel_dir(mean)
            self.pendingFirst = list(self.turnHist[0])
            self.pendingCap = True

    def cal_capture(self):
        if self.calState == CAL_CONFIRM:
            return self.cal_confirm()
        if self.calState == CAL_SURVEY:
            return self.survey_next()
        if self.calState == CAL_DOWN_READY:
            self.log("Coming back down.")
            return self.cal_down_begin(self.calStep, False)
        if self.calState == CAL_POINT_CHECK:                        # capture anyway
            b = self.turn_hist_mean() if self.turnHist else list(self.lastTurnAvg)
            return self.cal_store_point(b)
        if self.calState != CAL_WAITING:
            return
        if self.crank["ok"]:
            if not self.turnHist:
                self.log("N,noturn")
                return
            if ((self.calPass in (PASS_FIX_UP, PASS_FIX_DOWN) or (self.calPass == PASS_DOWN and self.downGate))
                    and not self.fixArmed) or self.backGate or self.backRising:
                self.log("N,notmoved")
                return
            mean = self.turn_hist_mean()
            if not self.cal_moved_on(mean, False, manual=True):
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
        if self.calState not in (CAL_POINT_CHECK, CAL_DOWN_READY, CAL_WAITING):
            return
        self.settleTurns = 0
        if self.calState == CAL_POINT_CHECK:
            self.backUpOk = False                                      # the rider is going back on purpose
            self.calState = CAL_WAITING
            self.calRedo = True
            self.fixArmed = False
            self.log(("U,%d,d" if self.calPass in (PASS_DOWN, PASS_FIX_DOWN) else "U,%d") % self.calStep)
            self.beep("undo")
            return self.cal_prompt()
        if self.calState == CAL_DOWN_READY:                         # back to up point 24
            self.backUpOk = False
            self.calState = CAL_WAITING
            self.calPass = PASS_UP
            self.calStep = NUM_GEARS - 1
            self.log("U,%d" % self.calStep)
            self.beep("undo")
            return self.cal_prompt()
        if self.calState != CAL_WAITING:
            return
        if self.calPass == PASS_DOWN:
            if self.calStep < self.downStart:
                self.backUpOk = False
                self.calStep += 1
                self.calDownMask &= ~(1 << self.calStep)
                if self.calValid and self.cal.get("pts"):
                    self.cal["downMask"] &= ~(1 << self.calStep)
                self.log("U,%d,d" % self.calStep)
            elif self.downStart == DOWN_FIRST and not self.downResumed:  # back into the up pass, point 24
                self.backUpOk = False
                self.calPass = PASS_UP
                self.calStep = NUM_GEARS - 1
                self.log("U,%d" % self.calStep)
            else:
                return
            self.beep("undo")
            return self.cal_prompt()
        if self.calPass != PASS_UP or self.calStep == 0:
            return
        self.backUpOk = False
        self.calStep -= 1
        self.log("U,%d" % self.calStep)
        self.beep("undo")
        self.cal_prompt()

    def cal_skip_down(self):                                           # calSkipDown(): 's'
        if self.calState == CAL_DOWN_READY:
            self.calState = CAL_IDLE
            self.calPass = PASS_UP
            self.paused = False
            self.log("Saved without the down pass.")
            return
        if self.calPass != PASS_DOWN or self.calState not in (CAL_WAITING, CAL_POINT_CHECK):
            return
        self.cal_finish_down()

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

    # ------------------------------------------------------------- pause (v3.3)
    def pausable(self):
        return self.crank["ok"] and self.calState in (CAL_CONFIRM, CAL_SURVEY, CAL_WAITING, CAL_POINT_CHECK,
                                                      CAL_DOWN_READY)

    def update_pause(self, now):                                       # updatePause()
        if not self.pausable():
            self.paused = False
            return
        lost = self.calFromBle and not self.phoneConn
        if lost and not self.phoneLostMs:
            self.phoneLostMs = now or 1
        if not lost:
            self.phoneLostMs = 0
        want = lost or u32(now - self.lastTurnMs) > CADENCE_TIMEOUT_MS
        if want and not self.paused:
            self.paused = True
            self.pauseStart = now
            self.log("Paused: phone disconnected." if lost else "Paused: pedal to continue.")
        elif not want and self.paused:
            dt = u32(now - self.pauseStart)
            if self.settleSince:
                self.settleSince = u32(self.settleSince + dt) or 1
            self.paused = False
            self.turnHist = []
            self.pendingCap = False
            self.settleTurns = 0
            self.agreeRun = 0
            self.runSum, self.runN = 0.0, 0
            self.pauseSkip = 1
            self.log("Resumed.")
        if lost and self.phoneLostMs and u32(now - self.phoneLostMs) >= DISCONNECT_GIVEUP_MS:
            self.phoneLostMs = 0
            if self.calState == CAL_DOWN_READY:
                self.calState = CAL_IDLE
                self.calPass = PASS_UP
                self.paused = False
            elif self.calPass == PASS_DOWN and self.calState in (CAL_WAITING, CAL_POINT_CHECK):
                self.cal_finish_down()
            else:
                self.cal_abort("phone disconnected")

    def phone_connected(self, on):                                     # uartNotifyCb() / prphDisconnectCb()
        self.phoneConn = bool(on)
        if not on:
            self.inBuf["ble"]["active"] = False

    # ------------------------------------------------------------- gear
    def up_for_path(self, i):                                        # upForPath()
        for ps, pt, _, g in self.suspects:
            if ps == 'u' and pt == i + 1:
                return g
        return self.cal["pts"][i]

    def build_path(self):                                              # buildPath()
        cal = self.cal
        flagged = {pt - 1 for _, pt, _, _ in self.suspects}
        mask = cal.get("downMask", 0) & ~sum(1 << i for i in flagged)
        self.pathPts = [list(self.up_for_path(i)) for i in range(NUM_GEARS)] + [None]
        for i in range(1, NUM_GEARS):
            if mask & (1 << i):
                self.pathPts[i] = [0.5 * (cal["pts"][i][k] + cal["down"][i][k]) for k in range(3)]
        self.pathPts[NUM_GEARS] = [self.pathPts[NUM_GEARS - 1][k] + cal["pts"][NUM_GEARS][k]
                                   - cal["pts"][NUM_GEARS - 1][k] for k in range(3)]
        tan, ls, rs = {}, {}, []
        for i in range(1, NUM_GEARS):
            v = [self.pathPts[i + 1][k] - self.pathPts[i - 1][k] for k in range(3)]
            n = math.sqrt(dot3(v, v))
            tan[i] = [x / n for x in v] if n > 0 else [0.0, 0.0, 0.0]
            ls[i] = self.local_step(self.pathPts, i)
            if mask & (1 << i) and ls[i] > 0:
                h = dot3([cal["pts"][i][k] - cal["down"][i][k] for k in range(3)], tan[i]) - 2 * EDGE_FRAC * ls[i]
                rs.append(h / ls[i])
        ratio = st_median(rs) if rs else (cal["stickRatio"] if cal.get("stickRatio", 0) > 0 else STICK_RATIO_DEFAULT)
        for i in range(1, NUM_GEARS):
            u, t = self.up_for_path(i), tan[i]
            bias = EDGE_FRAC * ls[i]
            eu = [u[k] - bias * t[k] for k in range(3)]
            if mask & (1 << i):
                ed = [cal["down"][i][k] + bias * t[k] for k in range(3)]
            else:
                stick = max(STICK_MIN_UT, ratio * ls[i])
                ed = [eu[k] - stick * t[k] for k in range(3)]
            if dot3([eu[k] - ed[k] for k in range(3)], t) < 0.1:
                m = [0.5 * (eu[k] + ed[k]) for k in range(3)]
                eu = [m[k] + 0.05 * t[k] for k in range(3)]
                ed = [m[k] - 0.05 * t[k] for k in range(3)]
            self.edgeUpR[i], _ = self.locate(self.pathPts, eu)
            self.edgeDownR[i], _ = self.locate(self.pathPts, ed)

    @staticmethod
    def locate(pts, b):
        best, bestRes = 1e30, 0.0
        for i in range(NUM_GEARS):
            d, t = dist_to_segment(b, pts[i], pts[i + 1])
            if d < best:
                best = d
                bestRes = GEAR_EDGES[i] + t * (GEAR_EDGES[i + 1] - GEAR_EDGES[i])
        return bestRes, best

    def locate_on_path(self, b):
        return self.locate(self.pathPts, b)

    def update_gear(self, b, now, useDwell):
        res, off = self.locate_on_path(b)
        self.offPath = off
        if off > self.tol.get("offHold", OFFPATH_HOLD_UT):
            if not self.offPathHold:
                self.offPathHold, self.offPathSince = True, now
            if u32(now - self.offPathSince) < OFFPATH_HOLD_MAX_MS:
                return
        else:
            self.offPathHold = False
        self.resistance = res
        candidate = self.stableGear
        r = self.resistance
        while candidate < NUM_GEARS and r >= self.edgeUpR[candidate]:
            candidate += 1
        while candidate > 1 and r < self.edgeDownR[candidate - 1]:
            candidate -= 1
        if not useDwell:
            self.stableGear = self.pendingGear = candidate
            return
        if candidate == self.stableGear:
            self.pendingGear = self.stableGear
        elif candidate != self.pendingGear:
            self.pendingGear, self.pendingSince = candidate, now
        elif u32(now - self.pendingSince) >= GEAR_DWELL_MS:
            self.stableGear = candidate

    # ------------------------------------------------------------- the check (calCheck), as in the sketch
    @staticmethod
    def interp_point(p, good, lo, hi, i):                            # interpPoint()
        a, b = i - 1, i + 1
        while a >= lo and not good[a]:
            a -= 1
        while b <= hi and not good[b]:
            b += 1
        if a < lo or b > hi:
            return None
        f = (GEAR_EDGES[i] - GEAR_EDGES[a]) / (GEAR_EDGES[b] - GEAR_EDGES[a])
        return [p[a][k] + f * (p[b][k] - p[a][k]) for k in range(3)]

    @staticmethod
    def unit_dir(p, a, b):                                            # unitDir()
        v = [p[b][k] - p[a][k] for k in range(3)]
        n = math.sqrt(dot3(v, v))
        return [x / n for x in v] if n > 0 else [0.0, 0.0, 0.0]

    def chk_tangent(self, good, i):                                   # chkTangent()
        a, b = i - 1, i + 1
        while a >= 0 and not good[a]:
            a -= 1
        while b <= CHK_LAST and not good[b]:
            b += 1
        return self.unit_dir(self.cal["pts"], i if a < 0 else a, i if b > CHK_LAST else b)

    def chk_shape(self, good, i):                                     # chkShape(): (resid, chord)
        P = self.cal["pts"]
        L = [j for j in range(i - 1, -1, -1) if good[j]][:2]
        R = [j for j in range(i + 1, CHK_LAST + 1) if good[j]][:2]
        if not L or not R:
            return 0.0, 0.0
        idx = L[::-1] + R
        iL = len(L) - 1
        chord = dist3(P[R[0]], P[L[0]])
        if len(idx) < 3:
            return dist_to_segment(P[i], P[L[0]], P[R[0]])[0], chord
        x = [0.0]
        for k in range(1, len(idx)):
            x.append(x[-1] + dist3(P[idx[k]], P[idx[k - 1]]))
        mean = sum(x) / len(x)
        sc = 0.5 * (x[-1] - x[0])
        if sc <= 0:
            return dist_to_segment(P[i], P[L[0]], P[R[0]])[0], chord
        x = [(v - mean) / sc for v in x]
        M = [[0.0] * 6 for _ in range(3)]
        for k, j in enumerate(idx):
            f = [1.0, x[k], x[k] * x[k]]
            for a in range(3):
                for b in range(3):
                    M[a][b] += f[a] * f[b]
                for ax in range(3):
                    M[a][3 + ax] += f[a] * P[j][ax]
        for c in range(3):
            piv = max(range(c, 3), key=lambda r: abs(M[r][c]))
            if abs(M[piv][c]) < 1e-6:
                return dist_to_segment(P[i], P[L[0]], P[R[0]])[0], chord
            M[c], M[piv] = M[piv], M[c]
            inv = 1.0 / M[c][c]
            M[c] = [v * inv for v in M[c]]
            for r in range(3):
                if r != c:
                    f = M[r][c]
                    M[r] = [M[r][k] - f * M[c][k] for k in range(6)]
        best2 = 1e30
        for st in range(41):
            u = x[iL] + (x[iL + 1] - x[iL]) * st / 40.0
            d2 = sum((M[0][3 + ax] + u * (M[1][3 + ax] + u * M[2][3 + ax]) - P[i][ax]) ** 2 for ax in range(3))
            best2 = min(best2, d2)
        return math.sqrt(best2), chord

    def chk_off_up(self, good, b):                                    # chkOffUp()
        best, prev = 1e30, -1
        for j in range(CHK_LAST + 1):
            if not good[j]:
                continue
            if prev >= 0:
                best = min(best, dist_to_segment(b, self.cal["pts"][prev], self.cal["pts"][j])[0])
            prev = j
        return best

    def chk_order(self, p, good, lo, hi, sign):                      # chkOrder()
        out, h = [], -1
        lims = self.chkLim["order"]
        for j in range(hi - lo + 1):
            i = lo + j if sign > 0 else hi - j
            if not good[i]:
                continue
            if h >= 0:
                d = self.unit_dir(self.cal["pts"], constrain(min(h, i) - 1, 0, CHK_LAST),
                                  constrain(max(h, i) + 1, 0, CHK_LAST))
                x = sign * dot3([p[i][k] - p[h][k] for k in range(3)], d)
                lim = lims[i]
                if x < lim:
                    out.append((h, i, 1.0 + (lim - x)))
            h = i
        return out

    @staticmethod
    def chk_local_median(vals, i):                                    # chkLocalMedian(): the up-to-6 nearest other edges
        others = sorted((abs(j - i), j) for j in vals if j != i)[:PAIR_NEIGHBOURS]
        return st_median([vals[j] for _, j in others]) if others else 0.0

    def chk_round(self):                                              # chkRound(): (pass, idx, why) or None
        cal = self.cal
        lim = self.chkLim
        mask = cal.get("downMask", 0)
        exU, exD, exP = self.chkExU, self.chkExD, self.chkExP
        gU = [i <= CHK_LAST and not exU[i] and not exP[i] for i in range(NUM_GEARS + 1)]
        gD = [bool((mask >> i) & 1) and 1 <= i <= DOWN_FIRST and not exD[i] and not exP[i]
              for i in range(NUM_GEARS + 1)]
        self.chkGU, self.chkGD = gU, gD
        best = [1.0, None]

        def consider(sc, ps, i, w):
            if sc > best[0]:
                best[0], best[1] = sc, (ps, i, w)

        for i in range(1, CHK_LAST + 1):
            if not gU[i]:
                continue
            r, chord = self.chk_shape(gU, i)
            thr = lim["shape"][i] + CHECK_SHAPE_FRAC * chord
            if r > thr:
                consider(r / thr, 'u', i, "offpath")
        s, q, t = {}, {}, {}
        for i in range(1, DOWN_FIRST + 1):
            if not (gU[i] and gD[i]):
                continue
            t[i] = self.chk_tangent(gU, i)
            o = [cal["pts"][i][k] - cal["down"][i][k] for k in range(3)]
            s[i] = dot3(o, t[i])
            r = [o[k] - s[i] * t[i][k] for k in range(3)]
            q[i] = math.sqrt(dot3(r, r))
        self.chkHaveSmed = len(s) >= CHECK_MIN_PAIRS
        self.chkS = s
        # down points off the up path; on the bike every down point sits 1.5-3.5 uT across
        # the up path, so the limit is the usual cross offset plus a margin
        medQ = st_median(list(q.values())) if self.chkHaveSmed else 0.0
        for i in range(1, DOWN_FIRST + 1):
            if not gD[i]:
                continue
            offLim = max(lim["off"][i], medQ + lim["pair"][i]) if self.chkHaveSmed else lim["off"][i]
            d = self.chk_off_up(gU, cal["down"][i])
            if d > offLim:
                consider(d / offLim, 'd', i, "offpath")
        dev, devq = {}, {}
        if self.chkHaveSmed:
            for i in s:
                sm = self.chk_local_median(s, i)
                qm = self.chk_local_median(q, i)
                w = PAIR_END_WIDEN if i in (1, DOWN_FIRST) else 1.0           # end edges: neighbours on one side only
                dev[i] = (s[i] - sm) / (w * max(lim["pair"][i], PAIR_FRAC * abs(sm)))
                devq[i] = (q[i] - qm) / (w * max(lim["pair"][i], PAIR_FRAC * qm))
        vu = self.chk_order(cal["pts"], gU, 0, CHK_LAST, +1)
        vd = self.chk_order(cal["down"], gD, 1, DOWN_FIRST, -1) if mask else []
        inU = {x for h, i, _ in vu for x in (h, i)}
        inD = {x for h, i, _ in vd for x in (h, i)}
        for i in sorted(s):
            sc = max(abs(dev[i]), devq[i]) if i in dev else 0.0
            if sc <= 1:
                continue
            if i in inU and i not in inD:
                consider(sc, 'u', i, "updown")
                continue
            if i in inD and i not in inU:
                consider(sc, 'd', i, "updown")
                continue
            gu = self.interp_point(cal["pts"], gU, 0, CHK_LAST, i)
            gd = self.interp_point(cal["down"], gD, 1, DOWN_FIRST, i)
            eu = abs(dot3([cal["pts"][i][k] - gu[k] for k in range(3)], t[i])) if gu else 0.0
            ed = abs(dot3([cal["down"][i][k] - gd[k] for k in range(3)], t[i])) if gd else 0.0
            if eu > CHECK_BLAME_RATIO * ed:
                consider(sc, 'u', i, "updown")
            elif ed > CHECK_BLAME_RATIO * eu:
                consider(sc, 'd', i, "updown")
            else:
                consider(sc, 'p', i, "pair")
        for h, i, sc in vu:
            if h in dev and i in dev:
                j = h if abs(dev[h]) > abs(dev[i]) else i
            else:
                g = -1
                for m in range(h):
                    if gU[m]:
                        g = m
                steps = []
                for m in range(max(0, h - 3), min(CHK_LAST, i + 3)):
                    if len(steps) < 8 and m != h and m != g and gU[m] and gU[m + 1]:
                        steps.append(dist3(cal["pts"][m + 1], cal["pts"][m]))
                over = len(steps) >= 2 and g >= 0 and dist3(cal["pts"][h], cal["pts"][g]) > CHECK_OVERSHOOT * st_median(steps)
                j = h if over else i
            consider(sc, 'u', j, "behind")
        for h, i, sc in vd:
            j = (h if abs(dev[h]) > abs(dev[i]) else i) if (h in dev and i in dev) else i
            consider(sc, 'd', j, "behind")
        return best[1]

    def chk_prior(self):                                              # chkPrior()
        if not getattr(self, "prev", None):
            return
        P, Q = self.cal["pts"], self.prev
        bad = [not self.chkGU[i] for i in range(CHK_LAST + 1)]
        settled = False
        for rnd in range(PRIOR_MAX + 1):
            good = [i for i in range(CHK_LAST + 1) if not bad[i]]
            shift = [st_median([P[i][k] - Q[i][k] for i in good]) for k in range(3)]
            worst, wi = 0.0, -1
            for i in range(1, CHK_LAST + 1):
                if bad[i]:
                    continue
                d = math.sqrt(sum((P[i][k] - Q[i][k] - shift[k]) ** 2 for k in range(3)))
                lim = max(self.chkLim["prior"], PRIOR_FRAC * self.local_step(P, i))
                if d / lim > worst:
                    worst, wi = d / lim, i
            if worst <= 1.0:
                settled = True
                break
            if rnd == PRIOR_MAX:
                break
            bad[wi] = True
            self.chkExU[wi] = "prior"
        if not settled:
            for i in range(CHK_LAST + 1):
                if self.chkExU[i] == "prior":
                    self.chkExU[i] = None

    def chk_prior_guess(self, i):                                     # chkPriorGuess()
        P, Q = self.cal["pts"], self.prev
        a = next((j for j in range(i - 1, -1, -1) if self.chkGU[j] and not self.chkExU[j]), -1)
        b = next((j for j in range(i + 1, CHK_LAST + 1) if self.chkGU[j] and not self.chkExU[j]), -1)
        if a < 0 or b < 0:
            return list(P[i])
        da, db = dist3(Q[i], Q[a]), dist3(Q[b], Q[i])
        f = da / (da + db) if da + db > 0 else 0.5
        return [P[a][k] + f * (P[b][k] - P[a][k]) for k in range(3)]

    def chk_limits(self):                                             # chkLimits(): from the noise and the local step
        """Per point: the v3.2 floors, but never more than a share of the usual step around it
        (a weak signal has small steps), nor less than a multiple of the noise."""
        cal = self.cal
        P = cal["pts"]
        n = max(NOISE_FLOOR_UT, cal["noiseUT"] if cal.get("noiseUT", 0) > 0 else NOISE_DEFAULT_UT)
        cs = [st_median([dist3(P[m + 1], P[m]) for m in range(max(0, i - 3), min(CHK_LAST, i + 3))])
              for i in range(NUM_GEARS + 1)]
        self.chkLim = dict(
            order=[max(min(CHECK_ORDER_UT, K_ORDER_STEP * c), K_ORDER * n) for c in cs],
            shape=[max(min(CHECK_SHAPE_UT, K_SHAPE_STEP * c), K_SHAPE * n) for c in cs],
            off=[max(min(CHECK_OFF_UT, K_OFF_STEP * c), K_OFF * n) for c in cs],
            pair=[max(min(PAIR_MIN, K_PAIR_STEP * c), K_PAIR * n) for c in cs],
            prior=K_PRIOR * n)
        return self.chkLim

    def cal_check(self, emit=True):                                    # calCheck()
        self.suspects = []
        if not self.calValid:
            if emit:
                self.log("F,end,0")
            return []
        cal = self.cal
        self.chk_limits()
        n = NUM_GEARS + 1
        self.chkExU, self.chkExD, self.chkExP = [None] * n, [None] * n, [False] * n
        for _ in range(CHECK_MAX_ROUNDS):
            c = self.chk_round()
            if c is None:
                break
            ps, i, why = c
            if ps == 'u':
                self.chkExU[i] = why
            elif ps == 'd':
                self.chkExD[i] = why
            else:
                self.chkExP[i] = True
        self.chk_round()
        self.chk_prior()
        gU, gD = self.chkGU, self.chkGD

        def sm(i):                                                     # the usual up/down offset near edge i
            return self.chk_local_median(self.chkS, i) if self.chkHaveSmed else 0.0

        def add(ps, i, why, g):
            if len(self.suspects) < MAX_SUSPECTS:
                self.suspects.append((ps, i + 1, why, g))

        for i in range(1, CHK_LAST + 1):
            if not self.chkExU[i]:
                continue
            t = self.chk_tangent(gU, i)
            if self.chkExU[i] == "prior":
                g = self.chk_prior_guess(i)
            elif self.chkHaveSmed and gD[i]:
                g = [cal["down"][i][k] + sm(i) * t[k] for k in range(3)]
            else:
                g = self.interp_point(cal["pts"], gU, 0, CHK_LAST, i) or list(cal["pts"][i])
            add('u', i, self.chkExU[i], g)
        for i in range(1, DOWN_FIRST + 1):
            if not self.chkExD[i]:
                continue
            t = self.chk_tangent(gU, i)
            if self.chkHaveSmed and gU[i]:
                g = [cal["pts"][i][k] - sm(i) * t[k] for k in range(3)]
            else:
                g = self.interp_point(cal["down"], gD, 1, DOWN_FIRST, i)
                if g is None:
                    gu = self.interp_point(cal["pts"], gU, 0, CHK_LAST, i)
                    g = [gu[k] - sm(i) * t[k] for k in range(3)] if gu else list(cal["down"][i])
            add('d', i, self.chkExD[i], g)
        for i in range(1, DOWN_FIRST + 1):
            if not self.chkExP[i]:
                continue
            t = self.chk_tangent(gU, i)
            add('u', i, "pair", [cal["down"][i][k] + sm(i) * t[k] for k in range(3)])
            add('d', i, "pair", [cal["pts"][i][k] - sm(i) * t[k] for k in range(3)])
        if emit:
            self.print_check()
        return self.suspects

    def print_check(self):                                             # calPrintCheck()
        for ps, pt, why, g in self.suspects:
            self.log("F,%s,%d,%s,%.1f,%.1f,%.1f" % (ps, pt, why, g[0], g[1], g[2]))
        self.log("F,end,%d" % len(self.suspects))

    # ------------------------------------------------------------- loop() work after the samples
    def loop_tail(self):
        """What loop() does after draining the queue: the check after a save, then its F lines."""
        if self.checkPending:
            self.checkPending = False
            self.cal_check(False)
            self.build_path()
            self.print_check()

    def dump_calibration(self):                                        # 'k': Q lines, then the check's F lines
        cal = self.cal
        if not self.calValid or not cal or not cal.get("pts"):
            return self.log("Q,none")
        span, minStep, minStepAt = 0.0, 1e9, 1
        for i in range(NUM_GEARS + 1):
            p = cal["pts"][i]
            self.log("Q,%d,%.1f,%.1f,%.1f" % (i + 1, p[0], p[1], p[2]))
            if i:
                s = dist3(cal["pts"][i], cal["pts"][i - 1])
                span += s
                if s < minStep:
                    minStep, minStepAt = s, i
        for i in range(1, NUM_GEARS):
            if (cal["downMask"] >> i) & 1:
                d = cal["down"][i]
                self.log("Q,down,%d,%.1f,%.1f,%.1f" % (i + 1, d[0], d[1], d[2]))
        if cal.get("crankOk"):
            u = cal["crankU"]
            self.log("Q,crank,%.4f,%.4f,%.4f,%.1f,%d" % (u[0], u[1], u[2], cal["crankDepth"], cal["crankSign"]))
        self.log("Q,end,%.1f,%.2f,%d" % (span, minStep, minStepAt))
        self.print_check()

    # ------------------------------------------------------------- '#' line commands
    def line(self, text, src=None):                                    # handleLine(): text without '#'
        if src is not None:
            self.cmdSrc = src
        self._line(text)
        self.loop_tail()

    def _line(self, text):
        if text[:1] in ("J", "j") and (len(text) == 1 or text[1] == ","):   # '#J,<text>': echo for the log (USB)
            self.log("J," + text[2:])
            return
        f = [t for t in text.split(",") if t][:7]                       # strtok(): empty fields vanish
        if not f:
            return
        cmd = f[0][:1].upper()
        ps = f[1][:1].lower() if len(f) > 1 else ""
        point = atoi(f[2]) if len(f) > 2 else 0
        pass_ok = ps in ("u", "d")
        n = len(f)
        if cmd == "R" and n == 3 and pass_ok:
            return self.cal_fix_start(ps == "d", point)
        if cmd == "G" and n == 3 and pass_ok:
            for sp, spt, _, g in self.suspects:
                if sp != ps or spt != point:
                    continue
                if self.calState != CAL_IDLE:
                    return self.log("E,fail,busy calibrating")
                up = [list(x) for x in self.cal["pts"]]
                down = [list(x) for x in self.cal["down"]]
                (up if ps == "u" else down)[point - 1] = list(g)
                return self.cal_commit(up, down, self.cal["downMask"], COMMIT_EDIT)
            return self.log("E,fail,that point isn't in the latest check")
        if cmd == "P" and n == 6 and pass_ok:
            if not self.calValid:
                return self.log("E,fail,no calibration to edit")
            i = point - 1
            if i < 0 or i > NUM_GEARS - 1 or (ps == "d" and not 1 <= i <= DOWN_FIRST):
                return self.log("E,fail,no such point")
            if not self.staging:
                self.stageUp = [list(x) for x in self.cal["pts"]]
                self.stageDown = [list(x) for x in self.cal["down"]]
                self.stageMask = self.cal["downMask"]
                self.staging = True
            if not all(strtof_ok(x) for x in f[3:6]):
                return self.log("E,fail,bad number")
            q = [float(x) for x in f[3:6]]
            if ps == "u":
                self.stageUp[i] = q
            else:
                self.stageDown[i] = q
                self.stageMask |= 1 << i
            return self.log("E,ok,staged")
        if cmd == "W" and n == 1:
            if not self.staging:
                return self.log("E,fail,nothing staged")
            if self.calState != CAL_IDLE:
                return self.log("E,fail,busy calibrating")
            return self.cal_commit(self.stageUp, self.stageDown, self.stageMask, COMMIT_EDIT)
        if cmd == "X" and n == 1:
            self.staging = False
            return self.log("E,ok,discarded")
        if cmd == "M" and n == 1:                                       # the board was moved
            self.spotForced = True
            self.prev = None
            return self.log("E,ok,moved")
        if cmd == "D" and n == 1:
            return self.cal_down_start()
        if cmd == "E" and n == 1:                                       # erase the calibration (USB only)
            if self.cmdSrc != "usb":
                return self.log("E,fail,usb only")
            if self.calState != CAL_IDLE:
                return self.log("E,fail,busy calibrating")
            self.cal, self.calValid, self.prev = None, False, None
            self.suspects, self.staging, self.spotForced = [], False, False
            self.load_crank_from_cal()
            self.stableGear = self.pendingGear = 1
            return self.log("E,ok,erased")
        if cmd == "I" and n == 1:                                       # injected samples (USB only)
            if self.cmdSrc != "usb":
                return self.log("E,fail,usb only")
            if self.calState != CAL_IDLE:
                return self.log("E,fail,busy calibrating")
            self.injecting = not self.injecting
            self.reset_signal_chain()
            return self.log("E,ok,inject " + ("on" if self.injecting else "off"))
        if cmd == "S" and n == 5:
            if self.cmdSrc != "usb":
                return self.log("E,fail,usb only")
            if not self.injecting:
                return self.log("E,fail,not injecting")
            if not re.match(r"\s*\d+$", f[1]) or not all(strtof_ok(x) for x in f[2:5]):
                return self.log("E,fail,bad number")
            ms = int(f[1]) & M32
            raw = [float(x) for x in f[2:5]]
            self.ms_now = ms
            self._process_sample(ms, raw, any(abs(x) > SATURATION_UT for x in raw))
            return
        self.log("E,fail,unknown command")

    def reset_signal_chain(self):                                      # resetSignalChain() ('#I')
        self.medianIdx = self.medianFill = 0
        self.emaSeeded = False
        self.crank_reset(self.crank["base"])
        self.selfPeriods = [0, 0]
        self.lastTurnMs = self.ms_now

    def input(self, text, src="usb"):                                  # handleInput() for each character
        for ch in text:
            self._input_char(ch, src)
        self.loop_tail()

    def _input_char(self, ch, src):
        st_ = self.inBuf[src]
        now = self.ms_now
        if st_["active"] and u32(now - st_["lastMs"]) > LINE_TIMEOUT_MS:
            st_["active"] = False
        st_["lastMs"] = now
        if st_["active"]:
            if ch in "\r\n":
                st_["active"] = False
                if st_["overflow"]:
                    self.log("E,fail,line too long")
                else:
                    self.cmdSrc = src
                    self._line(st_["buf"])
            elif len(st_["buf"]) < 63:
                st_["buf"] += ch
            else:
                st_["overflow"] = True
            return
        if ch == "#":
            st_.update(active=True, overflow=False, buf="")
            return
        self.cmdSrc = src
        self._command(ch)

    # ------------------------------------------------------------- turns, samples
    def on_turn_boundary(self, result, avg, periodMs, now):
        self.selfRevs = (self.selfRevs + 1) & 0xFFFF
        self.selfEventMs = now
        self.lastTurnMs = now
        self.lastDip = self.crDipMax                                   # the dip just finished
        self.boundaries.append((now, result, periodMs, avg))
        if result != 2:
            self.selfPeriods = [0, 0]
            return
        self.selfPeriods = [periodMs, self.selfPeriods[0]]
        self.place_on_turn(avg)
        self.cal_on_turn(avg)
        if self.calValid and self.cal.get("crankOk") and self.cal.get("pts"):
            self.update_gear(avg, now, False)

    def process_sample(self, ms, raw, sat=False):                   # processSample() + loop_tail()
        if self.injecting:                                             # real reads are ignored ('#I')
            return
        self._process_sample(ms, raw, sat)
        self.loop_tail()

    def _process_sample(self, ms, raw, sat=False):
        self.saturated = sat
        if sat and self.calState == CAL_SURVEY:
            self.survSat = True
        self.place_on_sample(ms, raw)
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
        self.update_pause(ms)
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
        if self.placeOn and (self.lastX is None or u32(ms - self.lastX) >= X_PERIOD_MS):
            self.lastX = ms
            self.log(self.x_line())
        if self.crank["ok"] or self.calState == CAL_LEARN:
            return
        self.cal_on_sample(self.fieldUT)
        self.cal_auto_check()
        if not self.calValid or not self.cal.get("pts"):
            return
        self.update_gear(self.fieldUT, ms, True)

    # ------------------------------------------------------------- placement stream ('v', X lines)
    def place_on_sample(self, ms, raw):                               # placeOnSample()
        if self.slowField is None:
            self.slowField = list(raw)
            self.hpStart = ms
        a = min(1.0, SAMPLE_PERIOD_MS / 1000.0)
        for k in range(3):
            self.slowField[k] += a * (raw[k] - self.slowField[k])
        hp = [raw[k] - self.slowField[k] for k in range(3)]
        if self.hpMin is None:
            self.hpMin, self.hpMax = list(hp), list(hp)
        self.hpMin = [min(self.hpMin[k], hp[k]) for k in range(3)]
        self.hpMax = [max(self.hpMax[k], hp[k]) for k in range(3)]
        if u32(ms - self.hpStart) >= 1000:
            self.hpP2P = math.sqrt(sum((self.hpMax[k] - self.hpMin[k]) ** 2 for k in range(3)))
            self.hpMin = self.hpMax = None
            self.hpStart = ms
        self.peakAbs = max(self.peakAbs, max(abs(x) for x in raw))
        if self.placeOn and not self.crank["ok"]:
            self.place_extend(self.slowField)

    def place_extend(self, b):
        if self.placeMin is None:
            self.placeMin, self.placeMax = list(b), list(b)
        self.placeMin = [min(self.placeMin[k], b[k]) for k in range(3)]
        self.placeMax = [max(self.placeMax[k], b[k]) for k in range(3)]

    def place_on_turn(self, avg):                                     # placeOnTurn()
        self.xTurns.append(list(avg))
        if len(self.xTurns) > X_NOISE_TURNS:
            self.xTurns.pop(0)
        if self.placeOn:
            self.place_extend(avg)

    def x_fields(self):                                                # printPlacement()
        mag = math.sqrt(dot3(self.fieldUT, self.fieldUT))
        swing = math.sqrt(sum((self.placeMax[k] - self.placeMin[k]) ** 2 for k in range(3))) if self.placeMin else 0.0
        dip = self.lastDip if self.crank["ok"] else self.hpP2P
        head = 100.0 * (1.0 - min(1.0, self.peakAbs / SATURATION_UT))
        d = [dist3(a, b) for a, b in zip(self.xTurns, self.xTurns[1:])]
        noise = st_median(d) if len(d) >= 3 and self.crank["ok"] else self.tol["noise"]
        self.peakAbs = 0.0
        return dict(fieldMag=mag, swing=swing, dip=dip, headroomPct=head, noise=noise)

    def x_line(self):
        x = self.x_fields()
        return "X,%.1f,%.1f,%.1f,%.0f,%.2f" % (x["fieldMag"], x["swing"], x["dip"], x["headroomPct"], x["noise"])

    # ------------------------------------------------------------- power
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

    # ------------------------------------------------------------- commands
    def command(self, ch, src="usb"):                                  # handleCommand() (+ loop_tail)
        self.cmdSrc = src
        self._command(ch)
        self.loop_tail()

    def _command(self, ch):
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
            if self.calState in (CAL_DOWN_READY,):
                self.cal_skip_down()
            elif self.calState != CAL_IDLE and self.calPass == PASS_DOWN:
                self.cal_finish_down()                                 # the down points so far are kept
            elif self.calState != CAL_IDLE:
                self.cal_abort("cancelled by user")
        elif ch == 'a':
            self.autoCapture = not self.autoCapture
        elif ch == 's':
            self.cal_skip_down()
        elif ch == 'v':
            self.placeOn = not self.placeOn
            self.placeMin = self.placeMax = None
            self.peakAbs = 0.0
            self.lastX = None
        elif ch == 'k':
            self.dump_calibration()

    def short_press(self):                                             # handleShortPress()
        self.cmdSrc = "button"
        if self.calState in (CAL_WAITING, CAL_CONFIRM, CAL_POINT_CHECK, CAL_SURVEY, CAL_DOWN_READY):
            self.cal_capture()
        self.loop_tail()

    def long_press(self):                                              # handleLongPress()
        self.cmdSrc = "button"
        if self.calState == CAL_IDLE:
            self.cal_start()
        else:
            self._command('x')
        self.loop_tail()

    # ------------------------------------------------------------- status
    def flags(self):                                                   # printStatus() flags
        s = ""
        if self.calValid:
            s += "V"
        if self.offPathHold:
            s += "H"
        if self.autoCapture:
            s += "A"
        if self.pedalling():
            s += "R"
        if self.settleSince and self.calState == CAL_WAITING:
            s += "M"
        fixing = self.calPass in (PASS_FIX_UP, PASS_FIX_DOWN) or (self.calPass == PASS_DOWN and self.downGate)
        if self.calState == CAL_WAITING and ((fixing and not self.fixArmed) or self.backGate):
            s += "B"
        if self.paused:
            s += "O"
        return s

    def pass_name(self):                                               # printStatus() pass field
        if self.calState == CAL_IDLE:
            return "-"
        if self.calState == CAL_SURVEY and self.survPhase != SURV_NOISE:
            return "su" if self.survPhase == SURV_UP else "sd"
        return {PASS_UP: "u", PASS_DOWN: "d", PASS_FIX_UP: "ru", PASS_FIX_DOWN: "rd"}[self.calPass]

    def status_fields(self):                                           # printStatus()
        ps = self.pass_name()
        return dict(gear=self.stableGear if self.calValid else 0, res=self.resistance, watts=self.powerW,
                    cad=self.cadenceRpm, cal=self.calState, point=self.calStep, calStep=self.calStep,
                    stab=self.stabPct, off=self.offPath, flags=self.flags(),
                    lturns=self.learnLast["turns"] if self.calState == CAL_LEARN else 0, pass_=ps,
                    step=self.step_no, steps=STEPS_TOTAL)

    def status_line(self):
        s = self.status_fields()
        return "S,%d,%.1f,%.0f,%.1f,%d,%d,%d,%.1f,%s,%u,%s,%u,%s,%d,%d" % (
            s["gear"], s["res"], s["watts"], s["cad"], s["cal"], s["point"], s["stab"], s["off"], s["flags"], 0,
            "B" if self.pedalling() else "-", s["lturns"], s["pass_"], s["step"], s["steps"])


def tick_millis(k):
    """millis() of the k-th sensor-task wake-up: 20 ticks of 1/1024 s, tick2ms()."""
    return (k * 20 * 1000) // 1024
