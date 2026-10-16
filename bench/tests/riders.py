"""Realistic simulated riders for the v3.3 tests (closed loop through fw_model).

Builds on the Sim / Rider / Console classes of test_fw_v32.py (copied here,
because importing that file runs its tests) and adds what the real bike
showed on 2026-10-16 (bench/logs/2026-10-16_v3_2b.log):

  - the lever settles back 0.1-0.8 uT (now and then up to 1.2 uT) a turn or
    two after the rider stops, or after the save beep (v3.2b behaviour);
  - an occasional slow creep (0.6 uT/s);
  - lever wobble at a held lever (turn-to-turn scatter like the bike's);
  - lower cadence in high gears (about 75 rpm up to gear 12, 45 rpm from 19);
  - stop - shift - pedal (3-8 s), rests (60 s), slow reactions, overshoots,
    pauses mid-gear, phone disconnects;
  - field strength x0.3 / x3 (board moved further / closer);
  - the v3.3 flow: crank -> cadence 'n' -> survey sweep up 'n' -> sweep down
    'n' -> up pass -> 'n' -> down pass.  On the v3.2 model the survey and the
    'n' before the down pass simply never come up.

Everything that touches a v3.3 name goes through API below, so the tests can
be adapted to the final model in one place.
"""
import json
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fw_model as fw  # noqa: E402
_argv, sys.argv = sys.argv, sys.argv[:1]               # synth.py reads sys.argv[1] as a log file
import synth  # noqa: E402
sys.argv = _argv

HERE = os.path.dirname(os.path.abspath(__file__))
LEV, BASE = synth.LEV, synth.BASE
_c = [LEV[1] * synth.CK["u"][2] - LEV[2] * synth.CK["u"][1],
      LEV[2] * synth.CK["u"][0] - LEV[0] * synth.CK["u"][2],
      LEV[0] * synth.CK["u"][1] - LEV[1] * synth.CK["u"][0]]
_n = math.sqrt(fw.dot3(_c, _c))
PERP = [x / _n for x in _c]
SAT_UT = 1600.0                                    # LIS3MDL +-16 gauss


def field_at(L):
    """Lever position L (uT along the path, scale 1) -> field, gently curved path."""
    bend = 0.002 * L * L
    return [BASE[j] + L * LEV[j] + bend * PERP[j] for j in range(3)]


def along(b, scale=1.0):
    """Field -> lever position (uT at scale 1)."""
    return fw.dot3([b[j] / scale - BASE[j] for j in range(3)], LEV)


# Gear edges along the lever (uT from the bottom), spaced like the real bike's steps.
STEPS = [17.8, 15.7, 13.0, 2.35, 4.7, 2.8, 3.05, 5.5, 5.65, 4.3, 6.3, 3.7, 2.55, 7.0, 3.2, 3.8, 5.2, 3.9,
         1.8, 1.8, 3.8, 3.8, 6.0]
UP_EDGE = [0.0]
for s_ in STEPS:
    UP_EDGE.append(UP_EDGE[-1] + s_)                  # index i: where gear i+1 starts going up
TOP_L = UP_EDGE[-1] + 4.0
PEDAL_TOP = UP_EDGE[-1] + 2.0                         # as far as a rider can still pedal


def R_TOP():
    return PEDAL_TOP

# The console's stickiness coming down (uT below the up edge), point by point.  The v3.2b calibration
# (2026-10-16) has up/down gaps of 0.7-9.4 uT, median 6.2 (about 1x the local step); the outliers there
# are points the check flagged (15, 18, 21-23), so the 'bike' console uses a smooth version: about 6.5 uT
# up to gear 14, falling to 3 uT at gear 23, +-10 % per edge, kept so a down step is never less than
# 60 % of the up step (the real down steps are 1.8-6.4 uT).
BIKE_GAP_RAW = [0.0, 6.2, 9.2, 9.4, 6.3, 7.1, 6.6, 4.6, 5.5, 6.1, 8.4, 5.7, 7.2, 6.5, 0.7, 3.2, 6.8, 3.4, 6.3,
                4.4, 2.6, 2.8, 2.2, 2.2, 0.0]
BIKE_GAP = [0.0] + [fw.interp_table([1, 13, 16, 23], [6.5, 6.5, 5.0, 3.0], i) for i in range(1, 24)] + [0.0]


def console_h(rnd, kind="bike", edges=None):
    E = edges or UP_EDGE
    if kind == "small":                               # the old test_fw_v32 console: 0.4-0.8 uT
        return [0.0] + [0.4 + 0.4 * rnd.random() for _ in range(23)] + [0.0]
    h = [0.0] * 25
    for i in range(1, 24):
        h[i] = BIKE_GAP[i] * rnd.uniform(0.9, 1.1)
    for i in range(2, 24):                            # down step i-1 -> i at least 60 % of the up step
        h[i] = min(h[i], h[i - 1] + 0.4 * (E[i] - E[i - 1]))
    return h


