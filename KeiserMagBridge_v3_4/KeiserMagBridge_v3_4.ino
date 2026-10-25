/*
 * KeiserMagBridge_v3_4.ino
 * -------------------------------------------------------------------------
 * Passive, zero-solder Bluetooth power bridge for a Keiser M3 indoor bike.
 *
 * v3.4.1 (issue #91): Bluetooth lines are sent whole or not at all. A piece
 *     the link can't take yet is retried (bounded) instead of being dropped,
 *     which glued half lines together on the phone; status lines are skipped
 *     whole when the link is behind. '#V' still answers E,ok,v3.4 (the page
 *     only accepts E,ok,v3.<n>).
 *
 * v3.4 changes (bench/PROTOCOL.md "v3.4 additions"; issues #5, #6, #8):
 *   - Press to capture: '#A,press' puts the gear points under the rider's
 *     control. Nothing is saved by itself; a press ('n', button A, the
 *     phone's circle) measures the next pedal turns at that spot (2 that
 *     agree, then the check turn), with the usual "still moving" check.
 *     '#A,auto' goes back to auto-capture (the default). Flags T (press
 *     mode) and I (measuring after a press); N,press acknowledges a press.
 *   - '#V' answers E,ok,v3.4 so the page can tell what the board supports.
 *   - No N,stuck hint any more: on the bike it fired after most captures,
 *     often in the right gear, and the rider couldn't act on it.
 *   - A new spot's soft hold (auto-capture) needs the reading to have moved a
 *     real part of a gear step, not just the noise floor: a rider pausing
 *     before shifting no longer saves the old gear again.
 *   - Going back to an overshot point happens once per point per pass (gear 5
 *     was gone back to three times on the bike).
 *
 * v3.3 changes (bench/V3_3_PLAN.md, bench/PROTOCOL.md "v3.3 additions"):
 *   - Survey after the cadence check: the turn-to-turn noise (learning turns,
 *     cadence-check turns, a few extra), then a slow sweep of the lever up
 *     and back down. It gives the path length, a signal verdict, and whether
 *     the board is where the stored calibration was made (Z line).
 *   - Tolerances worked out from the noise, the expected gear step and the
 *     lever's settle-back (learned during the run) instead of fixed uT
 *     values (deriveTolerances(), printed with 'p').
 *   - Steps with checkpoints: the up pass is saved as soon as it's done; the
 *     down pass starts on 'n' (or later with '#D') and keeps every point it
 *     measures, even if it is stopped or the power goes.
 *   - Pause: no pedal turn for 3 s (or, for a calibration started from the
 *     phone, the phone disconnected) pauses the calibration: timers stop,
 *     no beeps, and the first turn afterwards doesn't count.
 *   - The check compares each gear edge's up/down gap with its neighbours'
 *     (not one gap for all), and down points with the usual cross offset;
 *     it runs from loop() after a save. 'k' / 'p' output is paced.
 *   - 'v' placement stream (X lines), '#M' (board moved), '#D', '#J' (echo
 *     for the log), '#I' / '#S' (USB: injected samples, a virtual clock).
 *   - Calibration format v6 (v5 + noise, path length, stickiness ratio,
 *     rpm per point, spot id); v4 and v5 still load.
 *
 * v3.2 changes (bench/PROTOCOL.md, "v3.2 additions"):
 *   - Faster capture, same precision: 2 agreeing turns, then the check turn;
 *     if it agrees and the lever wasn't still moving, the point is the
 *     average of all 3 turns (one turn less per point than v3.1).
 *   - Forward only: a point is taken once it is >= 1.0 uT from the previous
 *     point with >= 0.5 uT of that in the pass's direction, so a point can't
 *     be saved before the lever moved, or behind the previous one. If
 *     agreeing turns sit behind the previous point, that point went too far:
 *     the board goes back to it by itself ('N,behind', 'U') and tells the
 *     rider to drop into the gear below and come back up to it.
 *   - Point 25 (lever all the way up, into the brake) is no longer pedalled:
 *     it is worked out from points 23 and 24.
 *   - Down pass after the up pass (crank mode): where each gear first shows
 *     coming down (gears 22..1). The path used for watts runs through the
 *     middle of each up/down pair. 's' skips the rest and saves.
 *   - Gear switch points: riders stop about 0.25 uT after the console
 *     changes, so each edge is taken 0.25 uT back from the saved point, and
 *     the board switches exactly there, going up and coming down (the
 *     console's own stickiness: measured by the down pass, else its median,
 *     else 0.6 uT). Simulated: matches the console ~97 % of held turns
 *     (95 % with the up pass only, against 75 % for v3.1's 20 % band).
 *   - A check after every save (and on 'k') flags points that look wrong
 *     ('F' lines: behind, offpath, updown, pair, prior) with a best guess,
 *     one suspect at a time; it also compares with the previous calibration
 *     (kept in flash). Nothing is changed without the rider.
 *   - '#' line commands: redo one point by pedalling (#R), use the best guess
 *     (#G), or load points over USB (#P, #W, #X).
 *   - Prompts no longer ask for 60-80 rpm: any steady pace works.
 *   - Calibration format v5 (v4 + down points); v4 files still load.
 *
 * v3 changes (tested first by replaying a 50 Hz bike recording through
 * bench/replay_v3.py, which mirrors this code):
 *   - Turn detection from the crank magnet: the Keiser's own RPM magnet
 *     gives one sharp dip per pedal turn along a learned direction. Each dip
 *     is a turn: cadence and the crank data sent to Zwift come from it, so
 *     no cadence pod is needed (a pod is still used if the crank magnet is
 *     too far away to detect).
 *   - Per-turn averaging: the gear comes from the average field over each
 *     full turn, which cancels the crank magnet's swing.
 *   - Calibration is done WHILE PEDALLING: first ~10 s of steady pedalling
 *     to learn the crank, then the 25 points, each captured automatically
 *     when 3 turns in a row agree.
 *   - 't' streams one line per turn. Calibrations from v2 must be redone.
 *
 * v3.1 changes (the first v3 bike test showed turns 3-5 uT apart instead of
 * ~0.5 uT, traced to sensor reads being skipped while the loop waited on
 * Bluetooth sends to the phone):
 *   - The magnetometer is read by its own FreeRTOS task at a fixed rate;
 *     readings are queued with their exact time, and loop() drains the
 *     queue, so a stalled loop no longer loses or skews readings.
 *   - Phone output goes out a whole line per notification (fewer sends).
 *   - Per-turn 'T' lines go to USB only.
 *   - Calibration capture: 3 turns within 2.0 uT (was 1.0).
 *   - Review fixes (2026-10-16): phone text sent in 20-byte pieces (the
 *     default link cuts longer writes at 23 bytes); learning cap 130 rpm;
 *     real sample clock in crankLearn(); a capture is checked one more turn
 *     and, if the lever looks like it was still moving, the rider is asked
 *     to keep or redo it (cal state 5, W line); calibration format v4.
 *   - Crank learning ends on turns, not a fixed 10 s (tested first with
 *     bench/replay_learn.py, which mirrors it): every 0.5 s the crank is
 *     learned again from everything so far and the turns counted; it ends
 *     once 6 turns are regular (most turns within 0.75-1.33x the median,
 *     under 160 rpm), or after 15 s. Turns seen and the provisional rpm go
 *     in the status line while learning.
 *   - Cadence check: after learning the board waits (cal state 4) for the
 *     rider to confirm the rpm matches the console ('n' / button A), or to
 *     learn again ('l'). An 'L' line reports the learning result.
 *   - Manual captures get the same "the lever moved" check as auto-capture
 *     (an 'N' line says why a capture was refused).
 *
 * v2 changes (see bench/PROTOCOL.md for the phone-page protocol):
 *   - Follow-the-path gear detection: the 25 calibration readings are kept
 *     as a chain of points in 3-D and each reading is located along that
 *     chain, instead of being projected onto one straight line. Works for
 *     curved field paths and reports how far a reading is from the path
 *     ("off-path"), which flags disturbances (crank magnet, phone, a
 *     shifted board). Short off-path spikes hold the last good gear.
 *   - Auto-capture calibration with beeps: hold the lever still ~2 s at each
 *     point and it captures by itself. 'u' undoes the last point.
 *   - 'r' fast raw stream (50 Hz, USB only) for diagnostics.
 *   - '1'/'0' machine-readable status stream for the phone web page.
 *   Calibrations from v1 are not compatible and must be redone.
 *
 * Hardware (nothing soldered, nothing spliced):
 *   - Adafruit CLUE (board: "Adafruit CLUE") or Adafruit Feather nRF52840
 *     Sense (board: "Adafruit Feather Bluefruit Sense"); both have the
 *     LIS3MDL magnetometer on board
 *   - USB power (CLUE: or a 3xAAA JST-PH holder; Feather: or a LiPo)
 *   - Any standard Bluetooth cadence pod (Cycling Speed & Cadence, 0x1816)
 *
 * How it works:
 *   1. The LIS3MDL reads the field of the Keiser's resistance magnets.
 *      As the gear lever moves the magnet carrier, the field at the board
 *      changes. A one-time calibration maps that field to Keiser's
 *      0-100 "resistance" scale and gears 1-24.
 *   2. The Feather connects AS A CENTRAL to your cadence pod and reads
 *      crank revolutions (the Feather needs cadence to compute power).
 *   3. The Feather acts AS A PERIPHERAL to Zwift and broadcasts the
 *      Cycling Power Service (0x1818) / Cycling Power Measurement (0x2A63),
 *      including crank revolution data so Zwift also gets cadence from it.
 *
 * Power model and gear table:
 *   Adapted from KBikeBLE by ajs123 (https://github.com/ajs123/KBikeBLE),
 *   MIT License, Copyright (c) 2021 ajs123. Power = P90(resistance) x f(rpm),
 *   which KBikeBLE reports as replicating Keiser's V4.06 console firmware.
 *   The table below is KBikeBLE's "original Keiser gears" table, so the
 *   gear this sketch reports matches the number on your Keiser console.
 *
 * Required libraries (Arduino Library Manager):
 *   - Adafruit nRF52 board package (Boards Manager: "Adafruit nRF52")
 *     -> provides bluefruit.h, InternalFileSystem, Adafruit_LittleFS
 *   - Adafruit LIS3MDL (pulls in Adafruit Unified Sensor + Adafruit BusIO)
 *
 * Controls: button A (CLUE) / USER button (Feather), the USB Serial Monitor
 * at 115200, or WIRELESSLY from a phone with Adafruit's free "Bluefruit
 * Connect" app (connect to "Keiser M3 Bridge", open UART, type a command)
 * or the bridge's web page (bench/PROTOCOL.md).
 *   Hold button 3 s / send 'c'  -> start calibration
 *   Short press   / send 'n'    -> capture current calibration point now
 *                                  (or confirm the cadence after learning)
 *   send 'l'                    -> learn the crank again (cadence check)
 *   send 'u'                    -> undo last calibration point
 *   send 'a'                    -> auto-capture on/off (default on)
 *   Hold button 3 s / send 'x'  -> abort calibration (while calibrating)
 *   send 'd'                    -> toggle live debug stream
 *   send 'r'                    -> toggle fast raw stream (USB only)
 *   send '1' / '0'              -> status stream for the web page on/off
 *   send 'p'                    -> print stored calibration
 *   send 'k'                    -> stored calibration as data lines
 *   send 'g' / 'm' / 'e' / 'y'  -> diagnostics recording: start / mark a
 *                                  step / stop / send (25 Hz, up to 8 min)
 *   send 'v'                    -> placement meters (X lines) on/off
 *   send 's'                    -> stop the down pass, keeping its points
 *   send 'h'                    -> list commands
 * The phone and Zwift can be connected at the same time.
 *
 * Red LED:  slow blink = not calibrated | fast blink = magnetometer
 *           saturating (move board farther from magnets) | solid during
 *           calibration = waiting for you to press | off = running normally.
 * Blue LED: Bluefruit connection LED (blinks while advertising to Zwift).
 * Speaker (CLUE): short beep = point captured, two low beeps = undo,
 *           rising chime = calibration saved, low buzz = rejected/aborted.
 * -------------------------------------------------------------------------
 */

#include <bluefruit.h>
#include <Adafruit_LIS3MDL.h>
#include <Adafruit_LittleFS.h>
#include <InternalFileSystem.h>
#include <stddef.h>

using namespace Adafruit_LittleFS_Namespace;

// =========================================================================
// User configuration
// =========================================================================
#define DEVICE_NAME          "Keiser M3 Bridge"

// Restrict which cadence pod the bridge connects to. Leave "" to accept
// the first Cycling Speed & Cadence sensor it sees. Otherwise put part of
// the pod's advertised name here, e.g. "RPM" or "Cadence".
#define CADENCE_NAME_FILTER  ""

static const uint32_t SAMPLE_PERIOD_MS   = 20;    // magnetometer read: 50 Hz
static const uint32_t NOTIFY_PERIOD_MS   = 500;   // power notifications: 2 Hz
static const uint32_t DEBUG_PERIOD_MS    = 200;   // debug print: 5 Hz
static const uint32_t STATUS_PERIOD_MS   = 250;   // web-page status: 4 Hz

static const float    EMA_ALPHA          = 0.15f; // field smoothing (~130 ms)
static const uint32_t GEAR_DWELL_MS      = 150;   // new gear must hold this long
static const uint32_t CADENCE_TIMEOUT_MS = 3000;  // no crank event -> 0 rpm
static const uint16_t CAPTURE_SAMPLES    = 32;    // samples averaged per cal point
static const uint32_t LONG_PRESS_MS      = 3000;

static const float    MIN_SPAN_UT        = 20.0f; // min path length, gear 1->24
static const float    MIN_STEP_WARN_UT   = 1.5f;  // warn if two gears this close
static const float    MIN_STEP_REJECT_UT = 0.3f;  // reject: two points indistinguishable
static const float    FOLD_MARGIN_UT     = 1.0f;  // reject: path comes back this close to itself
static const int16_t  SATURATION_RAW     = 26000; // ~15 gauss on the 16 gauss range

// Auto-capture: the field must stay within AUTO_STABLE_UT for AUTO_STABLE_MS
// and be at least AUTO_MIN_MOVE_UT away from the previous point.
static const float    AUTO_STABLE_UT     = 0.6f;
static const uint32_t AUTO_STABLE_MS     = 2000;
static const float    AUTO_MIN_MOVE_UT   = 1.0f;

// Off-path handling: a reading farther than this from the calibrated path
// holds the last good resistance, for at most OFFPATH_HOLD_MAX_MS.
static const float    OFFPATH_HOLD_UT    = 8.0f;
static const uint32_t OFFPATH_HOLD_MAX_MS = 2000;

// Crank learning (same values as bench/replay_learn.py): every 0.5 s the
// crank is learned again from everything buffered so far; learning ends as
// soon as there are enough regular turns, or at the cap.
static const uint16_t LEARN_MAX_SAMPLES  = 750;   // 15 s cap at 50 Hz
static const uint16_t LEARN_FIRST_PROBE  = 100;   // first look after 2 s
static const uint16_t LEARN_PROBE_EVERY  = 25;    // then every 0.5 s
static const uint8_t  LEARN_TARGET_TURNS = 6;     // regular full turns needed to finish early
static const uint8_t  LEARN_MIN_TURNS    = 4;     // at the cap, accept with this many
static const float    LEARN_REG_LO       = 0.75f; // a regular turn lasts LO..HI x the median turn
static const float    LEARN_REG_HI       = 1.33f;
static const float    LEARN_REG_SHARE    = 0.75f; // at least this share of turns must be regular
static const float    LEARN_MAX_RPM      = 130.0f;// faster: counting twice per turn
// Crank-magnet turn detector (same values as bench/replay_v3.py).
static const float    CRANK_MIN_DEPTH_UT = 8.0f;  // weaker dips: crank too far away to use
static const float    DIP_FRAC           = 0.5f;  // dip when below baseline by this x depth
static const float    REARM_FRAC         = 0.25f; // turn boundary when back above this x depth
static const uint32_t REFRACT_MS         = 200;   // ignore dips closer than this (300 rpm)
static const uint32_t STALL_MIN_MS       = 1200;  // no turn for max(2.5 x period, this): resync
static const float    QEMA_TAU_MS        = 1000;  // running mean used while resyncing
static const float    DEPTH_ADAPT        = 0.1f;  // slow tracking of the dip depth
static const float    TURN_AGREE_UT      = 2.0f;  // capture: 2 turns (then a check turn) within this
static const float    TURN_MOVE_UT       = 1.0f;  // ...this far from the previous point,
static const float    TURN_ALONG_UT      = 0.5f;  // ...with this much of it in the pass's direction
static const float    BEHIND_UT          = 0.5f;  // agreeing turns this far behind the previous point: N,behind
static const int      DOWN_FIRST         = 22;    // down pass: points 23..2 (0-based 22..1); the
                                                  // rider starts on point 24's edge, so it has none
static const float    EDGE_BIAS_UT       = 0.25f; // riders stop about this far past where the console changes
static const float    STICK_DEFAULT_UT   = 0.6f;  // console stickiness when no down pass measured it
static const float    STICK_MIN_UT       = 0.2f;
// The check after a save (calCheck; tuned in the 2026-10-16 study on 350
// simulated calibrations with injected faults, bench/NOTES.md).
static const float    CHECK_ORDER_UT     = 0.5f;  // a point must be this far past the one before
static const float    CHECK_OVERSHOOT    = 1.6f;  // the step into a point this x the usual -> it overshot
static const float    CHECK_SHAPE_UT     = 1.0f;  // up point off the neighbours' curve by this...
static const float    CHECK_SHAPE_FRAC   = 0.12f; // ...plus this x the gap it sits in
static const float    CHECK_OFF_UT       = 1.8f;  // down point this far off the up path
static const float    CHECK_PAIR_UT      = 1.1f;  // up/down offset along the path off the usual by this...
static const float    CHECK_PAIR_FRAC    = 0.15f; // ...plus this x the smaller neighbouring step
static const float    CHECK_PERP_UT      = 1.8f;  // up/down offset across the path
static const float    CHECK_BLAME_RATIO  = 1.6f;  // blame one of a pair only if it fits its pass this much worse
static const int      CHECK_MIN_PAIRS    = 5;     // pairs needed to know the usual offset
static const int      CHECK_MAX_ROUNDS   = 8;
static const float    PRIOR_UT           = 2.0f;  // up point this far from the previous calibration (after its shift)
static const int      PRIOR_MAX          = 6;     // more than this many: the board was moved, don't compare
static const uint8_t  MAX_SUSPECTS       = 20;
// "Lever still moving" check, made on the turn after 2 turns agree (tuned on
// the 2026-10-15 gear-change recording, bench/NOTES.md): along the direction
// of travel from the previous point, that check turn is >= DRIFT_UT past the
// 2 turns' average, or it is >= CREEP_UT past the first of them (over 3 turns,
// as in v3.1) and >= DRIFT_SLOW_UT past their average. Then the capture is dropped and the rider is asked to hold
// the lever still; after SETTLE_GIVEUP_MS of that, redo or capture anyway.
static const float    SUSPECT_DRIFT_UT   = 1.0f;
static const float    SUSPECT_CREEP_UT   = 0.8f;
static const float    SUSPECT_DRIFT_SLOW_UT = 0.4f;
static const uint32_t SETTLE_GIVEUP_MS   = 15000;
// (v3.3: the fixed uT values above are kept as floors and for reference; the
// tolerances in use come from deriveTolerances() and the multipliers below.)

// v3.3 survey: noise from still turns, then a sweep of the lever up and down.
static const uint8_t  STEPS_TOTAL        = 6;     // the calibration flow's steps (S field 16)
static const float    NOISE_FLOOR_UT     = 0.15f; // noise is never taken as less than this...
static const float    NOISE_MAX_UT       = 2.5f;  // ...nor more (the lever moved during the noise turns)
static const float    NOISE_DEFAULT_UT   = 0.6f;  // v4/v5 calibrations (2026-10-16 spot: 0.52-0.76)
static const uint8_t  NOISE_TURNS        = 20;    // still turns wanted (learning + cadence check + extra)
static const uint8_t  NOISE_MAX_TURNS    = 32;
static const uint8_t  NOISE_POOL         = 64;    // changes between held turns: the noise is refined during
static const uint8_t  NOISE_POOL_MIN     = 8;     // the passes (one rider's 20 turns vary up to 2x)
static const float    NOISE_CAL_LO = 0.6f, NOISE_CAL_HI = 1.6f;  // survey noise within these x the stored one
static const float    SETTLE_MAX_UT      = 2.0f;  // a settle-back over min(SETTLE_MAX_FRAC x step,
static const float    SETTLE_MAX_FRAC    = 0.5f;  // max(this, 4 noise)) is the rider moving: not learned
static const float    MOVE_CAP_FRAC      = 0.5f;  // move on never needs more than this x the expected step
static const float    K_NEAR = 6.0f, NEAR_FRAC = 0.6f;  // same spot: within max(this x noise, this x step) of
static const uint8_t  NEAR_HOLD_TURNS    = 10;    // where the point was last time, unless held this many turns
static const uint8_t  SWEEP_MAX_TURNS    = 120;   // per direction
static const float    SAME_SPOT_UT       = 1.5f;  // sweep's median distance from the stored path: same
static const float    K_SAME_SPOT        = 3.0f;  // spot under max(SAME_SPOT_UT, this x noise)
static const float    FOLD_SWEEP_UT      = 3.0f;  // sweep up folds back: its end is this much (or
static const float    FOLD_SWEEP_FRAC    = 0.15f; // this x its length) nearer the start than its farthest
static const uint8_t  SETTLE_SAVES       = 6;     // settle-back: running median of the last saves
static const uint8_t  BEHIND_HOLD_TURNS  = 6;     // agreeing turns held behind: go back at behindHeld
static const uint32_t DISCONNECT_GIVEUP_MS = 300000;  // phone gone this long: stop (down points kept)
static const uint32_t X_PERIOD_MS        = 250;   // placement stream: 4 Hz
static const uint8_t  X_NOISE_TURNS      = 8;
static const float    SATURATION_UT      = SATURATION_RAW / 1711.0f * 100.0f;  // 16 gauss range
// Tolerance multipliers (deriveTolerances; tuned on the 2026-10-16 logs, where
// the survey noise is 0.52-0.76 uT: at 0.55 they give v3.2's agree 2.0, drift
// 1.0, creep 0.8, move 1.0, and a go-back threshold of 2.2 uT).
static const float    K_AGREE = 3.6f,  AGREE_MIN = 1.0f;   // turns agree within
static const float    K_DRIFT = 1.8f,  DRIFT_MIN = 0.6f;   // still moving: drift / creep / slow
static const float    K_CREEP = 1.45f, CREEP_MIN = 0.5f;
static const float    K_SLOW  = 0.73f, SLOW_MIN  = 0.25f;
static const float    K_MOVE  = 1.8f;                      // move on: max(this x noise,
static const float    MOVE_FRAC_SAME = 0.4f, MOVE_FRAC_NEW = 0.25f;  // f x expected step)
static const float    K_BEHIND = 4.0f, BEHIND_FRAC = 0.2f, BEHIND_MIN = 0.5f;  // go back: also 2 x settle
static const float    K_BEHIND_HELD = 1.5f;                // ...or this (mean of the run) after BEHIND_HOLD_TURNS
static const float    K_RISE = 1.8f,   RISE_FRAC = 0.15f;  // after going back, come up this far
static const float    EDGE_FRAC = 0.07f;                   // edge bias = this x local step
static const float    STICK_RATIO_DEFAULT = 1.0f;          // stickiness = ratio x local step
static const float    K_OFFHOLD = 15.0f;
static const float    K_SPAN = 15.0f, SPAN_MIN = 10.0f;
static const float    K_STEP_WARN = 2.5f;
static const float    STEP_REJECT_UT = 0.4f;               // points closer: the same (small steps only warn)
static const float    K_FOLD = 0.5f,  FOLD_MIN = 0.5f;     // the path folds back within max(FOLD_MIN, K_FOLD x noise)
static const uint8_t  SOFT_HOLD_TURNS = 8;                 // new / first spot: held this long, a smaller move is enough:
static const float    SOFT_HOLD_FRAC  = 0.12f;             // max(noise floor, this x the expected step) (v3.4)
static const float    K_ORDER_STEP = 0.25f, K_SHAPE_STEP = 0.5f, K_OFF_STEP = 0.9f, K_PAIR_STEP = 1.0f;  // check floors x step
static const uint32_t INJECT_IDLE_MS = 5000;               // '#I': no '#S' for this long ends injecting
static const float    K_PRIOR = 6.0f, PRIOR_FRAC = 0.5f;   // previous calibration (after its shift)
static const float    K_ORDER = 0.8f, K_SHAPE = 1.7f, K_OFF = 3.0f;
static const float    K_PAIR = 2.0f, PAIR_FRAC = 0.5f, PAIR_MIN = 2.0f;  // up/down gap vs its neighbours'
static const int      PAIR_NEIGHBOURS = 6;
static const float    PAIR_END_WIDEN = 1.5f;               // end edges (2, 23): neighbours on one side only

// Diagnostics recording: average each pair of 50 Hz samples -> 25 Hz.
static const uint16_t REC_CAPACITY       = 12000; // 8 minutes at 25 Hz (~108 KB)
static const uint8_t  REC_MAX_MARKERS    = 32;
static const uint8_t  DUMP_LINES_PER_PASS = 8;

static const bool     USE_WATCHDOG       = true;
static const uint32_t WATCHDOG_SECONDS   = 8;

// =========================================================================
// Keiser power model (from KBikeBLE, MIT License)
// =========================================================================
static const int NUM_GEARS = 24;

// Resistance (0-100) at the bottom edge of each Keiser gear.
// GEAR_EDGES[0] = lever fully down, GEAR_EDGES[24] = lever fully up.
// Gear g spans GEAR_EDGES[g-1] .. GEAR_EDGES[g].
static const float GEAR_EDGES[NUM_GEARS + 1] = {
   0.00,  7.51, 11.40, 14.59, 18.57, 20.12, 23.32, 24.87,
  27.03, 29.53, 31.87, 34.20, 36.70, 39.72, 42.83, 46.03,
  49.14, 53.11, 56.99, 60.97, 66.49, 72.02, 78.41, 89.38, 100.00 };

