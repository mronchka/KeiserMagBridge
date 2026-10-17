// M3 Bridge phone page: Constants, URL flags (?demo=1 ...), shared state (state, diag) and small helpers ($, setHidden, num, fmt, esc).
// Classic script sharing the page's global scope; index.html loads the files in order (see its loader).
'use strict';

// ===================================================================
// Constants (see bench/PROTOCOL.md)
// ===================================================================
var NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
var NUS_RX      = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // page writes commands here
var NUS_TX      = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // board notifies lines here
var NAME_PREFIX = 'Keiser M3 Bridge';
var TOTAL_POINTS = 25;
var MARGINAL_UT = 1.5;
var STALE_MS = 5000;      // Bluetooth text can stall for over a second on the real board
var WAIT_NOTE_MS = 2500;  // calibration: show the small 'Waiting for the bridge' note after this much silence
var LOG_MAX = 600;
var RX_BUF_MAX = 2048;

var params;
try { params = new URLSearchParams(location.search); } catch (e) { params = { get: function () { return null; } }; }
var DEMO = params.get('demo') === '1';
var DEMO_UNCAL = params.get('uncal') === '1';
var DEMO_DROP = params.get('drop') === '1';       // demo: drop one D line in the first transfer
var DEMO_OLDFW = params.get('oldfw') === '1';     // demo: act like firmware without k/g/m/e/y
var FAST = params.get('fast') === '1' ? 5 : 1;    // divide diagnostic step times by 5
var DEMO_V3 = params.get('v2') !== '1';           // demo: v3.3 by default; &v2=1 = the old v2 simulator
var DEMO_STALL = params.get('stall') === '1';     // demo: status lines stall for 3 s every ~12 s
var DEMO_CAD = num(params.get('cad')) || 72;      // demo v3: cadence while calibrating, rpm
var DEMO_SUSPECT = params.get('suspect') === '1';     // demo v3: every 4th point gets 1-2 W lines (hold still), then settles
var DEMO_STUCK = params.get('stuck') === '1';         // demo v3: point 6 never settles: W lines, then P and cal=5
var DEMO_LEARNFAIL = params.get('learnfail') === '1';   // demo v3: the first crank learning fails
var DEMO_V31 = params.get('v31') === '1';             // demo: v3.1 instead of v3.3 (with &v3=1, or on its own)
var DEMO_V32ONLY = params.get('v32') === '1';         // demo: v3.2 instead of v3.3
if (DEMO_V31 || DEMO_V32ONLY) DEMO_V3 = true;
var DEMO_V32 = DEMO_V3 && !DEMO_V31;                  // demo: v3.2 features (also part of v3.3)
var DEMO_V33 = DEMO_V32 && !DEMO_V32ONLY;             // demo: &v3=1 simulates v3.3 by default
var DEMO_NSTUCK = params.get('nstuck') === '1';       // demo v3.3: N,stuck once at point 5
var DEMO_REST = params.get('rest') === '1';           // demo v3.3: short pedalling breaks while calibrating (flag O)
var DEMO_REVIEW = params.get('review') === '1';       // demo v3.2: the check flags up point 20 and down point 23 after saving
var DEMO_BEHIND = params.get('behind') === '1';       // demo v3.2: point 7 overshot: N,behind + U + B at point 8
var DEMO_STUBBORN = params.get('stubborn') === '1';   // demo v3.2 (with &review=1): gear 20 stays flagged after redos