# cadence vs the console's gear, from the v3.2b up pass (75 rpm to gear 12, ~46 from 19)
CAD_PROFILE = [(1, 1.0), (12, 0.95), (15, 0.87), (17, 0.80), (18, 0.70), (19, 0.62), (24, 0.60)]


def cad_factor(g):
    return fw.interp_table([x for x, _ in CAD_PROFILE], [y for _, y in CAD_PROFILE], g)


def ps_name(ps):
    return {fw.PASS_UP: "up", fw.PASS_DOWN: "down", fw.PASS_FIX_UP: "redo-up", fw.PASS_FIX_DOWN: "redo-down"}.get(ps, "?")


def crank_cal():
    return dict(crankOk=1, crankSign=synth.CK["sign"], crankU=list(synth.CK["u"]), crankDepth=synth.CK["depth"],
                crankBase=synth.CK["base"])


# ====================================================================== API adapter
class API:
    """Every v3.3 name the tests use (fw_model v3.3 API), with fallbacks for the v3.2 model."""

    @staticmethod
    def is_v33():
        return hasattr(fw.Firmware, "derive_tolerances")

    @staticmethod
    def version():
        return "v3.3" if API.is_v33() else "v3.2"

    # -- state
    @staticmethod
    def phase(f):
        """idle | learn | confirm | survey_noise | sweep_up | sweep_down | up | down | fix_up | fix_down |
        check (the 'keeps changing' card) | saved_up (CAL_DOWN_READY: 'n' starts the down pass)."""
        st = f.calState
        if st == getattr(fw, "CAL_SURVEY", -1):
            return {getattr(fw, "SURV_NOISE", 0): "survey_noise", getattr(fw, "SURV_UP", 1): "sweep_up",
                    getattr(fw, "SURV_DOWN", 2): "sweep_down"}.get(f.survPhase, "sweep_up")
        if st == getattr(fw, "CAL_DOWN_READY", -1):
            return "saved_up"
        if st == fw.CAL_IDLE:
            return "idle"
        if st == fw.CAL_LEARN:
            return "learn"
        if st == fw.CAL_CONFIRM:
            return "confirm"
        if st == fw.CAL_POINT_CHECK:
            return "check"
        return {fw.PASS_UP: "up", fw.PASS_DOWN: "down", fw.PASS_FIX_UP: "fix_up",
                fw.PASS_FIX_DOWN: "fix_down"}.get(f.calPass, "up")

    @staticmethod
    def step_no(f):
        return getattr(f, "step_no", None)

    @staticmethod
    def paused(f):
        return bool(getattr(f, "paused", False))

    @staticmethod
    def flags(f):
        fl = getattr(f, "flags", None)
        if callable(fl):
            return fl()
        s = ""
        if f.calValid:
            s += "V"
        if getattr(f, "settleSince", 0) and f.calState == fw.CAL_WAITING:
            s += "M"
        fixing = f.calPass in (fw.PASS_FIX_UP, fw.PASS_FIX_DOWN)
        if f.calState == fw.CAL_WAITING and ((fixing and not f.fixArmed) or getattr(f, "backGate", False)):
            s += "B"
        return s

    @staticmethod
    def go_back(f):
        """Flag B during the up / down pass: the board went back and wants the lever past the point first."""
        return "B" in API.flags(f)

    @staticmethod
    def tol(f):
        return getattr(f, "tol", None)

    @staticmethod
    def phone(f, connected):
        fn = getattr(f, "phone_connected", None)
        if fn is None:
            return False
        fn(connected)
        return True

    @staticmethod
    def start(f, src="usb"):
        """'c' from USB / BLE / the button."""
        if src == "button":
            return f.long_press()
        try:
            return f.command('c', src=src)
        except TypeError:
            return f.command('c')

    @staticmethod
    def command(f, c, src="usb"):
        try:
            return f.command(c, src=src)
        except TypeError:
            return f.command(c)

    @staticmethod
    def line(f, text, src="usb"):
        """A '#' command (text without '#')."""
        try:
            return f.line(text, src)
        except TypeError:
            return f.line(text)

    @staticmethod
    def set_noise(f, noise, settle=None, spot=None, exp_step=None):
        """Put a measured noise / settle / spot / expected steps in and derive the tolerances."""
        f.noiseUT = noise
        f.settleRing = [] if settle is None else [settle]
        if spot is not None:
            f.spotKind = fw.SPOT_NAMES.index(spot)
        if exp_step is not None:
            f.expStep = list(exp_step) if isinstance(exp_step, list) else [0.0] + [exp_step] * 23 + [0.0]
        return f.derive_tolerances()