// Power (W) at 90 rpm at each of the resistance points above.
static const float POWER90[NUM_GEARS + 1] = {
   20.9,  24.3,  27.7,  33.5,  40.4,  45.0,  54.3,  61.3,
   71.7,  84.4,  98.3, 118.0, 136.6, 163.3, 193.4, 225.9,
  261.9, 308.3, 360.5, 415.0, 497.4, 577.5, 671.5, 796.8, 878.0 };

// Power / Power(90 rpm) as a function of cadence: PC2 + PB2*rpm + PA2*rpm^2
static const float PC2 = -2.70E-03f;
static const float PB2 =  6.79E-03f;
static const float PA2 =  4.75E-05f;

// =========================================================================
// Calibration storage
// =========================================================================
static const char*    CAL_PATH    = "/keiser_cal.bin";
static const uint32_t CAL_MAGIC   = 0x4B4D3343;  // "KM3C"
static const uint16_t CAL_VERSION = 6;           // v6: v5 + survey/tolerance fields; v4, v5 still load

// Relative step sizes of points 1->2 ... 23->24 in the hand-corrected
// 2026-10-16 calibration (127.8 uT): how a new spot's path length is shared
// out to expect each gear's step. (Keiser's gear table widths put the top
// gears' steps 4x too large at that spot.)
static const float STEP_PROFILE_UT[NUM_GEARS - 1] = {
  17.78, 15.71, 13.00, 2.35, 4.72, 2.83, 3.05, 5.50, 5.65, 4.34, 6.34, 3.71,
   2.55,  6.97,  3.24, 3.76, 5.21, 3.88, 1.87, 1.77, 3.76, 3.80, 6.01 };

struct CalData {
  uint32_t magic;
  uint16_t version;
  uint16_t reserved;
  float    pts[NUM_GEARS + 1][3];   // field (uT) at each GEAR_EDGES point
  uint8_t  crankOk;                 // 1 = crank magnet detected, per-turn mode
  int8_t   crankSign;               // +1/-1: polarity so the dip goes down
  uint16_t pad;
  float    crankU[3];               // crank's main direction (unit vector)
  float    crankDepth;              // typical dip depth (uT)
  float    crankBase;               // mean signal while pedalling (uT)
  // v5
  uint32_t downMask;                // bit i: down[i] measured (coming down to gear i)
  float    down[NUM_GEARS + 1][3];  // field where the console first shows gear i coming down
  // v6
  float    noiseUT;                 // turn-to-turn noise from the survey (0 = unknown)
  float    stepScale;               // path length from the survey sweep (uT)
  float    stickRatio;              // console stickiness / local step, from a down pass (0 = none)
  uint32_t spotId;                  // which mounting spot: kept while the board stays put
  uint8_t  capRpm[NUM_GEARS + 1];   // cadence when each up point was captured
  uint8_t  downRpm[NUM_GEARS + 1];  // ...and each down point
  uint16_t pad2;
};
static const size_t CAL_V4_SIZE = offsetof(CalData, downMask);
static const size_t CAL_V5_SIZE = offsetof(CalData, noiseUT);
// The byte layouts the host tools pack (bench/tests/fw_model.py pack_cal()).
static_assert(offsetof(CalData, downMask) == 332, "CalData v4 layout");
static_assert(offsetof(CalData, noiseUT) == 636, "CalData v5 layout");
static_assert(sizeof(CalData) == 704, "CalData v6 layout");

// The crank magnet, as learned at calibration (copied from cal on boot).
struct CrankParams {
  bool  ok;
  int8_t sign;
  float u[3];
  float depth;
  float base;
};
static CrankParams crank = { false, 1, {1, 0, 0}, 0, 0 };

static CalData cal;
static bool    calValid = false;

// The calibration before the current one (its up points), for the check.
static const char*    PREV_PATH  = "/keiser_cal_prev.bin";
static const uint32_t PREV_MAGIC = 0x4B4D3350;  // "KM3P"
static float   prevPts[NUM_GEARS + 1][3];
static bool    prevValid = false;

// Built from cal on load and after every save: the path used for gear and
// watts (the middle of each up/down pair where both exist), and where the
// console switches gear at each edge going up / down (Keiser resistance).
static float   pathPts[NUM_GEARS + 1][3];
static float   edgeUpR[NUM_GEARS + 1], edgeDownR[NUM_GEARS + 1];
static bool    checkPending = false;           // a save happened: run the check from loop()

// The tolerances in use (deriveTolerances(): from the noise, the learned
// settle-back and the expected step at each point; printed with 'p').
struct Tolerances {
  float noise, settle;              // turn-to-turn noise; how far the lever settles back after a save
  float agree;                      // turns agree within
  float drift, creep, slow;         // "still moving" check
  float moveMin, moveFrac;          // move on: max(moveMin, moveFrac x expected step)
  float behindMin, behindFrac;      // go back: max(behindMin, behindFrac x local step)
  float behindHeld;                 // ...or after BEHIND_HOLD_TURNS agreeing turns this far behind
  float riseMin, riseFrac;          // after going back, come up max(riseMin, riseFrac x step)
  float stickRatio;                 // stickiness / local step where no down point measured it
  float offHold;                    // off-path hold
  float minSpan, stepWarn, stepReject, fold;   // calValidate()
  float sameSpot;                   // survey: same spot under this
  float expStep[NUM_GEARS + 1];     // expected step into point i (i = 1..23)
};
static Tolerances tol;

// Which spot the calibration is being made at (survey; '#M' forces new).
enum SpotKind { SPOT_FIRST, SPOT_SAME, SPOT_NEW };
static SpotKind spotKind = SPOT_FIRST;
static bool     spotForced = false;              // '#M': the board was moved
static const char* const SPOT_NAMES[] = { "first", "same", "new" };

// A speaker note (defined up here so Arduino's generated prototypes see it).
struct Note { uint16_t hz, ms; };

// One magnetometer reading, taken by the sensor task and queued for loop().
struct Sample {
  uint32_t ms;          // millis() when it was read
  float    raw[3];      // uT
  bool     sat;         // saturated
};
// The check's suspects and order violations, and a '#' line being typed
// (defined up here so Arduino's generated prototypes see them).
struct Suspect { char pass; uint8_t point; const char* why; float guess[3]; };
struct ChkViol { uint8_t h, i; float sc; };   // an order violation (calCheck)
struct LineIn { char buf[64]; uint8_t n; bool active; bool overflow; uint32_t lastMs; };   // one per input: USB, phone

static const uint16_t SAMPLE_QUEUE_LEN = 256;   // 5 s of readings at 50 Hz (a flash save takes up to ~2.6 s)
static QueueHandle_t  sampleQueue = nullptr;
static volatile uint32_t sampleDrops = 0;       // queue was full (loop stalled > 5 s)

// =========================================================================
// Globals
// =========================================================================
Adafruit_LIS3MDL lis3mdl;

// Peripheral side (to Zwift)
BLEService        cpsService(UUID16_SVC_CYCLING_POWER);
BLECharacteristic cpMeasurement(UUID16_CHR_CYCLING_POWER_MEASUREMENT);
BLECharacteristic cpFeature(UUID16_CHR_CYCLING_POWER_FEATURE);
BLECharacteristic cpSensorLocation(UUID16_CHR_SENSOR_LOCATION);
BLEDis            deviceInfo;
BLEUart           bleuart;           // phone console (Bluefruit Connect app)

// Central side (from cadence pod)
BLEClientService        cscService(UUID16_SVC_CYCLING_SPEED_AND_CADENCE);
BLEClientCharacteristic cscMeasurement(UUID16_CHR_CSC_MEASUREMENT);

static const uint8_t     MAX_PRPH_CONN = 2;  // Zwift + phone console
static volatile uint16_t phoneConn = BLE_CONN_HANDLE_INVALID;
static volatile uint16_t podConn   = BLE_CONN_HANDLE_INVALID;
static uint8_t           powerSubscribers = 0;   // apps receiving power

// Cadence state, written from the BLE task, read from loop()
static volatile bool     crankValid       = false;  // have pod crank data
static volatile uint16_t crankRevs        = 0;      // pod cumulative revs
static volatile uint16_t crankEventTime   = 0;      // pod time, 1/1024 s
static volatile float    podCadence       = 0.0f;   // rpm
static volatile uint32_t lastCrankEventMs = 0;

// Signal chain
static const int MEDIAN_N = 5;
static float     medianBuf[3][MEDIAN_N];
static int       medianIdx    = 0;
static int       medianFill   = 0;
static float     fieldUT[3]   = {0, 0, 0};  // smoothed field (uT)
static bool      emaSeeded    = false;
static bool      saturated    = false;

static float     resistance   = 0.0f;       // 0-100, continuous
static float     offPath      = 0.0f;       // uT from the calibrated path
static bool      offPathHold  = false;      // holding last gear (off-path)
static uint32_t  offPathSince = 0;
static int       stableGear   = 1;          // debounced 1-24
static int       pendingGear  = 1;
static uint32_t  pendingSince = 0;
static float     powerW       = 0.0f;
static float     cadenceRpm   = 0.0f;

// Calibration state machine
// v3.3: CAL_SURVEY (6) = noise turns, sweep up, sweep down (calStep 0/1/2);
// CAL_DOWN_READY (7) = the up pass is saved, 'n' comes back down.
enum CalState { CAL_IDLE, CAL_WAITING, CAL_CAPTURING, CAL_LEARN, CAL_CONFIRM, CAL_POINT_CHECK,
                CAL_SURVEY, CAL_DOWN_READY };
enum SurvPhase { SURV_NOISE, SURV_UP, SURV_DOWN };
// How a calibration is saved (calCommit): a new up pass, an edit, the end of a down pass.
enum CommitMode { COMMIT_NEW, COMMIT_EDIT, COMMIT_DOWN };
// Where the latest command came from (a calibration started from the phone pauses without it).
enum CmdSrc { SRC_USB, SRC_BLE, SRC_BUTTON };
// Which points are being measured: the up pass, the down pass, or one point
// being redone ('#R', "fix").
enum CalPass  { PASS_UP, PASS_DOWN, PASS_FIX_UP, PASS_FIX_DOWN };
static CalState  calState   = CAL_IDLE;
static CalPass   calPass    = PASS_UP;
static int       calStep    = 0;
static float     calRaw[NUM_GEARS + 1][3];
static float     calDown[NUM_GEARS + 1][3];
static uint32_t  calDownMask = 0;
static bool      behindSent = false;            // N,behind already sent for this point
static bool      fixArmed   = false;            // fix: the reading has been past the point
static bool      backGate   = false;            // auto-redo: waiting for the reading to go back
static float     backOld[3];                    // ...past the point it overshot (saved here)
static bool      backRising = false;            // gone back: waiting for it to come up again
static float     backMin    = 0;                // ...lowest reading so far (along the way back)
static bool      backUpOk   = true;             // going back allowed: not right after an undo / going back
static uint32_t  backedMask = 0;                // points gone back to in this pass: once each (v3.4)
static int8_t    backedPass = -1;               // ...the pass they belong to
static bool      behindNow  = false;            // set by calMovedOn: agreeing turns behind the last point
static const float BACK_RISE_UT = 1.0f;         // after going back, come up this far before a point counts
static float     capSum[3];
static uint16_t  capCount   = 0;

// Auto-capture
static bool      autoCapture = true;
// Press to capture (v3.4, '#A,press'): a press measures the next turns at that spot.
static bool      pressMode   = false;
static bool      pressArmed  = false;       // pressed: measuring this point
static bool      pressRefused = false;      // the last press measured the previous point's spot: the next one saves it anyway
static float     stabRef[3];
static uint32_t  stabSince   = 0;
static uint8_t   stabPct     = 0;           // 0-100, for the web page

// Crank learning buffer (filled during CAL_LEARN)
static float     learnBuf[LEARN_MAX_SAMPLES][3];
static float     learnP[LEARN_MAX_SAMPLES];
static uint16_t  learnPer[LEARN_MAX_SAMPLES / 10];   // full-turn periods (200 ms refractory)
static uint16_t  learnCount  = 0;

// Result of the latest look at the learning buffer.
struct LearnResult {
  bool        ok;
  uint8_t     turns;      // full turns counted
  uint8_t     regular;    // of those, how many are LEARN_REG_LO..HI x the median
  float       rpm;        // from the median turn
  float       depth;      // dip depth (uT)
  const char* why;        // "ok" or why not (no commas: goes in the L line)
};
static LearnResult learnLast = { false, 0, 0, 0, 0, "no signal" };

// Turn detector state
static bool      crArmed = true, crHaveBoundary = false;
static float     crDipMax = 0, crDepth = 0, crBaseline = 0, crQEma = 0, crSumQ = 0;
static float     crSum[3];
static uint32_t  crN = 0, crDipStartMs = 0, crLastBoundaryMs = 0, crLastMs = 0;
static uint32_t  crLastPeriodMs = 1000;

// Turns as the board counts them (replaces the cadence pod)
static uint16_t  selfRevs     = 0;            // cumulative turns
static uint32_t  selfEventMs  = 0;            // time of the last turn boundary
static uint32_t  selfPeriods[2] = {0, 0};     // last two full-turn periods (ms)
static bool      turnStream   = false;        // 't': one T line per turn

// Calibration while pedalling: the last few agreeing turn averages
static float     turnHist[3][3];
static uint8_t   turnHistN    = 0;
static bool      pendingCap   = false;        // 2 turns agreed: checking one more turn
static float     pendingMean[3];
static float     pendingCreep = 0;            // along travel, check turn - first of the 2
static float     pendingFirst[3];             // the first of the 2 agreeing turns
static float     pendingDir[3];               // unit direction of travel
static bool      calRedo      = false;        // prompt says 'move down below first'
static uint32_t  settleSince  = 0;            // 0, or when 'hold still' started for this point
static float     lastDist     = 0;            // set by calMovedOn: distance from the previous point
static uint8_t   softRun      = 0;            // turns in a row within tol.drift of the one before (v3.4 soft hold)
static bool      downResumed  = false;        // this down pass was started with '#D'
static float     runSum = 0;                   // along-path offsets of the current run of agreeing turns
static uint8_t   runN = 0;
static float     lastTurnAvg[3];              // most recent turn average (capture anyway)
static uint8_t   agreeRun     = 0;            // agreeing turns in a row (held behind: go back)
static bool      forwardNow   = false;        // set by calMovedOn: forward of the last point by >= noise
static bool      downGate     = false;        // '#D': the reading must be above the point first
static int       downStart    = DOWN_FIRST;   // where this down pass started (undo stops there)
static bool      prevSaved    = false;        // this calibration already kept the old one as prev
static uint8_t   capRpm[NUM_GEARS + 1], downRpm[NUM_GEARS + 1];

// Survey (v3.3)
static SurvPhase survPhase    = SURV_NOISE;
static float     noiseBuf[NOISE_MAX_TURNS][3];  // still turn averages: learning, cadence check, extra
static uint8_t   noiseN       = 0;
static float     sweepBuf[2 * SWEEP_MAX_TURNS][3];  // sweep turn averages: up, then down
static uint16_t  sweepN = 0, sweepUpN = 0;
static bool      survSat      = false;          // saturated during the survey
static float     survL        = 0;              // path length from the sweep (0: none)
static float     noiseUT      = NOISE_DEFAULT_UT;  // the noise in use (before the floor)
// Settle-back after a save: the next 2 turns' worst along-path offset.
static float     settleRing[SETTLE_SAVES];
static uint8_t   settleN = 0, settleIdx = 0;
static float     settleRef[3], settleDir[3], settleWorst = 0, settleStep = 0;
static uint8_t   settleTurns  = 0;
// The noise is refined from held turns during the passes (changes between consecutive turns).
static float     noisePool[NOISE_POOL];
static uint8_t   noisePoolN = 0, noisePoolIdx = 0;
// Same spot: where each point was last time (from the stored calibration, at the survey).
static float     expUp[NUM_GEARS + 1][3], expDown[NUM_GEARS + 1][3];
static bool      expHave = false;
static uint32_t  expDownMask = 0;

// Pause (v3.3): no pedal turn for CADENCE_TIMEOUT_MS, or the phone gone
static bool      calPaused    = false;
static uint32_t  pauseStart   = 0;
static uint8_t   pauseSkip    = 0;              // turns to drop after a pause
static uint32_t  lastTurnMs   = 0;              // last turn boundary (or the start of a pausable stage)
static bool      calFromBle   = false;          // the calibration was started from the phone
static uint32_t  phoneLostMs  = 0;
static CmdSrc    cmdSrc       = SRC_USB;

// Injected samples (v3.3, '#I' / '#S', USB only): everything calibration-related
// reads the time from clockMs(), which follows the injected samples meanwhile.
static bool      injecting    = false;
static uint32_t  injMs        = 0;
static uint32_t  injLastMs    = 0;              // millis() of the last '#S' (injecting ends after INJECT_IDLE_MS)
static uint32_t  sampleMs     = 0;              // time of the sample being processed (calibration timers)
static inline uint32_t clockMs() { return injecting ? injMs : millis(); }

// Placement stream (v3.3, 'v'): X lines
static bool      placeOn      = false;
static bool      placeHave    = false;
static float     placeMin[3], placeMax[3];      // range covered since 'v'
static float     slowField[3];                  // ~1 s average of the raw field
static bool      slowSeeded   = false;
static float     hpMin[3], hpMax[3];            // high-passed window (crank swing before it's learned)
static bool      hpHave       = false;
static uint32_t  hpStart      = 0;
static float     hpP2P        = 0, lastDip = 0, peakAbs = 0;
static float     xTurns[X_NOISE_TURNS][3];      // the last turns, for a live noise figure
static uint8_t   xTurnN = 0, xTurnIdx = 0;
static uint32_t  lastXMs      = 0;

// Paced output (v3.3): 'p', 'k' and the check's F lines go out a few lines per loop pass.
enum OutJob { JOB_NONE, JOB_P, JOB_K, JOB_F };
static OutJob    outJob = JOB_NONE;
static int       outPos = 0;
static bool      wantP = false, wantK = false, wantF = false;
static const uint8_t OUT_LINES_PER_PASS = 3;

// The check after a save: points that look wrong, with a best guess.
static Suspect   suspects[MAX_SUSPECTS];
static uint8_t   suspectN = 0;

static LineIn usbIn = { {0}, 0, false, false, 0 }, bleIn = { {0}, 0, false, false, 0 };
static const uint32_t LINE_TIMEOUT_MS = 1500;   // a '#' line not finished by then is dropped

// '#P' staged edits (USB), applied by '#W'
static bool      staging = false;
static float     stageUp[NUM_GEARS + 1][3], stageDown[NUM_GEARS + 1][3];
static uint32_t  stageMask = 0;

// Diagnostics recording (see bench/PROTOCOL.md)
static int16_t   recXYZ[REC_CAPACITY][3];       // raw field, 0.1 uT
static uint16_t  recRevs[REC_CAPACITY];         // pod crank revs, 0xFFFF = no pod
static uint8_t   recDt[REC_CAPACITY];           // ms since previous sample
static uint16_t  recCount     = 0;
static uint16_t  recMarkers[REC_MAX_MARKERS];
static uint8_t   recMarkerCount = 0;
static bool      recording    = false;
static bool      recHalf      = false;          // holding the first of a pair
static float     recPair[3];
static uint32_t  recLastMs = 0, recStartMs = 0, recEndMs = 0;
static int32_t   dumpPos      = -1;             // -1 = not sending

// Misc
static bool      debugStream  = false;
static bool      rawStream    = false;
static bool      statusStream = false;
static uint32_t  lastNotifyMs = 0, lastDebugMs = 0, lastStatusMs = 0;

// =========================================================================
// Console output: everything printed goes to USB serial AND, when a phone
// is connected with the Bluefruit Connect app, to its UART screen.
// =========================================================================
static inline void watchdogFeed();

class DualLog : public Print {
 public:
  void begin() { mutex_ = xSemaphoreCreateMutex(); }

  size_t write(uint8_t c) override {
    Serial.write(c);
    uint16_t conn = phoneConn;
    if (conn == BLE_CONN_HANDLE_INVALID || mutex_ == nullptr) return 1;
    xSemaphoreTake(mutex_, portMAX_DELAY);
    buf_[n_++] = c;
    // A half-line left from a previous connection is dropped, not glued on.
    if (conn != lastConn_) { n_ = 0; lastConn_ = conn; }
    // Send a whole line at a time (in 20-byte pieces, see sendLocked).
    if (c == '\n' || n_ >= sizeof(buf_)) sendLocked(conn);
    xSemaphoreGive(mutex_);
    return 1;
  }
  using Print::write;

 private:
  // The default link (no configPrphBandwidth) carries at most 20 bytes per
  // notification and the library cuts longer writes at 23 bytes, so send the
  // buffered line in 20-byte pieces.
  //
  // v3.4.1 (issue #91): a piece waits at most 100 ms in the library for a free
  // notification slot; on a slow link (or in a burst) write() returned 0 and the
  // piece was lost, so the phone glued half lines together. Now whole lines or
  // nothing:
  //   - the first piece of a status (S) or placement (X) line gets one try: if
  //     the link is behind, the whole line is skipped (the next one, 250 ms
  //     later, carries the same news) and nothing half-sent reaches the phone;
  //   - the first piece of any other line waits up to BLE_FIRST_WAIT_MS;
  //   - once a line has started, each further piece waits up to BLE_PIECE_WAIT_MS.
  // A disconnect ends the wait at once. 'p' shows the counts.
  void sendLocked(uint16_t conn) {
    if (n_ && bleuart.notifyEnabled(conn)) {
      bool periodic = n_ > 1 && buf_[1] == ',' && (buf_[0] == 'S' || buf_[0] == 'X');
      for (size_t i = 0; i < n_; i += 20) {
        uint32_t t0 = millis();
        uint32_t limit = i == 0 ? (periodic ? 0 : BLE_FIRST_WAIT_MS) : BLE_PIECE_WAIT_MS;
        while (!bleuart.write(conn, buf_ + i, min(n_ - i, (size_t)20))) {   // each try waits <= 100 ms
          watchdogFeed();
          if (!bleuart.notifyEnabled(conn) || millis() - t0 >= limit) {   // gone, or waited long enough
            if (i == 0) skipped++; else cut++;
            n_ = 0;
            return;
          }
        }
        watchdogFeed();                          // 'k' / 'p' can take several seconds on a slow link
      }
    }
    n_ = 0;
  }

 public:
  uint32_t skipped = 0;                          // whole lines not sent: the link was behind
  uint32_t cut = 0;                              // lines that started but couldn't finish (rare)

 private:
  static const uint32_t BLE_FIRST_WAIT_MS = 3000;   // a C / K / F / Q / E ... line waits its turn
  static const uint32_t BLE_PIECE_WAIT_MS = 1000;   // the rest of a line already started
  SemaphoreHandle_t mutex_ = nullptr;
  uint8_t buf_[160];
  size_t  n_ = 0;
  uint16_t lastConn_ = BLE_CONN_HANDLE_INVALID;
};

static DualLog Log;

// =========================================================================
// Small helpers
// =========================================================================
static float dot3(const float a[3], const float b[3]) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

static float dist3(const float a[3], const float b[3]) {
  float d[3] = { a[0] - b[0], a[1] - b[1], a[2] - b[2] };
  return sqrtf(dot3(d, d));
}

static float median5(float* v) {
  float t[MEDIAN_N];
  memcpy(t, v, sizeof(t));
  for (int i = 1; i < MEDIAN_N; i++) {          // insertion sort, n = 5
    float x = t[i];
    int j = i - 1;
    while (j >= 0 && t[j] > x) { t[j + 1] = t[j]; j--; }
    t[j + 1] = x;
  }
  return t[MEDIAN_N / 2];
}

// Linear interpolation of y over x at xq (x strictly increasing).
static float interpTable(const float* x, const float* y, int n, float xq) {
  if (xq <= x[0])     return y[0];
  if (xq >= x[n - 1]) return y[n - 1];
  for (int i = 1; i < n; i++) {
    if (xq < x[i]) {
      float f = (xq - x[i - 1]) / (x[i] - x[i - 1]);
      return y[i - 1] + f * (y[i] - y[i - 1]);
    }
  }
  return y[n - 1];
}

// Distance from point b to segment a->c; *t = position along it (0..1).
static float distToSegment(const float b[3], const float a[3], const float c[3], float* t) {
  float seg[3] = { c[0] - a[0], c[1] - a[1], c[2] - a[2] };
  float rel[3] = { b[0] - a[0], b[1] - a[1], b[2] - a[2] };
  float L2 = dot3(seg, seg);
  float u = L2 > 0 ? dot3(rel, seg) / L2 : 0;
  u = constrain(u, 0.0f, 1.0f);
  float d[3] = { rel[0] - u * seg[0], rel[1] - u * seg[1], rel[2] - u * seg[2] };
  if (t) *t = u;
  return sqrtf(dot3(d, d));
}

// Locate a field reading along a calibrated path of NUM_GEARS+1 points.
// Returns Keiser resistance (0-100); *off = distance (uT) from the path.
static float locateOnPath(const float pts[][3], const float b[3], float* off) {
  float best = 1e30f, bestRes = 0;
  for (int i = 0; i < NUM_GEARS; i++) {
    float t;
    float d = distToSegment(b, pts[i], pts[i + 1], &t);
    if (d < best) {
      best = d;
      bestRes = GEAR_EDGES[i] + t * (GEAR_EDGES[i + 1] - GEAR_EDGES[i]);
    }
  }
  *off = best;
  return bestRes;
}

// =========================================================================
// Speaker (CLUE only): tiny non-blocking note player
// =========================================================================
static const uint8_t MAX_NOTES = 6;
static Note     noteQueue[MAX_NOTES];
static uint8_t  noteCount = 0, noteIdx = 0;
static uint32_t noteEndMs = 0;