var DIAG_STEPS = [
  { label: 'Hands off — lever down', text: "Push the lever all the way down. Don't touch the bike.", secs: 8 },
  { label: 'Sweep up', text: 'Slowly push the lever all the way up.', secs: 15 },
  { label: 'Hold at top', text: 'Leave the lever all the way up.', secs: 5 },
  { label: 'Sweep down', text: 'Slowly bring the lever all the way down.', secs: 15 },
  { label: 'Hold at bottom', text: 'Leave the lever all the way down.', secs: 5 },
  { label: 'Slow crank turn', text: 'Lever down. Turn the crank slowly by hand through one full revolution, pausing at each quarter.', secs: 20 },
  { label: 'Set middle gear', text: 'Pedal and set the lever so the console shows about gear 10–12.', secs: 15 },
  { label: 'Pedal easy', text: 'Pedal easy and steady, about 60 rpm. Count your turns out loud (e.g. 20) and tell Claude the number.', secs: 20 },
  { label: 'Pedal fast', text: 'Pedal fast, 90–100 rpm. Count your turns out loud and tell Claude the number.', secs: 20 },
  { label: 'Stop', text: 'Stop pedalling. Sit still on the saddle.', secs: 15 },
  { label: 'Lean', text: 'Lean forward onto the bars 5 s, sit up 5 s, lean back 5 s.', secs: 15, optional: true }
];
var MAX_MARKERS = 32;
var D_RAW_SHOWN = 10;
var T_RAW_SHOWN = 10;
var LEARN_DONE_MS = 1400; // after crank learning: keep the finished (green) bar on screen this long
var CAPTURE_FLASH_MS = 1000; // [v3] after each captured point: show the ring green at 3/3 this long
// [v3.2] down pass: down points 23 .. 2 (step 22 .. 1); point 24 has no down reading
var DOWN_FIRST_STEP = 22;
var DOWN_POINTS = 22;
var UNCAL_HOLD_MS = 2000;    // once calibrated was seen, "Not calibrated" needs 2 s of uncalibrated S lines
var EDIT_TIMEOUT_MS = 8000;  // [v3.2] no E line after a # command: give up waiting
var STALL_MS = 10000;        // [v3.2] pedalling but no turn counted at a point this long: the "still on gear N?" hint
var FIX_MAX_TRIES = 2;       // [v3.2] guided fixes: redos per flagged point before offering the guess or skip
var S_FLAGS_RE = /^[A-Z]*$/;
var PASS_RE = /^(-|u|d|ru|rd)$/;
var PASS33_RE = /^[-a-z]{1,3}$/;   // [v3.3] lenient: a new pass name mustn't make every status line invalid
// [v3.3] one calibration flow: titles are plain instructions (no internal names)
var FLOW_STEPS = ['Find a good spot', 'Learn your pedalling', 'Sweep the lever', 'Up through the gears',
  'Back down through the gears', 'Check a few gears'];
// [v3.3] cadence guide, the same for every rider: the comfortable window for the gear you're in.
// Gears 1-10: 60-90 rpm, then sliding linearly to 30-55 rpm at gear 24. Red only outside 30-120.
var CAD_GUIDE = { flatTo: 10, low: [60, 90], top: 24, high: [30, 55] };
// [v3.3] placement meters (step 1): [weak below, great from]; in between is good.
var PLACE_ZONES = {
  swing: { good: 40, great: 100, max: 200 },    // uT covered by the lever, bottom to top
  dip: { good: 10, great: 30, max: 80 },        // uT crank-magnet dip per turn
  head: { good: 15, great: 35, max: 100 }       // % headroom before saturation
};
var B_CLEAR_MS = 1200;       // [v3.3] after B clears: show the gear you went back to in green this long
// [v3.2] confirm ride: four checks, app only (nothing is sent to the bridge)
var RIDE_CHECKS = [
  { gear: 5, pace: 'easy', label: 'Low gear', task: 'Shift to about gear 5 and pedal at an easy pace.' },
  { gear: 12, pace: 'easy', label: 'Middle gear, easy', task: 'Shift to about gear 12 and pedal at an easy pace.' },
  { gear: 12, pace: 'fast', label: 'Middle gear, faster', task: 'Stay in that gear and pedal faster.' },
  { gear: 19, pace: 'steady', label: 'High gear', task: 'Shift to about gear 19 and pedal steadily.' }
];
// A check asks "Does the console show gear N?" only once the bridge's gear is within
// CHECK_NEAR of the wanted gear and has stayed the same for CHECK_STEADY_MS while pedalling
// (the 'fast' check also wants the pace up by CHECK_FASTER rpm). If the bridge never reads
// near the wanted gear, it asks anyway after CHECK_ANYWAY_MS in any steady gear.
var CHECK_NEAR = 2, CHECK_STEADY_MS = 3000, CHECK_ANYWAY_MS = 20000, CHECK_FASTER = 8;

function $(id) { return document.getElementById(id); }
// Only touch the DOM when visibility really changes (no needless re-layout on every status line).
// SVG elements have no .hidden property, so they get the attribute ([hidden] hides any element).
function setHidden(id, v) {
  var el = $(id); v = !!v;
  if (el instanceof HTMLElement) { if (el.hidden !== v) el.hidden = v; }
  else if (el.hasAttribute('hidden') !== v) { if (v) el.setAttribute('hidden', ''); else el.removeAttribute('hidden'); }
}

