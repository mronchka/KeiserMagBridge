/*
 * KeiserMagBridge_v3_1.ino
 * -------------------------------------------------------------------------
 * Passive, zero-solder Bluetooth power bridge for a Keiser M3 indoor bike.
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
static const float    HYST_FRACTION      = 0.20f; // gear hysteresis, fraction of gear width
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
static const float    LEARN_MAX_RPM      = 160.0f;// faster: counting twice per turn
// Crank-magnet turn detector (same values as bench/replay_v3.py).
static const float    CRANK_MIN_DEPTH_UT = 8.0f;  // weaker dips: crank too far away to use
static const float    DIP_FRAC           = 0.5f;  // dip when below baseline by this x depth
static const float    REARM_FRAC         = 0.25f; // turn boundary when back above this x depth
static const uint32_t REFRACT_MS         = 200;   // ignore dips closer than this (300 rpm)
static const uint32_t STALL_MIN_MS       = 1200;  // no turn for max(2.5 x period, this): resync
static const float    QEMA_TAU_MS        = 1000;  // running mean used while resyncing
static const float    DEPTH_ADAPT        = 0.1f;  // slow tracking of the dip depth
static const float    TURN_AGREE_UT      = 2.0f;  // auto-capture: 3 turns within this
static const float    TURN_MOVE_UT       = 1.0f;  // ...and this far from the previous point

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
static const uint16_t CAL_VERSION = 3;           // v3: path of points + crank

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
};

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
enum CalState { CAL_IDLE, CAL_WAITING, CAL_CAPTURING, CAL_LEARN, CAL_CONFIRM };
static CalState  calState   = CAL_IDLE;
static int       calStep    = 0;
static float     calRaw[NUM_GEARS + 1][3];
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
static uint32_t  lastSampleMs = 0, lastNotifyMs = 0, lastDebugMs = 0, lastStatusMs = 0;

// =========================================================================
// Console output: everything printed goes to USB serial AND, when a phone
// is connected with the Bluefruit Connect app, to its UART screen.
// =========================================================================
class DualLog : public Print {
 public:
  void begin() { mutex_ = xSemaphoreCreateMutex(); }

  size_t write(uint8_t c) override {
    Serial.write(c);
    uint16_t conn = phoneConn;
    if (conn == BLE_CONN_HANDLE_INVALID || mutex_ == nullptr) return 1;
    xSemaphoreTake(mutex_, portMAX_DELAY);
    buf_[n_++] = c;
    // Send a whole line per notification (the stack splits it to the
    // connection's packet size), so fewer, larger sends.
    if (c == '\n' || n_ >= sizeof(buf_)) sendLocked(conn);
    xSemaphoreGive(mutex_);
    return 1;
  }
  using Print::write;

 private:
  void sendLocked(uint16_t conn) {
    if (n_ && bleuart.notifyEnabled(conn)) bleuart.write(conn, buf_, n_);
    n_ = 0;
  }
  SemaphoreHandle_t mutex_ = nullptr;
  uint8_t buf_[160];
  size_t  n_ = 0;
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
  bool ok = (f.read(&tmp, sizeof(tmp)) == (int)sizeof(tmp)) &&
            tmp.magic == CAL_MAGIC && tmp.version == CAL_VERSION;
  f.close();
  if (ok) cal = tmp;
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
  Log.println(F("Calibration path (point, Keiser resistance, field uT, step uT):"));
  for (int i = 0; i <= NUM_GEARS; i++) {
    float step = i ? dist3(cal.pts[i], cal.pts[i - 1]) : 0;
    Log.printf("  %2d  R=%6.2f  (%7.1f,%7.1f,%7.1f)  %5.2f\n", i + 1, GEAR_EDGES[i],
               cal.pts[i][0], cal.pts[i][1], cal.pts[i][2], step);
  }
}

static void calFinish();
static void calStorePoint(const float b[3]);
static void calOnTurn(const float avg[3]);

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
    if (crankSample(1 + i * SAMPLE_PERIOD_MS, learnBuf[i], avg, &per) == 2 && turns < maxTurns)
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
  const char* keep = crank.ok ? "Keep pedalling. " : "";
  if (calStep == 0) {
    Log.printf("\n[CAL 1/25] %sPush the gear lever ALL THE WAY DOWN.\n", keep);
  } else if (calStep < NUM_GEARS) {
    Log.printf("\n[CAL %d/25] %sMove the lever UP slowly until the Keiser console "
                  "FIRST shows gear %d. %s\n", calStep + 1, keep, calStep + 1,
                  crank.ok ? "Hold it there." : "Stop there.");
  } else {
    Log.printf("\n[CAL 25/25] %sPush the gear lever ALL THE WAY UP.\n", keep);
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
  stabReset();
}

static void calLearnStart() {
  calState   = CAL_LEARN;
  calStep    = 0;
  learnCount = 0;
  crank.ok   = false;                     // re-learned for this calibration
  stabPct    = 0;
  learnLast  = { false, 0, 0, 0, 0, "no signal" };
  Log.println(F("Pedal steadily at 60-80 rpm so the bridge can learn your crank (5-15 s)."));
}

static void calStart() {
  Log.println(F("\n=== Calibration started (hold button 3 s or send 'x' to abort, 'u' to undo) ==="));
  calLearnStart();
}

// Learn the crank again: after the cadence check, or at point 1 of a
// calibration that fell back to the hold-still method.
static void calRelearn() {
  if (calState != CAL_CONFIRM && !(calState == CAL_WAITING && calStep == 0)) return;
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
  Log.println(F("Cadence confirmed: keep pedalling through all 25 points."));
  playNotes(BEEP_CAPTURE, 1);
  calState = CAL_WAITING;
  calPrompt();
}

static void calAbort(const __FlashStringHelper* why) {
  calState = CAL_IDLE;
  loadCrankFromCal();
  Log.print(F("Calibration aborted: "));
  Log.println(why);
  Log.print(F("A,"));
  Log.println(why);
  if (calValid) Log.println(F("Previous calibration is still in use."));
  playNotes(BEEP_FAIL, 1);
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

  // Path length and smallest gap between consecutive points.
  float span = 0, minStep = 1e9f;
  int   minStepAt = 1;
  for (int i = 1; i <= NUM_GEARS; i++) {
    float step = dist3(calRaw[i], calRaw[i - 1]);
    span += step;
    if (step < minStep) { minStep = step; minStepAt = i; }
  }
  char msg[96];

  if (span < MIN_SPAN_UT) {
    Log.printf("Field path is only %.1f uT long across the full lever travel "
               "(need >= %.0f). Move the board closer to the magnet carrier.\n",
               span, MIN_SPAN_UT);
    calReject("signal too small", span, minStep, minStepAt);
    return;
  }
  if (minStep < MIN_STEP_REJECT_UT) {
    snprintf(msg, sizeof(msg), "points %d and %d are the same - did the lever move?",
             minStepAt, minStepAt + 1);
    calReject(msg, span, minStep, minStepAt);
    return;
  }
  // The path must not come back close to itself, or two lever positions
  // would look the same. Check each point against segments at least one
  // point away (nearer ones are within one small step by construction).
  for (int k = 0; k <= NUM_GEARS; k++) {
    for (int j = 0; j < NUM_GEARS; j++) {
      if (j >= k - 2 && j <= k + 1) continue;
      float d = distToSegment(calRaw[k], calRaw[j], calRaw[j + 1], nullptr);
      if (d < FOLD_MARGIN_UT) {
        snprintf(msg, sizeof(msg), "path folds back: point %d is %.1f uT from gear %d's segment",
                 k + 1, d, j + 1);
        calReject(msg, span, minStep, minStepAt);
        return;
      }
    }
  }

  cal.magic = CAL_MAGIC;
  cal.version = CAL_VERSION;
  cal.reserved = 0;
  memcpy(cal.pts, calRaw, sizeof(cal.pts));
  cal.crankOk    = crank.ok ? 1 : 0;
  cal.crankSign  = crank.sign;
  cal.pad        = 0;
  memcpy(cal.crankU, crank.u, sizeof(cal.crankU));
  cal.crankDepth = crank.depth;
  cal.crankBase  = crank.base;
  calValid = true;
  stableGear = pendingGear = 1;
  bool saved = saveCalibration();
  Log.printf("\n=== Calibration complete. Path %.1f uT, smallest step %.2f uT "
                "(around gear %d). %s ===\n",
                span, minStep, minStepAt, saved ? "Saved." : "SAVE FAILED (kept in RAM).");
  if (minStep < MIN_STEP_WARN_UT) {
    Log.println(F("Warning: some gears are very close together magnetically. "
                     "Mounting the board closer to the magnets will improve resolution."));
  }
  Log.printf("K,1,%.1f,%.2f,%d,%s\n", span, minStep, minStepAt, saved ? "saved" : "save failed");
  playNotes(BEEP_SAVED, 4);
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
  memcpy(calRaw[calStep], b, sizeof(calRaw[calStep]));
  Log.printf("  captured (%.1f, %.1f, %.1f) uT\n", b[0], b[1], b[2]);
  Log.printf("C,%d,%.1f,%.1f,%.1f\n", calStep + 1, b[0], b[1], b[2]);
  if (++calStep > NUM_GEARS) { calFinish(); return; }
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

// Calibration while pedalling: each completed turn. Captures once 3 turns
// in a row agree within TURN_AGREE_UT and differ from the previous point.
static void calOnTurn(const float avg[3]) {
  if (calState != CAL_WAITING || !crank.ok) return;
  if (turnHistN == 3) {                        // keep the most recent turns
    memmove(turnHist[0], turnHist[1], 2 * sizeof(turnHist[0]));
    turnHistN = 2;
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
  bool moved = calStep == 0 || dist3(mean, calRaw[calStep - 1]) >= TURN_MOVE_UT;
  stabPct = moved ? (uint8_t)min(100, turnHistN * 34) : 0;
  if (moved && autoCapture && turnHistN == 3) calStorePoint(mean);
}

static void calCapture() {
  if (calState == CAL_CONFIRM) { calConfirm(); return; }   // 'n' / button A also confirms
  if (calState != CAL_WAITING) return;
  // Manual captures get the same "the lever moved" check as auto-capture.
  if (crank.ok) {                              // manual capture while pedalling
    if (turnHistN == 0) {
      Log.println(F("No full pedal turn yet - keep pedalling."));
      Log.println(F("N,noturn"));
      return;
    }
    float mean[3];
    turnHistMean(mean);
    if (calStep > 0 && dist3(mean, calRaw[calStep - 1]) < TURN_MOVE_UT) {
      Log.println(F("Not captured: the lever hasn't moved from the previous point."));
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
  if (calState != CAL_WAITING || calStep == 0) return;
  calStep--;
  Log.printf("Undo: back to point %d.\n", calStep + 1);
  Log.printf("U,%d\n", calStep);
  playNotes(BEEP_UNDO, 3);
  calPrompt();
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
  if (cal.crankOk) {
    Log.printf("Q,crank,%.4f,%.4f,%.4f,%.1f,%d\n", cal.crankU[0], cal.crankU[1], cal.crankU[2],
               cal.crankDepth, cal.crankSign);
  }
  Log.printf("Q,end,%.1f,%.2f,%d\n", span, minStep, minStepAt);
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
  float res = locateOnPath(cal.pts, b, &off);
  offPath = off;
  if (off > OFFPATH_HOLD_UT) {
    if (!offPathHold) { offPathHold = true; offPathSince = now; }
    if (now - offPathSince < OFFPATH_HOLD_MAX_MS) return;   // keep last gear
  } else {
    offPathHold = false;
  }
  resistance = res;

  int candidate = stableGear;
  float lo = GEAR_EDGES[stableGear - 1];
  float hi = GEAR_EDGES[stableGear];
  float band = HYST_FRACTION * (hi - lo);
  if (resistance < lo - band || resistance >= hi + band) {
    candidate = NUM_GEARS;
    for (int g = 1; g <= NUM_GEARS; g++) {
      if (resistance < GEAR_EDGES[g]) { candidate = g; break; }
    }
  }
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
  Log.println(F("          a=auto-capture on/off  d=live data on/off"));
  Log.println(F("          r=fast raw data (USB)  p=show calibration  h=help"));
  Log.println(F("          g/m/e/y=diagnostics record/mark/stop/send  k=calibration data"));
  Log.println(F("          t=one line per pedal turn on/off"));
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
  }
  Log.printf("[BLE] App disconnected (0x%02X)\n", reason);
}

// The phone counts as "the console" once its UART screen subscribes.
static void uartNotifyCb(uint16_t conn, bool enabled) {
  if (enabled) {
    phoneConn = conn;
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
  if (calState == CAL_WAITING || calState == CAL_CONFIRM) calCapture();
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

// Commands arrive from USB serial or from the phone app's UART screen.
static void pollCommands() {
  while (Serial.available())  handleCommand(Serial.read());
  while (bleuart.available()) handleCommand(bleuart.read());
}

// =========================================================================
// Status LED and debug output
// =========================================================================
static void updateLed() {
  uint32_t now = millis();
  bool on;
  if (calState != CAL_IDLE)  on = (calState == CAL_WAITING || calState == CAL_CONFIRM);
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
  char flags[12];
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
  flags[n] = '\0';
  Log.printf("S,%d,%.1f,%.0f,%.1f,%d,%d,%d,%.1f,%s,%u,%c,%u\n",
             calValid ? stableGear : 0, resistance, powerW, cadenceRpm,
             (int)calState, calStep, stabPct, offPath, flags, recCount, cadenceSource(),
             calState == CAL_LEARN ? learnLast.turns : 0);
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

  Log.println(F("\nKeiser M3 magnetometer bridge v3.1"));

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
  xTaskCreate(sensorTask, "mag", 1024, nullptr, TASK_PRIO_NORMAL, nullptr);

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

  pollButton();
  pollCommands();
  updateLed();
  updateSpeaker();
  speakerTail();
  watchdogFeed();
  delay(2);   // yield to the BLE stack / FreeRTOS
}