static void playNotes(const Note* notes, uint8_t n) {
  if (calPaused) return;                         // no beeps while the calibration is paused
  noteCount = min(n, MAX_NOTES);
  memcpy(noteQueue, notes, noteCount * sizeof(Note));
  noteIdx = 0;
  noteEndMs = 0;
}

static void updateSpeaker() {
#ifdef PIN_BUZZER
  uint32_t now = millis();
  if (noteIdx >= noteCount || (int32_t)(now - noteEndMs) < 0) return;
  const Note& n = noteQueue[noteIdx++];
  if (n.hz) tone(PIN_BUZZER, n.hz); else noTone(PIN_BUZZER);
  noteEndMs = now + n.ms;
#endif
}

static void speakerTail() {
#ifdef PIN_BUZZER
  // Silence after the last note has played out.
  if (noteIdx >= noteCount && noteCount && (int32_t)(millis() - noteEndMs) >= 0) {
    noTone(PIN_BUZZER);
    noteCount = noteIdx = 0;
  }
#endif
}

static const Note BEEP_CAPTURE[] = { {2000, 120} };
static const Note BEEP_UNDO[]    = { {600, 120}, {0, 80}, {600, 120} };
static const Note BEEP_SAVED[]   = { {1047, 120}, {1319, 120}, {1568, 120}, {2093, 250} };
static const Note BEEP_FAIL[]    = { {220, 700} };
static const Note BEEP_LEARNED[] = { {2000, 90}, {0, 70}, {2000, 90} };

// =========================================================================
// Watchdog (nRF52 hardware WDT; resets the board if loop() ever hangs)
// =========================================================================
static void watchdogStart() {
  if (!USE_WATCHDOG) return;
  NRF_WDT->CONFIG = (WDT_CONFIG_SLEEP_Run << WDT_CONFIG_SLEEP_Pos) |
                    (WDT_CONFIG_HALT_Pause << WDT_CONFIG_HALT_Pos);
  NRF_WDT->CRV = WATCHDOG_SECONDS * 32768;
  NRF_WDT->RREN = WDT_RREN_RR0_Enabled << WDT_RREN_RR0_Pos;
  NRF_WDT->TASKS_START = 1;
}

static inline void watchdogFeed() {
  if (USE_WATCHDOG) NRF_WDT->RR[0] = WDT_RR_RR_Reload;
}

// =========================================================================
// Calibration persistence
// =========================================================================
static int16_t toDeci(float uT);

static float pathLength(const float p[][3]) {
  float L = 0;
  for (int i = 1; i <= NUM_GEARS; i++) L += dist3(p[i], p[i - 1]);
  return L;
}

// Which spot a calibration was made at: FNV-1a over its up points (0.1 uT).
static uint32_t calSpotHash(const float p[][3]) {
  uint32_t h = 0x811C9DC5UL;
  for (int i = 0; i <= NUM_GEARS; i++) {
    for (int k = 0; k < 3; k++) {
      uint16_t v = (uint16_t)toDeci(p[i][k]);
      h = (h ^ (v & 0xFF)) * 0x01000193UL;
      h = (h ^ (v >> 8)) * 0x01000193UL;
    }
  }
  return h ? h : 1;
}

static bool loadCalibration() {
  File f(InternalFS);
  if (!f.open(CAL_PATH, FILE_O_READ)) return false;
  CalData tmp;
  memset(&tmp, 0, sizeof(tmp));
  uint32_t size = f.size();
  bool ok = false;
  if (size == sizeof(tmp)) {
    ok = f.read(&tmp, sizeof(tmp)) == (int)sizeof(tmp) && tmp.version == CAL_VERSION;
  } else if (size == CAL_V5_SIZE) {               // v5: no survey fields
    ok = f.read(&tmp, CAL_V5_SIZE) == (int)CAL_V5_SIZE && tmp.version == 5;
  } else if (size == CAL_V4_SIZE) {               // v4: no down points either
    ok = f.read(&tmp, CAL_V4_SIZE) == (int)CAL_V4_SIZE && tmp.version == 4;
    tmp.downMask = 0;
  }
  ok = ok && tmp.magic == CAL_MAGIC;
  f.close();
  if (!ok) return false;
  if (tmp.version < 6) {                          // missing fields: defaults, or worked out
    tmp.noiseUT = 0;                              // -> NOISE_DEFAULT_UT
    tmp.stepScale = pathLength(tmp.pts);
    tmp.stickRatio = 0;                           // -> from the down points, else the default
    tmp.spotId = calSpotHash(tmp.pts);
    memset(tmp.capRpm, 0, sizeof(tmp.capRpm));
    memset(tmp.downRpm, 0, sizeof(tmp.downRpm));
    tmp.pad2 = 0;
  }
  cal = tmp;
  cal.version = CAL_VERSION;
  return true;
}

// Write a file whole: to a temporary file first, then rename it over the old
// one, so a power cut mid-write leaves the old file (the down pass saves every point).
static const char* TMP_PATH = "/keiser_tmp.bin";
static bool writeAtomic(const char* path, const uint8_t* a, size_t na, const uint8_t* b, size_t nb) {
  InternalFS.remove(TMP_PATH);
  File f(InternalFS);
  if (!f.open(TMP_PATH, FILE_O_WRITE)) return false;
  bool ok = f.write(a, na) == na && (!nb || f.write(b, nb) == nb);
  f.close();
  if (!ok) { InternalFS.remove(TMP_PATH); return false; }
  if (InternalFS.rename(TMP_PATH, path)) return true;
  InternalFS.remove(path);                        // rename refused to replace: remove, then rename
  return InternalFS.rename(TMP_PATH, path);
}

static bool saveCalibration() {
  return writeAtomic(CAL_PATH, (const uint8_t*)&cal, sizeof(cal), nullptr, 0);
}

static void loadPrev() {
  InternalFS.remove(TMP_PATH);                    // a half-written file from a power cut
  File f(InternalFS);
  if (!f.open(PREV_PATH, FILE_O_READ)) return;
  uint32_t magic = 0;
  prevValid = f.read(&magic, sizeof(magic)) == (int)sizeof(magic) && magic == PREV_MAGIC &&
              f.read(prevPts, sizeof(prevPts)) == (int)sizeof(prevPts);
  f.close();
}

// A new calibration replaces the current one: keep the current one's points.
static void savePrev() {
  memcpy(prevPts, cal.pts, sizeof(prevPts));
  prevValid = true;
  writeAtomic(PREV_PATH, (const uint8_t*)&PREV_MAGIC, sizeof(PREV_MAGIC), (const uint8_t*)prevPts, sizeof(prevPts));
}

// A new spot has no prior: forget the previous calibration ('#M', or the survey said so).
static void forgetPrev() {
  prevValid = false;
  InternalFS.remove(PREV_PATH);
}

// One line of 'p' (paced from loop(), see outStep()). Returns false when done.
static bool printCalibrationLine(int pos) {
  if (pos == 0) {
    if (!calValid) { Log.println(F("No valid calibration stored.")); }
    else Log.println(F("Calibration path (point, Keiser resistance, field uT, step uT; coming down, uT from the up point):"));
    return true;
  }
  if (calValid && pos <= NUM_GEARS + 1) {
    int i = pos - 1;
    float step = i ? dist3(cal.pts[i], cal.pts[i - 1]) : 0;
    Log.printf("  %2d  R=%6.2f  (%7.1f,%7.1f,%7.1f)  %5.2f", i + 1, GEAR_EDGES[i],
               cal.pts[i][0], cal.pts[i][1], cal.pts[i][2], step);
    if (cal.downMask & (1UL << i)) {
      Log.printf("   down (%7.1f,%7.1f,%7.1f)  %4.2f  %u rpm\n", cal.down[i][0], cal.down[i][1], cal.down[i][2],
                 dist3(cal.pts[i], cal.down[i]), cal.downRpm[i]);
    } else {
      Log.printf("  %u rpm\n", cal.capRpm[i]);
    }
    return true;
  }
  if (calValid) pos -= NUM_GEARS + 1;
  switch (pos) {
    case 1:
      if (calValid) {
        Log.printf("Stored: spot id %08lx, path %.1f uT, noise %.2f uT%s, %d down points, stickiness %.2f x step%s.\n",
                   (unsigned long)cal.spotId, cal.stepScale, cal.noiseUT > 0 ? cal.noiseUT : NOISE_DEFAULT_UT,
                   cal.noiseUT > 0 ? "" : " (default)", __builtin_popcount(cal.downMask),
                   cal.stickRatio > 0 ? cal.stickRatio : STICK_RATIO_DEFAULT, cal.stickRatio > 0 ? "" : " (default)");
      } else {
        Log.println(F("Stored: none."));
      }
      if (calState != CAL_IDLE) Log.printf("This calibration: %s spot, noise %.2f uT.\n", SPOT_NAMES[spotKind], tol.noise);
      return true;
    case 2:
      Log.printf("Tolerances (uT): agree %.2f, still moving %.2f/%.2f/%.2f, move on max(%.2f, %.2f x step), "
                 "settle %.2f\n", tol.agree, tol.drift, tol.creep, tol.slow, tol.moveMin, tol.moveFrac, tol.settle);
      return true;
    case 3:
      Log.printf("  go back max(%.2f, %.2f x step) or %.2f held, rise max(%.2f, %.2f x step), edge %.2f x step\n",
                 tol.behindMin, tol.behindFrac, tol.behindHeld, tol.riseMin, tol.riseFrac, EDGE_FRAC);
      return true;
    case 4:
      Log.printf("  off-path hold %.1f, span >= %.1f, step warn %.2f / reject %.2f, fold %.2f, same spot %.2f\n",
                 tol.offHold, tol.minSpan, tol.stepWarn, tol.stepReject, tol.fold, tol.sameSpot);
      return true;
    case 5:                                       // v3.4.1: lines the phone didn't get (issue #91)
      Log.printf("Bluetooth to the phone since power-up: %lu status lines skipped, %lu lines cut short.\n",
                 (unsigned long)Log.skipped, (unsigned long)Log.cut);
      return true;
    default:
      return false;
  }
}

// Path and switch points from cal (see pathPts).
static bool pairFlagged(int i);
static void unitDir(const float p[][3], int a, int b, float dir[3]);
static uint32_t usableDown() {                   // down points the path can use (the check's flags left out)
  uint32_t m = cal.downMask;
  for (int i = 1; i < NUM_GEARS; i++) if (pairFlagged(i)) m &= ~(1UL << i);
  return m;
}

static float medianOf(float* v, int n);

// The mean of the two steps at point i of a path (one at the ends).
static float localStep(const float p[][3], int i) {
  if (i <= 0) return dist3(p[1], p[0]);
  if (i >= NUM_GEARS) return dist3(p[NUM_GEARS], p[NUM_GEARS - 1]);
  return 0.5f * (dist3(p[i], p[i - 1]) + dist3(p[i + 1], p[i]));
}

// The up point the path uses: the check's guess while the point is flagged
// (the stored point itself is never changed by this).
static const float* upForPath(int i) {
  for (uint8_t n = 0; n < suspectN; n++)
    if (suspects[n].pass == 'u' && suspects[n].point == i + 1) return suspects[n].guess;
  return cal.pts[i];
}

static void buildPath() {
  for (int i = 0; i < NUM_GEARS; i++) memcpy(pathPts[i], upForPath(i), sizeof(pathPts[0]));
  uint32_t use = usableDown();
  for (int i = 1; i < NUM_GEARS; i++) {
    if (!(use & (1UL << i))) continue;
    for (int k = 0; k < 3; k++) pathPts[i][k] = 0.5f * (cal.pts[i][k] + cal.down[i][k]);
  }
  // The top stays the same step beyond point 24 as stored.
  for (int k = 0; k < 3; k++)
    pathPts[NUM_GEARS][k] = pathPts[NUM_GEARS - 1][k] + (cal.pts[NUM_GEARS][k] - cal.pts[NUM_GEARS - 1][k]);

  // Switch points. Each edge sits EDGE_FRAC x the local step back from where
  // the rider stopped (along the path; riders stop further past a big step);
  // coming down, the console switches lower by its stickiness: measured where
  // there is a pair, else the pairs' median ratio to the local step, else the
  // stored ratio (the last down pass at this spot), else STICK_RATIO_DEFAULT.
  static float tan[NUM_GEARS + 1][3];
  static float ls[NUM_GEARS + 1];
  static float rs[NUM_GEARS + 1];
  int nr = 0;
  for (int i = 1; i < NUM_GEARS; i++) {
    unitDir(pathPts, i - 1, i + 1, tan[i]);
    ls[i] = localStep(pathPts, i);
    if (!(use & (1UL << i)) || ls[i] <= 0) continue;
    float d[3] = { cal.pts[i][0] - cal.down[i][0], cal.pts[i][1] - cal.down[i][1], cal.pts[i][2] - cal.down[i][2] };
    rs[nr++] = (dot3(d, tan[i]) - 2 * EDGE_FRAC * ls[i]) / ls[i];
  }
  float ratio = nr ? medianOf(rs, nr) : cal.stickRatio > 0 ? cal.stickRatio : STICK_RATIO_DEFAULT;
  for (int i = 1; i < NUM_GEARS; i++) {
    const float* u = upForPath(i);
    float eu[3], ed[3];
    float bias = EDGE_FRAC * ls[i], stick = max(STICK_MIN_UT, ratio * ls[i]);
    for (int k = 0; k < 3; k++) {
      eu[k] = u[k] - bias * tan[i][k];
      ed[k] = (use & (1UL << i)) ? cal.down[i][k] + bias * tan[i][k] : eu[k] - stick * tan[i][k];
    }
    float gap[3] = { eu[0] - ed[0], eu[1] - ed[1], eu[2] - ed[2] };
    if (dot3(gap, tan[i]) < 0.1f) {               // crossed: a minimal band around the middle
      for (int k = 0; k < 3; k++) {
        float m = 0.5f * (eu[k] + ed[k]);
        eu[k] = m + 0.05f * tan[i][k];
        ed[k] = m - 0.05f * tan[i][k];
      }
    }
    float off;
    edgeUpR[i]   = locateOnPath(pathPts, eu, &off);
    edgeDownR[i] = locateOnPath(pathPts, ed, &off);
  }
}

// =========================================================================
// Tolerances (v3.3): worked out from the turn-to-turn noise, the learned
// settle-back and the expected gear step, instead of fixed uT values.
// fromCal: (on load, an edit, a redo, '#D') the noise and the expected steps
// come from the stored calibration; otherwise from the survey.
// =========================================================================
static void deriveTolerances(bool fromCal) {
  if (fromCal) {
    noiseUT = calValid && cal.noiseUT > 0 ? cal.noiseUT : NOISE_DEFAULT_UT;
    settleN = settleIdx = 0;
    for (int i = 0; i <= NUM_GEARS; i++)
      tol.expStep[i] = calValid && i >= 1 && i < NUM_GEARS ? dist3(upForPath(i), upForPath(i - 1)) : 0;
  }
  float n = max(NOISE_FLOOR_UT, noiseUT);
  float s = n;
  if (settleN) {
    static float tmp[SETTLE_SAVES];
    memcpy(tmp, settleRing, settleN * sizeof(float));
    s = medianOf(tmp, settleN);
  }
  tol.noise      = n;
  tol.settle     = s;
  tol.agree      = max(K_AGREE * n, AGREE_MIN);
  tol.drift      = max(K_DRIFT * n, DRIFT_MIN);
  tol.creep      = max(K_CREEP * n, CREEP_MIN);
  tol.slow       = max(K_SLOW * n, SLOW_MIN);
  tol.moveMin    = K_MOVE * n;
  tol.moveFrac   = spotKind == SPOT_SAME ? MOVE_FRAC_SAME : MOVE_FRAC_NEW;
  tol.behindMin  = max(max(K_BEHIND * n, 2 * s), BEHIND_MIN);
  tol.behindFrac = BEHIND_FRAC;
  tol.behindHeld = max(max(K_BEHIND_HELD * n, 2 * s), BEHIND_MIN);
  tol.riseMin    = K_RISE * n;
  tol.riseFrac   = RISE_FRAC;
  tol.stickRatio = calValid && cal.stickRatio > 0 ? cal.stickRatio : STICK_RATIO_DEFAULT;
  tol.offHold    = max(OFFPATH_HOLD_UT, K_OFFHOLD * n);
  tol.minSpan    = max(SPAN_MIN, K_SPAN * n);
  tol.stepWarn   = K_STEP_WARN * n;
  tol.stepReject = STEP_REJECT_UT;
  tol.fold       = max(FOLD_MIN, K_FOLD * n);
  tol.sameSpot   = max(SAME_SPOT_UT, K_SAME_SPOT * n);
}

// A settle-back measured after a save: into the running median.
static void settleAdd(float x) {
  settleRing[settleIdx] = x;
  settleIdx = (settleIdx + 1) % SETTLE_SAVES;
  if (settleN < SETTLE_SAVES) settleN++;
  deriveTolerances(false);
}

static void calFinish();
static void calStorePoint(const float b[3]);
static void calOnTurn(const float avg[3]);
static void calCheck();

// =========================================================================
// Crank-magnet turn detector (mirrors bench/replay_v3.py)
// =========================================================================
static void crankReset(float base) {
  crArmed = true;
  crHaveBoundary = false;
  crDipMax = 0;
  crDepth = crank.depth;
  crBaseline = crQEma = base;
  crSum[0] = crSum[1] = crSum[2] = 0;
  crSumQ = 0;
  crN = 0;
  crLastMs = 0;
  crLastPeriodMs = 1000;
}

// One raw sample. Returns 0 = nothing, 1 = turn boundary (after a pause,
// no full turn yet), 2 = a full turn completed: its average is in avg[] and
// its length in *periodMs.
static int crankSample(uint32_t now, const float raw[3], float avg[3], uint32_t* periodMs) {
  float q = crank.sign * dot3(raw, crank.u);
  for (int k = 0; k < 3; k++) crSum[k] += raw[k];
  crSumQ += q;
  crN++;
  float dt = crLastMs ? (float)(now - crLastMs) : (float)SAMPLE_PERIOD_MS;
  crLastMs = now;
  crQEma += min(1.0f, dt / QEMA_TAU_MS) * (q - crQEma);

  // Stalled (stopped, or the lever moved a lot): judge dips against the
  // running mean instead of the last turn's mean. A "dip" lasting longer
  // than the cadence timeout is a level shift, not a dip: re-arm.
  uint32_t stall = max((uint32_t)(2.5f * crLastPeriodMs), STALL_MIN_MS);
  if (!crHaveBoundary || now - crLastBoundaryMs > stall) {
    crBaseline = crQEma;
    if (!crArmed && now - crDipStartMs > CADENCE_TIMEOUT_MS) crArmed = true;
  }

  float d = crBaseline - q;
  if (crArmed) {
    bool gapOk = !crHaveBoundary || now - crLastBoundaryMs >= REFRACT_MS;
    if (d > DIP_FRAC * crDepth && gapOk) {
      crArmed = false;
      crDipMax = d;
      crDipStartMs = now;
    }
    return 0;
  }
  crDipMax = max(crDipMax, d);
  if (d >= REARM_FRAC * crDepth) return 0;

  // Climbed back out of the dip: one turn boundary.
  crArmed = true;
  crDepth += DEPTH_ADAPT * (crDipMax - crDepth);
  crDepth = constrain(crDepth, 0.5f * crank.depth, 2.0f * crank.depth);
  int result = 1;
  if (crHaveBoundary && now - crLastBoundaryMs <= CADENCE_TIMEOUT_MS && crN > 0) {
    for (int k = 0; k < 3; k++) avg[k] = crSum[k] / crN;
    crBaseline = crSumQ / crN;
    *periodMs = now - crLastBoundaryMs;
    crLastPeriodMs = *periodMs;
    result = 2;
  }
  crHaveBoundary = true;
  crLastBoundaryMs = now;
  crSum[0] = crSum[1] = crSum[2] = 0;
  crSumQ = 0;
  crN = 0;
  return result;
}

static int cmpFloat(const void* a, const void* b) {
  float x = *(const float*)a, y = *(const float*)b;
  return (x > y) - (x < y);
}

static int cmpU16(const void* a, const void* b) {
  return (int)*(const uint16_t*)a - (int)*(const uint16_t*)b;
}

// Learn the crank from the first n buffered raw samples of steady pedalling:
// main direction of variation, dip polarity and depth (into `crank`, with
// crank.ok left alone), then count the turns with the real detector and
// judge them: deep enough, enough turns, regular, and not impossibly fast.
// `atCap`: the buffer is full, so accept with LEARN_MIN_TURNS instead of
// LEARN_TARGET_TURNS. Mirrors learn()/verdict() in bench/replay_learn.py.
static LearnResult crankLearn(int n, bool atCap) {
  LearnResult r = { false, 0, 0, 0, 0, "no signal" };
  float m[3] = {0, 0, 0};
  for (int i = 0; i < n; i++) for (int k = 0; k < 3; k++) m[k] += learnBuf[i][k] / n;
  float C[3][3] = {{0}};
  for (int i = 0; i < n; i++)
    for (int a = 0; a < 3; a++)
      for (int b = 0; b < 3; b++)
        C[a][b] += (learnBuf[i][a] - m[a]) * (learnBuf[i][b] - m[b]) / n;
  float u[3] = {1.0f, 0.3f, 0.2f};                   // power iteration
  for (int it = 0; it < 50; it++) {
    float v[3];
    for (int a = 0; a < 3; a++) v[a] = C[a][0] * u[0] + C[a][1] * u[1] + C[a][2] * u[2];
    float nv = sqrtf(dot3(v, v));
    if (nv <= 0) return r;
    for (int a = 0; a < 3; a++) u[a] = v[a] / nv;
  }
  for (int i = 0; i < n; i++) learnP[i] = dot3(learnBuf[i], u);
  qsort(learnP, n, sizeof(float), cmpFloat);
  float med = learnP[n / 2];
  float below = med - learnP[n / 100], above = learnP[n - 1 - n / 100] - med;

  crank.sign = below >= above ? 1 : -1;
  crank.depth = max(below, above);
  memcpy(crank.u, u, sizeof(u));
  float base = 0;
  for (int i = 0; i < n; i++) base += crank.sign * dot3(learnBuf[i], u) / n;
  crank.base = base;

  // Count full turns in the buffer with the real detector.
  const int maxTurns = sizeof(learnPer) / sizeof(learnPer[0]);
  crankReset(base);
  int turns = 0;
  float avg[3];
  uint32_t per;
  for (int i = 0; i < n; i++) {
    uint32_t t = 1 + (uint32_t)((uint64_t)i * pdMS_TO_TICKS(SAMPLE_PERIOD_MS) * 1000 / configTICK_RATE_HZ);
    if (crankSample(t, learnBuf[i], avg, &per) == 2 && turns < maxTurns)
      learnPer[turns++] = (uint16_t)min(per, (uint32_t)65535);
  }
  crankReset(base);

  r.depth = crank.depth;
  r.turns = (uint8_t)min(turns, 255);
  if (turns > 0) {
    qsort(learnPer, turns, sizeof(learnPer[0]), cmpU16);
    float medPer = learnPer[turns / 2];
    int regular = 0;
    for (int i = 0; i < turns; i++)
      if (learnPer[i] >= LEARN_REG_LO * medPer && learnPer[i] <= LEARN_REG_HI * medPer) regular++;
    r.regular = (uint8_t)min(regular, 255);
    r.rpm = 60000.0f / medPer;
  }
  if (r.depth < CRANK_MIN_DEPTH_UT)                         r.why = "dip too shallow";
  else if (turns < (atCap ? LEARN_MIN_TURNS : LEARN_TARGET_TURNS)) r.why = "too few turns";
  else if (r.regular < LEARN_REG_SHARE * turns)              r.why = "irregular turns";
  else if (r.rpm > LEARN_MAX_RPM)                            r.why = "too fast - counting twice per turn?";
  else { r.ok = true; r.why = "ok"; }
  return r;
}

// The learned crank's full turns in the learning buffer (the lever was still):
// the first noise turns for the survey. Same synthetic clock as crankLearn().
static void learnNoiseTurns(int n) {
  noiseN = 0;
  crankReset(crank.base);
  float avg[3];
  uint32_t per;
  for (int i = 0; i < n; i++) {
    uint32_t t = 1 + (uint32_t)((uint64_t)i * pdMS_TO_TICKS(SAMPLE_PERIOD_MS) * 1000 / configTICK_RATE_HZ);
    if (crankSample(t, learnBuf[i], avg, &per) == 2 && noiseN < NOISE_MAX_TURNS)
      memcpy(noiseBuf[noiseN++], avg, sizeof(noiseBuf[0]));
  }
  crankReset(crank.base);
}

static void loadCrankFromCal() {
  crank.ok = calValid && cal.crankOk;
  if (!crank.ok) return;
  crank.sign = cal.crankSign;
  memcpy(crank.u, cal.crankU, sizeof(crank.u));
  crank.depth = cal.crankDepth;
  crank.base = cal.crankBase;
  crankReset(crank.base);
}

static bool pedalling() {
  return crank.ok && selfRevs > 0 && (int32_t)(clockMs() - selfEventMs) <= (int32_t)CADENCE_TIMEOUT_MS;
}

static float selfCadence() {
  if (!pedalling() || !selfPeriods[0]) return 0;
  uint32_t p = selfPeriods[1] ? (selfPeriods[0] + selfPeriods[1]) / 2 : selfPeriods[0];
  return 60000.0f / p;
}

// =========================================================================
// Calibration procedure
// =========================================================================
static void stabReset() {
  memcpy(stabRef, fieldUT, sizeof(stabRef));
  stabSince = clockMs();
  stabPct = 0;
}

