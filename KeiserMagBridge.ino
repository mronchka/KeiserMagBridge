/*
 * KeiserMagBridge.ino
 * -------------------------------------------------------------------------
 * Passive, zero-solder Bluetooth power bridge for a Keiser M3 indoor bike.
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
 * Connect" app: connect to "Keiser M3 Bridge", open UART, type a command.
 *   Hold button 3 s / send 'c'  -> start calibration
 *   Short press   / send 'n'    -> capture current calibration point
 *   Hold button 3 s / send 'x'  -> abort calibration (while calibrating)
 *   send 'd'                    -> toggle live debug stream
 *   send 'p'                    -> print stored calibration
 *   send 'h'                    -> list commands
 * The phone and Zwift can be connected at the same time.
 *
 * Red LED:  slow blink = not calibrated | fast blink = magnetometer
 *           saturating (move board farther from magnets) | solid during
 *           calibration = waiting for you to press | off = running normally.
 * Blue LED: Bluefruit connection LED (blinks while advertising to Zwift).
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

static const float    EMA_ALPHA          = 0.15f; // field smoothing (~130 ms)
static const float    HYST_FRACTION      = 0.20f; // gear hysteresis, fraction of gear width
static const uint32_t GEAR_DWELL_MS      = 150;   // new gear must hold this long
static const uint32_t CADENCE_TIMEOUT_MS = 3000;  // no crank event -> 0 rpm
static const uint16_t CAPTURE_SAMPLES    = 32;    // samples averaged per cal point
static const uint32_t LONG_PRESS_MS      = 3000;

static const float    MIN_SPAN_UT        = 20.0f; // min field change, gear 1->24
static const float    MIN_STEP_WARN_UT   = 1.5f;  // warn if two gears this close
static const int16_t  SATURATION_RAW     = 26000; // ~15 gauss on the 16 gauss range

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
static const uint16_t CAL_VERSION = 1;

struct CalData {
  uint32_t magic;
  uint16_t version;
  uint16_t reserved;
  float    origin[3];             // field (uT) with lever fully down
  float    axis[3];               // unit vector, lever down -> lever up
  float    s[NUM_GEARS + 1];      // projected field at each GEAR_EDGES point
};

static CalData cal;
static bool    calValid = false;

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
static int       stableGear   = 1;          // debounced 1-24
static int       pendingGear  = 1;
static uint32_t  pendingSince = 0;
static float     powerW       = 0.0f;
static float     cadenceRpm   = 0.0f;

// Calibration state machine
enum CalState { CAL_IDLE, CAL_WAITING, CAL_CAPTURING };
static CalState  calState   = CAL_IDLE;
static int       calStep    = 0;
static float     calRaw[NUM_GEARS + 1][3];
static float     capSum[3];
static uint16_t  capCount   = 0;

// Misc
static bool      debugStream = false;
static uint32_t  lastSampleMs = 0, lastNotifyMs = 0, lastDebugMs = 0;

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
    // Send on newline, or when a BLE packet (20 bytes) is full.
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
  uint8_t buf_[20];
  size_t  n_ = 0;
};

static DualLog Log;

// =========================================================================
// Small helpers
// =========================================================================
static float dot3(const float a[3], const float b[3]) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
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
  Log.println(F("Calibration (edge index, Keiser resistance, projected uT):"));
  for (int i = 0; i <= NUM_GEARS; i++) {
    Log.printf("  %2d  R=%6.2f  s=%8.2f\n", i, GEAR_EDGES[i], cal.s[i]);
  }
  Log.printf("  origin = (%.1f, %.1f, %.1f) uT  axis = (%.3f, %.3f, %.3f)\n",
                cal.origin[0], cal.origin[1], cal.origin[2],
                cal.axis[0], cal.axis[1], cal.axis[2]);
}

// =========================================================================
// Calibration procedure
// =========================================================================
static void calPrompt() {
  if (calStep == 0) {
    Log.println(F("\n[CAL 1/25] Push the gear lever ALL THE WAY DOWN."));
  } else if (calStep < NUM_GEARS) {
    Log.printf("\n[CAL %d/25] Move the lever UP slowly until the Keiser console "
                  "FIRST shows gear %d. Stop there.\n", calStep + 1, calStep + 1);
  } else {
    Log.println(F("\n[CAL 25/25] Push the gear lever ALL THE WAY UP."));
  }
  Log.println(F("Flywheel still, then press button A or send 'n'."));
}

static void calStart() {
  calState = CAL_WAITING;
  calStep  = 0;
  Log.println(F("\n=== Calibration started (hold button 3 s or send 'x' to abort) ==="));
  calPrompt();
}

static void calAbort(const __FlashStringHelper* why) {
  calState = CAL_IDLE;
  Log.print(F("Calibration aborted: "));
  Log.println(why);
  if (calValid) Log.println(F("Previous calibration is still in use."));
}

static void calFinish() {
  calState = CAL_IDLE;

  CalData c;
  c.magic = CAL_MAGIC;
  c.version = CAL_VERSION;
  c.reserved = 0;

  // Axis = direction the field moves from lever-down to lever-up.
  float d[3], norm = 0;
  for (int k = 0; k < 3; k++) {
    c.origin[k] = calRaw[0][k];
    d[k] = calRaw[NUM_GEARS][k] - calRaw[0][k];
    norm += d[k] * d[k];
  }
  norm = sqrtf(norm);
  if (norm < MIN_SPAN_UT) {
    Log.printf("Field only changed %.1f uT across the full lever travel "
                  "(need >= %.0f). Move the board closer to the magnet carrier.\n",
                  norm, MIN_SPAN_UT);
    calAbort(F("signal too small"));
    return;
  }
  for (int k = 0; k < 3; k++) c.axis[k] = d[k] / norm;

  // Project every captured point onto that axis.
  float minStep = 1e9f;
  int   minStepAt = 0;
  for (int i = 0; i <= NUM_GEARS; i++) {
    float rel[3] = { calRaw[i][0] - c.origin[0],
                     calRaw[i][1] - c.origin[1],
                     calRaw[i][2] - c.origin[2] };
    c.s[i] = dot3(rel, c.axis);
    if (i > 0) {
      float step = c.s[i] - c.s[i - 1];
      if (step <= 0) {
        Log.printf("Point %d did not increase over point %d (%.2f -> %.2f uT). "
                      "Re-run calibration moving the lever in one direction only.\n",
                      i + 1, i, c.s[i - 1], c.s[i]);
        calAbort(F("non-monotonic readings"));
        return;
      }
      if (step < minStep) { minStep = step; minStepAt = i; }
    }
  }

  cal = c;
  calValid = true;
  stableGear = pendingGear = 1;
  bool saved = saveCalibration();
  Log.printf("\n=== Calibration complete. Span %.1f uT, smallest step %.2f uT "
                "(around gear %d). %s ===\n",
                norm, minStep, minStepAt, saved ? "Saved." : "SAVE FAILED (kept in RAM).");
  if (minStep < MIN_STEP_WARN_UT) {
    Log.println(F("Warning: some gears are very close together magnetically. "
                     "Mounting the board closer to the magnets will improve resolution."));
  }
}

static void calOnSample(const float b[3]) {
  if (calState != CAL_CAPTURING) return;
  if (saturated) { calAbort(F("magnetometer saturated - move the board farther away")); return; }
  for (int k = 0; k < 3; k++) capSum[k] += b[k];
  if (++capCount < CAPTURE_SAMPLES) return;

  for (int k = 0; k < 3; k++) calRaw[calStep][k] = capSum[k] / CAPTURE_SAMPLES;
  Log.printf("  captured (%.1f, %.1f, %.1f) uT\n",
                calRaw[calStep][0], calRaw[calStep][1], calRaw[calStep][2]);

  if (++calStep > NUM_GEARS) { calFinish(); return; }
  calState = CAL_WAITING;
  calPrompt();
}

static void calCapture() {
  if (calState != CAL_WAITING) return;
  capSum[0] = capSum[1] = capSum[2] = 0;
  capCount = 0;
  calState = CAL_CAPTURING;
}

// =========================================================================
// Sensor pipeline: raw -> median -> EMA -> resistance -> debounced gear
// =========================================================================
static void sampleMagnetometer() {
  lis3mdl.read();
  saturated = abs(lis3mdl.x) > SATURATION_RAW ||
              abs(lis3mdl.y) > SATURATION_RAW ||
              abs(lis3mdl.z) > SATURATION_RAW;

  float raw[3] = { lis3mdl.x_gauss * 100.0f,       // gauss -> microtesla
                   lis3mdl.y_gauss * 100.0f,
                   lis3mdl.z_gauss * 100.0f };

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

  calOnSample(fieldUT);
  if (!calValid) return;

  // 3) Project onto the calibrated axis, map to Keiser resistance 0-100.
  float rel[3] = { fieldUT[0] - cal.origin[0],
                   fieldUT[1] - cal.origin[1],
                   fieldUT[2] - cal.origin[2] };
  float s = dot3(rel, cal.axis);
  resistance = interpTable(cal.s, GEAR_EDGES, NUM_GEARS + 1, s);

  // 4) Gear with hysteresis band + dwell time.
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

  uint32_t now = millis();
  if (candidate == stableGear) {
    pendingGear = stableGear;
  } else if (candidate != pendingGear) {
    pendingGear = candidate;
    pendingSince = now;
  } else if (now - pendingSince >= GEAR_DWELL_MS) {
    stableGear = candidate;
  }
}

// =========================================================================
// Power
// =========================================================================
static void updatePower() {
  bool valid; float cad; uint32_t lastEvt;
  taskENTER_CRITICAL();
  valid = crankValid; cad = podCadence; lastEvt = lastCrankEventMs;
  taskEXIT_CRITICAL();

  if (!valid || millis() - lastEvt > CADENCE_TIMEOUT_MS) cad = 0;
  cadenceRpm = cad;

  if (!calValid || cad < 1.0f) { powerW = 0; return; }

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
  taskENTER_CRITICAL();
  valid = crankValid; revs = crankRevs; evt = crankEventTime;
  taskEXIT_CRITICAL();

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
  Log.println(F("Commands: c=calibrate  n=next point  x=abort"));
  Log.println(F("          d=live data on/off  p=show calibration  h=help"));
}

static void prphConnectCb(uint16_t conn) {
  (void)conn;
  Log.println(F("[BLE] App connected"));
  // Keep advertising so Zwift and the phone console can both connect.
  if (Bluefruit.Periph.connected() < MAX_PRPH_CONN) Bluefruit.Advertising.start(0);
}

static void prphDisconnectCb(uint16_t conn, uint8_t reason) {
  if (conn == phoneConn) phoneConn = BLE_CONN_HANDLE_INVALID;
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
  if (calState == CAL_WAITING) calCapture();
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
    case 'x': if (calState != CAL_IDLE) calAbort(F("cancelled by user")); break;
    case 'd': debugStream = !debugStream; break;
    case 'p': printCalibration(); break;
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
  if (calState != CAL_IDLE)  on = (calState == CAL_WAITING);
  else if (saturated)        on = (now / 100) % 2;
  else if (!calValid)        on = (now / 500) % 2;
  else                       on = false;
  digitalWrite(LED_RED, on ? HIGH : LOW);
}

static void printDebug() {
  Log.printf("B=(%7.1f,%7.1f,%7.1f)uT %s R=%5.1f gear=%2d cad=%5.1f P=%4.0fW "
                "pod=%s app=%s\n",
                fieldUT[0], fieldUT[1], fieldUT[2], saturated ? "SAT" : "   ",
                resistance, calValid ? stableGear : 0, cadenceRpm, powerW,
                podConn  != BLE_CONN_HANDLE_INVALID ? "Y" : "n",
                powerSubscribers > 0 ? "Y" : "n");
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

  Log.println(F("\nKeiser M3 magnetometer bridge"));

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
  Log.println(calValid ? F("Calibration loaded.")
                          : F("No calibration yet: hold the button 3 s (or send 'c')."));

  Bluefruit.begin(MAX_PRPH_CONN, 1);            // Zwift + phone, plus 1 cadence pod
  Bluefruit.setTxPower(4);
  Bluefruit.setName(DEVICE_NAME);
  setupPeripheral();
  setupCentral();

  watchdogStart();
}

void loop() {
  uint32_t now = millis();

  if (now - lastSampleMs >= SAMPLE_PERIOD_MS) {
    lastSampleMs = now;
    sampleMagnetometer();
  }

  if (now - lastNotifyMs >= NOTIFY_PERIOD_MS) {
    lastNotifyMs = now;
    updatePower();
    sendPowerMeasurement();
  }

  if (debugStream && now - lastDebugMs >= DEBUG_PERIOD_MS) {
    lastDebugMs = now;
    printDebug();
  }

  pollButton();
  pollCommands();
  updateLed();
  watchdogFeed();
  delay(2);   // yield to the BLE stack / FreeRTOS
}