# ====================================================================== the console
class Console:
    """The Keiser console's gear, with its own stickiness h (uT) at each edge."""

    def __init__(self, h, edges=None):
        self.h, self.g = h, 1
        self.E = edges or UP_EDGE

    def update(self, L):
        while self.g < 24 and L >= self.E[self.g]:
            self.g += 1
        while self.g > 1 and L < self.E[self.g - 1] - self.h[self.g - 1]:
            self.g -= 1
        return self.g


# ====================================================================== the bike + lever
class Sim:
    """Closed loop at the board's sample clock: lever dynamics, cadence, field.

    lever:   target (rider's hand), speed (uT/s), settle / creep / wobble on top
    pedal:   self.pedal on/off; the rpm ramps (about 1 s down, 1.5 s up)
    field:   scale x (field_at(L) + crank) + sensor noise; saturates at 1600 uT
    record:  keeps every sample and command for scenario files (hil_replay)
    """

    def __init__(self, f, rpm=75, noise=0.3, seed=1, speed=6.0, h=None, scale=1.0, gear_cadence=True,
                 wobble=0.70, wobble_tau=0.5, cad_jitter=0.03, settle=(0.85, "stop"), settle_big=0.12,
                 creep_p=0.08, creep_rate=0.6, record=False, t0_k=0, steps=None, noise_scales=False):
        self.f, self.rpm0, self.noise = f, rpm, noise
        self.rnd = random.Random(seed)
        self.speed = speed
        # the bike's gear edges (uT along the lever): steps=None is the real bike's spacing (STEPS)
        self.edges = [0.0]
        for s_ in (steps or STEPS):
            self.edges.append(self.edges[-1] + s_)
        self.pedal_top = self.edges[-1] + 2.0
        self.h = h if isinstance(h, list) else console_h(self.rnd, h or "bike", self.edges)
        self.console = Console(self.h, self.edges)
        # noise_scales=False (default): the turn-to-turn wobble stays at today's level in uT of field
        # whatever the field scale (sensor + mechanical noise don't shrink when the board moves away);
        # True: the wobble is lever motion and scales with the field (the old behaviour)
        self.noise_scales = noise_scales
        self.scale = scale
        self.gear_cadence = gear_cadence
        self.wobble_sd, self.wobble_tau = wobble, wobble_tau
        self.cad_jitter = cad_jitter
        self.settle_p, self.settle_mode = settle if settle else (0.0, "stop")
        self.settle_big = settle_big
        self.creep_p, self.creep_rate = creep_p, creep_rate
        self.L = 0.0                       # hand position
        self.target = 0.0
        self.move_speed = None             # override for one move (sweeps)
        self.off = 0.0                     # settle + creep offset on top of the hand
        self.off_target = 0.0
        self.off_tau = 0.5
        self.creep_until = 0.0
        self.creep_dir = 0.0
        self.wob = 0.0
        self.k, self.phase = t0_k, self.rnd.random()
        self.rpm_now = rpm
        self.turn_jit = 1.0
        self.pedal = True
        self.moving = False
        self.last_dir = 0.0
        self.pending = []                  # (t_s, fn) scheduled lever events
        self.stops = {}                    # (pass, point index) -> where the rider meant to stop
        self.history = []                  # (ms, lever position incl. offsets) every 5th sample
        self.record = record
        self.trace = []                    # ("s", ms, raw) / ("c", ms, cmd) / ("l", ms, line) / ("p", ms, bool)
        self.events = []                   # (ms, text) rider-side notes
        self.n_caps = 0
        self.src = "usb"                   # where the rider's taps come from (the phone = 'ble')

    # -- helpers
    def t(self):
        return fw.tick_millis(self.k) / 1000.0

    def lever(self):
        return self.L + self.off + self.wob

    def gear(self):
        return self.console.g

    def cmd(self, c, src=None):
        ms = self.f.ms_now
        if self.record:
            self.trace.append(("c", ms, (c, src or self.src)))
        API.command(self.f, c, src or self.src)

    def hash_line(self, text):
        ms = self.f.ms_now
        if self.record:
            self.trace.append(("l", ms, text))
        return API.line(self.f, text)

    def phone(self, connected):
        if self.record:
            self.trace.append(("p", self.f.ms_now, bool(connected)))
        return API.phone(self.f, connected)

    def move_to(self, L, speed=None):
        self.target = L
        self.move_speed = speed

    def schedule(self, delay_s, fn):
        self.pending.append((self.t() + delay_s, fn))

    def _settle(self, direction):
        """The lever eases back against the last move."""
        if direction == 0 or self.rnd.random() >= self.settle_p:
            return
        amt = self.rnd.uniform(0.8, 1.2) if self.rnd.random() < self.settle_big else self.rnd.uniform(0.1, 0.8)
        turn = 60.0 / max(self.rpm_now, 30.0)
        delay = self.rnd.uniform(0.5, 2.0) * turn
        tgt = -direction * amt

        def go():
            self.off_target = self.off + tgt
            self.off_tau = 0.5 * turn
        self.schedule(delay, go)

    def on_capture(self):
        """Called by the rider when the board saved a point (the beep)."""
        if self.settle_mode == "save":
            self._settle(self.last_dir)

    # -- one sample
    def step(self):
        t_ms = fw.tick_millis(self.k)
        if self.k:
            dt = (t_ms - fw.tick_millis(self.k - 1)) / 1000.0
            t = t_ms / 1000.0
            for ev in [e for e in self.pending if e[0] <= t]:
                self.pending.remove(ev)
                ev[1]()
            # cadence
            g = self.console.g
            want = (self.rpm0 * (cad_factor(g) if self.gear_cadence else 1.0)) if self.pedal else 0.0
            ramp = (60.0 if want < self.rpm_now else 45.0) * dt      # rpm per sample
            self.rpm_now = want if abs(want - self.rpm_now) <= ramp else self.rpm_now + math.copysign(ramp, want - self.rpm_now)
            newp = self.phase + self.rpm_now * self.turn_jit / 60.0 * dt
            if math.floor(newp) > math.floor(self.phase):
                self.turn_jit = 1.0 + self.rnd.gauss(0, self.cad_jitter)
            self.phase = newp
            # hand
            d = self.target - self.L
            mv = (self.move_speed or self.speed) * dt
            if abs(d) > 1e-9:
                if not self.moving:                 # the hand takes the lever from where it settled
                    self.L += self.off
                    self.off = self.off_target = 0.0
                    self.creep_until = 0.0
                    d = self.target - self.L
                self.moving = True
                self.last_dir = math.copysign(1.0, d)
                self.L = self.target if abs(d) <= mv else self.L + math.copysign(mv, d)
                if self.L == self.target and abs(d) <= mv:
                    self.moving = False
                    self.move_speed = None
                    if self.settle_mode == "stop":
                        self._settle(self.last_dir)
                    if self.rnd.random() < self.creep_p:
                        c0 = self.rnd.uniform(1.0, 4.0)
                        dur = self.rnd.uniform(1.0, 2.5)
                        cdir = -self.last_dir if self.rnd.random() < 0.5 else self.last_dir
                        self.schedule(c0, lambda cd=cdir, du=dur: self._creep(cd, du))
            # settle offset (first-order) + creep
            self.off += (self.off_target - self.off) * min(1.0, dt / max(self.off_tau, 1e-3))
            if t < self.creep_until:
                self.off += self.creep_dir * self.creep_rate * dt
                self.off_target += self.creep_dir * self.creep_rate * dt
            # wobble (Ornstein-Uhlenbeck), only while pedalling
            if self.wobble_sd > 0:
                a = dt / self.wobble_tau
                amp = self.wobble_sd if self.rpm_now > 5 else 0.3 * self.wobble_sd
                if not self.noise_scales:
                    amp /= self.scale
                self.wob += -a * self.wob + amp * math.sqrt(2 * a) * self.rnd.gauss(0, 1)
        lev = self.lever()
        self.console.update(lev)
        c = synth.crank_at(self.phase)
        base = field_at(lev)
        raw = [self.scale * (base[j] + c[j]) + self.rnd.gauss(0, self.noise) for j in range(3)]
        sat = any(abs(x) >= SAT_UT for x in raw)
        raw = [max(-SAT_UT, min(SAT_UT, x)) for x in raw]
        f = self.f
        f.ms_now = t_ms
        if self.record:
            self.trace.append(("s", t_ms, [round(x, 2) for x in raw]))
        f.process_sample(t_ms, raw, sat) if sat else f.process_sample(t_ms, raw)
        if self.k % 5 == 0:
            self.history.append((t_ms, self.L + self.off))     # the lever without its wobble
        self.k += 1
        return t_ms

    def _creep(self, cdir, dur):
        self.creep_dir = cdir
        self.creep_until = self.t() + dur

    def run(self, seconds, policy=None):
        end = fw.tick_millis(self.k) + seconds * 1000
        while fw.tick_millis(self.k) < end:
            self.step()
            if policy and policy(self):
                return True
        return False

    def lever_at(self, ms):
        """Lever position at a time (from the history)."""
        lo, hi = 0, len(self.history) - 1
        if hi < 0:
            return self.lever()
        while lo < hi:
            mid = (lo + hi) // 2
            if self.history[mid][0] < ms:
                lo = mid + 1
            else:
                hi = mid
        return self.history[lo][1]

    def lever_span(self, ms0, ms1):
        v = [L for t, L in self.history if ms0 <= t <= ms1]
        return (max(v) - min(v)) if v else 0.0

    # -- scenario files (hil_replay)
    def scenario(self, name, note="", initial_cal=None):
        ev = []
        for kind, ms, x in self.trace:
            if kind == "s":
                ev.append([ms, "S", x])
            elif kind == "c":
                c, src = x if isinstance(x, tuple) else (x, "usb")
                ev.append([ms, "C", c] + ([src] if src != "usb" else []))
            elif kind == "l":
                ev.append([ms, "L", x])
            elif kind == "p":
                ev.append([ms, "P", 1 if x else 0])
        return dict(name=name, note=note, model=API.version(), initial_cal=initial_cal, events=ev)