// The flow's step for the S line (field 15): 1 placement ('v' on, idle), 2 crank
// (learning, cadence check, noise turns), 3 sweep, 4 up pass (and its checkpoint),
// 5 down pass, 6 redoing a point from the gear check; 0 idle.
static int calStepNo() {
  switch (calState) {
    case CAL_IDLE:       return placeOn ? 1 : 0;
    case CAL_LEARN:
    case CAL_CONFIRM:    return 2;
    case CAL_SURVEY:     return survPhase == SURV_NOISE ? 2 : 3;
    case CAL_DOWN_READY: return 4;
    default:             return calPass == PASS_UP ? 4 : calPass == PASS_DOWN ? 5 : 6;
  }
}

static void calPrompt() {
  const char* keep = crank.ok ? "Keep pedalling, any steady pace. " : "";
  if (calPass == PASS_FIX_UP) {
    Log.printf("\n[REDO] Gear %d: move the lever DOWN below gear %d first, then up to where the "
               "Keiser console FIRST shows gear %d, and hold it there. 'x' cancels.\n",
               calStep + 1, calStep + 1, calStep + 1);
  } else if (calPass == PASS_FIX_DOWN) {
    Log.printf("\n[REDO] Coming down to gear %d: move the lever UP into gear %d first, then down to "
               "where the console FIRST shows gear %d, and hold it there. 'x' cancels.\n",
               calStep, calStep + 1, calStep);
  } else if (calPass == PASS_DOWN) {
    Log.printf("\n[DOWN %d/%d] %s%s%sMove the lever DOWN to where the Keiser console FIRST shows "
               "gear %d, then hold it there.\n", DOWN_FIRST + 1 - calStep, DOWN_FIRST, keep,
               downGate ? "First shift UP into the gear above. " : "",
               calRedo ? "Redo: first move the lever UP above this gear. " : "", calStep);
  } else if (calStep == 0) {
    Log.printf("\n[UP 1/%d] %sPush the gear lever ALL THE WAY DOWN and hold it there.\n", NUM_GEARS, keep);
  } else {
    Log.printf("\n[UP %d/%d] %s%sMove the lever up to where the Keiser console "
                  "FIRST shows gear %d, then %s\n", calStep + 1, NUM_GEARS, keep,
                  calRedo ? "Redo: first move the lever DOWN below this gear. " : "",
                  calStep + 1, crank.ok ? "hold it there." : "stop there.");
  }
  if (crank.ok && pressMode) {
    Log.println(F("When the console shows it, press button A or send 'n': it measures the next pedal turns."));
  } else if (crank.ok) {
    Log.println(autoCapture ? F("It captures and beeps once 3 pedal turns agree. You can stop pedalling any time.")
                            : F("Then press button A or send 'n'."));
  } else if (autoCapture) {
    Log.println(F("Flywheel still and hold ~2 s: it captures and beeps by itself."));
  } else {
    Log.println(F("Flywheel still, then press button A or send 'n'."));
  }
  turnHistN = 0;
  pendingCap = false;
  settleSince = 0;
  behindSent = false;
  backGate = false;
  backRising = false;
  behindNow = false;
  agreeRun = 0;
  softRun = 0;
  pressArmed = false;
  pressRefused = false;
  stabReset();
}

static void calLearnStart() {
  calState   = CAL_LEARN;
  calStep    = 0;
  learnCount = 0;
  crank.ok   = false;                     // re-learned for this calibration
  stabPct    = 0;
  learnLast  = { false, 0, 0, 0, 0, "no signal" };
  selfPeriods[0] = selfPeriods[1] = 0;     // no cadence from the old crank settings
  Log.println(F("Pedal steadily, any comfortable pace, so the bridge can learn your crank (5-15 s)."));
}

static void calStart() {
  Log.println(F("\n=== Calibration started (hold button 3 s or send 'x' to abort, 'u' to undo) ==="));
  staging = false;
  calRedo = false;
  calPass = PASS_UP;
  calDownMask = 0;
  backUpOk = true;
  backedPass = -1;
  calFromBle = cmdSrc == SRC_BLE;
  prevSaved = false;
  memset(capRpm, 0, sizeof(capRpm));
  memset(downRpm, 0, sizeof(downRpm));
  settleN = settleIdx = 0;
  settleTurns = 0;
  survL = 0;
  calPaused = false;
  pauseSkip = 0;
  expHave = false;
  calLearnStart();
}

// Learn the crank again: after the cadence check, or at point 1 of a
// calibration that fell back to the hold-still method.
static void calRelearn() {
  if (calState != CAL_CONFIRM && !(calState == CAL_WAITING && calPass == PASS_UP && calStep == 0)) return;
  Log.println(F("Learning the crank again."));
  calLearnStart();
}

// End of the learning stage: crank found -> the rider checks the cadence
// against the console (CAL_CONFIRM), then the survey and per-turn calibration
// while pedalling; not found -> v2-style calibration with the flywheel still.
static void calLearnDone() {
  const LearnResult& r = learnLast;
  crank.ok = r.ok;                         // crankLearn() left the rest of `crank` set
  Log.printf("Crank: dip depth %.1f uT, %u turns (%u regular) at %.0f rpm in %.1f s: %s.\n",
             r.depth, r.turns, r.regular, r.rpm, learnCount * SAMPLE_PERIOD_MS / 1000.0f, r.why);
  Log.printf("L,%d,%u,%.0f,%.1f,%s\n", r.ok ? 1 : 0, r.turns, r.rpm, r.depth, r.why);
  if (r.ok) {
    learnNoiseTurns(learnCount);
    Log.println(F("Crank learned. Check that the cadence matches the Keiser console:"));
    Log.println(F("press button A or send 'n' if it does, send 'l' to learn again."));
    playNotes(BEEP_LEARNED, 3);
    calState = CAL_CONFIRM;
    stabPct  = 100;
    lastTurnMs = sampleMs;
    return;
  }
  Log.println(F("Crank magnet not detected well enough (too far from the board?)."));
  Log.println(F("Continuing without it: stop pedalling at each point; cadence comes from a pod."));
  Log.println(F("Send 'l' to try learning the crank again."));
  deriveTolerances(true);                  // no survey: the stored calibration's noise, or the default
  calState = CAL_WAITING;
  calPrompt();
}

// Every 0.5 s of learning: look at everything buffered so far.
static void calLearnProbe() {
  bool atCap = learnCount + LEARN_PROBE_EVERY > LEARN_MAX_SAMPLES;
  learnLast = crankLearn(learnCount, atCap);
  stabPct = learnLast.ok ? 100 : (uint8_t)min(95, learnLast.turns * 100 / LEARN_TARGET_TURNS);
  if (learnLast.ok || atCap) calLearnDone();
}

// ---------------------------------------------------------------------------
// Survey (v3.3): noise from still turns, then a sweep of the lever up and down.
// ---------------------------------------------------------------------------
static void surveyNoiseDone() {
  // Changes between consecutive turns, and second differences / sqrt(3), which
  // are the same size for a still lever but cancel a lever moved steadily
  // during these turns.
  static float d1[NOISE_MAX_TURNS], d2[NOISE_MAX_TURNS];
  int n1 = 0, n2 = 0;
  for (int i = 1; i < noiseN; i++) d1[n1++] = dist3(noiseBuf[i], noiseBuf[i - 1]);
  for (int i = 1; i + 1 < noiseN; i++) {
    float s = 0;
    for (int k = 0; k < 3; k++) {
      float e = noiseBuf[i + 1][k] - 2 * noiseBuf[i][k] + noiseBuf[i - 1][k];
      s += e * e;
    }
    d2[n2++] = sqrtf(s / 3.0f);
  }
  float stored = calValid && cal.noiseUT > 0 ? cal.noiseUT : 0;
  noisePoolN = noisePoolIdx = 0;
  if (n2 >= 2) {
    // Both kinds together (twice the samples), unless the lever moved steadily
    // (the first differences then come out larger): then the second only.
    static float all[2 * NOISE_MAX_TURNS], t1[NOISE_MAX_TURNS], t2[NOISE_MAX_TURNS];
    memcpy(t1, d1, n1 * sizeof(float));
    memcpy(t2, d2, n2 * sizeof(float));
    bool still = medianOf(t1, n1) <= 1.5f * medianOf(t2, n2);
    int na = 0;
    if (still) for (int i = 0; i < n1; i++) all[na++] = d1[i];
    for (int i = 0; i < n2; i++) all[na++] = d2[i];
    float n = medianOf(all, na);
    if (stored) n = constrain(n, NOISE_CAL_LO * stored, NOISE_CAL_HI * stored);   // one rider's turns vary a lot
    noiseUT = constrain(n, NOISE_FLOOR_UT, NOISE_MAX_UT);
    if (still) {                                  // the pool starts from these turns
      for (int i = max(0, n1 - (int)NOISE_POOL); i < n1; i++) {
        noisePool[noisePoolIdx] = d1[i];
        noisePoolIdx = (noisePoolIdx + 1) % NOISE_POOL;
        if (noisePoolN < NOISE_POOL) noisePoolN++;
      }
    }
  } else {
    noiseUT = stored ? stored : NOISE_DEFAULT_UT;
  }
  settleN = settleIdx = 0;
  deriveTolerances(false);
  Log.printf("Noise %.2f uT from %u still turns.\n", noiseUT, noiseN);
  survPhase = SURV_UP;
  calStep = 1;
  stabPct = 0;
  Log.println(F("\n[SWEEP UP] Keep pedalling. Lever all the way down, then slowly push it up as far as you "
                "can still pedal, then press button A or send 'n'."));
}

// The rider confirmed the cadence: on to the survey.
static void calConfirm() {
  if (calState != CAL_CONFIRM) return;
  Log.println(F("Cadence confirmed."));
  playNotes(BEEP_CAPTURE, 1);
  calState = CAL_SURVEY;
  calStep = 0;                                    // S step field: 0 noise turns, 1 sweep up, 2 sweep down
  sweepN = sweepUpN = 0;
  survSat = false;
  stabPct = 0;
  if (noiseN >= NOISE_TURNS) { surveyNoiseDone(); return; }
  survPhase = SURV_NOISE;
  Log.println(F("Keep pedalling with the lever still for a few more turns."));
}

static void surveyOnTurn(const float avg[3]) {
  if (survPhase == SURV_NOISE) {
    if (noiseN < NOISE_MAX_TURNS) memcpy(noiseBuf[noiseN++], avg, sizeof(noiseBuf[0]));
    stabPct = (uint8_t)min(100, noiseN * 100 / NOISE_TURNS);
    if (noiseN >= NOISE_TURNS) surveyNoiseDone();
    return;
  }
  uint16_t lim = survPhase == SURV_UP ? SWEEP_MAX_TURNS : sweepUpN + SWEEP_MAX_TURNS;
  if (sweepN < lim) memcpy(sweepBuf[sweepN++], avg, sizeof(sweepBuf[0]));
}

// Chained length of sweep turns, lightly de-noised (a turn closer than 2 x
// noise to the last one kept is skipped); *far = farthest kept turn from the
// start, *end = the last kept turn's distance from the start.
static float sweepLen(const float (*p)[3], int n, float noise, float* far, float* end) {
  *far = *end = 0;
  if (n <= 0) return 0;
  float L = 0;
  const float* last = p[0];
  for (int i = 1; i < n; i++) {
    float d = dist3(p[i], last);
    if (d < 2 * noise) continue;
    L += d;
    last = p[i];
    *far = max(*far, dist3(p[i], p[0]));
  }
  *end = dist3(last, p[0]);
  return L;
}

static void calSurveyDone() {
  float n = tol.noise, far, end, f2, e2;
  float Lu = sweepLen(sweepBuf, sweepUpN, n, &far, &end);
  float Ld = sweepLen(sweepBuf + sweepUpN, sweepN - sweepUpN, n, &f2, &e2);
  float L = max(Lu, Ld);
  bool folded = Lu > 0 && far - end > max(FOLD_SWEEP_UT, FOLD_SWEEP_FRAC * Lu);
  const char* verdict = survSat ? "saturated" : L < K_SPAN * n ? "weak" : folded ? "folded" : "ok";
  float offMed = -1;
  if (!calValid) {
    spotKind = SPOT_FIRST;
  } else if (spotForced) {
    spotKind = SPOT_NEW;
  } else {
    spotKind = SPOT_SAME;
    if (sweepN >= 3) {                            // move detection: the sweep against the stored path
      static float offs[2 * SWEEP_MAX_TURNS];
      for (int i = 0; i < sweepN; i++) locateOnPath(pathPts, sweepBuf[i], &offs[i]);
      offMed = medianOf(offs, sweepN);
      if (offMed >= tol.sameSpot) spotKind = SPOT_NEW;
    }
  }
  survL = L;
  expHave = spotKind == SPOT_SAME;                // where each point was last time
  if (expHave) {
    for (int i = 0; i < NUM_GEARS; i++) memcpy(expUp[i], upForPath(i), sizeof(expUp[0]));
    memcpy(expDown, cal.down, sizeof(expDown));
    expDownMask = usableDown();
  }
  if (spotKind == SPOT_SAME) {                    // the stored calibration's steps
    for (int i = 1; i < NUM_GEARS; i++) tol.expStep[i] = dist3(upForPath(i), upForPath(i - 1));
  } else {                                        // the sweep shared out like a typical path
    float sum = 0;
    for (int i = 0; i < NUM_GEARS - 1; i++) sum += STEP_PROFILE_UT[i];
    for (int i = 1; i < NUM_GEARS; i++) tol.expStep[i] = L * STEP_PROFILE_UT[i - 1] / sum;
  }
  tol.expStep[0] = tol.expStep[NUM_GEARS] = 0;
  deriveTolerances(false);
  Log.printf("Sweep: path %.1f uT (signal %s), %s spot", L, verdict, SPOT_NAMES[spotKind]);
  if (offMed >= 0) Log.printf(" (%.1f uT from the stored path)", offMed);
  Log.println(".");
  Log.printf("Z,%.2f,%.1f,%s,%.1f,%s\n", n, L, SPOT_NAMES[spotKind], offMed, verdict);
  calState = CAL_WAITING;
  calPass = PASS_UP;
  calStep = 0;
  calPrompt();
}

// 'n' / button A during the survey: the noise turns are enough, the sweep up
// is done, the sweep down is done.
static void surveyNext() {
  if (survPhase == SURV_NOISE) {
    surveyNoiseDone();
  } else if (survPhase == SURV_UP) {
    sweepUpN = sweepN;
    survPhase = SURV_DOWN;
    calStep = 2;
    Log.println(F("\n[SWEEP DOWN] Keep pedalling. Slowly back down to the bottom, then press button A or send 'n'."));
  } else {
    calSurveyDone();
  }
}

static void calAbort(const __FlashStringHelper* why) {
  bool fixing = calPass == PASS_FIX_UP || calPass == PASS_FIX_DOWN;
  backGate = false;
  calState = CAL_IDLE;
  calPass  = PASS_UP;
  calPaused = false;
  if (fixing) {                                   // redoing one point: nothing changed
    Log.print(F("Redo cancelled: "));
    Log.println(why);
    Log.print(F("A,"));
    Log.println(why);
    return;
  }
  loadCrankFromCal();
  deriveTolerances(true);
  Log.print(F("Calibration aborted: "));
  Log.println(why);
  Log.print(F("A,"));
  Log.println(why);
  if (calValid) Log.println(F("Previous calibration is still in use."));
  playNotes(BEEP_FAIL, 1);
}

// Work out the top point (lever all the way up, into the brake) from points
// 23 and 24: TOP_FRACTION of the 23->24 step beyond point 24 (on 2026-10-16
// the pedalled top was 1.9 uT past point 24, with a 6.4 uT step).
static const float TOP_FRACTION = 0.3f;
static void synthTop(float p[][3]) {
  float f = TOP_FRACTION;
  for (int k = 0; k < 3; k++)
    p[NUM_GEARS][k] = p[NUM_GEARS - 1][k] + f * (p[NUM_GEARS - 1][k] - p[NUM_GEARS - 2][k]);
}

static void calReject(const char* msg, float span, float minStep, int minStepAt);

// The checks a calibration must pass to be used. Returns false with msg set.
// judge false: only the figures (span, smallest step), no verdict.
static bool calValidate(const float p[][3], float* span, float* minStep, int* minStepAt,
                        char* msg, size_t msgLen, bool judge) {
  *span = 0; *minStep = 1e9f; *minStepAt = 1;
  for (int i = 1; i <= NUM_GEARS; i++) {
    float step = dist3(p[i], p[i - 1]);
    *span += step;
    if (step < *minStep) { *minStep = step; *minStepAt = i; }
  }
  if (!judge) return true;
  if (*span < tol.minSpan) {
    Log.printf("Field path is only %.1f uT long across the full lever travel "
               "(need >= %.0f). Move the board closer to the magnet carrier.\n",
               *span, tol.minSpan);
    snprintf(msg, msgLen, "signal too small");
    return false;
  }
  if (*minStep < tol.stepReject) {
    snprintf(msg, msgLen, "points %d and %d are the same - did the lever move?",
             *minStepAt, *minStepAt + 1);
    return false;
  }
  // The path must not come back close to itself, or two lever positions
  // would look the same. Check each point against segments at least one
  // point away (nearer ones are within one small step by construction).
  for (int k = 0; k <= NUM_GEARS; k++) {
    for (int j = 0; j < NUM_GEARS; j++) {
      if (j >= k - 2 && j <= k + 1) continue;
      float d = distToSegment(p[k], p[j], p[j + 1], nullptr);
      if (d < tol.fold) {
        snprintf(msg, msgLen, "path folds back: point %d is %.1f uT from gear %d's segment",
                 k + 1, d, j + 1);
        return false;
      }
    }
  }
  return true;
}

// The console's stickiness as a ratio of the local step, from the up/down
// pairs (0 if there are too few to say).
static float stickRatioFromPairs(const float up[][3], const float down[][3], uint32_t mask) {
  static float r[NUM_GEARS + 1];
  int n = 0;
  for (int i = 1; i < NUM_GEARS; i++) {
    if (!(mask & (1UL << i))) continue;
    float t[3];
    unitDir(up, i - 1, i + 1, t);
    float ls = localStep(up, i);
    if (ls <= 0) continue;
    float d[3] = { up[i][0] - down[i][0], up[i][1] - down[i][1], up[i][2] - down[i][2] };
    r[n++] = (dot3(d, t) - 2 * EDGE_FRAC * ls) / ls;
  }
  return n >= CHECK_MIN_PAIRS ? max(0.05f, medianOf(r, n)) : 0.0f;
}

// Check, store and save a calibration: a new up pass (COMMIT_NEW: also takes
// the crank just learned and the survey's figures), an edit of the stored one
// (COMMIT_EDIT: '#G', '#W', '#R'), or the end of a down pass (COMMIT_DOWN).
// The top point is worked out again from points 23 and 24 unless they are
// unchanged. The check itself runs from loop() (checkPending).
static bool calCommit(const float up[][3], const float down[][3], uint32_t mask, CommitMode mode) {
  static float p[NUM_GEARS + 1][3];
  memcpy(p, up, sizeof(p));
  bool topKept = mode != COMMIT_NEW && calValid &&
                 !memcmp(p[NUM_GEARS - 2], cal.pts[NUM_GEARS - 2], 2 * sizeof(p[0]));
  if (topKept) memcpy(p[NUM_GEARS], cal.pts[NUM_GEARS], sizeof(p[0]));
  else synthTop(p);
  float span, minStep;
  int minStepAt;
  char msg[96];
  bool upChanged = mode == COMMIT_NEW || !calValid || memcmp(p, cal.pts, NUM_GEARS * sizeof(p[0]));
  bool valid = calValidate(p, &span, &minStep, &minStepAt, msg, sizeof(msg), upChanged && mode != COMMIT_DOWN);
  if (!valid) {                                   // (down points never re-judge the up path)
    if (mode == COMMIT_NEW) {
      calReject(msg, span, minStep, minStepAt);
    } else {
      Log.printf("Not saved: %s\n", msg);
      Log.printf("E,fail,%s\n", msg);
    }
    return false;
  }
  bool hadCal = calValid;
  if (mode == COMMIT_NEW && hadCal && !prevSaved && spotKind == SPOT_SAME) {
    savePrev();                                   // the check compares with the calibration it replaces
    prevSaved = true;
  }
  if (mode == COMMIT_NEW && spotKind == SPOT_NEW) forgetPrev();   // a new spot has no prior
  if (mode == COMMIT_NEW) spotForced = false;    // '#M' applies to this calibration only
  uint32_t oldSpot = hadCal ? cal.spotId : 0;
  float oldStick = hadCal ? cal.stickRatio : 0;
  cal.magic = CAL_MAGIC;
  cal.version = CAL_VERSION;
  cal.reserved = 0;
  memcpy(cal.pts, p, sizeof(cal.pts));
  cal.downMask = mask & (((1UL << NUM_GEARS) - 1) & ~1UL);   // points 2-24 only
  memcpy(cal.down, down, sizeof(cal.down));
  if (mode == COMMIT_NEW) {
    cal.crankOk    = crank.ok ? 1 : 0;
    cal.crankSign  = crank.sign;
    cal.pad        = 0;
    memcpy(cal.crankU, crank.u, sizeof(cal.crankU));
    cal.crankDepth = crank.depth;
    cal.crankBase  = crank.base;
    cal.noiseUT    = tol.noise;
    cal.stepScale  = survL > 0 ? survL : span;
    cal.spotId     = hadCal && spotKind == SPOT_SAME && oldSpot ? oldSpot : calSpotHash(p);
    cal.stickRatio = hadCal && spotKind == SPOT_SAME ? oldStick : 0;
    memcpy(cal.capRpm, capRpm, sizeof(cal.capRpm));
    memset(cal.downRpm, 0, sizeof(cal.downRpm));
    cal.pad2 = 0;
  } else if (mode == COMMIT_DOWN) {
    memcpy(cal.downRpm, downRpm, sizeof(cal.downRpm));
    float r = stickRatioFromPairs(cal.pts, cal.down, cal.downMask);
    if (r > 0) cal.stickRatio = r;
  }
  calValid = true;
  suspectN = 0;                                   // the check runs from loop(); until then, the plain path
  buildPath();
  checkPending = true;
  deriveTolerances(false);
  stableGear = pendingGear = 1;
  staging = false;
  bool saved = saveCalibration();
  if (mode == COMMIT_EDIT) {
    Log.printf("Calibration updated. %s\n", saved ? "Saved." : "SAVE FAILED (kept in RAM).");
    Log.printf("E,ok,%s\n", saved ? "saved" : "save failed");
    playNotes(BEEP_CAPTURE, 1);
  } else {
    Log.printf("\n=== %s Path %.1f uT, smallest step %.2f uT (around gear %d). %s ===\n",
               mode == COMMIT_DOWN ? "Calibration complete." : crank.ok ? "Up pass saved." : "Calibration complete.",
               span, minStep, minStepAt, saved ? "Saved." : "SAVE FAILED (kept in RAM).");
    if (minStep < tol.stepWarn) {
      Log.println(F("Warning: some gears are very close together magnetically. "
                       "Mounting the board closer to the magnets will improve resolution."));
    }
    playNotes(BEEP_SAVED, 4);
  }
  Log.printf("K,1,%.1f,%.2f,%d,%s\n", span, minStep, minStepAt, saved ? "saved" : "save failed");
  return true;
}

static void calReject(const char* msg, float span, float minStep, int minStepAt) {
  calState = CAL_IDLE;
  calPaused = false;
  loadCrankFromCal();
  Log.printf("Calibration rejected: %s\n", msg);
  Log.printf("K,0,%.1f,%.2f,%d,%s\n", span, minStep, minStepAt, msg);
  if (calValid) Log.println(F("Previous calibration is still in use."));
  playNotes(BEEP_FAIL, 1);
}

// The up pass is complete: save it at once (usable straight away), then wait
// for 'n' to come back down (crank mode), or finish (hold-still method).
static void calFinish() {
  if (!calCommit(calRaw, calDown, 0, COMMIT_NEW)) return;
  if (!crank.ok) {
    calState = CAL_IDLE;
    calPass  = PASS_UP;
    return;
  }
  settleTurns = 0;
  calState = CAL_DOWN_READY;
  calPass  = PASS_DOWN;
  calStep  = DOWN_FIRST;
  downStart = DOWN_FIRST;
  downGate = false;
  calDownMask = 0;
  stabPct  = 0;
  Log.println(F("Up pass saved. Press button A or send 'n' to come back DOWN through the gears now, "
                "or 's' to stop here ('#D' does the down pass later)."));
}

// The down pass ends ('s', 'x', the last point, the phone gone too long): save
// the down points measured so far.
static void calFinishDown() {
  calState = CAL_IDLE;
  calPass  = PASS_UP;
  calPaused = false;
  Log.printf("Down pass: %d points.\n", __builtin_popcount(calDownMask));
  calCommit(calRaw, calDown, calDownMask, COMMIT_DOWN);
}

// Start (or resume) the down pass at point `step` (0-based). gate: the
// reading must first be in the upper half of the gear above ('#D').
static void calDownBegin(int step, bool gate) {
  settleTurns = 0;
  downResumed = gate;
  calPass  = PASS_DOWN;
  calStep  = step;
  downStart = step;
  downGate = gate;
  fixArmed = false;
  calRedo  = false;
  calState = CAL_WAITING;
  lastTurnMs = sampleMs;
  calPaused = false;
  calPrompt();
}

// '#D': the down pass on the stored calibration, from the highest point not measured yet.
static void calDownStart() {
  if (calState != CAL_IDLE)              { Log.println(F("E,fail,busy calibrating")); return; }
  if (!calValid || !cal.crankOk || !crank.ok) {
    Log.println(F("E,fail,needs a saved calibration made while pedalling"));
    return;
  }
  int i = DOWN_FIRST;
  while (i >= 1 && (cal.downMask & (1UL << i))) i--;
  if (i < 1) { Log.println(F("E,fail,down pass already done")); return; }
  memcpy(calRaw, cal.pts, sizeof(calRaw));
  memcpy(calDown, cal.down, sizeof(calDown));
  calDownMask = cal.downMask;
  memcpy(downRpm, cal.downRpm, sizeof(downRpm));
  staging  = false;
  calFromBle = cmdSrc == SRC_BLE;
  spotKind = SPOT_SAME;
  expHave  = false;
  deriveTolerances(true);
  Log.println(F("E,ok,down"));
  calDownBegin(i, true);
}

