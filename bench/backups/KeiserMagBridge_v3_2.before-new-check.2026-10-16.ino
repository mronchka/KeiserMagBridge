/*
 * KeiserMagBridge_v3_2.ino
 * -------------------------------------------------------------------------
 * Passive, zero-solder Bluetooth power bridge for a Keiser M3 indoor bike.
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
 *     ('F' lines) with a best guess; nothing is changed without the rider.
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
static const float    CHECK_BEHIND_UT    = 0.5f;  // check: a point must be this far past the one before
static const float    CHECK_OVERSHOOT    = 1.6f;  // check: the step into a point this x the usual -> it overshot
static const float    CHECK_UPDOWN_UT    = 1.5f;  // check: up/down offset off the usual by this...
static const float    CHECK_UPDOWN_FRAC  = 0.6f;  // ...and by this x the smaller neighbouring step
static const uint8_t  MAX_SUSPECTS       = 8;
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
static const uint16_t CAL_VERSION = 5;           // v5: v4 + down points; v4 files still load

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
};
static const size_t CAL_V4_SIZE = offsetof(CalData, downMask);

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

// Built from cal on load and after every save: the path used for gear and
// watts (the middle of each up/down pair where both exist), and where the
// console switches gear at each edge going up / down (Keiser resistance).
static float   pathPts[NUM_GEARS + 1][3];
static float   edgeUpR[NUM_GEARS + 1], edgeDownR[NUM_GEARS + 1];
static bool    checkPrintPending = false;      // F lines to send from loop()

// A speaker note (defined up here so Arduino's generated prototypes see it).
struct Note { uint16_t hz, ms; };

// One magnetometer reading, taken by the sensor task and queued for loop().
struct Sample {
  uint32_t ms;          // millis() when it was read
  float    raw[3];      // uT
  bool     sat;         // saturated
};
static const uint16_t SAMPLE_QUEUE_LEN = 128;   // 2.5 s of readings at 50 Hz
static QueueHandle_t  sampleQueue = nullptr;
static volatile uint32_t sampleDrops = 0;       // queue was full (loop stalled > 2.5 s)

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
enum CalState { CAL_IDLE, CAL_WAITING, CAL_CAPTURING, CAL_LEARN, CAL_CONFIRM, CAL_POINT_CHECK };
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
static bool      behindNow  = false;            // set by calMovedOn: agreeing turns behind the last point
static float     capSum[3];
static uint16_t  capCount   = 0;

// Auto-capture
static bool      autoCapture = true;
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
static float     lastTurnAvg[3];              // most recent turn average (capture anyway)

// The check after a save: points that look wrong, with a best guess.
struct Suspect { char pass; uint8_t point; const char* why; float guess[3]; };
static Suspect   suspects[MAX_SUSPECTS];
static uint8_t   suspectN = 0;

// A '#' line command being typed (one per input: USB, phone).
struct LineIn { char buf[64]; uint8_t n; bool active; bool overflow; uint32_t lastMs; };
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
  void sendLocked(uint16_t conn) {
    if (n_ && bleuart.notifyEnabled(conn)) {
      for (size_t i = 0; i < n_; i += 20) {
        bleuart.write(conn, buf_ + i, min(n_ - i, (size_t)20));
        watchdogFeed();                          // 'k' / 'p' can take several seconds on a slow link
      }
    }
    n_ = 0;
  }
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
static bool loadCalibration() {
  File f(InternalFS);
  if (!f.open(CAL_PATH, FILE_O_READ)) return false;
  CalData tmp;
  memset(&tmp, 0, sizeof(tmp));
  uint32_t size = f.size();
  bool ok = false;
  if (size == sizeof(tmp)) {
    ok = f.read(&tmp, sizeof(tmp)) == (int)sizeof(tmp) && tmp.version == CAL_VERSION;
  } else if (size == CAL_V4_SIZE) {               // v4: no down points
    ok = f.read(&tmp, CAL_V4_SIZE) == (int)CAL_V4_SIZE && tmp.version == 4;
    tmp.downMask = 0;
  }
  ok = ok && tmp.magic == CAL_MAGIC;
  f.close();
  if (ok) { cal = tmp; cal.version = CAL_VERSION; }
  return ok;
}

static bool saveCalibration() {
  InternalFS.remove(CAL_PATH);
  File f(InternalFS);
  if (!f.open(CAL_PATH, FILE_O_WRITE)) return false;
  bool ok = f.write((const uint8_t*)&cal, sizeof(cal)) == sizeof(cal);
  f.close();
  return ok;
}

static void printCalibration() {
  if (!calValid) { Log.println(F("No valid calibration stored.")); return; }
  Log.println(F("Calibration path (point, Keiser resistance, field uT, step uT; coming down, uT from the up point):"));
  for (int i = 0; i <= NUM_GEARS; i++) {
    float step = i ? dist3(cal.pts[i], cal.pts[i - 1]) : 0;
    Log.printf("  %2d  R=%6.2f  (%7.1f,%7.1f,%7.1f)  %5.2f", i + 1, GEAR_EDGES[i],
               cal.pts[i][0], cal.pts[i][1], cal.pts[i][2], step);
    if (cal.downMask & (1UL << i)) {
      Log.printf("   down (%7.1f,%7.1f,%7.1f)  %4.2f\n", cal.down[i][0], cal.down[i][1], cal.down[i][2],
                 dist3(cal.pts[i], cal.down[i]));
    } else {
      Log.println();
    }
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

  // Switch points. Each edge sits EDGE_BIAS_UT back from where the rider
  // stopped (along the path); coming down, the console switches lower by its
  // stickiness: measured where there is a pair, else their median, else
  // STICK_DEFAULT_UT.
  static float tan[NUM_GEARS + 1][3];
  static float hs[NUM_GEARS + 1];
  int nh = 0;
  for (int i = 1; i < NUM_GEARS; i++) {
    unitDir(pathPts, i - 1, i + 1, tan[i]);
    if (!(use & (1UL << i))) continue;
    float d[3] = { cal.pts[i][0] - cal.down[i][0], cal.pts[i][1] - cal.down[i][1], cal.pts[i][2] - cal.down[i][2] };
    hs[nh++] = dot3(d, tan[i]) - 2 * EDGE_BIAS_UT;
  }
  float stick = nh ? max(STICK_MIN_UT, medianOf(hs, nh)) : STICK_DEFAULT_UT;
  for (int i = 1; i < NUM_GEARS; i++) {
    const float* u = upForPath(i);
    float eu[3], ed[3];
    for (int k = 0; k < 3; k++) {
      eu[k] = u[k] - EDGE_BIAS_UT * tan[i][k];
      ed[k] = (use & (1UL << i)) ? cal.down[i][k] + EDGE_BIAS_UT * tan[i][k] : eu[k] - stick * tan[i][k];
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

static void calFinish();
static void calStorePoint(const float b[3]);
static void calOnTurn(const float avg[3]);
static void calCheck(bool print);

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
  return crank.ok && selfRevs > 0 && millis() - selfEventMs <= CADENCE_TIMEOUT_MS;
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
  stabSince = millis();
  stabPct = 0;
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
    Log.printf("\n[DOWN %d/%d] %s%sMove the lever DOWN to where the Keiser console FIRST shows "
               "gear %d, then hold it there.\n", DOWN_FIRST + 1 - calStep, DOWN_FIRST, keep,
               calRedo ? "Redo: first move the lever UP above this gear. " : "", calStep);
  } else if (calStep == 0) {
    Log.printf("\n[UP 1/%d] %sPush the gear lever ALL THE WAY DOWN and hold it there.\n", NUM_GEARS, keep);
  } else {
    Log.printf("\n[UP %d/%d] %s%sMove the lever up to where the Keiser console "
                  "FIRST shows gear %d, then %s\n", calStep + 1, NUM_GEARS, keep,
                  calRedo ? "Redo: first move the lever DOWN below this gear. " : "",
                  calStep + 1, crank.ok ? "hold it there." : "stop there.");
  }
  if (crank.ok) {
    Log.println(autoCapture ? F("It captures and beeps once 3 pedal turns agree.")
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
  calPass = PASS_UP;
  calDownMask = 0;
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
// against the console (CAL_CONFIRM), then per-turn calibration while
// pedalling; not found -> v2-style calibration with the flywheel still.
static void calLearnDone() {
  const LearnResult& r = learnLast;
  crank.ok = r.ok;                         // crankLearn() left the rest of `crank` set
  Log.printf("Crank: dip depth %.1f uT, %u turns (%u regular) at %.0f rpm in %.1f s: %s.\n",
             r.depth, r.turns, r.regular, r.rpm, learnCount * SAMPLE_PERIOD_MS / 1000.0f, r.why);
  Log.printf("L,%d,%u,%.0f,%.1f,%s\n", r.ok ? 1 : 0, r.turns, r.rpm, r.depth, r.why);
  if (r.ok) {
    Log.println(F("Crank learned. Check that the cadence matches the Keiser console:"));
    Log.println(F("press button A or send 'n' if it does, send 'l' to learn again."));
    playNotes(BEEP_LEARNED, 3);
    calState = CAL_CONFIRM;
    stabPct  = 100;
    return;
  }
  Log.println(F("Crank magnet not detected well enough (too far from the board?)."));
  Log.println(F("Continuing without it: stop pedalling at each point; cadence comes from a pod."));
  Log.println(F("Send 'l' to try learning the crank again."));
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

// The rider confirmed the cadence: on to the 25 points.
static void calConfirm() {
  if (calState != CAL_CONFIRM) return;
  Log.println(F("Cadence confirmed: keep pedalling (any steady pace) up through the gears, then back down."));
  playNotes(BEEP_CAPTURE, 1);
  calState = CAL_WAITING;
  calPrompt();
}

static void calAbort(const __FlashStringHelper* why) {
  bool fixing = calPass == PASS_FIX_UP || calPass == PASS_FIX_DOWN;
  backGate = false;
  calState = CAL_IDLE;
  calPass  = PASS_UP;
  if (fixing) {                                   // redoing one point: nothing changed
    Log.print(F("Redo cancelled: "));
    Log.println(why);
    Log.print(F("A,"));
    Log.println(why);
    return;
  }
  loadCrankFromCal();
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
static bool calValidate(const float p[][3], float* span, float* minStep, int* minStepAt,
                        char* msg, size_t msgLen) {
  *span = 0; *minStep = 1e9f; *minStepAt = 1;
  for (int i = 1; i <= NUM_GEARS; i++) {
    float step = dist3(p[i], p[i - 1]);
    *span += step;
    if (step < *minStep) { *minStep = step; *minStepAt = i; }
  }
  if (*span < MIN_SPAN_UT) {
    Log.printf("Field path is only %.1f uT long across the full lever travel "
               "(need >= %.0f). Move the board closer to the magnet carrier.\n",
               *span, MIN_SPAN_UT);
    snprintf(msg, msgLen, "signal too small");
    return false;
  }
  if (*minStep < MIN_STEP_REJECT_UT) {
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
      if (d < FOLD_MARGIN_UT) {
        snprintf(msg, msgLen, "path folds back: point %d is %.1f uT from gear %d's segment",
                 k + 1, d, j + 1);
        return false;
      }
    }
  }
  return true;
}

// Check, store and save a calibration: a finished one (newCal: also takes the
// crank just learned) or an edit of the stored one. The top point is always
// worked out again from points 23 and 24.
static bool calCommit(const float up[][3], const float down[][3], uint32_t mask, bool newCal) {
  static float p[NUM_GEARS + 1][3];
  memcpy(p, up, sizeof(p));
  bool topKept = !newCal && calValid &&
                 !memcmp(p[NUM_GEARS - 2], cal.pts[NUM_GEARS - 2], 2 * sizeof(p[0]));
  if (topKept) memcpy(p[NUM_GEARS], cal.pts[NUM_GEARS], sizeof(p[0]));
  else synthTop(p);
  float span, minStep;
  int minStepAt;
  char msg[96];
  if (!calValidate(p, &span, &minStep, &minStepAt, msg, sizeof(msg))) {
    if (newCal) {
      calReject(msg, span, minStep, minStepAt);
    } else {
      Log.printf("Not saved: %s\n", msg);
      Log.printf("E,fail,%s\n", msg);
    }
    return false;
  }
  cal.magic = CAL_MAGIC;
  cal.version = CAL_VERSION;
  cal.reserved = 0;
  memcpy(cal.pts, p, sizeof(cal.pts));
  cal.downMask = mask & (((1UL << NUM_GEARS) - 1) & ~1UL);   // points 2-24 only
  memcpy(cal.down, down, sizeof(cal.down));
  if (newCal) {
    cal.crankOk    = crank.ok ? 1 : 0;
    cal.crankSign  = crank.sign;
    cal.pad        = 0;
    memcpy(cal.crankU, crank.u, sizeof(cal.crankU));
    cal.crankDepth = crank.depth;
    cal.crankBase  = crank.base;
  }
  calValid = true;
  calCheck(false);                                // flagged pairs stay out of the path
  buildPath();
  stableGear = pendingGear = 1;
  staging = false;
  bool saved = saveCalibration();
  if (newCal) {
    Log.printf("\n=== Calibration complete. Path %.1f uT, smallest step %.2f uT "
                  "(around gear %d). %s ===\n",
                  span, minStep, minStepAt, saved ? "Saved." : "SAVE FAILED (kept in RAM).");
    if (minStep < MIN_STEP_WARN_UT) {
      Log.println(F("Warning: some gears are very close together magnetically. "
                       "Mounting the board closer to the magnets will improve resolution."));
    }
    playNotes(BEEP_SAVED, 4);
  } else {
    Log.printf("Calibration updated. %s\n", saved ? "Saved." : "SAVE FAILED (kept in RAM).");
    Log.printf("E,ok,%s\n", saved ? "saved" : "save failed");
    playNotes(BEEP_CAPTURE, 1);
  }
  Log.printf("K,1,%.1f,%.2f,%d,%s\n", span, minStep, minStepAt, saved ? "saved" : "save failed");
  checkPrintPending = true;                       // F lines from loop(), not from deep in the sample path
  return true;
}

static void calReject(const char* msg, float span, float minStep, int minStepAt) {
  calState = CAL_IDLE;
  loadCrankFromCal();
  Log.printf("Calibration rejected: %s\n", msg);
  Log.printf("K,0,%.1f,%.2f,%d,%s\n", span, minStep, minStepAt, msg);
  if (calValid) Log.println(F("Previous calibration is still in use."));
  playNotes(BEEP_FAIL, 1);
}

static void calFinish() {
  calState = CAL_IDLE;
  calPass  = PASS_UP;
  if (calDownMask) Log.printf("Down pass: %d points.\n", __builtin_popcount(calDownMask));
  calCommit(calRaw, calDown, calDownMask, true);
}

// A redone point ('#R') was captured: put it in and save.
static void calFixStore(const float b[3]) {
  bool down = calPass == PASS_FIX_DOWN;
  calState = CAL_IDLE;
  calPass  = PASS_UP;
  Log.printf("  captured (%.1f, %.1f, %.1f) uT\n", b[0], b[1], b[2]);
  if (down) {
    Log.printf("C,down,%d,%.1f,%.1f,%.1f\n", calStep + 1, b[0], b[1], b[2]);
    memcpy(calDown[calStep], b, sizeof(calDown[0]));
    calDownMask |= 1UL << calStep;
  } else {
    Log.printf("C,%d,%.1f,%.1f,%.1f\n", calStep + 1, b[0], b[1], b[2]);
    memcpy(calRaw[calStep], b, sizeof(calRaw[0]));
  }
  calCommit(calRaw, calDown, calDownMask, false);
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
  calState = CAL_WAITING;
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

// Store a calibration point and move on (shared by both capture methods).
static void calStorePoint(const float b[3]) {
  calRedo = false;
  pendingCap = false;
  settleSince = 0;
  if (calPass == PASS_FIX_UP || calPass == PASS_FIX_DOWN) { calFixStore(b); return; }
  Log.printf("  captured (%.1f, %.1f, %.1f) uT\n", b[0], b[1], b[2]);
  if (calPass == PASS_DOWN) {
    memcpy(calDown[calStep], b, sizeof(calDown[0]));
    calDownMask |= 1UL << calStep;
    Log.printf("C,down,%d,%.1f,%.1f,%.1f\n", calStep + 1, b[0], b[1], b[2]);
    if (--calStep < 1) { calFinish(); return; }
  } else {
    memcpy(calRaw[calStep], b, sizeof(calRaw[calStep]));
    Log.printf("C,%d,%.1f,%.1f,%.1f\n", calStep + 1, b[0], b[1], b[2]);
    if (calStep == NUM_GEARS - 1) {              // point 24: work out the top, no need to pedal into the brake
      synthTop(calRaw);
      {
        float span, minStep;
        int minStepAt;
        char msg[96];
        if (!calValidate(calRaw, &span, &minStep, &minStepAt, msg, sizeof(msg))) {
          calReject(msg, span, minStep, minStepAt);
          return;
        }
      }
      Log.println(F("Top point worked out from gears 23 and 24."));
      Log.printf("C,%d,%.1f,%.1f,%.1f\n", NUM_GEARS + 1, calRaw[NUM_GEARS][0], calRaw[NUM_GEARS][1],
                 calRaw[NUM_GEARS][2]);
      if (!crank.ok) { calFinish(); return; }
      Log.println(F("\n=== Up pass done. Now come back DOWN through the gears ('s' saves without it). ==="));
      calPass = PASS_DOWN;
      calStep = DOWN_FIRST;
      calDownMask = 0;
    } else {
      calStep++;
    }
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
    memcpy(prev, calStep >= DOWN_FIRST ? calRaw[NUM_GEARS - 1] : calDown[calStep + 1], 3 * sizeof(float));
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

// Has the reading moved far enough past the previous point, the right way?
// Sends N,behind (once per point) when agreeing turns sit behind it.
static bool calMovedOn(const float mean[3], bool agreeing) {
  float prev[3], dir[3];
  bool hasDir;
  if (!calPrevRef(prev, dir, &hasDir)) return true;
  float d[3] = { mean[0] - prev[0], mean[1] - prev[1], mean[2] - prev[2] };
  float dist  = sqrtf(dot3(d, d));
  float along = hasDir ? dot3(d, dir) : dist;
  behindNow = hasDir && agreeing && along <= -BEHIND_UT;
  return dist >= TURN_MOVE_UT && along >= TURN_ALONG_UT;
}

// Agreeing turns sit behind the last point: it was saved too far (the lever
// overshot). Go back to it by itself and ask the rider to drop into the gear
// before it and come back; it is taken again once the reading has gone back
// at least halfway from the point before it (backGate).
static void calBackUp() {
  bool down = calPass == PASS_DOWN;
  bool can = down ? calStep < DOWN_FIRST : calStep >= 2;
  if (!can) {                                     // nothing to go back to: just say so, once
    if (!behindSent) {
      behindSent = true;
      Log.println(F("N,behind"));
    }
    return;
  }
  int bad = down ? calStep + 1 : calStep - 1;
  memcpy(backOld, down ? calDown[bad] : calRaw[bad], sizeof(backOld));
  if (down) calDownMask &= ~(1UL << bad);
  calStep = bad;
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
    Log.println(F("Now come back to the point and hold it there."));
    turnHistN = 0;
    pendingCap = false;
    stabPct = 0;
    return false;                                 // this turn was on the way back
  }
  stabPct = 0;
  return false;
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

// Redoing one point: it is only taken after the reading has been past it
// (the lower half of the gear below for an up point, the upper half of the
// gear above for a down point) and has come back out of there.
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
// agree within TURN_AGREE_UT and have moved on from the previous point, one
// more turn checks the lever has stopped; the point is the average of all 3.
static void calOnTurn(const float avg[3]) {
  if (calState != CAL_WAITING || !crank.ok) return;
  memcpy(lastTurnAvg, avg, sizeof(lastTurnAvg));
  if ((calPass == PASS_FIX_UP || calPass == PASS_FIX_DOWN) && !calFixGate(avg)) return;
  if (backGate && !calBackGate(avg)) return;
  // Couldn't settle for a while: stop and let the rider redo or capture anyway.
  if (settleSince && millis() - settleSince >= SETTLE_GIVEUP_MS) {
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
                   (drift >= SUSPECT_DRIFT_UT ||
                    (pendingCreep >= SUSPECT_CREEP_UT && drift >= SUSPECT_DRIFT_SLOW_UT));
    if (!suspect) {
      float m[3];
      for (int k = 0; k < 3; k++) m[k] = (pendingMean[k] * turnHistN + avg[k]) / (turnHistN + 1);
      if (dist3(avg, pendingMean) <= TURN_AGREE_UT && calMovedOn(m, false)) {   // the check turn agrees: average all 3
        stabPct = 100;
        calStorePoint(m);
        return;
      }
      // It disagrees without "still moving": an ordinary turn (below).
    } else {
      // Still changing: drop this capture, ask to hold still, agree afresh
      // starting from this turn (the newest position).
      if (!settleSince) {
        settleSince = millis() ? millis() : 1;
        Log.printf("\nPoint %d: the reading is still changing - hold the lever still.\n", calStep + 1);
        playNotes(BEEP_UNDO, 3);
      }
      Log.printf("W,%d,%.1f,%.1f\n", calStep + 1, drift, pendingCreep);
      turnHistN = 0;
      memcpy(turnHist[turnHistN++], avg, sizeof(turnHist[0]));
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
    if (spread <= TURN_AGREE_UT) break;
    memmove(turnHist[0], turnHist[1], (turnHistN - 1) * sizeof(turnHist[0]));
    turnHistN--;
  }
  float mean[3];
  turnHistMean(mean);
  bool moved = calMovedOn(mean, turnHistN >= 2);
  if (behindNow && (calPass == PASS_UP || calPass == PASS_DOWN)) { calBackUp(); return; }
  stabPct = moved ? (turnHistN >= 2 ? 67 : 34) : 0;
  if (moved && autoCapture && turnHistN == 2) {
    // Don't store yet: check one more turn (calOnTurn above).
    memcpy(pendingMean, mean, sizeof(pendingMean));
    calTravelDir(mean, pendingDir);
    memcpy(pendingFirst, turnHist[0], sizeof(pendingFirst));
    pendingCap = true;
  }
}

static void calCapture() {
  if (calState == CAL_CONFIRM) { calConfirm(); return; }   // 'n' / button A also confirms
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
    if (turnHistN == 0) {
      Log.println(F("No full pedal turn yet - keep pedalling."));
      Log.println(F("N,noturn"));
      return;
    }
    if (((calPass == PASS_FIX_UP || calPass == PASS_FIX_DOWN) && !fixArmed) || backGate) {
      Log.println(F("Not captured: first move the lever past this point, then come back."));
      Log.println(F("N,notmoved"));
      return;
    }
    float mean[3];
    turnHistMean(mean);
    if (!calMovedOn(mean, false)) {
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
  if (calState == CAL_POINT_CHECK) {           // redo the point that wouldn't settle
    calState = CAL_WAITING;
    calRedo  = true;
    fixArmed = false;                            // a redone point: go past it again first
    Log.printf("Redo point %d.\n", calStep + 1);
    Log.printf(calPass == PASS_DOWN ? "U,%d,d\n" : "U,%d\n", calStep);
    playNotes(BEEP_UNDO, 3);
    calPrompt();
    return;
  }
  if (calState != CAL_WAITING) return;
  if (calPass == PASS_DOWN) {
    if (calStep < DOWN_FIRST) {
      calStep++;
      calDownMask &= ~(1UL << calStep);
      Log.printf("Undo: back to coming down to gear %d.\n", calStep);
      Log.printf("U,%d,d\n", calStep);
    } else {                                      // back into the up pass, point 24
      calPass = PASS_UP;
      calStep = NUM_GEARS - 1;
      Log.printf("Undo: back to point %d.\n", calStep + 1);
      Log.printf("U,%d\n", calStep);
    }
    playNotes(BEEP_UNDO, 3);
    calPrompt();
    return;
  }
  if (calPass != PASS_UP || calStep == 0) return;
  calStep--;
  Log.printf("Undo: back to point %d.\n", calStep + 1);
  Log.printf("U,%d\n", calStep);
  playNotes(BEEP_UNDO, 3);
  calPrompt();
}

// 's': save now without the rest of the down pass.
static void calSkipDown() {
  if (calPass != PASS_DOWN || (calState != CAL_WAITING && calState != CAL_POINT_CHECK)) return;
  Log.println(F("Saving without the rest of the down pass."));
  calFinish();
}

// Auto-capture (no crank magnet): field held steady, and moved away from the previous point.
static void calAutoCheck() {
  if (crank.ok) return;                        // per-turn capture instead
  if (calState != CAL_WAITING) { stabPct = 0; return; }
  if (dist3(fieldUT, stabRef) > AUTO_STABLE_UT) { stabReset(); return; }
  bool moved = calStep == 0 || dist3(fieldUT, calRaw[calStep - 1]) >= AUTO_MIN_MOVE_UT;
  if (!moved) { stabSince = millis(); stabPct = 0; return; }
  uint32_t held = millis() - stabSince;
  stabPct = held >= AUTO_STABLE_MS ? 100 : (uint8_t)(held * 100 / AUTO_STABLE_MS);
  if (autoCapture && held >= AUTO_STABLE_MS) calCapture();
}

// Stored calibration as machine-readable Q lines (command 'k').
static void dumpCalibration() {
  if (!calValid) { Log.println(F("Q,none")); return; }
  float span = 0, minStep = 1e9f;
  int   minStepAt = 1;
  for (int i = 0; i <= NUM_GEARS; i++) {
    Log.printf("Q,%d,%.1f,%.1f,%.1f\n", i + 1, cal.pts[i][0], cal.pts[i][1], cal.pts[i][2]);
    if (i > 0) {
      float step = dist3(cal.pts[i], cal.pts[i - 1]);
      span += step;
      if (step < minStep) { minStep = step; minStepAt = i; }
    }
  }
  for (int i = 1; i < NUM_GEARS; i++) {
    if (cal.downMask & (1UL << i))
      Log.printf("Q,down,%d,%.1f,%.1f,%.1f\n", i + 1, cal.down[i][0], cal.down[i][1], cal.down[i][2]);
  }
  if (cal.crankOk) {
    Log.printf("Q,crank,%.4f,%.4f,%.4f,%.1f,%d\n", cal.crankU[0], cal.crankU[1], cal.crankU[2],
               cal.crankDepth, cal.crankSign);
  }
  Log.printf("Q,end,%.1f,%.2f,%d\n", span, minStep, minStepAt);
  calPrintCheck();
}

// ---------------------------------------------------------------------------
// The check after a save: points that don't fit, each with a best guess.
// Deliberately conservative: Keiser's gears are unevenly spaced in the field,
// so only clear failures are flagged, and nothing is changed by itself.
// ---------------------------------------------------------------------------
static float medianOf(float* v, int n) {
  for (int i = 1; i < n; i++) {                  // insertion sort, n <= 23
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

// Points lo..hi of p, in the order they were measured (sign +1: up, -1: down):
// flag a point that isn't CHECK_BEHIND_UT past the one before. The later
// point is blamed (taken early), unless the step into the earlier one was
// unusually long (it overshot).
static void checkOrder(const float p[][3], int lo, int hi, int sign, uint32_t present, bool bad[],
                       const char* why[]) {
  const int last = NUM_GEARS - 1;
  for (int j = lo + 1; j <= hi; j++) {
    int i = sign > 0 ? j : hi + lo - j;          // this point
    int h = i - sign;                            // the one measured before it
    if (!(present & (1UL << i)) || !(present & (1UL << h))) continue;
    float dir[3];                                // local direction from the up path (cal points)
    int a = constrain(min(h, i) - 1, 0, last), b = constrain(max(h, i) + 1, 0, last);
    unitDir(cal.pts, sign > 0 ? a : b, sign > 0 ? b : a, dir);
    float d[3] = { p[i][0] - p[h][0], p[i][1] - p[h][1], p[i][2] - p[h][2] };
    if (dot3(d, dir) >= CHECK_BEHIND_UT) continue;
    // The usual step length nearby, leaving out the steps g-h and h-i.
    int g = h - sign;                            // the one measured before h
    float steps[8];
    int n = 0;
    for (int q = min(h, i) - 3; q < max(h, i) + 3 && n < 8; q++) {
      int r = q + 1;
      if (q < lo || r > hi || q == min(h, i) || q == min(g, h)) continue;
      if (!(present & (1UL << q)) || !(present & (1UL << r))) continue;
      steps[n++] = dist3(p[q], p[r]);
    }
    bool overshot = false;
    if (n >= 2 && g >= lo && g <= hi && (present & (1UL << g)))
      overshot = dist3(p[h], p[g]) > CHECK_OVERSHOOT * medianOf(steps, n);
    int blame = overshot ? h : i;
    if (!bad[blame]) { bad[blame] = true; why[blame] = "behind"; }
  }
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

static void calCheck(bool print);

// The latest check's results as F lines (and readable lines on USB).
static void calPrintCheck() {
  checkPrintPending = false;
  if (!calValid) { Log.println(F("F,end,0")); return; }
  for (uint8_t n = 0; n < suspectN; n++) {
    const Suspect& s = suspects[n];
    if (s.pass == 'u') {
      Serial.printf("Check: gear %d (going up) %s. Best guess (%.1f, %.1f, %.1f). Redo: '#R,u,%d'  use the guess: '#G,u,%d'\n",
                    s.point, strcmp(s.why, "behind") ? "doesn't match its down reading" : "isn't past the gear before it",
                    s.guess[0], s.guess[1], s.guess[2], s.point, s.point);
    } else {
      Serial.printf("Check: gear %d (coming down) %s. Best guess (%.1f, %.1f, %.1f). Redo: '#R,d,%d'  use the guess: '#G,d,%d'\n",
                    s.point - 1, strcmp(s.why, "behind") ? "doesn't match its up reading" : "isn't past the gear before it",
                    s.guess[0], s.guess[1], s.guess[2], s.point, s.point);
    }
    Log.printf("F,%c,%d,%s,%.1f,%.1f,%.1f\n", s.pass, s.point, s.why, s.guess[0], s.guess[1], s.guess[2]);
  }
  if (!suspectN) Serial.println(F("Check: all points fit."));
  Log.printf("F,end,%u\n", suspectN);
}

static void calCheck(bool print) {
  suspectN = 0;
  if (!calValid) { if (print) calPrintCheck(); return; }
  const int last = NUM_GEARS - 1;                 // point 24; the top is worked out
  const uint32_t upMask = ((1UL << NUM_GEARS) - 1);
  bool badU[NUM_GEARS + 1] = {false}, badD[NUM_GEARS + 1] = {false};
  const char* whyU[NUM_GEARS + 1];
  const char* whyD[NUM_GEARS + 1];
  checkOrder(cal.pts, 0, last, +1, upMask, badU, whyU);
  if (cal.downMask) checkOrder(cal.down, 1, DOWN_FIRST, -1, cal.downMask, badD, whyD);

  // Up/down pairs: the offset (up - down) should be much the same everywhere.
  static float off[NUM_GEARS + 1][3];
  float med[3] = {0, 0, 0};
  int nPairs = 0;
  for (int i = 1; i <= DOWN_FIRST; i++) {
    if (!(cal.downMask & (1UL << i))) continue;
    for (int k = 0; k < 3; k++) off[i][k] = cal.pts[i][k] - cal.down[i][k];
    nPairs++;
  }
  if (nPairs >= 3) {
    float v[NUM_GEARS + 1];
    int clean = 0;
    for (int i = 1; i <= DOWN_FIRST; i++) if ((cal.downMask & (1UL << i)) && !badU[i] && !badD[i]) clean++;
    for (int k = 0; k < 3; k++) {
      int n = 0;
      for (int i = 1; i <= DOWN_FIRST; i++)
        if ((cal.downMask & (1UL << i)) && (clean < 3 || (!badU[i] && !badD[i]))) v[n++] = off[i][k];
      med[k] = n ? medianOf(v, n) : 0;
    }
    bool goodU[NUM_GEARS + 1], goodD[NUM_GEARS + 1];
    for (int i = 0; i <= NUM_GEARS; i++) {
      goodU[i] = i <= last && !badU[i];
      goodD[i] = (cal.downMask & (1UL << i)) && !badD[i];
    }
    for (int i = 1; i <= DOWN_FIRST; i++) {
      if (!(cal.downMask & (1UL << i)) || badU[i] || badD[i]) continue;
      float e[3] = { off[i][0] - med[0], off[i][1] - med[1], off[i][2] - med[2] };
      float dev = sqrtf(dot3(e, e));
      float scale = min(dist3(cal.pts[i], cal.pts[i - 1]), dist3(cal.pts[i + 1], cal.pts[i]));
      if (dev <= max(CHECK_UPDOWN_UT, CHECK_UPDOWN_FRAC * scale)) continue;
      // Which one is off? The one farther from where its neighbours put it.
      float gu[3], gd[3];
      bool hu = interpPoint(cal.pts, goodU, 0, last, i, gu);
      bool hd = interpPoint(cal.down, goodD, 1, DOWN_FIRST, i, gd);
      float eu = hu ? dist3(cal.pts[i], gu) : 0, ed = hd ? dist3(cal.down[i], gd) : 0;
      if (eu >= ed) { badU[i] = true; whyU[i] = "updown"; }
      else          { badD[i] = true; whyD[i] = "updown"; }
    }
  }

  // Best guesses: the other pass plus the usual offset, else interpolated.
  bool goodU[NUM_GEARS + 1], goodD[NUM_GEARS + 1];
  for (int i = 0; i <= NUM_GEARS; i++) {
    goodU[i] = i <= last && !badU[i];
    goodD[i] = (cal.downMask & (1UL << i)) && !badD[i];
  }
  for (int i = 1; i <= last; i++) {
    if (!badU[i]) continue;
    float g[3];
    if (nPairs >= 3 && goodD[i]) for (int k = 0; k < 3; k++) g[k] = cal.down[i][k] + med[k];
    else if (!interpPoint(cal.pts, goodU, 0, last, i, g)) memcpy(g, cal.pts[i], sizeof(g));
    addSuspect('u', i, whyU[i], g);
  }
  for (int i = 1; i <= DOWN_FIRST; i++) {
    if (!badD[i]) continue;
    float g[3];
    if (nPairs >= 3 && goodU[i]) for (int k = 0; k < 3; k++) g[k] = cal.pts[i][k] - med[k];
    else if (!interpPoint(cal.down, goodD, 1, DOWN_FIRST, i, g)) memcpy(g, cal.down[i], sizeof(g));
    addSuspect('d', i, whyD[i], g);
  }

  if (print) calPrintCheck();
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
  if (off > OFFPATH_HOLD_UT) {
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
static void onTurnBoundary(int result, const float avg[3], uint32_t periodMs, uint32_t now) {
  selfRevs++;
  selfEventMs = now;
  if (result != 2) {                            // first turn after a pause
    selfPeriods[0] = selfPeriods[1] = 0;
    return;
  }
  selfPeriods[1] = selfPeriods[0];
  selfPeriods[0] = periodMs;
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

static void processSample(const Sample& smp) {
  saturated = smp.sat;
  const float* raw = smp.raw;
  recOnSample(raw, smp.ms);

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
      crHaveBoundary = false;
    }
    int r = crankSample(smp.ms, raw, avg, &per);
    if (r) onTurnBoundary(r, avg, per, smp.ms);
  }

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
  Log.println(F("          s=save now, without the rest of the down pass"));
  Log.println(F("          a=auto-capture on/off  d=live data on/off"));
  Log.println(F("          r=fast raw data (USB)  p=show calibration  h=help"));
  Log.println(F("          g/m/e/y=diagnostics record/mark/stop/send  k=calibration data + check"));
  Log.println(F("          t=one line per pedal turn on/off"));
  Log.println(F("          #R,u,N / #R,d,N = redo point N going up / coming down (pedalling)"));
  Log.println(F("          #G,u,N / #G,d,N = use the check's best guess for point N"));
  Log.println(F("          #P,u|d,N,x,y,z  then #W = load points (USB), #X = discard"));
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
static void handleShortPress() {
  if (calState == CAL_WAITING || calState == CAL_CONFIRM || calState == CAL_POINT_CHECK) calCapture();
}

static void handleLongPress() {
  if (calState == CAL_IDLE) calStart();
  else calAbort(F("cancelled by user"));
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
    case 'x': if (calState != CAL_IDLE) calAbort(F("cancelled by user")); break;
    case 's': calSkipDown(); break;
    case 'a':
      autoCapture = !autoCapture;
      Log.println(autoCapture ? F("Auto-capture ON.") : F("Auto-capture OFF."));
      break;
    case 'd': debugStream = !debugStream; break;
    case 'r': rawStream = !rawStream; break;
    case 't': turnStream = !turnStream; break;
    case '1': statusStream = true; break;
    case '0': statusStream = false; break;
    case 'p': printCalibration(); break;
    case 'k': dumpCalibration(); break;
    case 'g': recStart(); break;
    case 'm': recMark(); break;
    case 'e': recStop(false); break;
    case 'y': recDumpStart(); break;
    case 'h': case '?': printHelp(); break;
    default: break;                            // ignores newlines, spaces
  }
}

// '#' line commands (bench/PROTOCOL.md): pass is 'u' or 'd', point is 1-based.
static void handleLine(char* line) {
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
      calCommit(calRaw, calDown, calDownMask, false);
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
    calCommit(stageUp, stageDown, stageMask, false);   // clears staging when it saves
  } else if (cmd == 'X' && n == 1) {
    staging = false;
    Log.println(F("E,ok,discarded"));
  } else {
    Log.println(F("E,fail,unknown command"));
  }
}

// One input character: '#' starts a line command (ended by a newline),
// anything else is a single-character command.
static void handleInput(LineIn& in, int ch) {
  uint32_t now = millis();
  if (in.active && now - in.lastMs > LINE_TIMEOUT_MS) in.active = false;   // half a line: drop it
  in.lastMs = now;
  if (in.active) {
    if (ch == '\n' || ch == '\r') {
      in.buf[in.n] = '\0';
      in.active = false;
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
  handleCommand(ch);
}

// Commands arrive from USB serial or from the phone app's UART screen.
static void pollCommands() {
  while (Serial.available())  handleInput(usbIn, Serial.read());
  while (bleuart.available()) handleInput(bleIn, bleuart.read());
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
  char flags[14];
  int n = 0;
  if (calValid)                          flags[n++] = 'V';
  if (podConn != BLE_CONN_HANDLE_INVALID) flags[n++] = 'P';
  if (powerSubscribers > 0)              flags[n++] = 'Z';
  if (saturated)                         flags[n++] = 'S';
  if (offPathHold)                       flags[n++] = 'H';
  if (autoCapture)                       flags[n++] = 'A';
  if (recording)                         flags[n++] = 'G';
  if (dumpPos >= 0)                      flags[n++] = 'Y';
  if (pedalling())                       flags[n++] = 'R';
  if (settleSince && calState == CAL_WAITING) flags[n++] = 'M';   // hold the lever still
  bool fixing = calPass == PASS_FIX_UP || calPass == PASS_FIX_DOWN;
  if (calState == CAL_WAITING && ((fixing && !fixArmed) || backGate)) flags[n++] = 'B';   // go back past the point first
  flags[n] = '\0';
  const char* pass = calState == CAL_IDLE ? "-" : calPass == PASS_DOWN ? "d"
                   : calPass == PASS_FIX_UP ? "ru" : calPass == PASS_FIX_DOWN ? "rd" : "u";
  Log.printf("S,%d,%.1f,%.0f,%.1f,%d,%d,%d,%.1f,%s,%u,%c,%u,%s\n",
             calValid ? stableGear : 0, resistance, powerW, cadenceRpm,
             (int)calState, calStep, stabPct, offPath, flags, recCount, cadenceSource(),
             calState == CAL_LEARN ? learnLast.turns : 0, pass);
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

  Log.println(F("\nKeiser M3 magnetometer bridge v3.2"));

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
  if (calValid) { calCheck(false); buildPath(); }
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
  while (xQueueReceive(sampleQueue, &smp, 0) == pdTRUE) processSample(smp);

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
  recDumpStep();
  if (checkPrintPending) calPrintCheck();

  pollButton();
  pollCommands();
  updateLed();
  updateSpeaker();
  speakerTail();
  watchdogFeed();
  delay(2);   // yield to the BLE stack / FreeRTOS
}