def save_scenario(sc, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(sc, fh, separators=(",", ":"))


# ====================================================================== the rider
class Rider:
    """Follows the board like a person with the phone page open.

    Options (all off by default = the "normal rider"):
      react_s            reaction time before moving after a prompt (s)
      overshoot          (lo, hi) uT past the console edge where they stop
      stop_shift         probability per point of stop - shift - pedal; pause_s = (lo, hi)
      mid_pause          probability per point of a pause mid-gear (still pedalling), mid_s = (lo, hi) s,
                         mid_frac = (lo, hi) fraction of the way from where the lever is to the stop
      rests              {(pass, step): seconds} stop pedalling for that long before moving
      overshoot_at       {(pass, step)}: overshoot overshoot_by uT past the next edge there, then follow the go-back
      disconnects        {(pass, step): seconds} phone drops at that prompt for that long
      continue_down      True: tap 'n' on the "Saved" card; False: stop there ("Later")
      sweep_speed        uT/s during the survey sweeps
      on_prompt          callback(rider, sim, pass, step) for scenario-specific actions; return True to
                         take over that prompt
    """

    def __init__(self, sim, react_s=0.6, overshoot=(0.1, 0.4), stop_shift=0.0, pause_s=(3.0, 8.0),
                 mid_pause=0.0, mid_s=(3.0, 6.0), mid_frac=(0.4, 0.6), rests=None, overshoot_at=None, disconnects=None,
                 continue_down=True, sweep_speed=7.0, on_prompt=None, check_tap_s=3.0, undo_after=45.0,
                 overshoot_by=3.0):
        self.sim = sim
        self.react_s, self.over = react_s, overshoot
        self.stop_shift, self.pause_s = stop_shift, pause_s
        self.mid_pause, self.mid_s, self.mid_frac = mid_pause, mid_s, mid_frac
        self.mids = {}                   # (pass, step) -> (lever position of the pause, fraction of the step)
        self.mid_windows = []            # (pass, step, lever position, time the pause was planned)
        self.rests = dict(rests or {})
        self.overshoot_at = set(overshoot_at or ())
        self.disconnects = dict(disconnects or {})
        self.continue_down = continue_down
        self.sweep_speed = sweep_speed
        self.on_prompt = on_prompt
        self.check_tap_s = check_tap_s
        self.undo_after = undo_after
        self.out_seen = 0
        self.stucks = {}
        self.stuck_moves = 0
        self.overshoot_by = overshoot_by
        self.undos = 0
        self.key = None
        self.since = 0
        self.planned = False
        self.busy_until = 0.0
        self.tapped = set()
        self.went_back = False
        self.over_done = set()
        self.ncap = 0
        self.log = []                    # (t, what)
        self.done = False
        self.phases_seen = []

    def note(self, what):
        self.log.append((round(self.sim.t(), 2), what))

    def _tap(self, tag, c, delay=1.0):
        """Tap c once per tag, delay s after the tag first showed up."""
        now = self.sim.t()
        if tag not in self.tapped:
            self.tapped.add(tag)
            self.sim.schedule(delay, lambda: self._do_tap(tag, c))
        return False

    def _do_tap(self, tag, c):
        self.note(f"tap {c} ({tag})")
        self.sim.cmd(c)

    def __call__(self, sim):
        f = sim.f
        now = sim.t()
        E_ = sim.edges
        # the beep: a new capture
        if len(f.captures) != self.ncap:
            self.ncap = len(f.captures)
            sim.on_capture()
        ph = API.phase(f)
        if not self.phases_seen or self.phases_seen[-1] != ph:
            self.phases_seen.append(ph)
        if ph == "idle":
            self.done = True
            return True
        if ph == "learn":
            return False
        if ph == "confirm":
            return self._tap(("confirm", len(self.phases_seen)), 'n', 1.0)
        if ph == "survey_noise":
            return False
        if ph == "sweep_up":
            tag = ("sweep_up", len(self.phases_seen))
            if tag not in self.tapped and sim.target != sim.pedal_top:
                sim.move_to(sim.pedal_top, self.sweep_speed)
                self.note("sweep up")
            if not sim.moving and abs(sim.L - sim.pedal_top) < 1e-6:
                return self._tap(tag, 'n', 1.0)
            return False
        if ph == "sweep_down":
            tag = ("sweep_down", len(self.phases_seen))
            if tag not in self.tapped and sim.target != 0.0:
                sim.move_to(0.0, self.sweep_speed)
                self.note("sweep down")
            if not sim.moving and abs(sim.L) < 1e-6:
                return self._tap(tag, 'n', 1.0)
            return False
        if ph == "saved_up":
            if self.continue_down:
                return self._tap(("down", len(self.phases_seen)), 'n', 1.5)
            self.done = True
            return True
        if ph == "check":
            return self._tap(("check", f.calPass, f.calStep, len(self.phases_seen)), 'n', self.check_tap_s)
        if API.paused(f) and not sim.pedal:
            return False
        return self._points(sim, f, now)

    # -- a point prompt
    def _points(self, sim, f, now):
        E_ = sim.edges
        key = (f.calPass, f.calStep)
        if key != self.key:
            self.key, self.since = key, now
            self.planned = False
        # go-back instructions (flag B): drop into the gear before, then come back
        if API.go_back(f) and f.calPass in (fw.PASS_UP, fw.PASS_DOWN):
            i = f.calStep
            if not self.went_back:
                self.back_since, self.back_extra = now, 0
            elif not sim.moving and now - self.back_since > 10.0:   # still told to go back: one more gear
                self.back_since, self.back_extra = now, self.back_extra + 1
                self.note(f"go-back: one gear further ({self.back_extra})")
            if f.calPass == fw.PASS_UP:
                g = max(1, i - self.back_extra)
                sim.move_to(0.5 * (E_[g - 1] + E_[g]) if g >= 1 else 0.0)
            else:
                g = min(23, i + self.back_extra)
                sim.move_to(0.5 * (E_[g] + E_[g + 1]) if g < 23 else sim.pedal_top)
            self.went_back = True
            return False
        if self.went_back:
            self.went_back = False
            i = f.calStep
            stop = E_[i] + 0.25 if f.calPass == fw.PASS_UP else E_[i] - sim.h[i] - 0.25
            sim.move_to(stop)
            sim.stops[key] = stop
            self.planned = True
            return False
        n_stuck = sum(1 for _, l in f.out[self.out_seen:] if l == "N,stuck")
        self.out_seen = len(f.out)
        if n_stuck and f.calPass in (fw.PASS_UP, fw.PASS_DOWN):
            want_g = f.calStep + 1 if f.calPass == fw.PASS_UP else f.calStep
            if sim.console.g != want_g or sim.moving or now < self.busy_until:
                n_stuck = 0                                 # 'if the console already shows gear N': it doesn't
                self.note(f"N,stuck ignored (console shows {sim.console.g}, prompt gear {want_g})")
        if n_stuck and f.calPass in (fw.PASS_UP, fw.PASS_DOWN):
            self.stucks[key] = self.stucks.get(key, 0) + n_stuck
            if self.stucks[key] >= 2:                       # still stuck after easing back once: undo
                self.note(f"N,stuck twice at {ps_name(f.calPass)} {f.calStep + 1}: undo")
                self.undos += 1
                sim.schedule(sim.rnd.uniform(1.0, 2.0), lambda: sim.cmd('u'))
                self.stucks[key] = -99
                return False
            # 'ease back into the gear below (above) and come up (down) again'
            i = f.calStep
            stop = sim.stops.get(key, sim.L)
            if f.calPass == fw.PASS_UP:
                back = 0.5 * (E_[i - 1] + E_[i]) if i >= 1 else 0.0
            else:
                back = 0.5 * (E_[i] + E_[i + 1]) if i < 23 else sim.pedal_top
            self.note(f"N,stuck at {ps_name(f.calPass)} {i + 1}: ease back to {back:.1f}, then {stop:.1f}")
            self.stuck_moves += 1
            d = sim.rnd.uniform(1.0, 2.0)
            travel = abs(back - sim.L) / sim.speed
            sim.schedule(d, lambda b=back: sim.move_to(b))
            sim.schedule(d + travel + 2.0, lambda st_=stop: sim.move_to(st_))
            self.busy_until = now + d + 2 * travel + 3.0
            self.since = now
            return False
        if self.planned and self.undo_after and now - self.since > self.undo_after and not sim.moving                 and now > self.busy_until + self.undo_after and f.calState == fw.CAL_WAITING:
            # nothing happens although the console shows the gear: the page suggests Undo
            self.note(f"stuck at {ps_name(f.calPass)} {f.calStep + 1}: undo")
            self.undos += 1
            sim.cmd('u')
            self.since = now
            return False
        if self.planned or now < self.busy_until or now - self.since < self.react_s:
            return False
        self.planned = True
        i = f.calStep
        ps = f.calPass
        if self.on_prompt and self.on_prompt(self, sim, ps, i):
            return False
        if (ps, i) in self.disconnects:
            dur = self.disconnects.pop((ps, i))
            if sim.phone(False):
                self.note(f"phone off {dur}s")
                sim.schedule(dur, lambda: (sim.phone(True), self.note("phone on")))
        o = sim.rnd.uniform(*self.over)
        if ps in (fw.PASS_UP, fw.PASS_FIX_UP):
            stop = 0.0 if i == 0 else E_[i] + o
        else:
            stop = E_[i] - sim.h[i] - o
        if (ps, i) in self.overshoot_at and (ps, i) not in self.over_done:
            self.over_done.add((ps, i))
            ov = self.overshoot_by
            stop = E_[i + 1] + ov if ps == fw.PASS_UP else E_[i - 1] - sim.h[i - 1] - ov
            self.note(f"overshoot {ps},{i}")
        sim.stops[(ps, i)] = stop
        delay = 0.0
        if (ps, i) in self.rests:
            rest = self.rests.pop((ps, i))
            self.note(f"rest {rest}s")
            sim.pedal = False
            sim.schedule(rest, lambda: setattr(sim, "pedal", True))
            delay = rest + 1.5
        if self.stop_shift and sim.rnd.random() < self.stop_shift:
            p = sim.rnd.uniform(*self.pause_s)
            self.note(f"stop-shift-pedal {p:.1f}s")
            sim.pedal = False
            sim.schedule(delay + 1.0, lambda s=stop: sim.move_to(s))
            sim.schedule(delay + p, lambda: setattr(sim, "pedal", True))
            self.busy_until = now + delay + p
            return False
        if self.mid_pause and i > 0 and sim.rnd.random() < self.mid_pause:
            a = sim.L
            fr = sim.rnd.uniform(*self.mid_frac)
            mid = a + fr * (stop - a)
            self.mids[(ps, i)] = (mid, fr)
            self.mid_windows.append((ps, i, mid, now))
            p = sim.rnd.uniform(*self.mid_s)
            self.note(f"mid-gear pause {p:.1f}s at {mid:.1f}")
            sim.schedule(delay, lambda m=mid: sim.move_to(m))
            travel = abs(mid - sim.L) / sim.speed
            sim.schedule(delay + travel + p, lambda s=stop: sim.move_to(s))
            self.busy_until = now + delay + travel + p
            return False
        if delay:
            sim.schedule(delay, lambda s=stop: sim.move_to(s))
            self.busy_until = now + delay
        else:
            sim.move_to(stop)
        return False


# ====================================================================== runs and results
class Result:
    def __init__(self, f, sim, rider, label=""):
        self.f, self.sim, self.rider, self.label = f, sim, rider, label
        self.lines = [l for _, l in f.out]

    def count(self, prefix):
        return sum(1 for l in self.lines if l.startswith(prefix))

    def gobacks(self, unprompted=True):
        """The board going back by itself: N,behind followed by U at the same time.  unprompted: not counting
        go-backs within 30 s after an N,stuck (the rider eased back into the gear below as told: redoing the
        previous point is then the designed recovery)."""
        out = self.f.out
        stuck = [t for t, l in out if l == "N,stuck"]
        n = 0
        for (t0, a), (t1, b) in zip(out, out[1:]):
            if a == "N,behind" and b.startswith("U,") and t0 == t1:
                if unprompted and any(0 <= t0 - ts <= 30000 for ts in stuck):
                    continue
                n += 1
        return n

    def machine(self):
        return [l for l in self.lines if MACHINE.match(l)]

    def last_caps(self):
        """Last capture of each point: {('u', i) | ('d', i): (ms, point)}."""
        last = {}
        for ms, key, p in self.f.captures:
            if isinstance(key, int):
                last[('u', key)] = (ms, p)
            elif key[0] == 'd':
                last[('d', key[1])] = (ms, p)
        return last

    def ups(self):
        lc = self.last_caps()
        return [lc[('u', i)] for i in range(24) if ('u', i) in lc]

    def downs(self):
        lc = self.last_caps()
        return [lc[('d', i)] for i in range(fw.DOWN_FIRST, 0, -1) if ('d', i) in lc]

    def saved(self):
        return any(l.startswith("K,1") for l in self.lines)

    def f_end(self):
        e = [l for l in self.lines if l.startswith("F,end")]
        return e[-1] if e else None

    def flags(self):
        """The last F list: [(pass, point, why)]."""
        out, cur = [], []
        for l in self.lines:
            if l.startswith("F,end"):
                out, cur = cur, []
            elif l.startswith("F,"):
                p = l.split(",")
                cur.append((p[1], int(p[2]), p[3]))
        return out

    def errors(self):
        """Per capture: |board point - lever at capture| (uT), and lever span over the 3 turns before."""
        sc = self.sim.scale
        out = []
        bnd = [b[0] for b in self.f.boundaries]
        import bisect
        for ms, key, p in self.f.captures:
            L = self.sim.lever_at(ms)
            j = bisect.bisect_right(bnd, ms)
            t0 = bnd[max(0, j - 4)] if j else ms - 3000
            win = [Lh for t, Lh in self.sim.history if t0 <= t <= ms] or [L]
            after = [Lh for t, Lh in self.sim.history if ms <= t <= ms + 2500] or [L]
            mean = sum(win) / len(win)
            sk = (fw.PASS_UP, key) if isinstance(key, int) else ((fw.PASS_DOWN, key[1]) if key[0] == 'd' else None)
            stop = self.sim.stops.get(sk)
            at = along(p, sc)
            # where the lever rested: from where the rider stopped to where it settled
            lo = min([L] + after + ([stop] if stop is not None else []))
            hi = max([L] + after + ([stop] if stop is not None else []))
            err_hold = max(0.0, lo - at, at - hi)
            out.append(dict(ms=ms, key=key, err=abs(at - mean), err_now=abs(at - L), err_hold=err_hold,
                            err_stop=abs(at - stop) if stop is not None else None,
                            span=max(win) - min(win), at=at, lever=L, mean=mean, stop=stop))
        return out

    def in_order(self):
        sc = self.sim.scale
        u = [along(p, sc) for _, p in self.ups()]
        d = [along(p, sc) for _, p in self.downs()]
        return all(b > a for a, b in zip(u, u[1:])) and all(b < a for a, b in zip(d, d[1:]))


import re  # noqa: E402

MACHINE = re.compile(r"^([CKFUNWPZEALJ]),|^Q,")


def run_cal(seed=1, rpm=75, fw_kw=None, sim_kw=None, rider_kw=None, seconds=900, cal=None, f=None, start="usb",
            label=""):
    """One calibration from 'c' to the end (or seconds). Returns Result."""
    if f is None:
        f = fw.Firmware(cal=cal, **(fw_kw or {}))
        if cal is not None:
            f.crank["ok"] = bool(cal.get("crankOk"))
    sim = Sim(f, rpm=rpm, seed=seed, **(sim_kw or {}))
    if f.calValid and f.cal and f.cal.get("pts"):
        pass
    rider = Rider(sim, **(rider_kw or {}))
    sim.run(2.0)                                       # pedalling before 'c'
    sim.src = "ble" if start == "ble" else "usb"
    if sim.record:
        sim.trace.append(("c", f.ms_now, ('c', sim.src)))
    API.start(f, start)
    sim.run(seconds, rider)
    return Result(f, sim, rider, label)


def copy_cal(cal):
    return {k: ([list(x) for x in v] if isinstance(v, list) and v and isinstance(v[0], list) else
                (list(v) if isinstance(v, list) else v)) for k, v in cal.items()}


def scaled_cal_at(scale=1.0, shift=None, h=None, noise_cal=None):
    """A clean stored calibration of this simulated bike (true edges), for 'same spot' runs."""
    sh = shift or [0.0, 0.0, 0.0]
    pts = [[scale * x + sh[j] for j, x in enumerate(field_at(L))] for L in UP_EDGE]
    pts.append([pts[-1][k] + fw.TOP_FRACTION * (pts[-1][k] - pts[-2][k]) for k in range(3)])
    hh = h or BIKE_GAP
    down = [[0.0, 0.0, 0.0]] + [[scale * x + sh[j] for j, x in enumerate(field_at(UP_EDGE[i] - hh[i]))]
                                for i in range(1, 24)] + [[0.0, 0.0, 0.0]]
    mask = sum(1 << i for i in range(1, fw.DOWN_FIRST + 1))
    cal = dict(pts=pts, down=down, downMask=mask, **crank_cal())
    if scale != 1.0:
        cal["crankDepth"] = cal["crankDepth"] * scale
        cal["crankBase"] = cal["crankBase"] * scale
    return cal


# ====================================================================== shared check/print helpers
class Checker:
    def __init__(self, name):
        self.name = name
        self.fails = []
        self.skips = []
        self.passes = 0

    def check(self, cond, msg):
        print(("  PASS " if cond else "  FAIL ") + msg)
        if cond:
            self.passes += 1
        else:
            self.fails.append(msg)
        return cond

    def skip(self, msg):
        print("  SKIP " + msg)
        self.skips.append(msg)

    def info(self, msg):
        print("  INFO " + msg)

    def finish(self):
        tail = f" ({len(self.skips)} skipped)" if self.skips else ""
        print(f"\nRESULT: {self.name} [model {API.version()}]: " +
              (f"all {self.passes} checks passed{tail}" if not self.fails else
               f"{len(self.fails)} of {self.passes + len(self.fails)} check(s) failed{tail}: " + "; ".join(self.fails)))
        sys.exit(1 if self.fails else 0)