// A redone point ('#R') was captured: put it in and save.
static void calFixStore(const float b[3]) {
  bool down = calPass == PASS_FIX_DOWN;
  calState = CAL_IDLE;
  calPass  = PASS_UP;
  calPaused = false;
  Log.printf("  captured (%.1f, %.1f, %.1f) uT\n", b[0], b[1], b[2]);
  if (down) {
    Log.printf("C,down,%d,%.1f,%.1f,%.1f\n", calStep + 1, b[0], b[1], b[2]);
    memcpy(calDown[calStep], b, sizeof(calDown[0]));
    calDownMask |= 1UL << calStep;
  } else {
    Log.printf("C,%d,%.1f,%.1f,%.1f\n", calStep + 1, b[0], b[1], b[2]);
    memcpy(calRaw[calStep], b, sizeof(calRaw[0]));
  }
  calCommit(calRaw, calDown, calDownMask, COMMIT_EDIT);
}

// Start redoing one stored point by pedalling ('#R').
static void calFixStart(bool down, int point) {
  if (calState != CAL_IDLE)              { Log.println(F("E,fail,busy calibrating")); return; }
  if (!calValid || !cal.crankOk || !crank.ok) {
    Log.println(F("E,fail,needs a saved calibration made while pedalling"));
    return;
  }
  int i = point - 1;
  if (i < 1 || i > (down ? DOWN_FIRST : NUM_GEARS - 1)) {
    Log.println(F("E,fail,no such point"));
    return;
  }
  memcpy(calRaw, cal.pts, sizeof(calRaw));
  memcpy(calDown, cal.down, sizeof(calDown));
  calDownMask = cal.downMask;
  staging  = false;
  calPass  = down ? PASS_FIX_DOWN : PASS_FIX_UP;
  calStep  = i;
  calRedo  = false;
  fixArmed = false;
  calFromBle = cmdSrc == SRC_BLE;
  spotKind = SPOT_SAME;
  expHave  = false;
  deriveTolerances(true);
  calState = CAL_WAITING;
  lastTurnMs = sampleMs;
  calPaused = false;
  Log.println(F("E,ok,redo"));
  calPrompt();
}

static void calOnSample(const float b[3]) {
  if (calState != CAL_CAPTURING) return;
  if (saturated) { calAbort(F("magnetometer saturated - move the board farther away")); return; }
  for (int k = 0; k < 3; k++) capSum[k] += b[k];
  if (++capCount < CAPTURE_SAMPLES) return;

  float pt[3];
  for (int k = 0; k < 3; k++) pt[k] = capSum[k] / CAPTURE_SAMPLES;
  calStorePoint(pt);
}

static bool calPrevRef(float prev[3], float dir[3], bool* hasDir);

// After a save: watch the next 2 turns for how far the lever settles back.
// Not for the last point of a pass (the rider moves on at once) or a point
// redone after going back.
static void settleStart(const float b[3], bool redone) {
  float prev[3], dir[3];
  bool hasDir;
  settleTurns = 0;
  bool last = calStep == (calPass == PASS_UP ? NUM_GEARS - 1 : 1);
  if (!crank.ok || last || redone || !calPrevRef(prev, dir, &hasDir)) return;
  float v[3] = { b[0] - prev[0], b[1] - prev[1], b[2] - prev[2] };
  float n = sqrtf(dot3(v, v));
  if (n <= 0) return;
  memcpy(settleRef, b, sizeof(settleRef));
  for (int k = 0; k < 3; k++) settleDir[k] = v[k] / n;
  settleTurns = 2;
  settleWorst = 1e9f;
  settleStep = n;
}

// Store a calibration point and move on (shared by both capture methods).
static void calStorePoint(const float b[3]) {
  bool redone = calRedo || !backUpOk;
  backUpOk = true;
  calRedo = false;
  pendingCap = false;
  settleSince = 0;
  if (calPass == PASS_FIX_UP || calPass == PASS_FIX_DOWN) { calFixStore(b); return; }
  uint8_t rpm = (uint8_t)constrain(lroundf(selfCadence()), 0L, 255L);
  settleStart(b, redone);
  Log.printf("  captured (%.1f, %.1f, %.1f) uT\n", b[0], b[1], b[2]);
  if (calPass == PASS_DOWN) {
    memcpy(calDown[calStep], b, sizeof(calDown[0]));
    calDownMask |= 1UL << calStep;
    downRpm[calStep] = rpm;
    Log.printf("C,down,%d,%.1f,%.1f,%.1f\n", calStep + 1, b[0], b[1], b[2]);
    downGate = false;                             // '#D': shifted up once, that's enough
    if (calValid) {                               // kept at once (power loss, '#D' later)
      memcpy(cal.down[calStep], b, sizeof(cal.down[0]));
      cal.downMask |= 1UL << calStep;
      cal.downRpm[calStep] = rpm;
      saveCalibration();
    }
    if (--calStep < 1) { calFinishDown(); return; }
  } else {
    memcpy(calRaw[calStep], b, sizeof(calRaw[calStep]));
    capRpm[calStep] = rpm;
    Log.printf("C,%d,%.1f,%.1f,%.1f\n", calStep + 1, b[0], b[1], b[2]);
    if (calStep == NUM_GEARS - 1) {              // point 24: work out the top, no need to pedal into the brake
      synthTop(calRaw);
      {
        float span, minStep;
        int minStepAt;
        char msg[96];
        if (!calValidate(calRaw, &span, &minStep, &minStepAt, msg, sizeof(msg), true)) {
          calReject(msg, span, minStep, minStepAt);
          return;
        }
      }
      Log.println(F("Top point worked out from gears 23 and 24."));
      Log.printf("C,%d,%.1f,%.1f,%.1f\n", NUM_GEARS + 1, calRaw[NUM_GEARS][0], calRaw[NUM_GEARS][1],
                 calRaw[NUM_GEARS][2]);
      calFinish();
      return;
    }
    calStep++;
  }
  playNotes(BEEP_CAPTURE, 1);
  calState = CAL_WAITING;
  calPrompt();
}

static void turnHistMean(float out[3]) {
  for (int k = 0; k < 3; k++) {
    out[k] = 0;
    for (int i = 0; i < turnHistN; i++) out[k] += turnHist[i][k] / turnHistN;
  }
}

// The point the current one must move away from, and which way is forward
// (*hasDir false: any direction). Returns false when there is none (point 1,
// or a point being redone, which uses fixArmed instead).
static bool calPrevRef(float prev[3], float dir[3], bool* hasDir) {
  *hasDir = false;
  const float* a = nullptr;
  const float* b = nullptr;                      // forward = b - a
  if (calPass == PASS_UP) {
    if (calStep == 0) return false;
    memcpy(prev, calRaw[calStep - 1], 3 * sizeof(float));
    if (calStep >= 2) { a = calRaw[max(calStep - 4, 0)]; b = calRaw[calStep - 1]; }
  } else if (calPass == PASS_DOWN) {
    int j = calStep + 1;                         // the down point above, else (point 24 / not measured) the up one
    memcpy(prev, (calDownMask & (1UL << j)) ? calDown[j] : calRaw[min(j, NUM_GEARS - 1)], 3 * sizeof(float));
    // down the up-pass path, over a few up points around this edge
    a = calRaw[min(calStep + 2, NUM_GEARS - 1)]; b = calRaw[max(calStep - 1, 0)];
  } else {
    return false;
  }
  if (a) {
    float d[3] = { b[0] - a[0], b[1] - a[1], b[2] - a[2] };
    float n = sqrtf(dot3(d, d));
    if (n > 0) { for (int k = 0; k < 3; k++) dir[k] = d[k] / n; *hasDir = true; }
  }
  return true;
}

// The step into the current point: expected (up pass), measured on the way
// up (down pass), or the path's (a redo).
static float calLocalStep() {
  int i = calStep;
  if (calPass == PASS_UP)   return i >= 1 && i < NUM_GEARS ? tol.expStep[i] : 0;
  if (calPass == PASS_DOWN) return dist3(calRaw[min(i + 1, NUM_GEARS - 1)], calRaw[i]);
  int j = calPass == PASS_FIX_UP ? i - 1 : i + 1;
  return dist3(pathPts[i], pathPts[j]);
}

static float tolMove(float step) {
  float m = max(tol.moveMin, (calPass == PASS_DOWN ? MOVE_FRAC_SAME : tol.moveFrac) * step);
  return step > 0 ? min(m, MOVE_CAP_FRAC * step) : m;
}

// Changes between the held turns of a capture: the noise, refined as the passes go.
static void noiseAdd(float d) {
  noisePool[noisePoolIdx] = d;
  noisePoolIdx = (noisePoolIdx + 1) % NOISE_POOL;
  if (noisePoolN < NOISE_POOL) noisePoolN++;
}

static void noiseRefine() {
  if (noisePoolN < NOISE_POOL_MIN) return;
  static float tmp[NOISE_POOL];
  memcpy(tmp, noisePool, noisePoolN * sizeof(float));
  noiseUT = constrain(medianOf(tmp, noisePoolN), NOISE_FLOOR_UT, NOISE_MAX_UT);
  deriveTolerances(false);
}

// Same spot: has the reading got to within max(K_NEAR x noise, NEAR_FRAC x
// step) of where this point was last time (along the pass)? So a pause part-way
// through a gear isn't taken. Held for NEAR_HOLD_TURNS agreeing turns: yes.
static bool calNearStored(const float mean[3], const float dir[3], float step) {
  if (!expHave || agreeRun >= NEAR_HOLD_TURNS) return true;
  const float* e;
  if (calPass == PASS_UP && calStep >= 1 && calStep < NUM_GEARS) e = expUp[calStep];
  else if (calPass == PASS_DOWN && (expDownMask & (1UL << calStep))) e = expDown[calStep];
  else return true;
  float d[3] = { mean[0] - e[0], mean[1] - e[1], mean[2] - e[2] };
  return dot3(d, dir) >= -max(K_NEAR * tol.noise, NEAR_FRAC * step);
}

// Has the reading moved far enough past the previous point, the right way?
// Also sets behindNow (agreeing turns sit behind it: that point overshot) and
// forwardNow (forward of it by at least the noise, but maybe not enough).
static bool calMovedOn(const float mean[3], bool agreeing, bool manual = false) {
  float prev[3], dir[3];
  bool hasDir;
  behindNow = false;
  forwardNow = false;
  if (!calPrevRef(prev, dir, &hasDir)) return true;
  float d[3] = { mean[0] - prev[0], mean[1] - prev[1], mean[2] - prev[2] };
  float dist  = sqrtf(dot3(d, d));
  float along = hasDir ? dot3(d, dir) : dist;
  float step  = calLocalStep();
  float move  = tolMove(step);
  if (agreeing) {                                 // the run of agreeing turns: its mean offset
    if (agreeRun <= 2) { runSum = 0; runN = 0; }
    runSum += along;
    if (runN < 255) runN++;
  }
  bool held   = agreeing && agreeRun >= BEHIND_HOLD_TURNS && runN && runSum / runN <= -tol.behindHeld;
  behindNow   = hasDir && agreeing && (along <= -max(tol.behindMin, tol.behindFrac * step) || held);
  forwardNow  = along >= tol.noise;
  lastDist    = dist;
  float floor_ = tol.moveMin;
  if (manual) return dist >= floor_ && along >= 0.5f * floor_;   // 'n': the noise floor alone
  // New or first spot: the expected step is only a guess from the sweep, so
  // after SOFT_HOLD_TURNS agreeing turns held, a smaller move is enough. Not the
  // noise floor alone (v3.4): a rider who pauses before shifting would save the
  // old gear again (2026-10-17: point 2 at gear 1, 0.75 uT from point 1).
  float soft = max(floor_, SOFT_HOLD_FRAC * step);
  // Held means still: softRun counts turns that barely moved, not agreeing turns from
  // before the rider shifted (a slow lever agrees turn to turn while it moves).
  if (spotKind != SPOT_SAME && calPass == PASS_UP && softRun >= SOFT_HOLD_TURNS &&
      dist >= soft && along >= 0.5f * soft) return true;
  return dist >= move && along >= 0.5f * move && (!hasDir || calNearStored(mean, dir, step));
}

// Agreeing turns sit behind the last point: it was saved too far (the lever
// overshot). Go back to it by itself and ask the rider to drop into the gear
// before it and come back; it is taken again once the reading has gone back
// at least halfway from the point before it (backGate).
// Returns true if it went back (the turn is used up).
static bool calBackUp() {
  bool down = calPass == PASS_DOWN;
  if (backedPass != (int8_t)calPass) { backedMask = 0; backedPass = (int8_t)calPass; }
  int target = down ? calStep + 1 : calStep - 1;
  bool can = backUpOk && (down ? calStep < downStart : calStep >= 2) &&
             !(target >= 0 && target < 32 && (backedMask & (1UL << target)));   // once per point per pass
  if (!can) {                                     // nothing to go back to (or just did): say so, once
    if (!behindSent) {
      behindSent = true;
      Log.println(F("N,behind"));
    }
    return false;
  }
  int bad = down ? calStep + 1 : calStep - 1;
  memcpy(backOld, down ? calDown[bad] : calRaw[bad], sizeof(backOld));
  if (down) {
    calDownMask &= ~(1UL << bad);
    if (calValid) { cal.downMask &= ~(1UL << bad); saveCalibration(); }
  }
  calStep = bad;
  settleTurns = 0;
  int gear = down ? bad : bad + 1;                // the gear whose point is redone
  Log.printf("\nGear %d was saved a little too far %s. Shift %s into gear %d, then back %s to where "
             "the console FIRST shows gear %d.\n", gear, down ? "down" : "up", down ? "UP" : "DOWN",
             down ? gear + 1 : gear - 1, down ? "down" : "up", gear);
  Log.println(F("N,behind"));
  Log.printf(down ? "U,%d,d\n" : "U,%d\n", calStep);
  playNotes(BEEP_UNDO, 3);
  calRedo = true;
  calPrompt();
  backGate = true;                                // after calPrompt(), which clears it
  backUpOk = false;                               // once: never go back again before the next point
  backedMask |= 1UL << bad;                       // ...and never to this point again in this pass
  return true;
}

// Along the way back: the reading's position from the point before this one,
// towards where this one was wrongly saved.
static float calBackAlong(const float avg[3]) {
  float prev[3], dir[3];
  bool hasDir;
  if (!calPrevRef(prev, dir, &hasDir)) return 0;
  float span[3] = { backOld[0] - prev[0], backOld[1] - prev[1], backOld[2] - prev[2] };
  float L = sqrtf(dot3(span, span));
  float d[3] = { avg[0] - prev[0], avg[1] - prev[1], avg[2] - prev[2] };
  return L > 0 ? dot3(d, span) / L : 0;
}

// While backGate: has the reading gone back at least halfway from the point
// before this one to where this one was wrongly saved?
static bool calBackGate(const float avg[3]) {
  float prev[3], dir[3];
  bool hasDir;
  if (!calPrevRef(prev, dir, &hasDir)) { backGate = false; return true; }
  float span[3] = { backOld[0] - prev[0], backOld[1] - prev[1], backOld[2] - prev[2] };
  float L = sqrtf(dot3(span, span));
  if (L <= 0) { backGate = false; return true; }
  float d[3] = { avg[0] - prev[0], avg[1] - prev[1], avg[2] - prev[2] };
  if (dot3(d, span) / L <= 0.5f * L) {
    backGate = false;
    backRising = true;                            // a pause down here must not count as the point
    backMin = dot3(d, span) / L;
    Log.println(F("Now come back to the point and hold it there."));
    turnHistN = 0;
    pendingCap = false;
    stabPct = 0;
    return false;                                 // this turn was on the way back
  }
  stabPct = 0;
  return false;
}

// After going back: turns count only once the reading has come up
// max(riseMin, riseFrac x step) from the lowest it went (a pause in the gear
// below isn't the point).
static bool calBackRise(const float avg[3]) {
  float a = calBackAlong(avg);
  if (a < backMin) backMin = a;
  if (a < backMin + max(tol.riseMin, tol.riseFrac * calLocalStep())) {
    turnHistN = 0;
    pendingCap = false;
    stabPct = 0;
    return false;
  }
  backRising = false;
  return true;
}

// Direction of travel for the "still moving?" check (zero: no check).
static void calTravelDir(const float mean[3], float dir[3]) {
  dir[0] = dir[1] = dir[2] = 0;
  float d[3];
  if (calPass == PASS_FIX_UP || calPass == PASS_FIX_DOWN) {
    int i = calStep, j = calPass == PASS_FIX_UP ? i - 1 : i + 1;
    for (int k = 0; k < 3; k++) d[k] = pathPts[i][k] - pathPts[j][k];
  } else {
    float prev[3], fwd[3];
    bool hasDir;
    if (!calPrevRef(prev, fwd, &hasDir)) return;
    for (int k = 0; k < 3; k++) d[k] = mean[k] - prev[k];
  }
  float n = sqrtf(dot3(d, d));
  if (n > 0) for (int k = 0; k < 3; k++) dir[k] = d[k] / n;
}

// Redoing one point ('#R'), or a down pass started with '#D': it is only
// taken after the reading has been past it (the lower half of the gear below
// for an up point, the upper half of the gear above for a down point) and has
// come back out of there.
static bool calFixGate(const float avg[3]) {
  float off;
  float r = locateOnPath(pathPts, avg, &off);
  int i = calStep;
  bool past = calPass == PASS_FIX_UP ? r < 0.5f * (GEAR_EDGES[i - 1] + GEAR_EDGES[i])
                                     : r > 0.5f * (GEAR_EDGES[i] + GEAR_EDGES[i + 1]);
  if (past) {
    if (!fixArmed) Log.println(F("Now come back to the point and hold it there."));
    fixArmed = true;
    turnHistN = 0;
    pendingCap = false;
    stabPct = 0;
    return false;
  }
  if (!fixArmed) { stabPct = 0; return false; }
  return true;
}

// Calibration while pedalling: each completed turn. Once 2 turns in a row
// agree within tol.agree and have moved on from the previous point, one more
// turn checks the lever has stopped; the point is the average of all 3.
static void calOnTurn(const float avg[3]) {
  if (!crank.ok) return;
  if (calState == CAL_CONFIRM) {                 // still turns at the cadence check: for the noise
    if (noiseN < NOISE_MAX_TURNS) memcpy(noiseBuf[noiseN++], avg, sizeof(noiseBuf[0]));
    return;
  }
  if (calState == CAL_SURVEY) {
    if (!calPaused) surveyOnTurn(avg);
    return;
  }
  if (calState != CAL_WAITING) return;
  if (calPaused) { turnHistN = 0; pendingCap = false; return; }   // phone gone: turns don't count
  if (pauseSkip) {                               // the first turn after a pause never counts
    pauseSkip--;
    turnHistN = 0;
    pendingCap = false;
    return;
  }
  memcpy(lastTurnAvg, avg, sizeof(lastTurnAvg));
  if (settleTurns) {                             // learn how far the lever settles back after a save
    float d[3] = { avg[0] - settleRef[0], avg[1] - settleRef[1], avg[2] - settleRef[2] };
    settleWorst = min(settleWorst, dot3(d, settleDir));
    float x = max(0.0f, -settleWorst);            // more than this: the rider moved, not the lever settling
    if (!--settleTurns && x <= min(SETTLE_MAX_FRAC * settleStep, max(SETTLE_MAX_UT, 4 * tol.noise))) settleAdd(x);
  }
  bool fixing = calPass == PASS_FIX_UP || calPass == PASS_FIX_DOWN;
  if ((fixing || (calPass == PASS_DOWN && downGate)) && !calFixGate(avg)) return;
  if (backGate && !calBackGate(avg)) return;
  if (backRising && !calBackRise(avg)) return;
  // Couldn't settle for a while: stop and let the rider redo or capture anyway.
  uint32_t now = sampleMs;
  if (settleSince && (int32_t)(now - settleSince) >= (int32_t)SETTLE_GIVEUP_MS) {
    calState = CAL_POINT_CHECK;
    pendingCap = false;
    stabPct  = 0;
    Log.printf("\nPoint %d: the reading keeps changing.\n", calStep + 1);
    bool down = calPass == PASS_DOWN || calPass == PASS_FIX_DOWN;
    int gear = down ? calStep : calStep + 1;
    Log.printf("Redo it: send 'u', move the lever %s gear %d, then %s until the console "
               "FIRST shows gear %d and hold.  Or send 'n' / press A to capture it anyway.\n",
               down ? "UP above" : "DOWN below", gear, down ? "down" : "up", gear);
    Log.printf("P,%d\n", calStep + 1);
    playNotes(BEEP_FAIL, 1);
    return;
  }
  if (pendingCap) {                            // the turn after 2 agreed: still moving?
    pendingCap = false;
    float d[3] = { avg[0] - pendingMean[0], avg[1] - pendingMean[1], avg[2] - pendingMean[2] };
    float drift = dot3(d, pendingDir);
    float c[3] = { avg[0] - pendingFirst[0], avg[1] - pendingFirst[1], avg[2] - pendingFirst[2] };
    pendingCreep = dot3(c, pendingDir);
    bool hasDir = pendingDir[0] != 0 || pendingDir[1] != 0 || pendingDir[2] != 0;
    bool suspect = hasDir &&
                   (drift >= tol.drift || (pendingCreep >= tol.creep && drift >= tol.slow));
    if (!suspect) {
      float m[3];
      for (int k = 0; k < 3; k++) m[k] = (pendingMean[k] * turnHistN + avg[k]) / (turnHistN + 1);
      if (dist3(avg, pendingMean) <= tol.agree &&
          (calMovedOn(m, false, pressMode) || (pressMode && pressRefused && lastDist >= STEP_REJECT_UT))) {   // the check turn agrees: average all 3
        stabPct = 100;
        if (turnHistN == 2) {                    // 3 held turns: refine the noise
          noiseAdd(dist3(turnHist[1], turnHist[0]));
          noiseAdd(dist3(avg, turnHist[1]));
          noiseRefine();
        }
        calStorePoint(m);
        return;
      }
      // It disagrees without "still moving": an ordinary turn (below).
    } else {
      // Still changing: drop this capture, ask to hold still, agree afresh
      // starting from this turn (the newest position).
      if (!settleSince) {
        settleSince = now ? now : 1;
        Log.printf("\nPoint %d: the reading is still changing - hold the lever still.\n", calStep + 1);
        playNotes(BEEP_UNDO, 3);
      }
      Log.printf("W,%d,%.1f,%.1f\n", calStep + 1, drift, pendingCreep);
      turnHistN = 0;
      memcpy(turnHist[turnHistN++], avg, sizeof(turnHist[0]));
      agreeRun = 1;
      stabPct = 34;
      return;
    }
  }
  if (turnHistN == 2) {                        // keep the most recent turns
    memmove(turnHist[0], turnHist[1], sizeof(turnHist[0]));
    turnHistN = 1;
  }
  memcpy(turnHist[turnHistN++], avg, sizeof(turnHist[0]));
  // Drop older turns that disagree with the newest.
  while (turnHistN > 1) {
    float spread = 0;
    for (int i = 0; i < turnHistN; i++)
      for (int j = i + 1; j < turnHistN; j++) spread = max(spread, dist3(turnHist[i], turnHist[j]));
    if (spread <= tol.agree) break;
    memmove(turnHist[0], turnHist[1], (turnHistN - 1) * sizeof(turnHist[0]));
    turnHistN--;
  }
  agreeRun = turnHistN == 2 ? (uint8_t)min(agreeRun + 1, 255) : 1;
  softRun = turnHistN == 2 && dist3(turnHist[1], turnHist[0]) <= tol.drift ? (uint8_t)min(softRun + 1, 255) : 0;
  float mean[3];
  turnHistMean(mean);
  bool moved = calMovedOn(mean, turnHistN >= 2);
  if (behindNow && (calPass == PASS_UP || calPass == PASS_DOWN) && calBackUp()) return;
  // Press mode (v3.4): nothing counts until the rider presses; then the
  // noise floor alone (as for 'n') says the lever has left the previous point.
  if (pressMode && !pressArmed) { stabPct = 0; return; }
  // A second press at a refused spot saves it anyway (gears that coincide magnetically), but
  // never closer than STEP_REJECT_UT: two such points would fail the whole calibration.
  if (pressMode) moved = turnHistN < 2 || calMovedOn(mean, false, true) || (pressRefused && lastDist >= STEP_REJECT_UT);
  stabPct = moved ? (turnHistN >= 2 ? 67 : 34) : 0;
  if (pressMode && !moved) {                     // measured at the previous point's spot: not saved
    pressArmed = false;
    if (pressRefused) Log.println(F("Not captured: this spot reads the same as the previous gear. Move the lever a little further, then press."));
    else Log.println(F("Not captured: the lever hasn't moved on from the previous point. Press again to save it here anyway."));
    pressRefused = true;                         // a second press here saves it anyway (gears that coincide)
    Log.println(F("N,notmoved"));
    return;
  }
  if (moved && (autoCapture || pressMode) && turnHistN == 2) {
    // Don't store yet: check one more turn (calOnTurn above).
    memcpy(pendingMean, mean, sizeof(pendingMean));
    calTravelDir(mean, pendingDir);
    memcpy(pendingFirst, turnHist[0], sizeof(pendingFirst));
    pendingCap = true;
  }
}