// ===================================================================
// App state
// ===================================================================
var state = {
  conn: 'idle',        // idle | connecting | connected | disconnected | unsupported
  s: null,             // last parsed S line
  sAt: 0,              // time of last S line
  prevCal: 0,
  points: [],          // [{point, x, y, z}]
  result: null,        // {type:'K', ok, span, minstep, minAt, msg, recordId} | {type:'A', reason}
  showRaw: false,
  view: 'ride',
  q: null,             // collecting Q lines: {points:[], crank, timer}
  v3: false,           // [v3] S lines carry src
  v31: false,          // [v3.1] S lines carry lturns (13 fields)
  v32: false,          // [v3.2] S lines carry pass (14 fields)
  downPoints: [],      // [v3.2] [{point, x, y, z}] measured on the way down (points 23..2)
  behind: null,        // [v3.2] N,behind for {pass, step, at}; alone (no U) it is a gentle hint for that step
  overshoot: null,     // [v3.2] the board went back to an overshot point: {pass, step} being measured again
  stallSince: 0,       // [v3.2] pedalling with stab 0 at this step since (stuck hint after 10 s)
  stallKey: '',
  fixTries: {},        // [v3.2] guided fixes: redos started per flagged point ('u20': 2)
  fixPaused: false,    // [v3.2] guided fixes wait for the rider (cancelled, refused, 2 tries, or a stored readback)
  fixAfter: '',        // [v3.2] '' | 'skip' | 'guess': what to do once the current redo is cancelled
  v33: false,          // [v3.3] S lines carry the flow step and step count (16 fields)
  newerLines: 0,       // [v3.3] status lines longer than this page knows (a newer bridge)
  place: null,         // [v3.3] step 1 on screen: {x: last X line, xOn: we switched the stream on}
  sweepNexts: 0,       // [v3.3] Next taps during the sweep (0 = going up, 1 = coming down)
  survey: null,        // [v3.3] Z line: {noise, pathLen, spot, offMedian, verdict}
  upSaved: false,      // [v3.3] checkpoint: the up pass is saved; waiting for "Continue down" or "Later"
  fixHold: false,      // [v3.3] guided fixes wait until the down pass is done (or Later)
  bWas: null,          // [v3.3] last status line's B flag for {pass, step}
  bClearAt: 0, bClearGear: 0,   // [v3.3] B just cleared: show that gear green briefly
  flowLocal: 0,        // [v3.3] app-side flow step (1 placement, 6 gear check), 0 = none
  fList: null,         // [v3.2] F lines being collected until F,end
  review: null,        // [v3.2] {items:[{pass, point, reason, gx, gy, gz}], source}
  reviewKept: {},      // [v3.2] 'u20' etc. the rider chose to keep (this calibration)
  edit: null,          // [v3.2] pending # command: {kind:'R'|'G', pass, point, g, timer}
  editErr: '',         // [v3.2] last E,fail text, shown on the review card
  check: null,         // [v3.2] confirm ride: {phase:'offer'|'run'|'done', idx, results, picking, val, recordId}
  checkDone: false,    // [v3.2] the gear check was offered and finished or skipped for this calibration
  calSeen: false,      // a calibrated S line was seen on this connection
  uncalSince: 0,       // first of the current run of uncalibrated S lines
  lastGear: 0,         // last calibrated gear
  lastTurn: null,      // last T line
  tShown: 0            // T lines logged since Turns was last toggled
};

// Diagnostic run state
var diag = {
  phase: 'idle',       // idle | starting | countdown | running | stopping | dumping | done | incomplete | error | interrupted
  lean: true,
  steps: [],
  idx: 0,
  endAt: 0,
  cdEnd: 0,
  lastCd: 0,
  tick: 0,
  sent: 0,             // markers sent since 'g'
  labelByK: {},        // marker k -> step label
  capacity: 12000,
  period: 40,
  startedAt: 0,
  gstop: null,
  full: false,
  msg: '',
  startTO: 0, stopTO: 0, dumpTO: 0,
  dump: null,
  recordId: null
};

// ===================================================================
// Defensive number parsing
// ===================================================================
function num(s) {
  if (s === undefined || s === null) return NaN;
  var t = String(s).trim();
  if (t === '') return NaN;
  var v = Number(t);
  return isFinite(v) ? v : NaN;
}
function int(s) { var v = num(s); return isFinite(v) ? Math.round(v) : NaN; }
function fin(v) { return typeof v === 'number' && isFinite(v); }
function fmt(v, d) { return fin(v) ? v.toFixed(d) : '--'; }

function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}