static void calCapture() {
  if (calState == CAL_CONFIRM) { calConfirm(); return; }   // 'n' / button A also confirms
  if (calState == CAL_SURVEY) { surveyNext(); return; }
  if (calState == CAL_DOWN_READY) {                         // come back down
    Log.println(F("Coming back down."));
    calDownBegin(calStep, false);
    return;
  }
  if (calState == CAL_POINT_CHECK) {                        // capture anyway
    float b[3];
    if (turnHistN > 0) turnHistMean(b); else memcpy(b, lastTurnAvg, sizeof(b));
    Log.println(F("Captured anyway."));
    calStorePoint(b);
    return;
  }
  if (calState != CAL_WAITING) return;
  // Manual captures get the same "the lever moved" check as auto-capture.
  if (crank.ok) {                              // manual capture while pedalling
    if (turnHistN == 0 && !pressMode) {
      Log.println(F("No full pedal turn yet - keep pedalling."));
      Log.println(F("N,noturn"));
      return;
    }
    bool gated = calPass == PASS_FIX_UP || calPass == PASS_FIX_DOWN || (calPass == PASS_DOWN && downGate);
    if ((gated && !fixArmed) || backGate || backRising) {
      Log.println(F("Not captured: first move the lever past this point, then come back."));
      Log.println(F("N,notmoved"));
      return;
    }
    if (pressMode) {                             // measure from the next turns (a new press restarts it)
      pressArmed = true;
      turnHistN = 0;
      pendingCap = false;
      agreeRun = 0;
      stabPct = 0;
      Log.println(F("Measuring: keep pedalling, lever still."));
      Log.println(F("N,press"));
      return;
    }
    float mean[3];
    turnHistMean(mean);
    if (!calMovedOn(mean, false, true)) {
      Log.println(F("Not captured: the lever hasn't moved on from the previous point."));
      Log.println(F("N,notmoved"));
      return;
    }
    calStorePoint(mean);
    return;
  }
  if (calStep > 0 && dist3(fieldUT, calRaw[calStep - 1]) < AUTO_MIN_MOVE_UT) {
    Log.println(F("Not captured: the lever hasn't moved from the previous point."));
    Log.println(F("N,notmoved"));
    return;
  }
  capSum[0] = capSum[1] = capSum[2] = 0;
  capCount = 0;
  calState = CAL_CAPTURING;
}

static void calUndo() {
  if (calState != CAL_POINT_CHECK && calState != CAL_DOWN_READY && calState != CAL_WAITING) return;
  settleTurns = 0;
  if (calState == CAL_POINT_CHECK) {           // redo the point that wouldn't settle
    backUpOk = false;                            // the rider is going back on purpose
    calState = CAL_WAITING;
    calRedo  = true;
    fixArmed = false;                            // a redone point: go past it again first
    Log.printf("Redo point %d.\n", calStep + 1);
    Log.printf(calPass == PASS_DOWN || calPass == PASS_FIX_DOWN ? "U,%d,d\n" : "U,%d\n", calStep);
    playNotes(BEEP_UNDO, 3);
    calPrompt();
    return;
  }
  if (calState == CAL_DOWN_READY) {            // back to up point 24 (saved again when it's taken)
    backUpOk = false;
    calState = CAL_WAITING;
    calPass  = PASS_UP;
    calStep  = NUM_GEARS - 1;
    Log.printf("Undo: back to point %d.\n", calStep + 1);
    Log.printf("U,%d\n", calStep);
    playNotes(BEEP_UNDO, 3);
    calPrompt();
    return;
  }
  if (calState != CAL_WAITING) return;
  if (calPass == PASS_DOWN) {
    if (calStep < downStart) {
      backUpOk = false;
      calStep++;
      calDownMask &= ~(1UL << calStep);
      if (calValid) { cal.downMask &= ~(1UL << calStep); saveCalibration(); }
      Log.printf("Undo: back to coming down to gear %d.\n", calStep);
      Log.printf("U,%d,d\n", calStep);
    } else if (downStart == DOWN_FIRST && !downResumed) {   // back into the up pass, point 24
      backUpOk = false;
      calPass = PASS_UP;
      calStep = NUM_GEARS - 1;
      Log.printf("Undo: back to point %d.\n", calStep + 1);
      Log.printf("U,%d\n", calStep);
    } else {
      return;
    }
    playNotes(BEEP_UNDO, 3);
    calPrompt();
    return;
  }
  if (calPass != PASS_UP || calStep == 0) return;
  backUpOk = false;
  calStep--;
  Log.printf("Undo: back to point %d.\n", calStep + 1);
  Log.printf("U,%d\n", calStep);
  playNotes(BEEP_UNDO, 3);
  calPrompt();
}

// 's': stop the down pass and save its points (at the checkpoint: just stop).
static void calSkipDown() {
  if (calState == CAL_DOWN_READY) {
    calState = CAL_IDLE;
    calPass  = PASS_UP;
    calPaused = false;
    Log.println(F("Saved without the down pass ('#D' does it later)."));
    return;
  }
  if (calPass != PASS_DOWN || (calState != CAL_WAITING && calState != CAL_POINT_CHECK)) return;
  Log.println(F("Saving without the rest of the down pass."));
  calFinishDown();
}

// Auto-capture (no crank magnet): field held steady, and moved away from the previous point.
static void calAutoCheck() {
  if (crank.ok) return;                        // per-turn capture instead
  if (calState != CAL_WAITING) { stabPct = 0; return; }
  if (dist3(fieldUT, stabRef) > AUTO_STABLE_UT) { stabReset(); return; }
  bool moved = calStep == 0 || dist3(fieldUT, calRaw[calStep - 1]) >= AUTO_MIN_MOVE_UT;
  if (!moved) { stabSince = clockMs(); stabPct = 0; return; }
  uint32_t held = clockMs() - stabSince;
  stabPct = held >= AUTO_STABLE_MS ? 100 : (uint8_t)(held * 100 / AUTO_STABLE_MS);
  if (autoCapture && held >= AUTO_STABLE_MS) calCapture();
}

// ---------------------------------------------------------------------------
// Pause (v3.3): steps 2-5 (and a redo) pause while there is no pedal turn for
// CADENCE_TIMEOUT_MS, or, for a calibration started from the phone, while the
// phone is disconnected. Timers freeze (shifted by the paused time), no
// beeps, and the first turn after a pause doesn't count. Run per sample.
// ---------------------------------------------------------------------------
static void updatePause(uint32_t now) {
  bool pausable = crank.ok && (calState == CAL_CONFIRM || calState == CAL_SURVEY || calState == CAL_WAITING ||
                               calState == CAL_POINT_CHECK || calState == CAL_DOWN_READY);
  if (!pausable) { calPaused = false; return; }
  bool lost = calFromBle && phoneConn == BLE_CONN_HANDLE_INVALID;
  if (lost && !phoneLostMs) phoneLostMs = now ? now : 1;
  if (!lost) phoneLostMs = 0;
  bool want = lost || (int32_t)(now - lastTurnMs) > (int32_t)CADENCE_TIMEOUT_MS;
  if (want && !calPaused) {
    calPaused = true;
    pauseStart = now;
    Log.println(lost ? F("Paused: phone disconnected. Reconnect to carry on.")
                     : F("Paused: pedal to continue."));
  } else if (!want && calPaused) {
    uint32_t dt = now - pauseStart;
    if (settleSince) { settleSince += dt; if (!settleSince) settleSince = 1; }
    calPaused = false;
    turnHistN = 0;
    pendingCap = false;
    settleTurns = 0;
    agreeRun = 0;
    runSum = 0;
    runN = 0;
    pauseSkip = 1;
    Log.println(F("Resumed."));
  }
  if (lost && phoneLostMs && (int32_t)(now - phoneLostMs) >= (int32_t)DISCONNECT_GIVEUP_MS) {
    phoneLostMs = 0;
    if (calState == CAL_DOWN_READY) {
      calState = CAL_IDLE;
      calPass  = PASS_UP;
      calPaused = false;
    } else if (calPass == PASS_DOWN && (calState == CAL_WAITING || calState == CAL_POINT_CHECK)) {
      calFinishDown();
    } else {
      calAbort(F("phone disconnected"));
    }
  }
}

// ---------------------------------------------------------------------------
// Paced output (v3.3): 'p', 'k' and the check's F lines go out a few lines per
// loop pass, as the recording dump does, so a slow phone link can't stall the
// loop for seconds.
// ---------------------------------------------------------------------------
static void calPrintCheckLine(int pos);
static bool dumpCalibrationLine(int pos);

// One line of the current job; false when the job is done.
static bool outLine() {
  switch (outJob) {
    case JOB_P: return printCalibrationLine(outPos++);
    case JOB_K:
      if (dumpCalibrationLine(outPos++)) return true;
      if (!calValid) return false;                // 'Q,none' only
      outJob = JOB_F;                             // then the check's result
      outPos = 0;
      wantF = false;
      return true;
    case JOB_F:
      if (outPos > suspectN) return false;
      calPrintCheckLine(outPos++);
      return true;
    default: return false;
  }
}

static void outStep() {
  if (outJob == JOB_NONE) {
    if (wantP)      { outJob = JOB_P; wantP = false; }
    else if (wantK) { outJob = JOB_K; wantK = false; }
    else if (wantF) { outJob = JOB_F; wantF = false; }
    else return;
    outPos = 0;
  }
  for (uint8_t n = 0; n < OUT_LINES_PER_PASS && outJob != JOB_NONE; n++) {
    if (!outLine()) outJob = JOB_NONE;
  }
}

// Stored calibration as machine-readable Q lines (command 'k'), one per call.
static bool dumpCalibrationLine(int pos) {
  if (!calValid) {
    if (pos == 0) { Log.println(F("Q,none")); return true; }
    return false;
  }
  if (pos <= NUM_GEARS) {
    Log.printf("Q,%d,%.1f,%.1f,%.1f\n", pos + 1, cal.pts[pos][0], cal.pts[pos][1], cal.pts[pos][2]);
    return true;
  }
  pos -= NUM_GEARS + 1;                           // down points 2..24 (only those measured)
  for (int i = 1, k = 0; i < NUM_GEARS; i++) {
    if (!(cal.downMask & (1UL << i))) continue;
    if (k++ == pos) {
      Log.printf("Q,down,%d,%.1f,%.1f,%.1f\n", i + 1, cal.down[i][0], cal.down[i][1], cal.down[i][2]);
      return true;
    }
  }
  pos -= __builtin_popcount(cal.downMask & (((1UL << NUM_GEARS) - 1) & ~1UL));
  int crankLines = cal.crankOk ? 1 : 0;
  if (pos < crankLines) {
    Log.printf("Q,crank,%.4f,%.4f,%.4f,%.1f,%d\n", cal.crankU[0], cal.crankU[1], cal.crankU[2],
               cal.crankDepth, cal.crankSign);
    return true;
  }
  if (pos == crankLines) {
    float span = 0, minStep = 1e9f;
    int   minStepAt = 1;
    for (int i = 1; i <= NUM_GEARS; i++) {
      float step = dist3(cal.pts[i], cal.pts[i - 1]);
      span += step;
      if (step < minStep) { minStep = step; minStepAt = i; }
    }
    Log.printf("Q,end,%.1f,%.2f,%d\n", span, minStep, minStepAt);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The check after a save: points that don't fit, each with a best guess
// (bench/NOTES.md, "post-calibration study"). Keiser's gears are unevenly
// spaced in the field, so the spacing itself is never judged; what is:
//   shape    an up point off the smooth curve through its neighbours
//   offpath  a down point off the up path
//   pair     an edge whose up/down offset differs from the usual one
//   behind   a point not past the one before it (in its pass)
//   prior    an up point that moved from the previous calibration
// One suspect at a time: the worst is set aside and everything is scored
// again without it, so one bad point doesn't make its neighbours look bad.
// Nothing is changed by itself: the rider redoes a point or takes the guess.
// ---------------------------------------------------------------------------
static const int CHK_LAST = NUM_GEARS - 1;       // point 24; the top is worked out

static float medianOf(float* v, int n) {
  for (int i = 1; i < n; i++) {                  // insertion sort, n <= 24
    float x = v[i];
    int j = i - 1;
    while (j >= 0 && v[j] > x) { v[j + 1] = v[j]; j--; }
    v[j + 1] = x;
  }
  return n ? (n % 2 ? v[n / 2] : 0.5f * (v[n / 2 - 1] + v[n / 2])) : 0;
}

// Point i of p interpolated between its nearest good neighbours (lo..hi),
// in proportion to Keiser's gear table. False if there is no good pair.
static bool interpPoint(const float p[][3], const bool good[], int lo, int hi, int i, float out[3]) {
  int a = i - 1, b = i + 1;
  while (a >= lo && !good[a]) a--;
  while (b <= hi && !good[b]) b++;
  if (a < lo || b > hi) return false;
  float f = (GEAR_EDGES[i] - GEAR_EDGES[a]) / (GEAR_EDGES[b] - GEAR_EDGES[a]);
  for (int k = 0; k < 3; k++) out[k] = p[a][k] + f * (p[b][k] - p[a][k]);
  return true;
}

// Unit direction from p[a] to p[b].
static void unitDir(const float p[][3], int a, int b, float dir[3]) {
  float d[3] = { p[b][0] - p[a][0], p[b][1] - p[a][1], p[b][2] - p[a][2] };
  float n = sqrtf(dot3(d, d));
  for (int k = 0; k < 3; k++) dir[k] = n > 0 ? d[k] / n : 0;
}

// The up path's direction at point i, from its nearest good neighbours.
static void chkTangent(const bool* good, int i, float t[3]) {
  int a = i - 1, b = i + 1;
  while (a >= 0 && !good[a]) a--;
  while (b <= CHK_LAST && !good[b]) b++;
  unitDir(cal.pts, a < 0 ? i : a, b > CHK_LAST ? i : b, t);
}

// How far up point i is from a quadratic through up to 2 good neighbours on
// each side (not using i itself); *chord = the gap it sits in. The curve's
// parameter is the distance along those neighbours, centred and scaled so the
// float32 sums stay well conditioned.
static float chkShape(const bool* good, int i, float* chord) {
  const float (*P)[3] = cal.pts;
  int L[2], nl = 0, R[2], nr = 0;
  for (int j = i - 1; j >= 0 && nl < 2; j--) if (good[j]) L[nl++] = j;
  for (int j = i + 1; j <= CHK_LAST && nr < 2; j++) if (good[j]) R[nr++] = j;
  *chord = 0;
  if (!nl || !nr) return 0;
  int idx[4], n = 0;
  for (int k = nl - 1; k >= 0; k--) idx[n++] = L[k];
  int iL = n - 1;
  for (int k = 0; k < nr; k++) idx[n++] = R[k];
  *chord = dist3(P[R[0]], P[L[0]]);
  if (n < 3) return distToSegment(P[i], P[L[0]], P[R[0]], nullptr);
  float x[4], mean = 0;
  x[0] = 0;
  for (int k = 1; k < n; k++) x[k] = x[k - 1] + dist3(P[idx[k]], P[idx[k - 1]]);
  for (int k = 0; k < n; k++) mean += x[k] / n;
  float sc = 0.5f * (x[n - 1] - x[0]);
  if (sc <= 0) return distToSegment(P[i], P[L[0]], P[R[0]], nullptr);
  for (int k = 0; k < n; k++) x[k] = (x[k] - mean) / sc;
  // least squares: [1 x x^2] c = P, per axis (normal equations, 3x3)
  float M[3][6] = {{0}};                         // [A^T A | A^T P]
  for (int k = 0; k < n; k++) {
    float f[3] = { 1, x[k], x[k] * x[k] };
    for (int a = 0; a < 3; a++) {
      for (int b = 0; b < 3; b++) M[a][b] += f[a] * f[b];
      for (int ax = 0; ax < 3; ax++) M[a][3 + ax] += f[a] * P[idx[k]][ax];
    }
  }
  for (int c = 0; c < 3; c++) {                  // Gauss-Jordan, partial pivoting
    int piv = c;
    for (int r = c + 1; r < 3; r++) if (fabsf(M[r][c]) > fabsf(M[piv][c])) piv = r;
    if (fabsf(M[piv][c]) < 1e-6f) return distToSegment(P[i], P[L[0]], P[R[0]], nullptr);
    if (piv != c) for (int k = 0; k < 6; k++) { float t = M[c][k]; M[c][k] = M[piv][k]; M[piv][k] = t; }
    float inv = 1.0f / M[c][c];
    for (int k = 0; k < 6; k++) M[c][k] *= inv;
    for (int r = 0; r < 3; r++) {
      if (r == c) continue;
      float f = M[r][c];
      for (int k = 0; k < 6; k++) M[r][k] -= f * M[c][k];
    }
  }
  // closest of 41 points on the curve between the two neighbours around i
  float best2 = 1e30f;
  for (int s = 0; s <= 40; s++) {
    float u = x[iL] + (x[iL + 1] - x[iL]) * s / 40.0f;
    float d2 = 0;
    for (int ax = 0; ax < 3; ax++) {
      float c = M[0][3 + ax] + u * (M[1][3 + ax] + u * M[2][3 + ax]) - P[i][ax];
      d2 += c * c;
    }
    best2 = min(best2, d2);
  }
  return sqrtf(best2);
}

// Distance of b from the polyline through the good up points.
static float chkOffUp(const bool* good, const float b[3]) {
  float best = 1e30f;
  int prev = -1;
  for (int j = 0; j <= CHK_LAST; j++) {
    if (!good[j]) continue;
    if (prev >= 0) best = min(best, distToSegment(b, cal.pts[prev], cal.pts[j], nullptr));
    prev = j;
  }
  return best;
}

// Working state of one check (static: kept off the loop stack).
static bool        chkGU[NUM_GEARS + 1], chkGD[NUM_GEARS + 1];
static const char* chkExU[NUM_GEARS + 1];
static const char* chkExD[NUM_GEARS + 1];
static bool        chkExP[NUM_GEARS + 1];
static bool        chkHasDev[NUM_GEARS + 1];
static float       chkDev[NUM_GEARS + 1], chkT[NUM_GEARS + 1][3];
static bool        chkHasPair[NUM_GEARS + 1];     // edge i has a good up/down pair this round
static float       chkS[NUM_GEARS + 1], chkQ[NUM_GEARS + 1];   // its gap along / across the path
static bool        chkHaveSmed;                    // enough pairs to judge them
static ChkViol     chkVU[NUM_GEARS], chkVD[NUM_GEARS];
// Limits for this calibration (chkLimits(): from its noise; the v3.2 values are the floors).
// Per point: the v3.2 floors, but never more than a share of the usual step
// around it (a weak signal has small steps), nor less than a multiple of the noise.
static float       chkLimOrder[NUM_GEARS + 1], chkLimShape[NUM_GEARS + 1], chkLimOff[NUM_GEARS + 1],
                   chkLimPair[NUM_GEARS + 1], chkLimPrior;

static void chkLimits() {
  float n = max(NOISE_FLOOR_UT, cal.noiseUT > 0 ? cal.noiseUT : NOISE_DEFAULT_UT);
  for (int i = 0; i <= NUM_GEARS; i++) {
    float t[6];
    int k = 0;
    for (int m = max(0, i - 3); m < min(CHK_LAST, i + 3); m++) t[k++] = dist3(cal.pts[m + 1], cal.pts[m]);
    float c = medianOf(t, k);
    chkLimOrder[i] = max(min(CHECK_ORDER_UT, K_ORDER_STEP * c), K_ORDER * n);
    chkLimShape[i] = max(min(CHECK_SHAPE_UT, K_SHAPE_STEP * c), K_SHAPE * n);
    chkLimOff[i]   = max(min(CHECK_OFF_UT, K_OFF_STEP * c), K_OFF * n);
    chkLimPair[i]  = max(min(PAIR_MIN, K_PAIR_STEP * c), K_PAIR * n);
  }
  chkLimPrior = K_PRIOR * n;
}

// The median of v[] over the up-to-PAIR_NEIGHBOURS nearest other edges with a
// good pair (nearest first, the lower one first on a tie): the usual up/down
// gap around edge i. On the bike it runs 0.7-9.4 uT, about 1x the local step,
// so each edge is judged against its neighbours rather than one figure.
static float chkLocalMedian(const float* v, int i) {
  float t[PAIR_NEIGHBOURS];
  int n = 0;
  for (int d = 1; d <= DOWN_FIRST && n < PAIR_NEIGHBOURS; d++) {
    if (i - d >= 1 && chkHasPair[i - d]) t[n++] = v[i - d];
    if (n < PAIR_NEIGHBOURS && i + d <= DOWN_FIRST && chkHasPair[i + d]) t[n++] = v[i + d];
  }
  return n ? medianOf(t, n) : 0;
}

// Order violations among the good points of p (up: sign +1, lo..hi rising;
// down: sign -1, hi..lo): consecutive good points (h then i) where i is not
// chkLimOrder[i] past h along the up path.
static int chkOrder(const float p[][3], const bool* good, int lo, int hi, int sign, ChkViol* out) {
  int n = 0, h = -1;
  for (int j = 0; j <= hi - lo; j++) {
    int i = sign > 0 ? lo + j : hi - j;
    if (!good[i]) continue;
    if (h >= 0) {
      float d[3];
      unitDir(cal.pts, constrain(min(h, i) - 1, 0, CHK_LAST), constrain(max(h, i) + 1, 0, CHK_LAST), d);
      float v[3] = { p[i][0] - p[h][0], p[i][1] - p[h][1], p[i][2] - p[h][2] };
      float x = sign * dot3(v, d);
      if (x < chkLimOrder[i]) out[n++] = { (uint8_t)h, (uint8_t)i, 1.0f + (chkLimOrder[i] - x) };
    }
    h = i;
  }
  return n;
}

// Score everything with the current exclusions; the worst candidate (score
// above 1) comes back in *pass ('u', 'd' or 'p' = the pair), *idx, *why.
static bool chkRound(char* pass, int* idx, const char** why) {
  for (int i = 0; i <= NUM_GEARS; i++) {
    chkGU[i] = i <= CHK_LAST && !chkExU[i] && !chkExP[i];
    chkGD[i] = (cal.downMask & (1UL << i)) && i >= 1 && i <= DOWN_FIRST && !chkExD[i] && !chkExP[i];
    chkHasDev[i] = false;
  }
  float best = 1.0f;
  bool found = false;
  auto consider = [&](float sc, char ps, int i, const char* w) {
    if (sc > best) { best = sc; *pass = ps; *idx = i; *why = w; found = true; }
  };
  // shape: up points off the curve through their neighbours
  for (int i = 1; i <= CHK_LAST; i++) {
    if (!chkGU[i]) continue;
    float chord, r = chkShape(chkGU, i, &chord);
    float thr = chkLimShape[i] + CHECK_SHAPE_FRAC * chord;
    if (r > thr) consider(r / thr, 'u', i, "offpath");
  }
  // up/down pairs: offset along the path (s) and across it (q)
  static float q[NUM_GEARS + 1], tmp[NUM_GEARS + 1];
  float* s = chkS;
  int np = 0;
  for (int i = 1; i <= DOWN_FIRST; i++) {
    chkHasPair[i] = chkGU[i] && chkGD[i];
    if (!chkHasPair[i]) continue;
    chkTangent(chkGU, i, chkT[i]);
    float o[3] = { cal.pts[i][0] - cal.down[i][0], cal.pts[i][1] - cal.down[i][1], cal.pts[i][2] - cal.down[i][2] };
    s[i] = dot3(o, chkT[i]);
    float r[3] = { o[0] - s[i] * chkT[i][0], o[1] - s[i] * chkT[i][1], o[2] - s[i] * chkT[i][2] };
    q[i] = chkQ[i] = sqrtf(dot3(r, r));
    tmp[np++] = q[i];
  }
  chkHaveSmed = np >= CHECK_MIN_PAIRS;
  // down points off the up path: on the bike every down point sits 1.5-3.5 uT
  // across the up path, so the limit is the usual cross offset plus a margin
  float medQ = chkHaveSmed ? medianOf(tmp, np) : 0;
  for (int i = 1; i <= DOWN_FIRST; i++) {
    if (!chkGD[i]) continue;
    float offLim = chkHaveSmed ? max(chkLimOff[i], medQ + chkLimPair[i]) : chkLimOff[i];
    float d = chkOffUp(chkGU, cal.down[i]);
    if (d > offLim) consider(d / offLim, 'd', i, "offpath");
  }
  // each pair against the usual gap (along) and cross offset near it
  static float devq[NUM_GEARS + 1];
  if (chkHaveSmed) {
    for (int i = 1; i <= DOWN_FIRST; i++) {
      if (!chkHasPair[i]) continue;
      float sm = chkLocalMedian(chkS, i), qm = chkLocalMedian(chkQ, i);
      float w = (i == 1 || i == DOWN_FIRST) ? PAIR_END_WIDEN : 1.0f;
      chkDev[i] = (s[i] - sm) / (w * max(chkLimPair[i], PAIR_FRAC * fabsf(sm)));
      devq[i]   = (q[i] - qm) / (w * max(chkLimPair[i], PAIR_FRAC * qm));
      chkHasDev[i] = true;
    }
  }
  // order (computed before the pairs use it for blame)
  int nvu = chkOrder(cal.pts, chkGU, 0, CHK_LAST, +1, chkVU);
  int nvd = cal.downMask ? chkOrder(cal.down, chkGD, 1, DOWN_FIRST, -1, chkVD) : 0;
  auto inViol = [](const ChkViol* v, int n, int i) {
    for (int k = 0; k < n; k++) if (v[k].h == i || v[k].i == i) return true;
    return false;
  };
  for (int i = 1; i <= DOWN_FIRST; i++) {
    if (!chkHasPair[i]) continue;
    float sc = chkHasDev[i] ? max(fabsf(chkDev[i]), devq[i]) : 0.0f;
    if (sc <= 1) continue;
    bool iu = inViol(chkVU, nvu, i), id = inViol(chkVD, nvd, i);
    if (iu && !id) { consider(sc, 'u', i, "updown"); continue; }
    if (id && !iu) { consider(sc, 'd', i, "updown"); continue; }
    float gu[3], gd[3];                          // which one fits its own pass worse?
    float eu = 0, ed = 0;
    if (interpPoint(cal.pts, chkGU, 0, CHK_LAST, i, gu)) {
      float v[3] = { cal.pts[i][0] - gu[0], cal.pts[i][1] - gu[1], cal.pts[i][2] - gu[2] };
      eu = fabsf(dot3(v, chkT[i]));
    }
    if (interpPoint(cal.down, chkGD, 1, DOWN_FIRST, i, gd)) {
      float v[3] = { cal.down[i][0] - gd[0], cal.down[i][1] - gd[1], cal.down[i][2] - gd[2] };
      ed = fabsf(dot3(v, chkT[i]));
    }
    if (eu > CHECK_BLAME_RATIO * ed)      consider(sc, 'u', i, "updown");
    else if (ed > CHECK_BLAME_RATIO * eu) consider(sc, 'd', i, "updown");
    else                                  consider(sc, 'p', i, "pair");
  }
  for (int k = 0; k < nvu; k++) {
    int h = chkVU[k].h, i = chkVU[k].i, j;
    if (chkHasDev[h] && chkHasDev[i]) {
      j = fabsf(chkDev[h]) > fabsf(chkDev[i]) ? h : i;
    } else {                                     // the later one, unless the step into h overshot
      int g = -1;
      for (int m = 0; m < h; m++) if (chkGU[m]) g = m;
      float steps[8];
      int n = 0;
      for (int m = max(0, h - 3); m < min(CHK_LAST, i + 3) && n < 8; m++)
        if (m != h && m != g && chkGU[m] && chkGU[m + 1]) steps[n++] = dist3(cal.pts[m + 1], cal.pts[m]);
      bool over = n >= 2 && g >= 0 && dist3(cal.pts[h], cal.pts[g]) > CHECK_OVERSHOOT * medianOf(steps, n);
      j = over ? h : i;
    }
    consider(chkVU[k].sc, 'u', j, "behind");
  }
  for (int k = 0; k < nvd; k++) {
    int h = chkVD[k].h, i = chkVD[k].i;
    int j = (chkHasDev[h] && chkHasDev[i]) ? (fabsf(chkDev[h]) > fabsf(chkDev[i]) ? h : i) : i;
    consider(chkVD[k].sc, 'd', j, "behind");
  }
  return found;
}

static bool pairFlagged(int i) {                // the check flagged point i+1, going up or coming down
  for (uint8_t n = 0; n < suspectN; n++) if (suspects[n].point == i + 1) return true;
  return false;
}

static void addSuspect(char pass, int i, const char* why, const float guess[3]) {
  if (suspectN >= MAX_SUSPECTS) return;
  Suspect& s = suspects[suspectN++];
  s.pass = pass;
  s.point = (uint8_t)(i + 1);
  s.why = why;
  memcpy(s.guess, guess, sizeof(s.guess));
}

// Up points that moved from the previous calibration (after its overall
// shift) by more than max(chkLimPrior, PRIOR_FRAC x the local step), one at a
// time. If more than PRIOR_MAX would be flagged, the board has probably been
// moved: the comparison is dropped. (A new spot has no previous calibration.)
static void chkPrior() {
  if (!prevValid) return;
  static bool bad[NUM_GEARS + 1];
  static float tmp[3][NUM_GEARS + 1];
  float shift[3] = {0, 0, 0};
  for (int i = 0; i <= CHK_LAST; i++) bad[i] = !chkGU[i];   // already flagged by the main check
  bool settled = false;
  for (int round = 0; round <= PRIOR_MAX; round++) {
    int n = 0;
    for (int i = 0; i <= CHK_LAST; i++) {
      if (bad[i]) continue;
      for (int k = 0; k < 3; k++) tmp[k][n] = cal.pts[i][k] - prevPts[i][k];
      n++;
    }
    for (int k = 0; k < 3; k++) shift[k] = medianOf(tmp[k], n);
    float worst = 0;
    int wi = -1;
    for (int i = 1; i <= CHK_LAST; i++) {
      if (bad[i]) continue;
      float r[3] = { cal.pts[i][0] - prevPts[i][0] - shift[0], cal.pts[i][1] - prevPts[i][1] - shift[1],
                     cal.pts[i][2] - prevPts[i][2] - shift[2] };
      float d = sqrtf(dot3(r, r)) / max(chkLimPrior, PRIOR_FRAC * localStep(cal.pts, i));
      if (d > worst) { worst = d; wi = i; }
    }
    if (worst <= 1.0f) { settled = true; break; }
    if (round == PRIOR_MAX) break;
    bad[wi] = true;
    chkExU[wi] = "prior";
  }
  if (!settled) {                                 // too different: the board was probably moved
    for (int i = 0; i <= CHK_LAST; i++) if (chkExU[i] && !strcmp(chkExU[i], "prior")) chkExU[i] = nullptr;
    Serial.println(F("Check: very different from the previous calibration (board moved?) - not compared."));
  }
}

// The guess for a prior-flagged point: placed between its good neighbours in
// this calibration as it was in the previous one.
static void chkPriorGuess(int i, float g[3]) {
  int a = -1, b = -1;
  for (int j = i - 1; j >= 0; j--) if (chkGU[j] && !chkExU[j]) { a = j; break; }
  for (int j = i + 1; j <= CHK_LAST; j++) if (chkGU[j] && !chkExU[j]) { b = j; break; }
  if (a < 0 || b < 0) { memcpy(g, cal.pts[i], 3 * sizeof(float)); return; }
  float da = dist3(prevPts[i], prevPts[a]), db = dist3(prevPts[b], prevPts[i]);
  float f = da + db > 0 ? da / (da + db) : 0.5f;
  for (int k = 0; k < 3; k++) g[k] = cal.pts[a][k] + f * (cal.pts[b][k] - cal.pts[a][k]);
}

// The latest check's results as F lines (and readable lines on USB), one per
// call (paced from loop()): suspect pos, then F,end at pos == suspectN.
static void calPrintCheckLine(int pos) {
  if (!calValid) { if (pos == 0) Log.println(F("F,end,0")); return; }
  if (pos < suspectN) {
    const Suspect& s = suspects[pos];
    const char* what = !strcmp(s.why, "behind") ? "isn't past the gear before it"
                     : !strcmp(s.why, "offpath") ? "is off the path the other points make"
                     : !strcmp(s.why, "prior") ? "moved since the last calibration"
                     : "doesn't match its other reading";
    Serial.printf("Check: gear %d (%s) %s. Best guess (%.1f, %.1f, %.1f). Redo: '#R,%c,%d'  use the guess: '#G,%c,%d'\n",
                  s.pass == 'u' ? s.point : s.point - 1, s.pass == 'u' ? "going up" : "coming down", what,
                  s.guess[0], s.guess[1], s.guess[2], s.pass, s.point, s.pass, s.point);
    Log.printf("F,%c,%d,%s,%.1f,%.1f,%.1f\n", s.pass, s.point, s.why, s.guess[0], s.guess[1], s.guess[2]);
    return;
  }
  if (pos > suspectN) return;
  if (!suspectN) Serial.println(F("Check: all points fit."));
  Log.printf("F,end,%u\n", suspectN);
}

// Run the check (from loop() after a save, and at boot); the F lines after a
// save and 'k' send its result.
static void calCheck() {
  suspectN = 0;
  if (!calValid) return;
  chkLimits();
  for (int i = 0; i <= NUM_GEARS; i++) { chkExU[i] = chkExD[i] = nullptr; chkExP[i] = false; }
  char pass;
  int idx;
  const char* why;
  for (int r = 0; r < CHECK_MAX_ROUNDS && chkRound(&pass, &idx, &why); r++) {
    if (pass == 'u') chkExU[idx] = why;
    else if (pass == 'd') chkExD[idx] = why;
    else chkExP[idx] = true;
  }
  chkRound(&pass, &idx, &why);                    // the good sets and the usual offset, final
  chkPrior();

  // Guesses: the other pass's reading shifted by the usual offset near it,
  // else in proportion between good neighbours.
  for (int i = 1; i <= CHK_LAST; i++) {
    if (!chkExU[i]) continue;
    float g[3], t[3];
    float sm = chkHaveSmed ? chkLocalMedian(chkS, i) : 0;
    chkTangent(chkGU, i, t);
    if (!strcmp(chkExU[i], "prior")) chkPriorGuess(i, g);
    else if (chkHaveSmed && chkGD[i]) for (int k = 0; k < 3; k++) g[k] = cal.down[i][k] + sm * t[k];
    else if (!interpPoint(cal.pts, chkGU, 0, CHK_LAST, i, g)) memcpy(g, cal.pts[i], sizeof(g));
    addSuspect('u', i, chkExU[i], g);
  }
  for (int i = 1; i <= DOWN_FIRST; i++) {
    if (!chkExD[i]) continue;
    float g[3], t[3];
    float sm = chkHaveSmed ? chkLocalMedian(chkS, i) : 0;
    chkTangent(chkGU, i, t);
    if (chkHaveSmed && chkGU[i]) {
      for (int k = 0; k < 3; k++) g[k] = cal.pts[i][k] - sm * t[k];
    } else if (!interpPoint(cal.down, chkGD, 1, DOWN_FIRST, i, g)) {
      float gu[3];
      if (interpPoint(cal.pts, chkGU, 0, CHK_LAST, i, gu)) for (int k = 0; k < 3; k++) g[k] = gu[k] - sm * t[k];
      else memcpy(g, cal.down[i], sizeof(g));
    }
    addSuspect('d', i, chkExD[i], g);
  }
  for (int i = 1; i <= DOWN_FIRST; i++) {
    if (!chkExP[i]) continue;
    float t[3], gu[3], gd[3];
    float sm = chkHaveSmed ? chkLocalMedian(chkS, i) : 0;
    chkTangent(chkGU, i, t);
    for (int k = 0; k < 3; k++) { gu[k] = cal.down[i][k] + sm * t[k]; gd[k] = cal.pts[i][k] - sm * t[k]; }
    addSuspect('u', i, "pair", gu);
    addSuspect('d', i, "pair", gd);
  }
}

// =========================================================================
// Diagnostics recording: 25 Hz raw field + crank revs into RAM, sent on 'y'
// =========================================================================
static void recStart() {
  recCount = 0;
  recMarkerCount = 0;
  recHalf = false;
  dumpPos = -1;
  recording = true;
  recStartMs = recLastMs = millis();
  Log.printf("G,start,%u,%u\n", REC_CAPACITY, (unsigned)(SAMPLE_PERIOD_MS * 2));
}

static void recStop(bool full) {
  if (!recording) return;
  recording = false;
  recEndMs = millis();
  Log.printf("G,%s,%u,%lu\n", full ? "full" : "stop", recCount,
             (unsigned long)(recEndMs - recStartMs));
}

static void recMark() {
  if (!recording || recMarkerCount >= REC_MAX_MARKERS) return;
  recMarkers[recMarkerCount++] = recCount;
  Log.printf("M,%u,%u\n", recMarkerCount, recCount);
}

static int16_t toDeci(float uT) {
  return (int16_t)constrain(lroundf(uT * 10.0f), -32767L, 32767L);
}

static void recOnSample(const float raw[3], uint32_t now) {
  if (!recording) return;
  if (!recHalf) {
    memcpy(recPair, raw, sizeof(recPair));
    recHalf = true;
    return;
  }
  recHalf = false;
  for (int k = 0; k < 3; k++) recXYZ[recCount][k] = toDeci((recPair[k] + raw[k]) * 0.5f);
  bool valid; uint16_t revs;
  if (crank.ok) {
    valid = selfRevs > 0; revs = selfRevs;
  } else {
    taskENTER_CRITICAL();
    valid = crankValid; revs = crankRevs;
    taskEXIT_CRITICAL();
  }
  recRevs[recCount] = valid ? revs : 0xFFFF;
  recDt[recCount] = recCount == 0 ? 0 : (uint8_t)min(now - recLastMs, (uint32_t)255);
  recLastMs = now;
  if (++recCount >= REC_CAPACITY) recStop(true);
}

static void recDumpStart() {
  if (recording) recStop(false);
  Log.printf("Y,begin,%u,%u,%u\n", recCount, (unsigned)(SAMPLE_PERIOD_MS * 2), recMarkerCount);
  for (uint8_t k = 0; k < recMarkerCount; k++) {
    Log.printf("Y,m,%u,%u\n", k + 1, recMarkers[k]);
  }
  dumpPos = 0;
}

// Called every loop pass: sends a few D lines at a time so loop() keeps
// running (and the watchdog stays fed) during a long send.
static void recDumpStep() {
  if (dumpPos < 0) return;
  for (uint8_t n = 0; n < DUMP_LINES_PER_PASS && dumpPos < recCount; n++, dumpPos++) {
    const int16_t* s = recXYZ[dumpPos];
    int revs = recRevs[dumpPos] == 0xFFFF ? -1 : recRevs[dumpPos];
    Log.printf("D,%d,%d,%d,%d,%u\n", s[0], s[1], s[2], revs, recDt[dumpPos]);
  }
  if (dumpPos >= recCount) {
    int32_t sum = 0;
    for (uint16_t i = 0; i < recCount; i++) sum += recXYZ[i][0] + recXYZ[i][1] + recXYZ[i][2];
    uint32_t checksum = (uint32_t)(((sum % 65536) + 65536) % 65536);
    Log.printf("Y,end,%u,%lu\n", recCount, (unsigned long)checksum);
    dumpPos = -1;
  }
}

// =========================================================================
// Gear: locate a field reading along the calibrated path, then hysteresis
// (and, for per-sample updates, a dwell time)
// =========================================================================
static void updateGear(const float b[3], uint32_t now, bool useDwell) {
  float off;
  float res = locateOnPath(pathPts, b, &off);
  offPath = off;
  if (off > tol.offHold) {
    if (!offPathHold) { offPathHold = true; offPathSince = now; }
    if (now - offPathSince < OFFPATH_HOLD_MAX_MS) return;   // keep last gear
  } else {
    offPathHold = false;
  }
  resistance = res;

  // At each edge the console's switch points going up and coming down (buildPath).
  int candidate = stableGear;
  while (candidate < NUM_GEARS && resistance >= edgeUpR[candidate]) candidate++;
  while (candidate > 1 && resistance < edgeDownR[candidate - 1]) candidate--;
  if (!useDwell) {                              // per-turn: already averaged
    stableGear = pendingGear = candidate;
    return;
  }
  if (candidate == stableGear) {
    pendingGear = stableGear;
  } else if (candidate != pendingGear) {
    pendingGear = candidate;
    pendingSince = now;
  } else if (now - pendingSince >= GEAR_DWELL_MS) {
    stableGear = candidate;
  }
}

// A turn boundary (result 1 or 2 from crankSample).
static void placeOnTurn(const float avg[3]);

static void onTurnBoundary(int result, const float avg[3], uint32_t periodMs, uint32_t now) {
  selfRevs++;
  selfEventMs = now;
  lastTurnMs = now;
  lastDip = crDipMax;                           // the dip just finished
  if (result != 2) {                            // first turn after a pause
    selfPeriods[0] = selfPeriods[1] = 0;
    return;
  }
  selfPeriods[1] = selfPeriods[0];
  selfPeriods[0] = periodMs;
  placeOnTurn(avg);
  calOnTurn(avg);
  if (calValid && cal.crankOk) updateGear(avg, now, false);
  if (turnStream) {
    Serial.printf("T,%lu,%lu,%.1f,%.1f,%.1f,%d,%.1f\n", (unsigned long)now, (unsigned long)periodMs,
               avg[0], avg[1], avg[2], calValid ? stableGear : 0, resistance);
  }
}

// =========================================================================
// Sensor pipeline: raw -> (crank mode) turn detector -> per-turn average
//                      -> (no crank) median -> EMA -> path position -> gear
// =========================================================================
// Sensor task: the only code that talks to the magnetometer after setup().
// Reads at a fixed rate and queues each reading with its time, so nothing
// the loop does (e.g. waiting on Bluetooth) can skip or skew readings.
static void sensorTask(void*) {
  TickType_t wake = xTaskGetTickCount();
  const TickType_t period = pdMS_TO_TICKS(SAMPLE_PERIOD_MS);
  for (;;) {
    vTaskDelayUntil(&wake, period);
    Sample smp;
    lis3mdl.read();
    smp.ms  = millis();
    smp.sat = abs(lis3mdl.x) > SATURATION_RAW || abs(lis3mdl.y) > SATURATION_RAW ||
              abs(lis3mdl.z) > SATURATION_RAW;
    smp.raw[0] = lis3mdl.x_gauss * 100.0f;          // gauss -> microtesla
    smp.raw[1] = lis3mdl.y_gauss * 100.0f;
    smp.raw[2] = lis3mdl.z_gauss * 100.0f;
    if (xQueueSend(sampleQueue, &smp, 0) != pdTRUE) sampleDrops++;
  }
}

// ---------------------------------------------------------------------------
// Placement meters ('v', X lines): field, lever swing since 'v', crank dip,
// headroom to saturation, and a live noise figure.
// ---------------------------------------------------------------------------
static void placeExtend(const float b[3]) {
  if (!placeHave) { memcpy(placeMin, b, sizeof(placeMin)); memcpy(placeMax, b, sizeof(placeMax)); placeHave = true; }
  for (int k = 0; k < 3; k++) { placeMin[k] = min(placeMin[k], b[k]); placeMax[k] = max(placeMax[k], b[k]); }
}

static void placeOnSample(const float raw[3], uint32_t ms) {
  if (!slowSeeded) { memcpy(slowField, raw, sizeof(slowField)); slowSeeded = true; hpStart = ms; }
  const float a = SAMPLE_PERIOD_MS / 1000.0f;   // ~1 s average
  float hp[3];
  for (int k = 0; k < 3; k++) {
    slowField[k] += a * (raw[k] - slowField[k]);
    hp[k] = raw[k] - slowField[k];
  }
  if (!hpHave) { memcpy(hpMin, hp, sizeof(hpMin)); memcpy(hpMax, hp, sizeof(hpMax)); hpHave = true; }
  for (int k = 0; k < 3; k++) { hpMin[k] = min(hpMin[k], hp[k]); hpMax[k] = max(hpMax[k], hp[k]); }
  if (ms - hpStart >= 1000) {                    // 1 s windows: the crank's swing before it's learned
    float d[3] = { hpMax[0] - hpMin[0], hpMax[1] - hpMin[1], hpMax[2] - hpMin[2] };
    hpP2P = sqrtf(dot3(d, d));
    hpHave = false;
    hpStart = ms;
  }
  for (int k = 0; k < 3; k++) peakAbs = max(peakAbs, fabsf(raw[k]));
  if (placeOn && !crank.ok) placeExtend(slowField);
}

static void placeOnTurn(const float avg[3]) {
  memcpy(xTurns[xTurnIdx], avg, sizeof(xTurns[0]));
  xTurnIdx = (xTurnIdx + 1) % X_NOISE_TURNS;
  if (xTurnN < X_NOISE_TURNS) xTurnN++;
  if (placeOn) placeExtend(avg);
}

static void printPlacement() {
  float mag = sqrtf(dot3(fieldUT, fieldUT));
  float swing = 0;
  if (placeHave) {
    float d[3] = { placeMax[0] - placeMin[0], placeMax[1] - placeMin[1], placeMax[2] - placeMin[2] };
    swing = sqrtf(dot3(d, d));
  }
  float dip = crank.ok ? lastDip : hpP2P;
  float head = 100.0f * (1.0f - min(1.0f, peakAbs / SATURATION_UT));
  float noise = tol.noise;
  if (crank.ok && xTurnN >= 4) {                // consecutive turns, oldest first
    static float d[X_NOISE_TURNS];
    int n = 0, first = (xTurnIdx + X_NOISE_TURNS - xTurnN) % X_NOISE_TURNS;
    for (int i = 1; i < xTurnN; i++)
      d[n++] = dist3(xTurns[(first + i) % X_NOISE_TURNS], xTurns[(first + i - 1) % X_NOISE_TURNS]);
    noise = medianOf(d, n);
  }
  peakAbs = 0;
  Log.printf("X,%.1f,%.1f,%.1f,%.0f,%.2f\n", mag, swing, dip, head, noise);
}

static void processSample(const Sample& smp) {
  sampleMs = smp.ms;
  saturated = smp.sat;
  if (saturated && calState == CAL_SURVEY) survSat = true;
  const float* raw = smp.raw;
  recOnSample(raw, smp.ms);
  placeOnSample(raw, smp.ms);

  // Crank learning (calibration, first stage) and turn detection.
  if (calState == CAL_LEARN) {
    if (learnCount < LEARN_MAX_SAMPLES) memcpy(learnBuf[learnCount++], raw, sizeof(learnBuf[0]));
    if (learnCount >= LEARN_FIRST_PROBE && (learnCount - LEARN_FIRST_PROBE) % LEARN_PROBE_EVERY == 0)
      calLearnProbe();
  } else if (crank.ok) {
    float avg[3];
    uint32_t per = 0;
    static uint32_t seenDrops = 0;
    if (sampleDrops != seenDrops) {             // readings were lost: don't time a turn across the gap
      seenDrops = sampleDrops;
      if (!injecting) crHaveBoundary = false;   // ('#I': the lost readings are the sensor's, unused)
    }
    int r = crankSample(smp.ms, raw, avg, &per);
    if (r) onTurnBoundary(r, avg, per, smp.ms);
  }
  updatePause(smp.ms);

  // 1) Median-of-5 per axis removes single-sample spikes.
  for (int k = 0; k < 3; k++) medianBuf[k][medianIdx] = raw[k];
  medianIdx = (medianIdx + 1) % MEDIAN_N;
  if (medianFill < MEDIAN_N) { medianFill++; return; }

  float med[3];
  for (int k = 0; k < 3; k++) med[k] = median5(medianBuf[k]);

  // 2) Exponential moving average for low-frequency noise.
  if (!emaSeeded) {
    memcpy(fieldUT, med, sizeof(fieldUT));
    emaSeeded = true;
  } else {
    for (int k = 0; k < 3; k++) fieldUT[k] += EMA_ALPHA * (med[k] - fieldUT[k]);
  }

  // Fast raw stream for diagnostics: USB only, never to the phone.
  if (rawStream) {
    Serial.printf("R,%lu,%.1f,%.1f,%.1f,%.1f,%.1f,%.1f\n", (unsigned long)smp.ms,
                  raw[0], raw[1], raw[2], fieldUT[0], fieldUT[1], fieldUT[2]);
  }

  if (crank.ok || calState == CAL_LEARN) return;   // gear comes per turn

  calOnSample(fieldUT);
  calAutoCheck();
  if (!calValid) return;
  updateGear(fieldUT, smp.ms, true);
}

// =========================================================================
// Power
// =========================================================================
static void updatePower() {
  float cad;
  if (calState == CAL_LEARN) {
    cad = learnLast.rpm;                        // provisional, from the turns seen so far
  } else if (crank.ok) {
    cad = selfCadence();
  } else {
    bool valid; uint32_t lastEvt;
    taskENTER_CRITICAL();
    valid = crankValid; cad = podCadence; lastEvt = lastCrankEventMs;
    taskEXIT_CRITICAL();
    if (!valid || millis() - lastEvt > CADENCE_TIMEOUT_MS) cad = 0;
  }
  cadenceRpm = cad;

  if (!calValid || cad < 1.0f || calState == CAL_LEARN) { powerW = 0; return; }

  // Continuous resistance (not the rounded gear) drives power, as on the
  // Keiser console and in KBikeBLE, so half-gear lever positions are honoured.
  float p90 = interpTable(GEAR_EDGES, POWER90, NUM_GEARS + 1, resistance);
  float p = p90 * (PC2 + PB2 * cad + PA2 * cad * cad);
  powerW = constrain(p, 0.0f, 2000.0f);
}

// =========================================================================
// BLE: Cycling Power Service to Zwift
// =========================================================================
static void sendPowerMeasurement() {
  bool valid; uint16_t revs, evt;
  if (crank.ok) {                               // the board's own turn count
    valid = selfRevs > 0;
    revs  = selfRevs;
    evt   = (uint16_t)(((uint64_t)selfEventMs * 1024) / 1000);   // 1/1024 s
  } else {
    taskENTER_CRITICAL();
    valid = crankValid; revs = crankRevs; evt = crankEventTime;
    taskEXIT_CRITICAL();
  }

  // Flags bit 5 = Crank Revolution Data Present
  uint16_t flags = valid ? 0x0020 : 0x0000;
  int16_t  watts = (int16_t)lroundf(powerW);
  uint8_t  buf[8];
  buf[0] = flags & 0xFF;  buf[1] = flags >> 8;
  buf[2] = watts & 0xFF;  buf[3] = (uint16_t)watts >> 8;
  uint16_t len = 4;
  if (valid) {
    buf[4] = revs & 0xFF;  buf[5] = revs >> 8;
    buf[6] = evt & 0xFF;   buf[7] = evt >> 8;
    len = 8;
  }

  // Send to every connected app that subscribed to power (normally just
  // Zwift; the phone console doesn't subscribe).
  uint8_t subs = 0;
  for (uint16_t c = 0; c < BLE_MAX_CONNECTION; c++) {
    if (Bluefruit.Periph.connected(c) && cpMeasurement.notifyEnabled(c)) {
      cpMeasurement.notify(c, buf, len);
      subs++;
    }
  }
  powerSubscribers = subs;
}

static void printHelp() {
  Log.println(F("Commands: c=calibrate  n=capture point / confirm cadence  u=undo  x=abort"));
  Log.println(F("          l=learn the crank again (at the cadence check or point 1)"));
  Log.println(F("          s=stop the down pass (its points are kept)"));
  Log.println(F("          a=auto-capture on/off  d=live data on/off"));
  Log.println(F("          r=fast raw data (USB)  p=show calibration  h=help"));
  Log.println(F("          g/m/e/y=diagnostics record/mark/stop/send  k=calibration data + check"));
  Log.println(F("          t=one line per pedal turn on/off  v=placement meters (X lines) on/off"));
  Log.println(F("          #R,u,N / #R,d,N = redo point N going up / coming down (pedalling)"));
  Log.println(F("          #G,u,N / #G,d,N = use the check's best guess for point N"));
  Log.println(F("          #P,u|d,N,x,y,z  then #W = load points (USB), #X = discard"));
  Log.println(F("          #D = (resume) the down pass  #M = the board was moved  #J,text = echo"));
  Log.println(F("          #I = injected samples on/off, #S,ms,x,y,z = one sample (USB)"));
}

static void prphConnectCb(uint16_t conn) {
  (void)conn;
  Log.println(F("[BLE] App connected"));
  // Keep advertising so Zwift and the phone console can both connect.
  if (Bluefruit.Periph.connected() < MAX_PRPH_CONN) Bluefruit.Advertising.start(0);
}

static void prphDisconnectCb(uint16_t conn, uint8_t reason) {
  if (conn == phoneConn) {
    phoneConn = BLE_CONN_HANDLE_INVALID;
    statusStream = false;                    // the page re-enables it on connect
    bleIn.active = false;                    // a half-sent '#' line dies with the link
  }
  Log.printf("[BLE] App disconnected (0x%02X)\n", reason);
}

// The phone counts as "the console" once its UART screen subscribes.
static void uartNotifyCb(uint16_t conn, bool enabled) {
  if (enabled) {
    phoneConn = conn;
    bleIn.active = false;
    Log.println(F("\nKeiser M3 Bridge - phone console connected."));
    printHelp();
  } else if (conn == phoneConn) {
    phoneConn = BLE_CONN_HANDLE_INVALID;
    statusStream = false;
  }
}

static void setupPeripheral() {
  deviceInfo.setManufacturer("DIY");
  deviceInfo.setModel("Keiser M3 Mag Bridge");
  deviceInfo.begin();

  cpsService.begin();

  cpMeasurement.setProperties(CHR_PROPS_NOTIFY);
  cpMeasurement.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  cpMeasurement.setMaxLen(8);
  cpMeasurement.begin();

  // Cycling Power Feature: bit 3 = Crank Revolution Data Supported
  cpFeature.setProperties(CHR_PROPS_READ);
  cpFeature.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  cpFeature.setFixedLen(4);
  cpFeature.begin();
  cpFeature.write32(0x00000008);

  // Sensor Location: 0 = Other
  cpSensorLocation.setProperties(CHR_PROPS_READ);
  cpSensorLocation.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  cpSensorLocation.setFixedLen(1);
  cpSensorLocation.begin();
  cpSensorLocation.write8(0);

  bleuart.begin();
  bleuart.setNotifyCallback(uartNotifyCb);

  Bluefruit.Periph.setConnectCallback(prphConnectCb);
  Bluefruit.Periph.setDisconnectCallback(prphDisconnectCb);

  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();
  Bluefruit.Advertising.addService(cpsService);
  Bluefruit.Advertising.addService(bleuart);    // lets the phone app find it
  Bluefruit.ScanResponse.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244);   // 20 ms fast, 152.5 ms slow
  Bluefruit.Advertising.setFastTimeout(30);
  Bluefruit.Advertising.start(0);
}

// =========================================================================
// BLE: Cycling Speed & Cadence client (cadence pod)
// =========================================================================
static bool     podHaveRef  = false;
static uint16_t podLastRevs = 0;
static uint16_t podLastTime = 0;

static void cscNotifyCb(BLEClientCharacteristic* chr, uint8_t* data, uint16_t len) {
  (void)chr;
  if (len < 1) return;
  uint8_t flags = data[0];
  uint16_t i = 1;
  if (flags & 0x01) i += 6;                   // skip wheel revs (u32) + time (u16)
  if (!(flags & 0x02) || len < i + 4) return; // no crank data in this packet

  uint16_t revs = data[i] | (data[i + 1] << 8);
  uint16_t t    = data[i + 2] | (data[i + 3] << 8);

  if (!podHaveRef) {
    podHaveRef = true;
    podLastRevs = revs;
    podLastTime = t;
  } else if (t != podLastTime) {               // pods repeat the last event when idle
    uint16_t dRev = revs - podLastRevs;        // uint16 math handles rollover
    uint16_t dT   = t - podLastTime;           // 1/1024 s
    if (dRev > 0 && dRev < 20 && dT > 0) {
      float rpm = dRev * 61440.0f / dT;        // 60 s * 1024 ticks/s
      if (rpm <= 200.0f) {
        taskENTER_CRITICAL();
        podCadence = rpm;
        lastCrankEventMs = millis();
        taskEXIT_CRITICAL();
      }
    }
    podLastRevs = revs;
    podLastTime = t;
  }

  taskENTER_CRITICAL();
  crankRevs = revs;
  crankEventTime = t;
  crankValid = true;
  taskEXIT_CRITICAL();
}

static void podScanCb(ble_gap_evt_adv_report_t* report) {
  const char* filter = CADENCE_NAME_FILTER;
  if (filter[0] != '\0') {
    char name[32] = {0};
    if (!Bluefruit.Scanner.parseReportByType(report, BLE_GAP_AD_TYPE_COMPLETE_LOCAL_NAME,
                                             (uint8_t*)name, sizeof(name) - 1)) {
      Bluefruit.Scanner.parseReportByType(report, BLE_GAP_AD_TYPE_SHORT_LOCAL_NAME,
                                          (uint8_t*)name, sizeof(name) - 1);
    }
    if (strstr(name, filter) == nullptr) {
      Bluefruit.Scanner.resume();
      return;
    }
  }
  Bluefruit.Central.connect(report);
}

static void podConnectCb(uint16_t conn) {
  if (!cscService.discover(conn) || !cscMeasurement.discover()) {
    Log.println(F("[BLE] Device has no CSC measurement - disconnecting"));
    Bluefruit.disconnect(conn);
    return;
  }
  podConn = conn;
  podHaveRef = false;
  if (cscMeasurement.enableNotify()) {
    Log.println(F("[BLE] Cadence pod connected"));
  } else {
    Log.println(F("[BLE] Cadence pod: could not enable notifications"));
    Bluefruit.disconnect(conn);
  }
}

static void podDisconnectCb(uint16_t conn, uint8_t reason) {
  if (conn == podConn) podConn = BLE_CONN_HANDLE_INVALID;
  taskENTER_CRITICAL();
  crankValid = false;
  podCadence = 0;
  taskEXIT_CRITICAL();
  podHaveRef = false;
  Log.printf("[BLE] Cadence pod disconnected (0x%02X), rescanning\n", reason);
}

static void setupCentral() {
  cscService.begin();
  cscMeasurement.setNotifyCallback(cscNotifyCb);
  cscMeasurement.begin();

  Bluefruit.Central.setConnectCallback(podConnectCb);
  Bluefruit.Central.setDisconnectCallback(podDisconnectCb);

  Bluefruit.Scanner.setRxCallback(podScanCb);
  Bluefruit.Scanner.restartOnDisconnect(true);
  Bluefruit.Scanner.setInterval(160, 80);      // 100 ms interval, 50 ms window
  Bluefruit.Scanner.filterUuid(cscService.uuid);
  Bluefruit.Scanner.useActiveScan(true);       // active scan so names are visible
  Bluefruit.Scanner.start(0);
}

// =========================================================================
// User input: button + serial
// =========================================================================
static void handleCommand(int ch);

static void handleShortPress() {
  cmdSrc = SRC_BUTTON;
  if (calState == CAL_WAITING || calState == CAL_CONFIRM || calState == CAL_POINT_CHECK ||
      calState == CAL_SURVEY || calState == CAL_DOWN_READY) calCapture();
}

static void handleLongPress() {
  cmdSrc = SRC_BUTTON;
  if (calState == CAL_IDLE) calStart();
  else handleCommand('x');
}

static void pollButton() {
  static bool     lastLevel = HIGH, stableLevel = HIGH;
  static uint32_t lastChange = 0, pressStart = 0;
  static bool     longFired = false;

  bool level = digitalRead(PIN_BUTTON1);
  uint32_t now = millis();
  if (level != lastLevel) { lastLevel = level; lastChange = now; }
  if (now - lastChange < 30) return;           // 30 ms debounce

  if (level != stableLevel) {
    stableLevel = level;
    if (level == LOW) {                        // pressed
      pressStart = now;
      longFired = false;
    } else if (!longFired) {                   // released before long-press
      handleShortPress();
    }
  }
  if (stableLevel == LOW && !longFired && now - pressStart >= LONG_PRESS_MS) {
    longFired = true;
    handleLongPress();
  }
}

static void handleCommand(int ch) {
  switch (tolower(ch)) {
    case 'c': if (calState == CAL_IDLE) calStart(); break;
    case 'n': calCapture(); break;
    case 'l': calRelearn(); break;
    case 'u': calUndo(); break;
    case 'x':                                  // the down pass (and the saved up pass) are kept
      if (calState == CAL_DOWN_READY) calSkipDown();
      else if (calState != CAL_IDLE && calPass == PASS_DOWN) calFinishDown();
      else if (calState != CAL_IDLE) calAbort(F("cancelled by user"));
      break;
    case 's': calSkipDown(); break;
    case 'a':
      if (pressMode) { pressMode = pressArmed = false; autoCapture = true; }   // v3.4: back to auto
      else autoCapture = !autoCapture;
      Log.println(autoCapture ? F("Auto-capture ON.") : F("Auto-capture OFF."));
      break;
    case 'd': debugStream = !debugStream; break;
    case 'r': rawStream = !rawStream; break;
    case 't': turnStream = !turnStream; break;
    case '1': statusStream = true; break;
    case '0': statusStream = false; break;
    case 'p': wantP = true; break;              // paced from loop()
    case 'k': wantK = true; break;
    case 'v':
      placeOn = !placeOn;
      placeHave = false;                       // the swing and the headroom start again
      peakAbs = 0;
      lastXMs = 0;
      break;
    case 'g': recStart(); break;
    case 'm': recMark(); break;
    case 'e': recStop(false); break;
    case 'y': recDumpStart(); break;
    case 'h': case '?': printHelp(); break;
    default: break;                            // ignores newlines, spaces
  }
}

// '#' line commands (bench/PROTOCOL.md): pass is 'u' or 'd', point is 1-based.
static void resetSignalChain();

static void handleLine(char* line) {
  if (toupper(line[0]) == 'J' && (line[1] == '\0' || line[1] == ',')) {   // '#J,<text>': echo for the log (USB)
    Serial.printf("J,%s\n", line[1] ? line + 2 : "");
    return;
  }
  char* f[7];
  int n = 0;
  for (char* t = strtok(line, ","); t && n < 7; t = strtok(nullptr, ",")) f[n++] = t;
  if (n == 0) return;
  char cmd = toupper(f[0][0]);
  char pass = n > 1 ? tolower(f[1][0]) : 0;
  int point = n > 2 ? atoi(f[2]) : 0;
  bool passOk = pass == 'u' || pass == 'd';
  if (cmd == 'R' && n == 3 && passOk) {
    calFixStart(pass == 'd', point);
  } else if (cmd == 'G' && n == 3 && passOk) {
    for (uint8_t i = 0; i < suspectN; i++) {
      const Suspect& s = suspects[i];
      if (s.pass != pass || s.point != point) continue;
      if (calState != CAL_IDLE) { Log.println(F("E,fail,busy calibrating")); return; }
      memcpy(calRaw, cal.pts, sizeof(calRaw));
      memcpy(calDown, cal.down, sizeof(calDown));
      calDownMask = cal.downMask;
      memcpy(pass == 'u' ? calRaw[point - 1] : calDown[point - 1], s.guess, sizeof(s.guess));
      Log.printf("Using the best guess for point %d.\n", point);
      calCommit(calRaw, calDown, calDownMask, COMMIT_EDIT);
      return;
    }
    Log.println(F("E,fail,that point isn't in the latest check"));
  } else if (cmd == 'P' && n == 6 && passOk) {
    if (!calValid) { Log.println(F("E,fail,no calibration to edit")); return; }
    int i = point - 1;
    if (i < 0 || i > NUM_GEARS - 1 || (pass == 'd' && (i < 1 || i > DOWN_FIRST))) {
      Log.println(F("E,fail,no such point"));
      return;
    }
    if (!staging) {
      memcpy(stageUp, cal.pts, sizeof(stageUp));
      memcpy(stageDown, cal.down, sizeof(stageDown));
      stageMask = cal.downMask;
      staging = true;
    }
    float v[3];
    for (int k = 0; k < 3; k++) {
      char* end;
      v[k] = strtof(f[3 + k], &end);
      if (end == f[3 + k] || *end) { Log.println(F("E,fail,bad number")); return; }
    }
    float* q = pass == 'u' ? stageUp[i] : stageDown[i];
    memcpy(q, v, sizeof(v));
    if (pass == 'd') stageMask |= 1UL << i;
    Log.printf("Staged point %d (%s): (%.1f, %.1f, %.1f). '#W' saves, '#X' discards.\n",
               point, pass == 'u' ? "up" : "down", q[0], q[1], q[2]);
    Log.println(F("E,ok,staged"));
  } else if (cmd == 'W' && n == 1) {
    if (!staging) { Log.println(F("E,fail,nothing staged")); return; }
    if (calState != CAL_IDLE) { Log.println(F("E,fail,busy calibrating")); return; }
    calCommit(stageUp, stageDown, stageMask, COMMIT_EDIT);   // clears staging when it saves
  } else if (cmd == 'X' && n == 1) {
    staging = false;
    Log.println(F("E,ok,discarded"));
  } else if (cmd == 'M' && n == 1) {             // the board was moved: new spot, no prior
    spotForced = true;
    forgetPrev();
    Log.println(F("The board was moved: the next calibration starts afresh."));
    Log.println(F("E,ok,moved"));
  } else if (cmd == 'D' && n == 1) {
    calDownStart();
  } else if (cmd == 'A' && n == 2) {             // capture mode (v3.4): '#A,press' or '#A,auto'
    if (!strcmp(f[1], "press")) {
      pressMode = true;
      pressArmed = false;
      autoCapture = false;
      Log.println(F("Press to capture: move to the gear, then press."));
    } else if (!strcmp(f[1], "auto")) {
      pressMode = pressArmed = false;
      autoCapture = true;
      Log.println(F("Auto-capture ON."));
    } else {
      Log.println(F("E,fail,press or auto"));
      return;
    }
    Log.printf("E,ok,capture,%s\n", pressMode ? "press" : "auto");
  } else if (cmd == 'V' && n == 1) {             // version (v3.4): what this board supports
    Log.println(F("E,ok,v3.4"));
  } else if (cmd == 'E' && n == 1) {             // erase the calibration (USB only; bench testing)
    if (cmdSrc != SRC_USB) { Log.println(F("E,fail,usb only")); return; }
    if (calState != CAL_IDLE) { Log.println(F("E,fail,busy calibrating")); return; }
    InternalFS.remove(CAL_PATH);
    InternalFS.remove(TMP_PATH);
    forgetPrev();
    calValid = false;
    suspectN = 0;
    staging = false;
    spotForced = false;
    loadCrankFromCal();                           // crank.ok follows calValid: off
    stableGear = pendingGear = 1;
    Log.println(F("Calibration erased: the board is uncalibrated."));
    Log.println(F("E,ok,erased"));
  } else if (cmd == 'I' && n == 1) {             // injected samples (bench/PROTOCOL.md, v3.3)
    if (cmdSrc != SRC_USB) { Log.println(F("E,fail,usb only")); return; }
    if (calState != CAL_IDLE) { Log.println(F("E,fail,busy calibrating")); return; }
    injecting = !injecting;
    injMs = 0;
    injLastMs = millis();
    resetSignalChain();
    Log.printf("E,ok,inject %s\n", injecting ? "on" : "off");
  } else if (cmd == 'S' && n == 5) {
    if (cmdSrc != SRC_USB) { Log.println(F("E,fail,usb only")); return; }
    if (!injecting) { Log.println(F("E,fail,not injecting")); return; }
    char* end;
    const char* p1 = f[1];
    while (*p1 == ' ') p1++;
    unsigned long ms = strtoul(p1, &end, 10);
    if (*p1 < '0' || *p1 > '9' || *end) { Log.println(F("E,fail,bad number")); return; }
    Sample smp;
    for (int k = 0; k < 3; k++) {
      smp.raw[k] = strtof(f[2 + k], &end);
      if (end == f[2 + k] || *end) { Log.println(F("E,fail,bad number")); return; }
    }
    smp.ms = injMs = (uint32_t)ms;
    injLastMs = millis();
    smp.sat = fabsf(smp.raw[0]) > SATURATION_UT || fabsf(smp.raw[1]) > SATURATION_UT ||
              fabsf(smp.raw[2]) > SATURATION_UT;
    processSample(smp);
    injLastMs = millis();                         // idle counts from here: a capture's saves take seconds
  } else {
    Log.println(F("E,fail,unknown command"));
  }
}

// One input character: '#' starts a line command (ended by a newline),
// anything else is a single-character command.
static void handleInput(LineIn& in, int ch, CmdSrc src) {
  uint32_t now = millis();                      // real time: this is about the link, not the samples
  if (in.active && now - in.lastMs > LINE_TIMEOUT_MS) in.active = false;   // half a line: drop it
  in.lastMs = now;
  if (in.active) {
    if (ch == '\n' || ch == '\r') {
      in.buf[in.n] = '\0';
      in.active = false;
      cmdSrc = src;
      if (in.overflow) Log.println(F("E,fail,line too long"));
      else handleLine(in.buf);
    } else if (in.n < sizeof(in.buf) - 1) {
      in.buf[in.n++] = (char)ch;
    } else {
      in.overflow = true;
    }
    return;
  }
  if (ch == '#') { in.active = true; in.overflow = false; in.n = 0; return; }
  cmdSrc = src;
  handleCommand(ch);
}

// Commands arrive from USB serial or from the phone app's UART screen.
// (At most a few hundred characters per pass: injected samples can arrive
// faster than they are processed, and loop() must keep running.)
static void pollCommands() {
  for (int n = 0; n < 512 && Serial.available(); n++) handleInput(usbIn, Serial.read(), SRC_USB);
  for (int n = 0; n < 128 && bleuart.available(); n++) handleInput(bleIn, bleuart.read(), SRC_BLE);
}

// '#I': start the signal chain afresh on the new time base.
static void resetSignalChain() {
  medianIdx = medianFill = 0;
  emaSeeded = false;
  slowSeeded = hpHave = false;
  crankReset(crank.base);
  selfPeriods[0] = selfPeriods[1] = 0;
  lastTurnMs = sampleMs;
  calPaused = false;
}

// =========================================================================
// Status LED and debug output
// =========================================================================
static void updateLed() {
  uint32_t now = millis();
  bool on;
  if (calState != CAL_IDLE)  on = (calState == CAL_WAITING || calState == CAL_CONFIRM ||
                                   calState == CAL_POINT_CHECK);
  else if (saturated)        on = (now / 100) % 2;
  else if (!calValid)        on = (now / 500) % 2;
  else                       on = false;
  digitalWrite(LED_RED, on ? HIGH : LOW);
}

// Where cadence currently comes from: B = board (crank magnet), W = pod, - = none.
static char cadenceSource() {
  if (crank.ok) return pedalling() ? 'B' : '-';
  bool valid; uint32_t lastEvt;
  taskENTER_CRITICAL();
  valid = crankValid; lastEvt = lastCrankEventMs;
  taskEXIT_CRITICAL();
  return valid && millis() - lastEvt <= CADENCE_TIMEOUT_MS ? 'W' : '-';
}

static void printDebug() {
  Log.printf("B=(%7.1f,%7.1f,%7.1f)uT %s R=%5.1f gear=%2d off=%4.1f cad=%5.1f(%c) "
                "P=%4.0fW turns=%u drops=%lu pod=%s app=%s\n",
                fieldUT[0], fieldUT[1], fieldUT[2], saturated ? "SAT" : "   ",
                resistance, calValid ? stableGear : 0, offPath, cadenceRpm, cadenceSource(),
                powerW, selfRevs, (unsigned long)sampleDrops,
                podConn  != BLE_CONN_HANDLE_INVALID ? "Y" : "n",
                powerSubscribers > 0 ? "Y" : "n");
}

// Machine-readable status for the web page (bench/PROTOCOL.md).
static void printStatus() {
  char flags[16];
  int n = 0;
  if (calValid)                          flags[n++] = 'V';
  if (podConn != BLE_CONN_HANDLE_INVALID) flags[n++] = 'P';
  if (powerSubscribers > 0)              flags[n++] = 'Z';
  if (saturated)                         flags[n++] = 'S';
  if (offPathHold)                       flags[n++] = 'H';
  if (autoCapture)                       flags[n++] = 'A';
  if (pressMode)                         flags[n++] = 'T';   // v3.4: press to capture
  if (pressMode && pressArmed && calState == CAL_WAITING) flags[n++] = 'I';   // measuring after a press
  if (recording)                         flags[n++] = 'G';
  if (dumpPos >= 0)                      flags[n++] = 'Y';
  if (pedalling())                       flags[n++] = 'R';
  if (settleSince && calState == CAL_WAITING) flags[n++] = 'M';   // hold the lever still
  bool gated = calPass == PASS_FIX_UP || calPass == PASS_FIX_DOWN || (calPass == PASS_DOWN && downGate);
  if (calState == CAL_WAITING && ((gated && !fixArmed) || backGate)) flags[n++] = 'B';   // go back past the point first
  if (calPaused)                         flags[n++] = 'O';   // paused: pedal (or reconnect) to continue
  flags[n] = '\0';
  const char* pass = calState == CAL_IDLE ? "-"
                   : calState == CAL_SURVEY && survPhase == SURV_UP ? "su"
                   : calState == CAL_SURVEY && survPhase == SURV_DOWN ? "sd"
                   : calPass == PASS_DOWN ? "d"
                   : calPass == PASS_FIX_UP ? "ru" : calPass == PASS_FIX_DOWN ? "rd" : "u";
  Log.printf("S,%d,%.1f,%.0f,%.1f,%d,%d,%d,%.1f,%s,%u,%c,%u,%s,%d,%u\n",
             calValid ? stableGear : 0, resistance, powerW, cadenceRpm,
             (int)calState, calStep, stabPct, offPath, flags, recCount, cadenceSource(),
             calState == CAL_LEARN ? learnLast.turns : 0, pass, calStepNo(), STEPS_TOTAL);
}

// =========================================================================
// Arduino entry points
// =========================================================================
void setup() {
  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 1500) delay(10);  // don't block when headless

  pinMode(LED_RED, OUTPUT);
  pinMode(PIN_BUTTON1, INPUT_PULLUP);
  Log.begin();

  Log.println(F("\nKeiser M3 magnetometer bridge v3.4.1"));

  if (!lis3mdl.begin_I2C()) {
    Log.println(F("LIS3MDL not found. Is this a CLUE or Feather nRF52840 Sense?"));
    while (true) { digitalWrite(LED_RED, !digitalRead(LED_RED)); delay(50); }
  }
  lis3mdl.setPerformanceMode(LIS3MDL_ULTRAHIGHMODE);
  lis3mdl.setOperationMode(LIS3MDL_CONTINUOUSMODE);
  lis3mdl.setDataRate(LIS3MDL_DATARATE_155_HZ);
  lis3mdl.setRange(LIS3MDL_RANGE_16_GAUSS);     // widest range: near strong magnets

  InternalFS.begin();
  calValid = loadCalibration();
  loadPrev();
  if (calValid) { calCheck(); buildPath(); }
  spotKind = calValid ? SPOT_SAME : SPOT_FIRST;
  deriveTolerances(true);
  loadCrankFromCal();
  Log.println(calValid ? F("Calibration loaded.")
                          : F("No calibration yet: hold the button 3 s (or send 'c')."));
  if (calValid) {
    Log.println(crank.ok ? F("Cadence and gear come from the crank magnet (per pedal turn).")
                         : F("Crank magnet not used: cadence comes from a pod."));
  }

  Bluefruit.begin(MAX_PRPH_CONN, 1);            // Zwift + phone, plus 1 cadence pod
  Bluefruit.setTxPower(4);
  Bluefruit.setName(DEVICE_NAME);
  setupPeripheral();
  setupCentral();

  sampleQueue = xQueueCreate(SAMPLE_QUEUE_LEN, sizeof(Sample));
  if (!sampleQueue || xTaskCreate(sensorTask, "mag", 1024, nullptr, TASK_PRIO_NORMAL, nullptr) != pdPASS) {
    Log.println(F("Could not start the sensor task (out of memory?)."));
    while (true) { digitalWrite(LED_RED, !digitalRead(LED_RED)); delay(50); }
  }

  watchdogStart();
}

void loop() {
  uint32_t now = millis();

  Sample smp;
  while (xQueueReceive(sampleQueue, &smp, 0) == pdTRUE)
    if (!injecting) processSample(smp);         // '#I': real reads are ignored

  if (now - lastNotifyMs >= NOTIFY_PERIOD_MS) {
    lastNotifyMs = now;
    updatePower();
    sendPowerMeasurement();
  }

  if (debugStream && now - lastDebugMs >= DEBUG_PERIOD_MS) {
    lastDebugMs = now;
    printDebug();
  }

  // Status pauses while a recording is being sent (it shares the link).
  if (statusStream && dumpPos < 0 && now - lastStatusMs >= STATUS_PERIOD_MS) {
    lastStatusMs = now;
    printStatus();
  }
  if (injecting && now - injLastMs > INJECT_IDLE_MS) {   // the harness went quiet: back to the sensor
    injecting = false;
    resetSignalChain();
    Log.println(F("Injected samples stopped: back to the magnetometer."));
    Log.println(F("E,ok,inject off"));
  }
  if (placeOn && dumpPos < 0 && now - lastXMs >= X_PERIOD_MS) {
    lastXMs = now;
    printPlacement();
  }
  recDumpStep();
  if (checkPending) {                           // after a save: the check, then its F lines
    checkPending = false;
    calCheck();
    buildPath();                                // flagged points stay out of the path
    wantF = true;
  }
  outStep();

  pollButton();
  pollCommands();
  updateLed();
  updateSpeaker();
  speakerTail();
  watchdogFeed();
  delay(2);   // yield to the BLE stack / FreeRTOS
}
