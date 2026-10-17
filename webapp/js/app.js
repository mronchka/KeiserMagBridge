// M3 Bridge phone page: the app (see webapp/README.md, bench/PROTOCOL.md).
// Classic script: index.html loads the files in order with ?v=<APP_BUILD>; they share the page's global scope.
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

// ===================================================================
// Line assembly: notification chunks (<=20 bytes) -> text -> lines
// ===================================================================
var rxBuf = '';
var decoder = makeDecoder();
function makeDecoder() { try { return new TextDecoder('utf-8'); } catch (e) { return null; } }
function resetRx() { rxBuf = ''; decoder = makeDecoder(); }

function onBytes(u8) {
  var text = '';
  try {
    if (decoder) text = decoder.decode(u8, { stream: true });
    else for (var i = 0; i < u8.length; i++) text += String.fromCharCode(u8[i]);
  } catch (e) { return; }
  rxBuf += text;
  var idx;
  while ((idx = rxBuf.indexOf('\n')) >= 0) {
    var line = rxBuf.slice(0, idx);
    rxBuf = rxBuf.slice(idx + 1);
    handleLine(line);
  }
  if (rxBuf.length > RX_BUF_MAX) { console.warn('RX buffer overflow without newline; dropped'); rxBuf = ''; }
}

function onNotify(ev) {
  var dv = ev && ev.target && ev.target.value;
  if (!dv || !dv.buffer) return;
  onBytes(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
}

// ===================================================================
// Line parser
// ===================================================================
var MACHINE_RE = /^([SCKAUQGMYDLNWPFEXZJ]),/;

function handleLine(raw) {
  var line = raw;
  var L = line.length;
  if (L && line.charCodeAt(L - 1) === 13) line = line.slice(0, L - 1);
  // Fast path for D lines: a recording dump is thousands of them.
  if (line.charCodeAt(0) === 68 && line.charCodeAt(1) === 44) {
    var dok = false;
    try { dok = onD(line); } catch (e) { dok = false; }
    var dd = diag.dump;
    if (!dok) { if (!dd || dd.badLogged++ < 5) logLine(line + '   (malformed, ignored)', 'rawbad'); }
    else if (state.showRaw && dd && dd.rawShown < D_RAW_SHOWN) {
      dd.rawShown++;
      logLine(line, 'raw');
      if (dd.rawShown === D_RAW_SHOWN) logLine('(further D lines of this transfer not shown)', 'raw');
    }
    return;
  }
  line = line.replace(/[\r\0]/g, '').replace(/\s+$/, '');
  if (!line.trim()) return;
  // [v3] T lines: one per pedal turn; logged only with "Show machine lines", capped.
  if (line.charCodeAt(0) === 84 && line.charCodeAt(1) === 44) {
    var tok = false;
    try { tok = onT(line.split(',')); } catch (e) { tok = false; }
    if (!tok) logLine(line + '   (malformed, ignored)', 'rawbad');
    else if (state.showRaw && state.tShown < T_RAW_SHOWN) {
      state.tShown++;
      logLine(line, 'raw');
      if (state.tShown === T_RAW_SHOWN) logLine('(further T lines not shown until Turns is switched again)', 'raw');
    }
    return;
  }
  var m = MACHINE_RE.exec(line);
  if (!m) { logLine(line, 'human'); return; }
  var parts = line.split(',');
  var ok = false;
  try {
    switch (m[1]) {
      case 'S': ok = onS(parts); break;
      case 'C': ok = onC(parts); break;
      case 'K': ok = onK(parts); break;
      case 'A': ok = onA(parts); break;
      case 'U': ok = onU(parts); break;
      case 'Q': ok = onQ(parts); break;
      case 'G': ok = onG(parts); break;
      case 'M': ok = onM(parts); break;
      case 'Y': ok = onY(parts); break;
      case 'L': ok = onL(parts); break;
      case 'N': ok = onN(parts); break;
      case 'W': ok = onW(parts); break;
      case 'P': ok = onP(parts); break;
      case 'F': ok = onF(parts); break;
      case 'E': ok = onE(parts); break;
      case 'X': ok = onX(parts); break;
      case 'Z': ok = onZ(parts); break;
      case 'J': ok = true; break;   // [v3.3] echo of our #J (gear check results), for the USB log
    }
  } catch (e) { console.warn('parse error', line, e); ok = false; }
  if (state.showRaw || !ok) logLine(ok ? line : line + '   (malformed, ignored)', ok ? 'raw' : 'rawbad');
}

// S,<gear>,<res>,<watts>,<cad>,<cal>,<step>,<stab>,<off>,<flags>
function onS(p) {
  var n = p.length;
  if (n < 9) return false;
  if (!/^\d{1,2}$/.test(p[1].trim()) || !/^\d$/.test(p[5].trim())) return false;
  // [v3.3] fields 15/16: flow step (0 idle, 1-6) and step count. More fields than that come from
  // a newer bridge: still read the first 16, and suggest reloading the page. (A glued pair of
  // lines has 25 or more fields, so up to 20 is taken as "newer", not as damage.)
  var v33line = n >= 16 && n <= 20 && /^\d$/.test((p[14] || '').trim()) && /^\d$/.test((p[15] || '').trim());
  if (v33line && n > 16) {
    if (++state.newerLines === 3) showStale('The bridge has newer firmware than this page knows. Reload the page.');
    p = p.slice(0, 16); n = 16;
  }
  var gear = int(p[1]), cal = int(p[5]);
  if (!fin(gear) || gear < 0 || gear > 99) return false;
  if (!fin(cal) || cal < 0 || cal > (v33line ? 9 : 5)) return false;
  // [v3] 12th field src: B board / W pod / - none. Its presence marks v3 firmware.
  var srcRaw = n >= 12 ? p[11].trim() : '';
  var src = srcRaw === 'B' || srcRaw === 'W' || srcRaw === '-' ? srcRaw : '';
  if (cal >= 3 && !src) return false;   // cal=3 only exists on v3, cal=4 and 5 on v3.1
  var flagStr = (p[9] || '').trim();
  var passRaw = n >= 14 ? p[13].trim() : '';
  // Once the connection is known to be v3+ only well-formed lines count. A lost 20-byte piece
  // glues two lines together ("S,1,2.5,0,0.0,0,0,0,S,1,..."): field 10 is then a number, not
  // the flags, and the gear flashed "Not calibrated" for one line.
  if (state.v33) { if (!v33line || !PASS33_RE.test(passRaw)) return false; }
  else if (state.v32) { if (n !== 14 || !PASS_RE.test(passRaw)) return false; }
  else if (state.v31) { if (n !== 13 && n !== 14 && !v33line) return false; }
  else if (state.v3) { if ((n < 12 || n > 14) && !v33line) return false; }
  if (state.v3 || n >= 12) {
    if (!src || !S_FLAGS_RE.test(flagStr)) return false;
    if (n === 14 && !PASS_RE.test(passRaw)) return false;
    if (v33line && !PASS33_RE.test(passRaw)) return false;
    if (n === 15 || (n > 16 && !v33line)) return false;
  }
  var flags = {};
  for (var i = 0; i < flagStr.length; i++) flags[flagStr.charAt(i)] = true;
  var step = int(p[6]);
  var stab = num(p[7]);
  var s = {
    gear: gear,
    res: num(p[2]),
    watts: int(p[3]),
    cad: num(p[4]),
    cal: cal,
    step: fin(step) ? Math.max(0, Math.min(TOTAL_POINTS - 1, step)) : 0,
    stab: fin(stab) ? Math.max(0, Math.min(100, stab)) : 0,
    off: num(p[8]),
    flags: flags,
    flagStr: flagStr,
    rec: int(p[10]),     // optional 11th field: samples recorded so far
    src: src,            // [v3] '' on v2
    lturns: int(p[12]),  // [v3.1] turns seen while learning the crank; NaN on earlier firmware
    pass: n >= 14 ? passRaw : '',   // [v3.2] - u d ru rd; '' on earlier firmware
    flow: v33line ? int(p[14]) : 0,      // [v3.3] flow step 1-6 (0 idle)
    flowSteps: v33line ? int(p[15]) : 0, // [v3.3] step count (6)
    paused: !!flags.O,                   // [v3.3] no pedal turn for a while: timers frozen, nothing lost
    pedalling: src ? (src !== '-' && !!flags.R) : true
  };
  var prevCal = state.s ? state.s.cal : 0;
  var prevPass = state.s ? state.s.pass : '';
  var prevFlow = state.s ? state.s.flow : 0;
  state.s = s;
  state.sAt = Date.now();
  // Firmware level, latched until disconnect, only from lines of the exact length.
  if (src && ((n >= 12 && n <= 14) || v33line)) state.v3 = true;
  if (src && (n === 13 || n === 14 || v33line) && fin(s.lturns)) state.v31 = true;   // [v3.1] 13th field lturns
  if (src && (n === 14 || v33line) && s.pass) state.v32 = true;                       // [v3.2] 14th field pass
  if (src && v33line) state.v33 = true;                                                // [v3.3] fields 15/16
  // [v3.3] B (go back first) just cleared at this point: show the gear gone back to in green for a moment
  var bKey = s.pass + s.step;
  if (state.v33 && state.bWas && state.bWas.key === bKey && !flags.B && cal === 1) {
    state.bClearAt = state.sAt; state.bClearGear = state.bWas.gear;
    setTimeout(render, B_CLEAR_MS + 50);
  }
  state.bWas = flags.B && cal !== 0 ? { key: bKey, gear: backGear(s) } : null;
  if (state.v33) onFlowStatus(s, prevCal, prevFlow);
  // "Not calibrated" debounce (renderRide): keep the last good gear through short runs of
  // uncalibrated lines once calibrated has been seen on this connection.
  if (gear > 0 && flags.V) { state.calSeen = true; state.uncalSince = 0; state.lastGear = gear; }
  else if (!state.uncalSince) state.uncalSince = state.sAt;
  // [v3.2] N,behind and the overshoot redo belong to one point
  if (state.behind && (state.behind.step !== s.step || state.behind.pass !== s.pass || cal === 0)) state.behind = null;
  if (state.nstuck && (state.nstuck.step !== s.step || state.nstuck.pass !== s.pass || cal === 0)) state.nstuck = null;
  if (state.overshoot && (state.overshoot.step !== s.step || state.overshoot.pass !== s.pass || cal === 0)) state.overshoot = null;
  // [v3.2] stuck hint: pedalling in the up or down pass, but no turn has counted (stab 0) at this point
  var stallable = state.v32 && !state.learnFailed && (s.pass === 'u' || s.pass === 'd') && cal === 1 && s.pedalling &&
    s.stab === 0 && !flags.B && !flags.M && !flags.O && s.step > 0 && s.step < TOTAL_POINTS - 1 &&
    !(state.v33 && s.flow !== 4 && s.flow !== 5);   // [v3.3] only on the gear steps
  if (!stallable) { state.stallSince = 0; state.stallKey = ''; }
  else if (!state.stallSince || state.stallKey !== s.pass + s.step) { state.stallSince = state.sAt; state.stallKey = s.pass + s.step; }
  if (s.pass === 'd' && prevPass === 'u' && cal !== 0) {
    toast('Top done. Now back down, one gear at a time');
    try { if (navigator.vibrate) navigator.vibrate([60, 60, 60]); } catch (e) {}
  }
  if (cal === 5 && prevCal !== 5) {
    // [v3.1] the point couldn't settle for 15 s: the board waits for redo (u) or capture anyway (n)
    if (!state.stuck || state.stuck.point !== s.step + 1) {
      state.stuck = { point: s.step + 1 };   // no P line seen
      try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch (e) {}
    }
  }
  if (cal === 0) state.redo = 0;
  if (prevCal === 0 && cal !== 0) {
    // A fresh calibration starts at step 0. A later step after a reconnect is the same run continuing.
    // [v3.2] A redo (#R) of one point of the saved calibration is not a new run.
    // [v3.3] Nor is the down pass started from the checkpoint ('n') or later (#D).
    if (s.pass === 'ru' || s.pass === 'rd') onRedoStarted(s);
    else if (state.v33 && s.flow === 5) { state.calEnded = true; state.upSaved = false; state.fixHold = true; }
    else if (s.step > 0 && state.points.length) state.calEnded = false;
    else onCalStarted();
    // however it started (the page, the bridge's button, #D, a reconnect): show it, full screen
    if (state.view !== 'cal') showView('cal');
  }
  if (prevCal !== 0 && cal === 0) {
    // Ended: K or A normally arrives just before this. If neither does, keep what was captured.
    setTimeout(function () { if (!state.calEnded) savePartialCal('ended without a result'); }, 1500);
    // [v3.2] a redo that ended without E/K/A (e.g. cancelled): stop waiting for it
    var ed0 = state.edit;
    if (ed0 && ed0.kind === 'R' && ed0.started) {
      setTimeout(function () {
        if (state.edit === ed0 && !ed0.okd) {
          state.edit = null;
          if (state.fixAfter) redoStopped(); else if (reviewItems().length) state.fixPaused = true;
          renderReview(); render();
        }
      }, 3000);
    }
  }
  if (cal === 3 && prevCal !== 3) state.learnFailed = false;   // (re)learning the crank
  if (prevCal === 3 && cal === 4) {
    // [v3.1] crank learned: the board waits for the rider to check the cadence
    try { if (navigator.vibrate) navigator.vibrate([60, 60, 60]); } catch (e) {}
  }
  if (prevCal === 3 && (cal === 1 || cal === 2) && !state.learnFailed) {
    // v3 before the cadence check: straight on to the points
    state.learnDoneAt = Date.now();   // renderCal shows a green "Crank learned" briefly
    setTimeout(render, LEARN_DONE_MS + 50);
    try { if (navigator.vibrate) navigator.vibrate([60, 60, 60]); } catch (e) {}
  }
  render();
  return true;
}

// C,<point>,<x>,<y>,<z>
function onC(p) {
  if (p.length < 2) return false;
  if (p[1].trim() === 'down') return onCDown(p);   // [v3.2]
  var point = int(p[1]);
  if (!fin(point) || point < 1 || point > TOTAL_POINTS) return false;
  var pt = { point: point, x: num(p[2]), y: num(p[3]), z: num(p[4]) };
  if (isRedoing()) {
    // [v3.2] a redo replaces that one point and keeps the rest
    state.points = state.points.filter(function (q) { return q.point !== point; });
  } else {
    state.points = state.points.filter(function (q) { return q.point < point; });
    state.downPoints = [];   // an up point after the down pass started can only be a new run
  }
  state.points.push(pt);
  state.behind = null; state.overshoot = null;
  state.capturedAt = Date.now(); state.capturedPoint = point; state.capturedDown = false;   // renderCal: green 3/3 flash
  if (state.w && state.w.point === point) state.w.resolved = true;   // settled and captured
  if (state.stuck && state.stuck.point === point) state.stuck = null;
  if (state.redo === point) state.redo = 0;                            // redone
  setTimeout(render, CAPTURE_FLASH_MS + 50);
  try { if (navigator.vibrate) navigator.vibrate(40); } catch (e) {}
  renderPoints();
  render();
  return true;
}

// [v3.2] C,down,<point>,<x>,<y>,<z>: down point captured (23 down to 2)
function onCDown(p) {
  var point = int(p[2]);
  if (!fin(point) || point < 2 || point > TOTAL_POINTS - 1) return false;
  var pt = { point: point, x: num(p[3]), y: num(p[4]), z: num(p[5]) };
  // Down points come 23, 22, ... 2: anything at or below this one is from before an undo.
  state.downPoints = state.downPoints.filter(function (q) { return isRedoing() ? q.point !== point : q.point > point; });
  state.downPoints.push(pt);
  state.behind = null; state.overshoot = null;
  state.capturedAt = Date.now(); state.capturedPoint = point; state.capturedDown = true;
  if (state.w && state.w.point === point) state.w.resolved = true;
  if (state.stuck && state.stuck.point === point) state.stuck = null;
  if (state.redo === point && state.redoPass === 'd') state.redo = 0;
  setTimeout(render, CAPTURE_FLASH_MS + 50);
  try { if (navigator.vibrate) navigator.vibrate(40); } catch (e) {}
  renderPoints();
  render();
  return true;
}

function isRedoing() {
  return !!(state.s && (state.s.pass === 'ru' || state.s.pass === 'rd')) || !!(state.edit && state.edit.kind === 'R' && state.edit.started);
}

// [v3.2] the board started a #R redo: one point of the saved calibration, by pedalling
function onRedoStarted(s) {
  var pass = s.pass === 'rd' ? 'd' : 'u', point = s.step + 1;
  if (!state.edit || state.edit.kind !== 'R') state.edit = { kind: 'R', pass: pass, point: point };
  state.edit.started = true;
  clearTimeout(state.edit.timer);   // the redo can take a while; E arrives when it is saved
  state.calEnded = true;            // not a new run: never saved as an incomplete calibration
  state.behind = null; state.capturedAt = 0; state.learnDoneAt = 0;
  state.w = null; state.stuck = null; state.redo = 0; state.editErr = '';
  if (state.check && state.check.phase === 'run') state.check.phase = 'done';
  showView('cal');
}

function editLabel(ed) {
  if (!ed) return '';
  return (ed.kind === 'R' ? 'redo of ' : 'best guess for ') + pointWords(ed.pass, ed.point);
}

// K,<ok>,<span>,<minstep>,<minstepAt>,<msg>
function onK(p) {
  if (p.length < 2) return false;
  var okStr = p[1].trim();
  if (okStr !== '0' && okStr !== '1') return false;
  var r = {
    type: 'K', ok: okStr === '1',
    span: num(p[2]), minstep: num(p[3]), minAt: int(p[4]),
    msg: p.slice(5).join(',').trim()
  };
  // [v3.2] after an edit (#R / #G) the board saves again and sends K
  var ed = state.edit && state.edit.okd ? state.edit : null;
  if (ed) { clearTimeout(ed.timer); state.edit = null; r.edit = editLabel(ed); }
  r.down = state.v32 && !state.learnFailed ? state.downPoints.length : -1;   // no down pass with the hold-still method
  state.result = r;
  state.calEnded = true;
  state.wantReadback = false;
  logLine(r.ok
    ? 'Calibration saved' + (r.edit ? ' (' + r.edit + ')' : '') + ': span ' + fmt(r.span, 1) + ' µT, smallest step ' + fmt(r.minstep, 1) + ' µT at gear ' + (fin(r.minAt) ? r.minAt : '?')
    : 'Calibration rejected: ' + (r.msg || 'no reason given'), 'sys');
  try { if (navigator.vibrate) navigator.vibrate(r.ok ? [60, 60, 60] : [300]); } catch (e) {}
  // [v3.3] which step just saved: the up pass (checkpoint) or the down pass (then fixes, then the gear check)
  var flowAt = state.v33 && state.s ? state.s.flow : 0;
  if (r.ok && !r.edit && flowAt === 4) {
    r.down = -1;             // the down pass hasn't started yet: nothing to say about it
    state.upSaved = true;
    state.fixHold = true;    // flagged gears wait until the down pass is done (or Later)
    setFlowRecord({ downDone: false, checkDone: false });
    try { if (navigator.vibrate) navigator.vibrate([60, 60, 60, 60, 120]); } catch (e) {}
  } else if (r.ok && !r.edit && flowAt === 5) {
    state.upSaved = false;
    state.fixHold = false;
    var finished = state.downPoints.some(function (q) { return q.point === 2; });
    setFlowRecord({ downDone: finished, checkDone: false });
  }
  if (r.edit && state.points.length < TOTAL_POINTS || (state.v33 && !r.edit && r.ok && state.points.length < TOTAL_POINTS)) {
    // Edited (or finished the down pass of) a calibration this page didn't watch being made, e.g.
    // after a reload or with #D: read the stored one back once the F list is in, instead of
    // saving a partial copy.
    state.wantReadback = true;
  } else {
    try {
      r.recordId = saveCalRecord('run', { ok: r.ok, span: r.span, minstep: r.minstep, minAt: r.minAt, msg: r.msg, edit: r.edit, down: state.v32 ? state.downPoints : null }, state.points);
    } catch (e) { console.warn('save failed', e); }
  }
  // Older firmware sends no F list: offer the gear check straight away.
  if (r.ok && !state.v32) { state.review = null; maybeOfferCheck(); }
  renderResult();
  renderReview();
  renderBadge();
  return true;
}

// [v3.2] F,<u|d>,<point>,<reason>,<gx>,<gy>,<gz> ... F,end,<count>: points that look wrong
function onF(p) {
  var kind = (p[1] || '').trim();
  if (kind === 'end') {
    var count = int(p[2]);
    if (!fin(count) || count < 0) return false;
    clearTimeout(state.fTimer);
    var items = state.fList || [];
    state.fList = null;
    if (items.length !== count) logLine('Check list: expected ' + count + ' flagged point' + (count === 1 ? '' : 's') + ', received ' + items.length + '.', 'bad');
    var flagged = items.filter(function (it) { return !state.reviewKept[it.pass + it.point]; });
    // A stored readback the rider asked for doesn't start a redo by itself; one the page asked for
    // after an edit (wantReadback) carries on with the guided fixes.
    var stored = state.qJustEnded && !state.qFromEdit;
    state.review = { items: flagged, source: stored ? 'stored' : 'run' };
    state.qJustEnded = false;
    state.qFromEdit = false;
    if (items.length) {
      logLine('The bridge flagged ' + items.length + ' point' + (items.length === 1 ? '' : 's') + ': ' +
        items.map(function (it) { return pointWords(it.pass, it.point) + ' (' + it.reason + ')'; }).join('; ') + '.', 'sys');
    }
    if (state.wantReadback) {
      // save the edited calibration first; its F list (after Q,end) drives what comes next
      state.wantReadback = false;
      state.qFromEdit = true;
      requestStoredCal();
    } else if (flagged.length) {
      if (stored) state.fixPaused = true;
      if (!state.fixHold) {
        try { if (navigator.vibrate) navigator.vibrate([150, 80, 150]); } catch (e) {}
        fixNext();
      }
    } else {
      state.review = null;
      maybeOfferCheck();
    }
    renderReview();
    renderBadge();
    return true;
  }
  if (kind !== 'u' && kind !== 'd') return false;
  var point = int(p[2]);
  if (!fin(point) || point < 1 || point > TOTAL_POINTS) return false;
  if (!state.fList) state.fList = [];
  state.fList = state.fList.filter(function (it) { return !(it.pass === kind && it.point === point); });
  state.fList.push({ pass: kind, point: point, reason: (p[3] || '').trim(), gx: num(p[4]), gy: num(p[5]), gz: num(p[6]) });
  // If F,end gets lost on the way, finish the list anyway (otherwise nothing would ever start).
  clearTimeout(state.fTimer);
  state.fTimer = setTimeout(function () {
    if (!state.fList) return;
    logLine('The end of the check list never arrived: using the ' + state.fList.length + ' points received.', 'bad');
    onF(['F', 'end', String(state.fList.length)]);
    render();
  }, 3000);
  return true;
}

// [v3.2] E,ok,<what> / E,fail,<reason>: answer to a # command
function onE(p) {
  var kind = (p[1] || '').trim(), text = p.slice(2).join(',').trim();
  var ed = state.edit;
  if (kind === 'ok') {
    state.editErr = '';
    if (ed) {
      clearTimeout(ed.timer);
      ed.okd = true;   // K follows
      // A guess isn't sent back as a C line: apply it here so the saved copy matches the bridge.
      if (ed.kind === 'G' && ed.g && fin(ed.g.x)) {
        var list = ed.pass === 'd' ? 'downPoints' : 'points';
        state[list] = state[list].filter(function (q) { return q.point !== ed.point; });
        state[list].push({ point: ed.point, x: ed.g.x, y: ed.g.y, z: ed.g.z });
        renderPoints();
      }
      toast(ed.kind === 'R' ? 'Redone and saved' : 'Best guess used and saved');
    }
    logLine('Edit done' + (text ? ' (' + text + ')' : '') + '.', 'sys');
  } else if (kind === 'fail') {
    if (ed) { clearTimeout(ed.timer); state.edit = null; }
    logLine('Edit refused: ' + (text || 'no reason given'), 'bad');
    if (ed && ed.kind === 'R' && state.fixAfter) {
      redoStopped();   // the rider chose Skip / Use best guess: this is just the redo being cancelled
    } else {
      state.editErr = text || 'no reason given';
      toast('Not changed: ' + state.editErr);
      if (state.fixAfter === '' && reviewItems().length) state.fixPaused = true;   // wait for the rider
    }
  } else return false;
  renderReview();
  render();
  return true;
}

// A,<reason>
function onA(p) {
  var reason = p.slice(1).join(',').trim();
  if (state.edit && state.edit.kind === 'R' && state.edit.started) {
    // [v3.2] a redo was cancelled: the saved calibration is unchanged
    clearTimeout(state.edit.timer);
    state.edit = null;
    logLine('Redo cancelled: ' + (reason || 'no reason given') + '. The saved calibration is unchanged.', 'sys');
    if (state.fixAfter) redoStopped();
    else { toast('Redo cancelled'); if (reviewItems().length) state.fixPaused = true; }
    renderReview();
    render();
    return true;
  }
  state.result = { type: 'A', reason: reason || 'no reason given' };
  logLine('Calibration aborted: ' + state.result.reason, 'sys');
  state.result.recordId = savePartialCal('aborted: ' + state.result.reason);
  renderResult();
  renderBadge();
  return true;
}

// U,<step>
function onU(p) {
  if (p.length < 2) return false;
  var step = int(p[1]);
  if (!fin(step) || step < 0 || step >= TOTAL_POINTS) return false;
  var down = (p[2] || '').trim() === 'd';   // [v3.2] U,<step>,d: undo in the down pass
  // After undo the current step is <step>, so points 1..step remain captured.
  // [v3.1] A redo after cal=5 keeps the same step: that point was never added (no C line), so nothing is lost.
  var wasStuck = (state.s && state.s.cal === 5) || (state.stuck && state.stuck.point === step + 1);
  if (wasStuck) { state.redo = step + 1; state.redoPass = down ? 'd' : 'u'; }
  // [v3.2] N,behind then U one point back: the board went back to the overshot point by itself
  var b = state.behind;
  if (!wasStuck && b && Date.now() - b.at < 5000 && (down ? b.pass === 'd' && step === b.step + 1 : b.pass === 'u' && step === b.step - 1)) {
    state.overshoot = { pass: down ? 'd' : 'u', step: step };
    try { if (navigator.vibrate) navigator.vibrate([150, 80, 150]); } catch (e) {}
  }
  state.stuck = null;
  state.behind = null;
  state.stallSince = 0;
  if (state.w) state.w.resolved = true;
  // Down pass: point step+1 is being measured again, so only the points above it remain.
  if (down) state.downPoints = state.downPoints.filter(function (q) { return q.point > step + 1; });
  else {
    state.points = state.points.filter(function (q) { return q.point <= step; });
    // [v3.2] undo from the first down point goes back to up point 24 (and the worked-out top goes too)
    if (state.downPoints.length || (state.s && state.s.pass === 'd')) state.downPoints = [];
  }
  if (state.s) { state.s.step = step; if (state.v32 && state.s.cal !== 0 && (state.s.pass === 'd') !== down) state.s.pass = down ? 'd' : 'u'; }
  renderPoints();
  render();
  return true;
}

// [v3.1] L,<ok>,<turns>,<rpm>,<depth>,<reason>: crank learning result
function onL(p) {
  if (p.length < 2 || (p[1] !== '0' && p[1] !== '1')) return false;
  var ok = p[1] === '1', reason = p.slice(5).join(',').trim();
  state.learnFailed = !ok;
  logLine(ok ? 'Crank learned: ' + (p[2] || '?') + ' turns at ' + (p[3] || '?') + ' rpm, dip ' + (p[4] || '?') + ' µT'
    : 'Crank not found (' + (reason || 'no reason given') + '). Continuing with the hold-still method.', 'sys');
  if (!ok) toast('Crank not found: ' + (reason || 'no reason given'));
  render();
  return true;
}

// [v3.1] W,<point>,<drift>,<creep>: point may have been taken while the lever was still moving
function onW(p) {
  var point = int(p[1]);
  if (!fin(point) || point < 1 || point > TOTAL_POINTS) return false;
  // [v3.1] Non-blocking: the board dropped that capture and keeps waiting for the lever to settle.
  var fresh = !state.w || state.w.point !== point || state.w.resolved;
  var count = fresh ? 1 : state.w.count + 1;
  state.w = { point: point, drift: num(p[2]), creep: num(p[3]), resolved: false, count: count };
  logLine('Point ' + point + ': still changing (the check turn moved ' + fmt(state.w.drift, 1) + ' \u00b5T further, creep ' +
    fmt(state.w.creep, 1) + ' \u00b5T). Waiting for the lever to settle.', 'sys');
  if (fresh) { try { if (navigator.vibrate) navigator.vibrate([150, 80, 150]); } catch (e) {} }
  render();
  return true;
}

// [v3.1] P,<point>: the reading kept changing for 15 s; the board enters cal=5
function onP(p) {
  var point = int(p[1]);
  if (!fin(point) || point < 1 || point > TOTAL_POINTS) return false;
  var fresh = !state.stuck || state.stuck.point !== point;
  state.stuck = { point: point };
  logLine('Point ' + point + ': the reading kept changing for 15 s. Redo it or capture it anyway.', 'sys');
  if (fresh) { try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch (e) {} }
  render();
  return true;
}

// [v3.1] N,<reason>: a manual capture was refused
function onN(p) {
  var r = (p[1] || '').trim();
  if (r === 'notmoved') toast('Not saved: move the lever to the next gear first');
  else if (r === 'noturn') toast('Keep pedalling: no full turn yet');
  else if (r === 'stuck') {
    // [v3.3] 6 agreeing turns that neither move on nor sit behind: a gentle hint for this point
    var s0 = state.s;
    state.nstuck = s0 ? { pass: s0.pass, step: s0.step } : null;
    render();
  }
  else if (r === 'behind') {
    // [v3.2] the agreeing turns sit behind the previous point: that point overshot. Normally a U line
    // follows and the board goes back to it (onU turns this into state.overshoot). Alone (point 2,
    // the first down point) it stays a gentle hint until the step changes.
    var s = state.s;
    state.behind = s ? { pass: s.pass, step: s.step, at: Date.now() } : { pass: '', step: -1, at: Date.now() };
    logLine('This reading is behind the last point.', 'sys');
    try { if (navigator.vibrate) navigator.vibrate([150, 80, 150]); } catch (e) {}
    render();
  }
  else return false;
  return true;
}

function onCalStarted() {
  state.points = [];
  state.downPoints = [];
  state.behind = null;
  state.overshoot = null;
  state.stallSince = 0;
  state.review = null;
  state.reviewKept = {};
  state.fixTries = {};
  state.fixPaused = false;
  state.fixAfter = '';
  state.sweepNexts = 0;
  state.survey = null;
  state.upSaved = false;
  state.fixHold = false;
  state.bWas = null; state.bClearAt = 0;
  state.fList = null;
  state.editErr = '';
  state.check = null;
  state.checkDone = false;
  if (state.edit) { clearTimeout(state.edit.timer); state.edit = null; }
  state.result = null;
  state.calEnded = false;
  state.partialSaved = -1;
  state.learnFailed = false;
  state.capturedAt = 0;
  state.learnDoneAt = 0;
  state.w = null;
  state.stuck = null;
  state.redo = 0;
  setHidden('storedMsg', true);
  renderPoints();
  renderResult();
  renderReview();
}

// ===================================================================
// [v3.3] flow steps, placement (X), survey (Z), checkpoints
// ===================================================================
// A calibration step is on screen (cal 7, the checkpoint after the up pass, shows the Saved card instead).
// [v3.3] sweep direction: pass su / sd from the board; Next taps counted here as a fallback
function sweepIsDown(s) { return s.pass === 'sd' || (s.pass !== 'su' && (s.pass === 'd' || state.sweepNexts >= 1)); }
function calRunning(s) { return !!(s && s.cal !== 0 && !(state.v33 && s.cal === 7)); }

// The gear the rider is asked for at this point, and the one to go back into first (flag B).
function promptGear(s) { return s.pass === 'd' || s.pass === 'rd' ? s.step : s.step + 1; }
function backGear(s) {
  var down = s.pass === 'd' || s.pass === 'rd', g = promptGear(s);
  return down ? Math.min(24, g + 1) : Math.max(1, g - 1);
}

// Cadence window for a gear (CAD_GUIDE): [lo, hi] rpm.
function cadWindow(gear) {
  var g = Math.max(1, Math.min(CAD_GUIDE.top, gear || 1));
  if (g <= CAD_GUIDE.flatTo) return CAD_GUIDE.low.slice();
  var f = (g - CAD_GUIDE.flatTo) / (CAD_GUIDE.top - CAD_GUIDE.flatTo);
  return [Math.round(CAD_GUIDE.low[0] + (CAD_GUIDE.high[0] - CAD_GUIDE.low[0]) * f),
    Math.round(CAD_GUIDE.low[1] + (CAD_GUIDE.high[1] - CAD_GUIDE.low[1]) * f)];
}

// Flow step shown in the breadcrumb (1-6), or 0 when not in the flow.
function flowNow() {
  var s = state.s;
  // Whenever the board is calibrating, its own step wins (a #D after the gear check is step 5, not 6).
  if (s && state.v33 && s.cal !== 0 && s.flow >= 1 && s.flow <= 6) return s.flow;
  if (state.place) return 1;
  if (state.check && state.check.phase === 'run' && state.check.flow) return 6;
  if (state.upSaved) return 4;
  return 0;
}

// Per-status-line flow bookkeeping (v3.3 only).
function onFlowStatus(s, prevCal, prevFlow) {
  if (s.flow !== 3) state.sweepNexts = s.flow > 3 ? 1 : 0;
  // cal 7: the up pass is saved and the board waits at the checkpoint (n = down now, s/x = later)
  if (s.cal === 7 && !state.upSaved) { state.upSaved = true; state.fixHold = true; }
  if (prevCal === 7 && s.cal === 0) {   // stopped at the checkpoint (Later, or s/x from elsewhere)
    state.upSaved = false; state.fixHold = false;
    if (reviewItems().length) state.fixPaused = true;
  }
  if (s.flow === 5 && s.cal !== 0 && s.cal !== 7 && state.upSaved) { state.upSaved = false; state.fixHold = true; }   // down pass started
  // The board started calibrating again (e.g. #D after the gear check): the gear check gives way.
  if (s.cal !== 0 && s.cal !== 7 && s.flow >= 2 && s.flow <= 5 && state.check && state.check.phase === 'run') state.check = null;
  if (s.flow !== prevFlow) {
    if (s.flow === 3 && prevFlow === 2) logLine('Sweep: lever slowly up, then back down.', 'sys');
    if (s.flow === 4 && prevFlow === 3) toast('Now up through the gears');
  }
}

// Remember on this phone what is left of the last calibration (resume offers on the start screen).
var FLOW_KEY = 'm3bridge.flow';
function flowRecord() { try { return JSON.parse(localStorage.getItem(FLOW_KEY)) || null; } catch (e) { return null; } }
function setFlowRecord(patch) {
  var r = flowRecord() || {};
  for (var k in patch) r[k] = patch[k];
  r.at = new Date().toISOString();
  try { localStorage.setItem(FLOW_KEY, JSON.stringify(r)); } catch (e) {}
}

// [v3.3] X,<fieldMag>,<swing>,<dip>,<headroomPct>,<noise>: placement stream ('v')
function onX(p) {
  var x = { field: num(p[1]), swing: num(p[2]), dip: num(p[3]), head: num(p[4]), noise: num(p[5]), at: Date.now() };
  if (!fin(x.swing) || !fin(x.head)) return false;
  if (state.place) { state.place.x = x; renderPlace(); }
  return true;
}

// [v3.3] Z,<noise>,<pathLen>,<spot>,<offMedian>,<verdict>: survey result after the sweep
function onZ(p) {
  var z = { noise: num(p[1]), pathLen: num(p[2]), spot: (p[3] || '').trim(), offMedian: num(p[4]), verdict: (p[5] || '').trim() };
  if (!fin(z.pathLen)) return false;
  state.survey = z;
  var words = { ok: 'good', weak: 'too weak', saturated: 'saturated', folded: 'folds back on itself' };
  logLine('Sweep: lever path ' + fmt(z.pathLen, 1) + ' µT, noise ' + fmt(z.noise, 2) + ' µT, ' +
    (z.spot === 'same' ? 'same spot as last time' : z.spot === 'new' ? 'the board has moved since last time' : 'first calibration here') +
    ', signal ' + (words[z.verdict] || z.verdict) + '.', 'sys');
  if (z.verdict && z.verdict !== 'ok') toast('Signal ' + (words[z.verdict] || z.verdict) + ': see the Console');
  return true;
}

function showStale(text) {
  $('staleText').textContent = text;
  setHidden('staleBar', false);
}
// Is the published page newer than this one? (GitHub Pages lets phones cache it for 10 minutes,
// and a tab left open keeps old code for good: that's how the v3.2b run ended up on the v3.1 page.)
function checkPageVersion() {
  if (DEMO || !window.fetch || location.protocol === 'file:') return;
  try {
    fetch(location.pathname + '?build=' + Date.now(), { cache: 'no-store' }).then(function (r) {
      return r.ok ? r.text() : '';
    }).then(function (html) {
      var m = /var APP_BUILD = '([^']+)'/.exec(html || '');
      if (m && m[1] !== APP_BUILD) showStale('A newer version of this page is available.');
    }).catch(function () {});
  } catch (e) {}
}

// Save the points of a calibration that ended without a K line (abort, disconnect,
// or no result). Saved at most once per point count, and only with at least 1 point.
function savePartialCal(reason) {
  state.calEnded = true;
  var n = state.points.length;
  if (!n || state.partialSaved === n) return null;
  state.partialSaved = n;
  try {
    var id = saveCalRecord('run', { ok: false, partial: true, msg: reason, down: state.v32 ? state.downPoints : null }, state.points);
    logLine('Saved the ' + n + ' captured point' + (n > 1 ? 's' : '') + ' as an incomplete calibration.', 'sys');
    return id;
  } catch (e) { console.warn('partial save failed', e); return null; }
}

// ===================================================================
// Q: stored calibration (reply to 'k')
// Q,<point>,<x>,<y>,<z> ... Q,end,<span>,<minstep>,<minstepAt>   or   Q,none
// ===================================================================
function requestStoredCal() {
  if (state.conn !== 'connected') { toast('Not connected'); return; }
  if (state.q) clearTimeout(state.q.timer);
  setHidden('storedMsg', true);
  state.q = { points: [], down: [], timer: 0 };
  state.q.timer = setTimeout(function () {
    if (state.q) { state.q = null; toast('No reply. The bridge may need firmware v2.'); }
  }, 10000);
  send('k');
}

function onQ(p) {
  var kind = (p[1] || '').trim();
  if (kind === 'none') {
    if (state.q) clearTimeout(state.q.timer);
    state.q = null;
    var hasPartial = records.some(function (x) { return x.type === 'cal' && x.partial; });
    var m = $('storedMsg');
    m.textContent = 'No complete calibration on the bridge yet. Finish all 25 points first' +
      (hasPartial ? ' — your captured points from the last attempt are under Saved runs.' : '.');
    m.hidden = false;
    toast('No complete calibration on the bridge');
    return true;
  }
  if (kind === 'end') {
    var q = state.q;
    if (q) clearTimeout(q.timer);
    state.q = null;
    state.qJustEnded = true;   // [v3.2] the F list that follows belongs to the stored calibration
    if (!q || !q.points.length) return true; // stray end without points
    var info = { ok: true, span: num(p[2]), minstep: num(p[3]), minAt: int(p[4]), msg: 'stored', crank: q.crank || null,
      down: state.v32 || q.down.length ? q.down : null };
    saveCalRecord('stored', info, q.points);
    toast('Stored calibration saved');
    return true;
  }
  if (kind === 'down') {
    // [v3.2] Q,down,<point>,<x>,<y>,<z>: stored down point (23..2)
    var dp = int(p[2]);
    if (!fin(dp) || dp < 2 || dp > TOTAL_POINTS - 1) return false;
    if (!state.q) state.q = { points: [], down: [], timer: 0 };
    state.q.down = state.q.down.filter(function (x) { return x.point !== dp; });
    state.q.down.push({ point: dp, x: num(p[3]), y: num(p[4]), z: num(p[5]) });
    return true;
  }
  if (kind === 'crank') {
    // [v3] Q,crank,<ux>,<uy>,<uz>,<depth>,<sign>
    var crank = { ux: num(p[2]), uy: num(p[3]), uz: num(p[4]), depth: num(p[5]), sign: int(p[6]) };
    if (!fin(crank.ux) || !fin(crank.uy) || !fin(crank.uz)) return false;
    if (!state.q) state.q = { points: [], down: [], timer: 0 };
    state.q.crank = crank;
    return true;
  }
  var point = int(kind);
  if (!fin(point) || point < 1 || point > TOTAL_POINTS) return false;
  if (!state.q) state.q = { points: [], down: [], timer: 0 }; // 'k' typed in the console
  clearTimeout(state.q.timer);
  state.q.timer = setTimeout(function () { state.q = null; }, 10000);
  state.q.points = state.q.points.filter(function (x) { return x.point !== point; });
  state.q.points.push({ point: point, x: num(p[2]), y: num(p[3]), z: num(p[4]) });
  return true;
}

// ===================================================================
// [v3] T,<ms>,<period_ms>,<x>,<y>,<z>,<gear>,<res>: one pedal turn
// ===================================================================
function onT(p) {
  if (p.length < 3) return false;
  var period = num(p[2]);
  if (!fin(period) || period < 0) return false;
  state.lastTurn = { ms: num(p[1]), period: period, x: num(p[3]), y: num(p[4]), z: num(p[5]), gear: int(p[6]), res: num(p[7]) };
  renderTurnInfo();
  return true;
}
function renderTurnInfo() {
  var t = state.lastTurn, el = $('turnInfo');
  if (!t) { el.hidden = true; return; }
  el.hidden = false;
  var rpm = t.period > 0 ? 60000 / t.period : NaN;
  el.textContent = 'Last turn: ' + Math.round(t.period) + ' ms · ' + fmt(rpm, 1) + ' rpm' +
    (t.gear > 0 ? ' · gear ' + t.gear : '') + (fin(t.res) ? ' · res ' + fmt(t.res, 1) : '');
}

// ===================================================================
// G / M / Y / D: diagnostics recording
// ===================================================================
function onG(p) {
  var kind = (p[1] || '').trim();
  if (kind === 'start') {
    var cap = int(p[2]), per = int(p[3]);
    if (fin(cap) && cap > 0) diag.capacity = cap;
    if (fin(per) && per > 0) diag.period = per;
    logLine('Recording started (capacity ' + diag.capacity + ' samples, ' + diag.period + ' ms).', 'sys');
    if (diag.phase === 'starting') {
      clearTimeout(diag.startTO);
      diag.startedAt = Date.now();
      beginCountdown();
    }
    return true;
  }
  if (kind === 'stop' || kind === 'full') {
    diag.gstop = { count: int(p[2]), duration: int(p[3]), full: kind === 'full' };
    logLine('Recording ' + (kind === 'full' ? 'full' : 'stopped') + ': ' + (fin(diag.gstop.count) ? diag.gstop.count : '?') +
      ' samples, ' + (fin(diag.gstop.duration) ? (diag.gstop.duration / 1000).toFixed(1) + ' s' : '?') + '.', 'sys');
    if (kind === 'full') {
      diag.full = true;
      if (diag.phase === 'running' || diag.phase === 'countdown') {
        toast('Recording memory full. Downloading.');
        clearDiagTimers();
        requestDump();
        return true;
      }
    }
    if (diag.phase === 'stopping') requestDump();
    return true;
  }
  return false;
}

function onM(p) {
  var k = int(p[1]), idx = int(p[2]);
  return fin(k) && fin(idx) && k >= 1 && idx >= 0;
}

function onY(p) {
  var kind = (p[1] || '').trim();
  var d = diag.dump;
  if (kind !== 'begin' && kind !== 'm' && kind !== 'end') return false;
  if (diag.phase !== 'dumping' || !d) return true; // not expecting a transfer: ignore
  d.lastAt = Date.now();
  if (kind === 'begin') {
    var count = int(p[2]);
    if (!fin(count) || count < 0) return false;
    d.begun = true;
    d.count = count;
    d.period = int(p[3]) > 0 ? int(p[3]) : diag.period;
    d.nMarkers = int(p[4]) >= 0 ? int(p[4]) : 0;
    d.markers = []; d.x = []; d.y = []; d.z = []; d.r = []; d.dt = []; d.bad = 0; d.rawShown = 0;
    scheduleDumpRender();
    return true;
  }
  if (kind === 'm') {
    var k = int(p[2]), idx = int(p[3]);
    if (!fin(k) || !fin(idx)) return false;
    d.markers.push({ k: k, index: idx });
    return true;
  }
  d.endCount = int(p[2]);
  d.checksum = int(p[3]);
  verifyDump();
  return true;
}

function onD(line) {
  var d = diag.dump;
  if (diag.phase !== 'dumping' || !d || !d.begun) return true; // not expecting: ignore quietly
  var p = line.split(',');
  if (p.length < 6 || p[1] === '' || p[2] === '' || p[3] === '' || p[4] === '' || p[5] === '') { d.bad++; return false; }
  var x = +p[1], y = +p[2], z = +p[3], r = +p[4], dt = +p[5];
  if (x !== x || y !== y || z !== z || r !== r || dt !== dt) { d.bad++; return false; }
  d.x.push(x); d.y.push(y); d.z.push(z); d.r.push(r); d.dt.push(dt);
  if ((d.x.length & 63) === 0) { d.lastAt = Date.now(); scheduleDumpRender(); }
  return true;
}

// ===================================================================
// Diagnostic run flow
// ===================================================================
function diagSteps() { return DIAG_STEPS.filter(function (s) { return !s.optional || diag.lean; }); }
function stepMs(s) { return Math.round(s.secs * 1000 / FAST); }

function clearDiagTimers() {
  clearTimeout(diag.startTO); clearTimeout(diag.stopTO); clearTimeout(diag.dumpTO);
  clearInterval(diag.tick); diag.tick = 0;
}

function setDiagPhase(ph) {
  diag.phase = ph;
  renderDiag();
  render();
}

function diagStart() {
  if (state.conn !== 'connected') { toast('Not connected'); return; }
  unlockAudio();
  clearDiagTimers();
  diag.steps = diagSteps();
  diag.idx = 0; diag.sent = 0; diag.labelByK = {}; diag.gstop = null; diag.full = false;
  diag.dump = null; diag.recordId = null; diag.msg = ''; diag.startedAt = 0;
  setDiagPhase('starting');
  send('g');
  diag.startTO = setTimeout(function () {
    if (diag.phase === 'starting') diagFail("Firmware doesn't support recording — update to v2");
  }, 3000);
}

function diagFail(msg) {
  clearDiagTimers();
  diag.msg = msg;
  setDiagPhase('error');
}

function beginCountdown() {
  diag.cdEnd = Date.now() + 3000;
  diag.lastCd = 0;
  setDiagPhase('countdown');
  startTick();
}

function startTick() {
  clearInterval(diag.tick);
  diag.tick = setInterval(diagTick, 200);
  diagTick();
}

function diagTick() {
  var now = Date.now();
  if (diag.phase === 'countdown') {
    var left = diag.cdEnd - now;
    if (left <= 0) { diag.phase = 'running'; goStep(0); return; }
    var sec = Math.ceil(left / 1000);
    if (sec !== diag.lastCd) { diag.lastCd = sec; beep(660, 80, 1); }
    renderDiagRun();
    return;
  }
  if (diag.phase === 'running') {
    if (now >= diag.endAt) { nextStep(); return; }
    renderDiagRun();
  }
}

function goStep(i) {
  if (diag.sent >= MAX_MARKERS) { toast('Marker limit reached (' + MAX_MARKERS + ')'); return; }
  diag.idx = i;
  diag.endAt = Date.now() + stepMs(diag.steps[i]);
  send('m');
  diag.sent++;
  diag.labelByK[diag.sent] = diag.steps[i].label;
  beep(880, 150, 1);
  renderDiag();
}

function nextStep() {
  if (diag.idx < diag.steps.length - 1) goStep(diag.idx + 1);
  else finishRun();
}

function finishRun() {
  clearInterval(diag.tick); diag.tick = 0;
  beep(880, 120, 2);
  setDiagPhase('stopping');
  send('e');
  diag.stopTO = setTimeout(function () { if (diag.phase === 'stopping') requestDump(); }, 4000);
}

function requestDump() {
  if (state.conn !== 'connected') { toast('Not connected'); return; }
  clearDiagTimers();
  diag.dump = {
    begun: false, count: 0, period: diag.period, nMarkers: 0, markers: [],
    x: [], y: [], z: [], r: [], dt: [], bad: 0, badLogged: 0, rawShown: 0,
    endCount: null, checksum: null, lastAt: Date.now(), requestedAt: Date.now()
  };
  diag.msg = '';
  setDiagPhase('dumping');
  send('y');
  armDumpWatch();
}

function armDumpWatch() {
  clearTimeout(diag.dumpTO);
  diag.dumpTO = setTimeout(function () {
    var d = diag.dump;
    if (diag.phase !== 'dumping' || !d) return;
    var idle = Date.now() - d.lastAt;
    if (!d.begun && idle > 10000) dumpIncomplete('No reply to the download request.');
    else if (d.begun && idle > 8000) dumpIncomplete('Transfer stalled after ' + d.x.length + ' of ' + d.count + ' samples.');
    else armDumpWatch();
  }, 1000);
}

function dumpIncomplete(reason) {
  clearTimeout(diag.dumpTO);
  diag.msg = reason;
  setDiagPhase('incomplete');
  beep(330, 300, 1);
}

function checksumOf(d) {
  var sum = 0, n = d.x.length;
  for (var i = 0; i < n; i++) sum += d.x[i] + d.y[i] + d.z[i];
  return ((sum % 65536) + 65536) % 65536;
}

function verifyDump() {
  var d = diag.dump;
  clearTimeout(diag.dumpTO);
  if (!d.begun) { dumpIncomplete('The transfer ended before it began.'); return; }
  var n = d.x.length;
  var cs = checksumOf(d);
  d.computed = cs;
  var problems = [];
  if (n !== d.count) problems.push('received ' + n + ' of ' + d.count + ' samples');
  if (d.endCount !== d.count) problems.push('end count ' + d.endCount + ' does not match ' + d.count);
  if (d.bad) problems.push(d.bad + ' malformed lines');
  if (d.markers.length !== d.nMarkers) problems.push('received ' + d.markers.length + ' of ' + d.nMarkers + ' markers');
  if (cs !== d.checksum) problems.push('checksum ' + cs + ' does not match ' + d.checksum);
  if (problems.length) {
    logLine('Transfer check failed: ' + problems.join('; '), 'bad');
    dumpIncomplete('Transfer incomplete: ' + problems.join('; ') + '.');
    return;
  }
  logLine('Transfer OK: ' + n + ' samples, checksum ' + cs + '.', 'sys');
  try { diag.recordId = saveDiagRecord(d); } catch (e) { console.warn(e); diag.recordId = null; }
  setDiagPhase('done');
  beep(1047, 120, 2);
}

function diagCancel() {
  var ph = diag.phase;
  clearDiagTimers();
  if ((ph === 'starting' || ph === 'countdown' || ph === 'running' || ph === 'stopping') && state.conn === 'connected') send('e');
  diag.dump = null;
  setDiagPhase('idle');
  toast('Diagnostic run discarded');
}

function diagOnDisconnect() {
  var ph = diag.phase;
  if (ph === 'starting' || ph === 'countdown' || ph === 'running' || ph === 'stopping') {
    clearDiagTimers();
    diag.msg = 'The connection dropped during the run. The bridge keeps what it recorded until the next start; reconnect and tap Download recording to fetch it.';
    setDiagPhase('interrupted');
  } else if (ph === 'dumping') {
    dumpIncomplete('The connection dropped during the transfer. Reconnect, then tap Retry.');
  }
}

var dumpRenderPending = false;
function scheduleDumpRender() {
  if (dumpRenderPending) return;
  dumpRenderPending = true;
  setTimeout(function () { dumpRenderPending = false; renderDiagRun(); }, 120);
}

// ---- beeps and vibration at step changes ----
var audioCtx = null;
function unlockAudio() {
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!audioCtx && AC) audioCtx = new AC();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) {}
}
function beep(freq, ms, count) {
  try { if (navigator.vibrate) navigator.vibrate(count > 1 ? [ms, 80, ms] : ms); } catch (e) {}
  if (!audioCtx) return;
  try {
    var t0 = audioCtx.currentTime;
    for (var i = 0; i < (count || 1); i++) {
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      var st = t0 + i * (ms + 80) / 1000;
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, st);
      g.gain.exponentialRampToValueAtTime(0.25, st + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, st + ms / 1000);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(st); o.stop(st + ms / 1000 + 0.02);
    }
  } catch (e) {}
}

// ===================================================================
// Saved records (localStorage, ~4 MB cap, oldest dropped first)
// ===================================================================
var STORE_IDX = 'm3bridge.records';
var STORE_PREFIX = 'm3bridge.rec.';
var STORE_CAP = 4 * 1024 * 1024;   // characters
var records = [];                  // newest first: {id, type, source, ts, title, summary, filename, size, persisted}
var memCsv = {};                   // id -> csv (this session)

function loadRecords() {
  try {
    var j = localStorage.getItem(STORE_IDX);
    var a = j ? JSON.parse(j) : [];
    records = Array.isArray(a) ? a.filter(function (r) { return r && r.id && r.filename; }) : [];
    records.forEach(function (r) { r.persisted = true; });
  } catch (e) { records = []; }
}
function saveIndex() {
  try {
    localStorage.setItem(STORE_IDX, JSON.stringify(records.filter(function (r) { return r.persisted; })));
    return true;
  } catch (e) { return false; }
}
function getCsv(id) {
  if (memCsv[id]) return memCsv[id];
  try { return localStorage.getItem(STORE_PREFIX + id); } catch (e) { return null; }
}
function findRecord(id) {
  for (var i = 0; i < records.length; i++) if (records[i].id === id) return records[i];
  return null;
}
function oldestPersisted(except) {
  for (var i = records.length - 1; i >= 0; i--) if (records[i].persisted && records[i] !== except) return records[i];
  return null;
}
function removeRecord(r) {
  try { localStorage.removeItem(STORE_PREFIX + r.id); } catch (e) {}
  delete memCsv[r.id];
  records = records.filter(function (x) { return x !== r; });
}
function storedTotal(except) {
  var t = 0;
  records.forEach(function (r) { if (r.persisted && r !== except) t += r.size || 0; });
  return t;
}

function addRecord(meta, csv) {
  // keep filenames unique when two records land in the same minute
  var base = meta.filename.replace(/\.csv$/, ''), name = meta.filename, n = 2;
  while (records.some(function (r) { return r.filename === name; })) name = base + '-' + (n++) + '.csv';
  meta.filename = name;
  meta.size = csv.length;
  meta.persisted = false;
  memCsv[meta.id] = csv;
  records.unshift(meta);
  var dropped = [];
  if (meta.size <= STORE_CAP) {
    while (storedTotal(meta) + meta.size > STORE_CAP) {
      var old = oldestPersisted(meta);
      if (!old) break;
      removeRecord(old); dropped.push(old);
    }
    for (var attempt = 0; attempt < 50; attempt++) {
      try {
        localStorage.setItem(STORE_PREFIX + meta.id, csv);
        meta.persisted = true;
        break;
      } catch (e) {
        var o = oldestPersisted(meta);
        if (!o) break;
        removeRecord(o); dropped.push(o);
      }
    }
  }
  if (meta.persisted && !saveIndex()) {
    // index could not be written: undo so storage stays consistent
    try { localStorage.removeItem(STORE_PREFIX + meta.id); } catch (e) {}
    meta.persisted = false;
    saveIndex();
  }
  if (dropped.length) {
    var msg = 'Storage full: removed ' + dropped.length + ' oldest saved run' + (dropped.length > 1 ? 's' : '') +
      ' (' + dropped.map(function (d) { return d.filename; }).join(', ') + ').';
    logLine(msg, 'sys');
    toast('Storage full: removed oldest saved run');
  }
  if (!meta.persisted) {
    logLine('Could not keep ' + meta.filename + ' on this device. Export it before closing the page.', 'bad');
    toast('Not saved on this device. Export it now.');
  }
  renderSaved();
  return meta.id;
}

// ---- CSV helpers ----
function csvCell(v) {
  v = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function ascii(s) {
  return String(s).replace(/[–—]/g, '-').replace(/µ/g, 'u').replace(/[\r\n]+/g, ' ');
}
function z2(n) { return (n < 10 ? '0' : '') + n; }
function fileStamp(d) {
  return d.getFullYear() + '-' + z2(d.getMonth() + 1) + '-' + z2(d.getDate()) + '-' + z2(d.getHours()) + z2(d.getMinutes());
}
function newId(d) { return d.getTime().toString(36) + Math.floor(Math.random() * 1296).toString(36); }
function dist3(a, b) {
  if (!a || !b || !fin(a.x) || !fin(a.y) || !fin(a.z) || !fin(b.x) || !fin(b.y) || !fin(b.z)) return NaN;
  return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2) + Math.pow(a.z - b.z, 2));
}
function mmss(ms) {
  var s = Math.max(0, Math.round(ms / 1000));
  return Math.floor(s / 60) + ':' + z2(s % 60);
}

function saveCalRecord(source, info, pointsIn) {
  var d = new Date();
  var pts = pointsIn.slice().sort(function (a, b) { return a.point - b.point; });
  var downs = info.down ? info.down.slice() : null;   // [v3.2] null = firmware without a down pass
  var stored = source === 'stored';
  var result = stored ? 'stored' : info.partial ? 'incomplete (' + pts.length + ' of ' + TOTAL_POINTS + ' points)' : (info.ok ? 'saved' : 'rejected');
  var lines = [
    '# Keiser M3 Bridge calibration',
    '# record: calibration',
    '# source: ' + (stored ? 'stored (read back from the bridge with k)' : 'calibration run'),
    '# timestamp: ' + d.toISOString(),
    '# result: ' + result,
    '# span_uT: ' + (fin(info.span) ? info.span.toFixed(1) : ''),
    '# minstep_uT: ' + (fin(info.minstep) ? info.minstep.toFixed(1) : ''),
    '# minstep_at_gear: ' + (fin(info.minAt) ? info.minAt : ''),
    '# message: ' + ascii(info.msg || ''),
    '# points: ' + pts.length + ' of ' + TOTAL_POINTS,
    (info.crank ? '# crank: ux=' + fmt(info.crank.ux, 3) + ', uy=' + fmt(info.crank.uy, 3) + ', uz=' + fmt(info.crank.uz, 3) +
      ', depth_uT=' + fmt(info.crank.depth, 1) + ', sign=' + (fin(info.crank.sign) ? info.crank.sign : '') : null),
    (info.edit ? '# edit: ' + ascii(info.edit) : null),
    '# labels: point 1 = lever all the way down (Bottom); points 2-24 = where the console first shows that gear; point 25 = lever all the way up (Top)',
    // [v3.2] down points: same gear edge as the up point, approached from above
    (downs ? '# down_points: ' + downs.length + ' of ' + DOWN_POINTS + ' (down point N = coming down, where the console first shows gear N-1; empty when not measured)' : null),
    'point,label,x_uT,y_uT,z_uT,dist_prev_uT' + (downs ? ',down_x_uT,down_y_uT,down_z_uT' : '')
  ].filter(function (l) { return l !== null; });
  var downBy = {};
  if (downs) downs.forEach(function (q) { downBy[q.point] = q; });
  for (var i = 0; i < pts.length; i++) {
    var p = pts[i];
    var prev = i > 0 && pts[i - 1].point === p.point - 1 ? pts[i - 1] : null;
    var dd = dist3(p, prev), dn = downBy[p.point];
    var row = [p.point, pointLabel(p.point), fmt(p.x, 1), fmt(p.y, 1), fmt(p.z, 1), fin(dd) ? dd.toFixed(2) : ''];
    if (downs) row = row.concat(dn ? [fmt(dn.x, 1), fmt(dn.y, 1), fmt(dn.z, 1)] : ['', '', '']);
    lines.push(row.map(function (v) { return csvCell(v === '--' ? '' : v); }).join(','));
  }
  var title = stored ? 'Stored calibration' : info.partial ? 'Calibration incomplete' : (info.ok ? (info.edit ? 'Calibration edited' : 'Calibration saved') : 'Calibration rejected');
  var summary = info.partial
    ? 'incomplete (' + pts.length + ' of ' + TOTAL_POINTS + ' points) · ' + info.msg
    : 'Span ' + fmt(info.span, 1) + ' µT · smallest step ' + fmt(info.minstep, 1) + ' µT' +
    (fin(info.minAt) ? ' at gear ' + info.minAt : '') + ' · ' + pts.length + ' points' +
    (downs ? ' · down ' + downs.length + ' of ' + DOWN_POINTS : '') +
    (info.edit ? ' · ' + info.edit : '') +
    (!stored && !info.ok && info.msg ? ' · ' + info.msg : '');
  return addRecord({
    id: newId(d), type: 'cal', source: source, partial: !!info.partial, ts: d.toISOString(), title: title, summary: summary,
    filename: 'keiser-cal-' + fileStamp(d) + '.csv'
  }, lines.join('\n') + '\n');
}

// Add '#' comment lines to a saved record, just above its header row (e.g. the gear check).
function appendRecordComments(id, comments, summaryAdd) {
  var rec = findRecord(id), csv = rec ? getCsv(id) : null;
  if (!rec || csv === null || csv === undefined) return false;
  var lines = csv.split('\n'), at = 0;
  while (at < lines.length && lines[at].charAt(0) === '#') at++;
  lines.splice.apply(lines, [at, 0].concat(comments.map(function (c) { return '# ' + ascii(c); })));
  csv = lines.join('\n');
  memCsv[id] = csv;
  rec.size = csv.length;
  if (summaryAdd) rec.summary += ' · ' + summaryAdd;
  if (rec.persisted) {
    try { localStorage.setItem(STORE_PREFIX + id, csv); } catch (e) { rec.persisted = false; }
    saveIndex();
  }
  renderSaved();
  return true;
}

function saveDiagRecord(dump) {
  var d = new Date();
  var n = dump.x.length;
  var markers = dump.markers.slice().sort(function (a, b) { return a.index - b.index || a.k - b.k; });
  var t = new Array(n), acc = 0;
  for (var i = 0; i < n; i++) { acc += i === 0 ? 0 : dump.dt[i]; t[i] = acc; }
  function labelFor(k) { return diag.labelByK[k] || ('marker ' + k); }
  var lines = [
    '# Keiser M3 Bridge diagnostic recording',
    '# record: diagnostic',
    '# timestamp: ' + d.toISOString(),
    '# samples: ' + n,
    '# period_ms: ' + dump.period,
    '# duration_ms: ' + (n ? t[n - 1] : 0),
    '# checksum: ' + dump.checksum + ' (verified)',
    '# firmware: ' + (diag.gstop ? (diag.gstop.full ? 'G,full' : 'G,stop') + ' count=' + diag.gstop.count + ' duration_ms=' + diag.gstop.duration : 'no G,stop seen'),
    '# lean_step: ' + (diag.lean ? 'yes' : 'no') + (FAST > 1 ? '; fast mode (step times / ' + FAST + ')' : ''),
    '# units: x/y/z in uT (raw, 0.1 uT resolution); t_ms cumulative from dt; revs empty when no cadence pod',
    '# markers: k,index,t_ms,step'
  ];
  markers.forEach(function (m) {
    lines.push('# ' + m.k + ',' + m.index + ',' + (m.index < n ? t[m.index] : '') + ',' + csvCell(ascii(labelFor(m.k))));
  });
  lines.push('i,t_ms,step,x_uT,y_uT,z_uT,revs');
  var mi = 0, cur = '';
  for (var j = 0; j < n; j++) {
    while (mi < markers.length && markers[mi].index <= j) { cur = csvCell(ascii(labelFor(markers[mi].k))); mi++; }
    var r = dump.r[j];
    lines.push(j + ',' + t[j] + ',' + cur + ',' + (dump.x[j] / 10).toFixed(1) + ',' + (dump.y[j] / 10).toFixed(1) + ',' +
      (dump.z[j] / 10).toFixed(1) + ',' + (r === -1 ? '' : r));
  }
  var summary = n + ' samples · ' + mmss(n ? t[n - 1] : 0) + ' · ' + markers.length + (markers.length === 1 ? ' step marker' : ' step markers') + ' · checksum OK' +
    (diag.full ? ' · memory filled' : '');
  return addRecord({
    id: newId(d), type: 'diag', source: 'run', ts: d.toISOString(), title: 'Diagnostic run', summary: summary,
    filename: 'keiser-diag-' + fileStamp(d) + '.csv'
  }, lines.join('\n') + '\n');
}

// ---- export actions ----
// Share is shown when the browser can share a file, or at least text.
function canShare() {
  if (!navigator.share) return false;
  return true;
}

function recActionsHtml(id) {
  return '<div class="rec-acts">' +
    (canShare() ? '<button class="btn" type="button" data-rec-act="share" data-id="' + id + '">Share</button>' : '') +
    '<button class="btn" type="button" data-rec-act="download" data-id="' + id + '">Download</button>' +
    '<button class="btn" type="button" data-rec-act="copy" data-id="' + id + '">Copy</button>' +
    '<button class="btn danger" type="button" data-rec-act="delete" data-id="' + id + '">Delete</button>' +
    '</div>';
}

function doRecAction(act, id, btn) {
  var rec = findRecord(id);
  if (!rec) { toast('That record is gone'); renderSaved(); return; }
  if (act === 'delete') {
    twoTap(btn, 'Tap again', function () {
      removeRecord(rec); saveIndex(); renderSaved(); renderResult(); renderDiag();
      toast('Deleted');
    });
    return;
  }
  var csv = getCsv(id);
  if (csv === null || csv === undefined) { toast('Could not read the saved data'); return; }
  if (act === 'share') {
    var file = null;
    try { file = new File([csv], rec.filename, { type: 'text/csv' }); } catch (e) { file = null; }
    var p;
    try {
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) p = navigator.share({ files: [file], title: rec.filename });
      else if (navigator.share) p = navigator.share({ title: rec.filename, text: csv });
    } catch (e) { p = Promise.reject(e); }
    if (p && p.catch) p.catch(function (err) { if (!err || err.name !== 'AbortError') toast('Share failed'); });
    return;
  }
  if (act === 'download') {
    try {
      var url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      var a = document.createElement('a');
      a.href = url; a.download = rec.filename; a.style.display = 'none';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 15000);
    } catch (e) { toast('Download failed'); }
    return;
  }
  if (act === 'copy') {
    var fallback = function () { showCopySheet(csv, rec.filename); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(csv).then(function () { toast('Copied ' + rec.filename); }, fallback);
      } else fallback();
    } catch (e) { fallback(); }
  }
}

function showCopySheet(text, title) {
  $('copyTitle').textContent = title;
  var ta = $('copyText');
  ta.value = text;
  setHidden('copySheet', false);
  try { ta.focus(); ta.select(); ta.setSelectionRange(0, text.length); } catch (e) {}
}

// Generic "tap twice within 3 s" confirmation.
function twoTap(btn, armedText, fn) {
  var until = +(btn.getAttribute('data-armed') || 0);
  if (Date.now() < until) { disarm(btn); fn(); return; }
  btn.setAttribute('data-armed', String(Date.now() + 3000));
  if (btn.getAttribute('data-label') === null) btn.setAttribute('data-label', btn.textContent);
  btn.textContent = armedText;
  btn.classList.add('armed');
  clearTimeout(btn._disarmT);
  btn._disarmT = setTimeout(function () { disarm(btn); }, 3000);
}
function disarm(btn) {
  clearTimeout(btn._disarmT);
  var l = btn.getAttribute('data-label');
  if (l !== null) { btn.textContent = l; btn.removeAttribute('data-label'); }
  btn.removeAttribute('data-armed');
  btn.classList.remove('armed');
}

function fmtDate(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  var mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return d.getDate() + ' ' + mons[d.getMonth()] + ' ' + d.getFullYear() + ', ' + z2(d.getHours()) + ':' + z2(d.getMinutes());
}

function renderSaved() {
  var list = $('savedList');
  if (!records.length) {
    $('savedInfo').textContent = 'Nothing saved yet. Finished calibrations and diagnostic runs appear here.';
    list.innerHTML = '';
    return;
  }
  var total = storedTotal(null);
  $('savedInfo').textContent = records.length + ' saved · ' + (total / 1048576).toFixed(2) + ' MB of ' +
    (STORE_CAP / 1048576).toFixed(0) + ' MB on this phone. The oldest are removed when full.';
  list.innerHTML = records.map(function (r) {
    return '<div class="rec-item"><div class="rec-head"><span class="rec-title">' + esc(r.title) + '</span>' +
      '<span class="rec-date">' + esc(fmtDate(r.ts)) + '</span></div>' +
      '<div class="rec-sum">' + esc(r.summary) + (r.persisted ? '' : ' <span class="tag">· not saved on this device</span>') +
      '<br><span class="small muted">' + esc(r.filename) + '</span></div>' + recActionsHtml(r.id) + '</div>';
  }).join('');
}

// ===================================================================
// Diagnose rendering
// ===================================================================
function renderDiagIdleList() {
  var html = '', total = 0;
  DIAG_STEPS.forEach(function (s, i) {
    var off = s.optional && !diag.lean;
    if (!off) total += stepMs(s);
    html += '<li' + (off ? ' class="off"' : '') + '><span>' + (i + 1) + '. ' + esc(s.label) + (s.optional ? ' (optional)' : '') +
      '</span><span class="sec">' + (Math.round(stepMs(s) / 100) / 10) + ' s</span></li>';
  });
  $('diagStepList').innerHTML = html;
  $('diagTotal').textContent = 'About ' + mmss(total + 3000) + ' including a 3 s get-ready countdown' +
    (FAST > 1 ? ' (fast mode: step times divided by ' + FAST + ').' : '.') + ' The bridge holds up to 8 minutes.';
  $('leanToggle').setAttribute('aria-checked', diag.lean ? 'true' : 'false');
}

function renderDiag() {
  var ph = diag.phase, connected = state.conn === 'connected';
  var runVisible = ph === 'starting' || ph === 'countdown' || ph === 'running' || ph === 'stopping' || ph === 'dumping';
  setHidden('diagRun', !runVisible);
  setHidden('diagIdle', runVisible || ph === 'incomplete' || ph === 'interrupted');
  setHidden('savedCard', runVisible);
  $('diagStart').disabled = !connected;
  $('diagStart').textContent = connected ? 'Start diagnostic run' : 'Connect first';
  renderDiagIdleList();

  var card = $('diagResult');
  if (ph === 'done' || ph === 'incomplete' || ph === 'error' || ph === 'interrupted') {
    card.hidden = false;
    var html = '';
    if (ph === 'done') {
      var rec = diag.recordId ? findRecord(diag.recordId) : null;
      card.className = 'card result ok';
      html = '<h2>Recording saved<button class="x-btn" type="button" data-diag="dismiss" aria-label="Dismiss">×</button></h2>' +
        '<p>' + esc(rec ? rec.summary : 'Transfer OK') + '</p>' +
        (rec ? '<p class="small muted">' + esc(rec.filename) + '</p>' + recActionsHtml(rec.id)
          : '<p class="small">' + (diag.recordId ? 'Deleted from this phone.' : 'The record could not be saved.') + '</p>');
    } else if (ph === 'incomplete') {
      card.className = 'card result warn';
      html = '<h2>Transfer incomplete</h2><p><b>' + esc(diag.msg) + '</b></p><p class="small">Tap Retry to download the recording again. The bridge still has it.</p>' +
        '<div class="cal-btns"><button class="btn primary" type="button" data-diag="retry"' + (connected ? '' : ' disabled') + '>Retry</button>' +
        '<button class="btn danger" type="button" data-diag="discard">Discard</button></div>';
    } else if (ph === 'interrupted') {
      card.className = 'card result warn';
      html = '<h2>Run interrupted</h2><p>' + esc(diag.msg) + '</p>' +
        '<div class="cal-btns"><button class="btn primary" type="button" data-diag="retry"' + (connected ? '' : ' disabled') + '>Download recording</button>' +
        '<button class="btn danger" type="button" data-diag="discard">Discard</button></div>';
    } else {
      card.className = 'card result bad';
      html = '<h2>Could not start<button class="x-btn" type="button" data-diag="dismiss" aria-label="Dismiss">×</button></h2><p><b>' + esc(diag.msg) + '</b></p>';
    }
    card.innerHTML = html;
  } else {
    card.hidden = true;
    card.innerHTML = '';
  }

  if (runVisible) {
    var segs = $('dSegs');
    if (segs.children.length !== diag.steps.length) {
      segs.style.gridTemplateColumns = 'repeat(' + diag.steps.length + ', minmax(0, 1fr))';
      segs.innerHTML = '';
      for (var i = 0; i < diag.steps.length; i++) { var s = document.createElement('div'); s.className = 'dseg'; segs.appendChild(s); }
    }
    disarm($('dCancel'));
    renderDiagRun();
  }
}

function renderDiagRun() {
  var ph = diag.phase;
  if ($('diagRun').hidden) return;
  var n = diag.steps.length;
  var stepPhase = ph === 'countdown' || ph === 'running';
  var curIdx = ph === 'running' ? diag.idx : (ph === 'countdown' || ph === 'starting' ? -1 : n);
  var segs = $('dSegs').children;
  for (var i = 0; i < segs.length; i++) segs[i].className = 'dseg' + (i < curIdx ? ' done' : (i === curIdx ? ' cur' : ''));

  setHidden('dTimer', !stepPhase);
  setHidden('dNav', ph !== 'running');
  setHidden('dDump', !(ph === 'dumping' || ph === 'stopping' || ph === 'starting'));

  var cnt = $('dCount');
  if (ph === 'starting') {
    $('dStepNo').textContent = 'Starting';
    $('dLabel').textContent = 'Starting the recording';
    $('dText').textContent = 'Waiting for the bridge...';
    $('dDumpText').textContent = 'Waiting for the bridge to start recording...';
    $('dBar').style.transform = 'scaleX(0)';
    $('dDumpSub').textContent = '';
  } else if (ph === 'countdown') {
    var left = Math.max(0, diag.cdEnd - Date.now());
    $('dStepNo').textContent = 'Get ready';
    $('dLabel').textContent = 'Step 1: ' + diag.steps[0].label;
    $('dText').textContent = diag.steps[0].text;
    cnt.textContent = String(Math.max(1, Math.ceil(left / 1000)));
    cnt.className = 'countdown ready';
    $('dCountSub').textContent = 'get ready';
  } else if (ph === 'running') {
    var st = diag.steps[diag.idx];
    $('dStepNo').textContent = 'Step ' + (diag.idx + 1) + ' of ' + n;
    if ($('dLabel').textContent !== st.label) {
      $('dLabel').textContent = st.label;
      $('dText').textContent = st.text;
    }
    cnt.textContent = String(Math.max(0, Math.ceil((diag.endAt - Date.now()) / 1000)));
    cnt.className = 'countdown';
    $('dCountSub').textContent = 'seconds';
    $('dBack').disabled = diag.sent >= MAX_MARKERS;
    $('dNext').textContent = diag.idx === n - 1 ? 'FINISH' : 'NEXT';
  } else if (ph === 'stopping' || ph === 'dumping') {
    var d = diag.dump;
    $('dStepNo').textContent = 'Finishing';
    $('dLabel').textContent = 'Recording done';
    $('dText').textContent = 'You can relax. Keep the phone near the bike while the recording downloads.';
    if (ph === 'stopping' || !d || !d.begun) {
      $('dDumpText').textContent = ph === 'stopping' ? 'Stopping the recording...' : 'Requesting the recording...';
      $('dBar').style.transform = 'scaleX(0)';
      $('dDumpSub').textContent = '';
    } else {
      var got = d.x.length, pct = d.count ? Math.min(100, got / d.count * 100) : 0;
      $('dDumpText').textContent = 'Downloading recording... ' + Math.floor(pct) + '%';
      $('dBar').style.transform = 'scaleX(' + (pct / 100).toFixed(3) + ')';
      $('dDumpSub').textContent = got + ' of ' + d.count + ' samples' + (d.bad ? ' · ' + d.bad + ' bad lines' : '');
    }
  }

  // recording info from the S line's rec field
  var s = state.s, info = '';
  var per = diag.period || 40;
  var recN = s && fin(s.rec) ? s.rec : NaN;
  if (ph === 'countdown' || ph === 'running') {
    if (fin(recN)) {
      info = 'REC ' + mmss(recN * per) + ' · ' + recN + ' samples · ' + mmss(Math.max(0, diag.capacity - recN) * per) + ' left';
    } else if (diag.startedAt) {
      var el = Date.now() - diag.startedAt;
      info = 'REC ' + mmss(el) + ' · ' + mmss(Math.max(0, diag.capacity * per - el)) + ' left';
    }
  }
  $('dRec').textContent = info;
}

function transferActive() {
  return diag.phase === 'dumping' || !!(state.s && state.s.flags.Y);
}

// ===================================================================
// Command writes: one char per write (# commands in 20-byte pieces), serialized through a promise queue
// ===================================================================
var writeChain = Promise.resolve();
var enc = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;

function send(str, quiet) {
  if (state.conn !== 'connected') { toast('Not connected'); return; }
  var chars = String(str).split('');
  chars.forEach(function (c) {
    var code = c.charCodeAt(0);
    if (code < 32 || code > 126) return;
    if (!quiet) logLine('> ' + c, 'sent');
    if (c === 't') state.tShown = 0;   // T-line logging cap restarts each time Turns is toggled
    writeChain = writeChain
      .then(function () { return writeChar(c); })
      .catch(function (err) {
        logLine('Write failed (' + c + '): ' + (err && err.message ? err.message : err), 'bad');
      });
  });
  return writeChain;
}

// [v3.2] Multi-character command (e.g. "#R,u,20"): ends with \n and goes out in <=20-byte
// writes, in order, each awaited, through the same queue as single characters. If a piece
// fails the rest is dropped and a lone \n is sent so the board discards the partial line.
function sendCmd(str) {
  if (state.conn !== 'connected') { toast('Not connected'); return null; }
  var text = String(str).replace(/[\r\n]+/g, '') + '\n';
  logLine('> ' + text.slice(0, -1), 'sent');
  var pieces = [];
  for (var i = 0; i < text.length; i += 20) pieces.push(text.slice(i, i + 20));   // commands are ASCII: 1 char = 1 byte
  var failed = false;
  pieces.forEach(function (piece) {
    writeChain = writeChain
      .then(function () { return failed ? null : writeChar(piece); })
      .catch(function (err) {
        failed = true;
        logLine('Write failed (' + text.slice(0, -1) + '): ' + (err && err.message ? err.message : err), 'bad');
        return writeChar('\n').catch(function () {});
      });
  });
  return writeChain;
}

// Write one character, or one <=20-byte piece of a # command.
function writeChar(c) {
  if (DEMO) { sim.receive(c); return Promise.resolve(); }
  if (typeof window.__m3Write === 'function') { window.__m3Write(c); return Promise.resolve(); }   // test harness
  if (!rxChar) return Promise.reject(new Error('not connected'));
  var data = enc ? enc.encode(c) : new Uint8Array(String(c).split('').map(function (ch) { return ch.charCodeAt(0) & 255; }));
  var props = rxChar.properties || {};
  if (typeof rxChar.writeValueWithoutResponse === 'function' && props.writeWithoutResponse !== false) {
    return rxChar.writeValueWithoutResponse(data);
  }
  if (typeof rxChar.writeValueWithResponse === 'function' && props.write) {
    return rxChar.writeValueWithResponse(data);
  }
  return rxChar.writeValue(data);
}

// ===================================================================
// Bluetooth transport
// ===================================================================
var device = null, rxChar = null, txChar = null, userDisconnect = false;

function errText(e) {
  if (!e) return 'Unknown error';
  if (e.name === 'NotFoundError') return 'No bridge selected.';
  if (e.name === 'SecurityError') return 'Bluetooth was blocked. The page must be opened over https or from a local file, and Bluetooth permission must be allowed.';
  if (e.name === 'NetworkError') return 'Could not reach the bridge. Make sure it is powered and in range, then try again.';
  return e.message || String(e);
}

function connectClick() {
  if (DEMO) { demoConnect(); return; }
  if (!navigator.bluetooth) { setConn('unsupported'); return; }
  if (device && state.conn === 'disconnected') { reconnect(); return; }
  setConn('connecting', 'Choose "' + NAME_PREFIX + '" in the list.');
  // requestDevice must be the first await inside the user gesture.
  navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: NAME_PREFIX }],
    optionalServices: [NUS_SERVICE]
  }).then(function (dev) {
    if (device && device !== dev) {
      try { device.removeEventListener('gattserverdisconnected', onGattDisconnected); } catch (e) {}
    }
    device = dev;
    device.removeEventListener('gattserverdisconnected', onGattDisconnected);
    device.addEventListener('gattserverdisconnected', onGattDisconnected);
    return openGatt();
  }).catch(function (e) {
    setConn(device ? 'disconnected' : 'idle', errText(e), e && e.name !== 'NotFoundError');
  });
}

function openGatt() {
  setConn('connecting', 'Connecting to ' + (device.name || 'bridge') + '...');
  return device.gatt.connect().then(function (server) {
    return server.getPrimaryService(NUS_SERVICE);
  }).then(function (svc) {
    return Promise.all([svc.getCharacteristic(NUS_RX), svc.getCharacteristic(NUS_TX)]);
  }).then(function (chars) {
    rxChar = chars[0];
    if (txChar) { try { txChar.removeEventListener('characteristicvaluechanged', onNotify); } catch (e) {} }
    txChar = chars[1];
    resetRx();
    txChar.addEventListener('characteristicvaluechanged', onNotify);
    return txChar.startNotifications();
  }).then(function () {
    writeChain = Promise.resolve();
    setConn('connected');
    send('1', true); // status stream on
  }).catch(function (e) {
    try { if (device && device.gatt && device.gatt.connected) device.gatt.disconnect(); } catch (x) {}
    rxChar = null;
    throw e;
  });
}

function reconnect() {
  if (DEMO) { demoConnect(); return; }
  if (!device) { connectClick(); return; }
  openGatt().catch(function (e) { setConn('disconnected', 'Reconnect failed: ' + errText(e), true); });
}

function onGattDisconnected() {
  rxChar = null;
  var msg = userDisconnect ? 'Disconnected.' : 'Connection lost. Tap Reconnect.';
  userDisconnect = false;
  if (state.conn !== 'connecting') setConn('disconnected', msg, false);
}

function disconnect() {
  userDisconnect = true;
  if (DEMO) { sim.disconnect(); onGattDisconnected(); return; }
  try { if (device && device.gatt && device.gatt.connected) device.gatt.disconnect(); else onGattDisconnected(); } catch (e) { onGattDisconnected(); }
}

// ===================================================================
// Connection UI
// ===================================================================
function setConn(c, msg, isErr) {
  state.conn = c;
  var dot = $('connDot'), txt = $('connText'), card = $('connCard'), btn = $('connectBtn'), cm = $('connMsg'), hb = $('hdrBtn');
  dot.className = 'dot';
  hb.hidden = true;
  btn.disabled = false;
  cm.className = isErr ? 'err' : 'muted';
  setHidden('demoHint', true);
  var label = DEMO ? ' (demo)' : '';
  switch (c) {
    case 'idle':
      txt.textContent = 'Not connected' + label;
      card.classList.add('show');
      btn.textContent = DEMO ? 'Connect to simulator' : 'Connect';
      cm.textContent = msg || (DEMO ? 'Demo mode: a built-in simulator stands in for the bridge.' : 'Connect to your Keiser M3 Bridge to begin.');
      break;
    case 'connecting':
      dot.classList.add('busy');
      txt.textContent = 'Connecting' + label;
      card.classList.add('show');
      btn.textContent = 'Connecting...';
      btn.disabled = true;
      cm.textContent = msg || 'Connecting...';
      break;
    case 'connected':
      dot.classList.add('on');
      txt.textContent = DEMO ? 'Simulator' : 'Connected';
      card.classList.remove('show');
      hb.hidden = false;
      keepAwake(true);
      logLine(DEMO ? 'Connected to simulator.' : 'Connected.', 'sys');
      break;
    case 'disconnected':
      dot.classList.add('off');
      txt.textContent = 'Disconnected' + label;
      card.classList.add('show');
      btn.textContent = 'Reconnect';
      cm.textContent = msg || 'Disconnected.';
      // A calibration in progress: keep its points as an incomplete record (once).
      if (state.s && state.s.cal !== 0) savePartialCal('connection lost');
      state.s = null;
      state.v3 = false;          // re-detected from the next S lines
      state.v31 = false;
      state.v32 = false;
      state.v33 = false; state.newerLines = 0; state.bWas = null;
      state.place = null;        // step 1 needs the live stream: start it again after reconnecting
      state.calSeen = false; state.uncalSince = 0;
      state.behind = null; state.fList = null; state.overshoot = null; state.stallSince = 0;
      state.fixAfter = ''; state.qFromEdit = false; state.qJustEnded = false;
      if (state.edit) { clearTimeout(state.edit.timer); state.edit = null; }   // a redo still running is picked up again from its S lines
      state.lastTurn = null;
      renderTurnInfo();
      keepAwake(false);
      logLine(msg || 'Disconnected.', 'sys');
      diagOnDisconnect();
      if (state.q) { clearTimeout(state.q.timer); state.q = null; }
      break;
    case 'unsupported':
      txt.textContent = 'Bluetooth unavailable';
      card.classList.add('show');
      btn.textContent = 'Connect';
      btn.disabled = true;
      cm.className = 'err';
      cm.textContent = 'This browser has no Web Bluetooth. Open this page in Bluefy on iPhone, or Chrome on Android/desktop.';
      setHidden('demoHint', false);
      break;
  }
  render();
  renderDiag();
}

// ===================================================================
// Screen wake lock
// ===================================================================
var wakeLock = null;
function keepAwake(on) {
  if (!('wakeLock' in navigator)) return;
  try {
    if (on && !wakeLock) {
      navigator.wakeLock.request('screen').then(function (wl) {
        wakeLock = wl;
        wl.addEventListener('release', function () { wakeLock = null; });
      }).catch(function () {});
    } else if (!on && wakeLock) {
      var w = wakeLock; wakeLock = null;
      w.release().catch(function () {});
    }
  } catch (e) {}
}
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible' && state.conn === 'connected') keepAwake(true);
  if (document.visibilityState === 'visible') checkPageVersion();   // [v3.3] a tab left open keeps old code
});

// ===================================================================
// Rendering
// ===================================================================
// Status lines pause while a recording is being sent, so that is not "stale".
function isStale() {
  if (!state.s) return true;
  if (transferActive()) return false;
  return (Date.now() - state.sAt) > STALE_MS;
}

function setChip(id, on, cls) {
  var el = $(id);
  el.classList.remove('on', 'warn', 'bad');
  if (on) el.classList.add(cls || 'on');
}

function render() {
  renderRide();
  renderCal();
  renderReview();
  renderRideCheck();
  renderBadge();
}

// Calibrated for display. Once a calibrated line has been seen on this connection, a run of
// uncalibrated S lines must last UNCAL_HOLD_MS before the page says "Not calibrated"; until
// then the last good gear stays. One odd line can't flash the warning.
function rideCalibrated() {
  var s = state.s;
  if (!s) return false;
  if (s.gear > 0 && s.flags.V) return true;
  return state.calSeen && state.lastGear > 0 && !!state.uncalSince && Date.now() - state.uncalSince < UNCAL_HOLD_MS;
}
function rideGear() {
  var s = state.s;
  if (!s) return 0;
  if (s.gear > 0 && s.flags.V) return s.gear;
  return rideCalibrated() ? state.lastGear : 0;
}

function renderRide() {
  var s = state.s, stale = isStale(), connected = state.conn === 'connected';
  var gearEl = $('gear'), note = $('gearNote'), goCal = $('goCal');
  // Late S lines never change what is shown: the last values stay, with a small note.
  var f = s ? s.flags : {};
  var calibrated = rideCalibrated();
  setChip('chipP', !!f.P);
  setChip('chipZ', !!f.Z);
  setChip('chipV', calibrated);
  setHidden('chipS', !f.S);
  setHidden('chipH', !f.H);
  setHidden('chipG', !f.G);
  setHidden('chipY', !(f.Y || diag.phase === 'dumping'));
  $('chipHText').textContent = 'Hold, off ' + fmt(s ? s.off : NaN, 1) + ' µT';

  gearEl.className = 'gear';
  note.className = 'gear-note';
  setHidden('goCal', !(s && !calibrated && !transferActive()));

  if (!s) {
    gearEl.textContent = '--';
    gearEl.classList.add('dim');
    note.textContent = connected ? 'Waiting for data' : 'Not connected';
    $('watts').textContent = '--'; $('cad').textContent = '--'; $('res').textContent = '--';
    return;
  }
  $('watts').textContent = fin(s.watts) ? String(s.watts) : '--';
  $('cad').textContent = fmt(s.cad, 0);
  $('res').textContent = fmt(s.res, 0);
  // [v3] cadence source under the cadence
  var cs = $('cadSrc');
  setHidden('cadSrc', !s.src);
  cs.className = 'src' + (s.src && !s.pedalling ? ' off' : '');
  cs.textContent = !s.src ? '' : !s.pedalling ? 'not pedalling' : s.src === 'B' ? 'from crank magnet' : 'from Wahoo pod';

  var gearNow = rideGear();
  if (transferActive()) {
    gearEl.textContent = calibrated ? String(gearNow) : '--';
    gearEl.classList.add('dim');
    note.textContent = 'Sending diagnostics recording...';
    return;
  }
  if (!calibrated) {
    gearEl.textContent = '--';
    gearEl.classList.add('dim');
    note.textContent = s.cal !== 0 ? 'Calibration in progress' : 'Not calibrated — go to Calibrate';
    note.classList.add('warn');
    if (stale) note.textContent = 'Waiting for the bridge…';
    return;
  }
  gearEl.textContent = String(gearNow);
  if (s.flags.S) {
    note.textContent = 'Magnetometer saturated';
    note.classList.add('bad');
  } else if (s.src && !s.pedalling && s.cal === 0) {
    // [v3] gear comes from whole pedal turns, so it only updates while pedalling
    gearEl.classList.add('dim');
    note.textContent = 'Not pedalling — showing the last gear';
  } else if (s.flags.H) {
    gearEl.classList.add('hold');
    note.textContent = 'Holding last good gear (off ' + fmt(s.off, 1) + ' µT)';
    note.classList.add('warn');
  } else if (s.cal !== 0) {
    note.textContent = 'Calibration in progress';
  } else {
    note.textContent = '';
  }
  if (stale) { note.className = 'gear-note warn'; note.textContent = 'Waiting for the bridge…'; }
}

var RING_C = 2 * Math.PI * 112;
// Any steady cadence works while calibrating (crank mode). Outside these limits the
// dot turns red: below ~30 a turn takes over 2 s and may time out (3 s); above ~120
// the dip detector risks counting twice per turn (learning rejects over 130).
var CAD_LO = 30, CAD_HI = 120;

// Calibration walkthrough: one step per page. Kept free of firmware details that may
// change (how the top point is taken) so it stays true. Steps marked v32 show only
// with firmware v3.2 (the down pass).
var CAL_INTRO = {
  crank: [
    { art: 'pedal', title: 'Keep pedalling', text: 'The bridge reads the gear on every pedal turn, so pedal the whole time at a steady pace.' },
    { art: 'check', title: 'A quick cadence check', text: 'First it learns your pedal stroke. Then check the rpm matches your Keiser console.' },
    { art: 'shift', title: 'One gear at a time', text: 'Shift up until the console just shows the next gear, then hold it. The circle turns green when it’s saved.' },
    { art: 'ring', title: 'Bottom to top', text: 'Start with the lever all the way down and work up. It takes a few minutes.' },
    { art: 'ring', v32: true, title: 'Then back down', text: 'From the top, come back down the same way: stop where the console first shows each lower gear. You can finish early.' }
  ],
  still: [
    { art: 'ring', title: 'Bottom to top', text: 'You’ll set the lever at each gear, starting all the way down and working up.' },
    { art: 'shift', title: 'One gear at a time', text: 'Shift up until the console just shows the next gear. The circle turns green when it’s saved.' },
    { art: 'still', title: 'Then stop and hold', text: 'At each gear stop pedalling and keep the lever still for a couple of seconds.' }
  ]
};
var onbIdx = 0, onbKey = '';

function onbSteps() {
  return state.v3 ? CAL_INTRO.crank.filter(function (st) { return !st.v32 || state.v32; }) : CAL_INTRO.still;
}

function renderOnb() {
  var steps = onbSteps();
  if (onbIdx > steps.length - 1) onbIdx = steps.length - 1;
  var st = steps[onbIdx], last = onbIdx === steps.length - 1;
  var arts = document.querySelectorAll('#onb .art');
  for (var i = 0; i < arts.length; i++) arts[i].classList.toggle('on', arts[i].getAttribute('data-art') === st.art);
  var key = (state.v3 ? 'crank' : 'still') + (state.v32 ? '32-' : '') + onbIdx;  // the step list switches once v3 is detected
  if (key !== onbKey) {
    $('onbTitle').textContent = st.title;
    $('onbText').textContent = st.text;
    onbKey = key;
  }
  var dots = $('onbDots');
  if (dots.children.length !== steps.length) {
    dots.innerHTML = '';
    for (var d = 0; d < steps.length; d++) dots.appendChild(document.createElement('i'));
  }
  for (var k = 0; k < dots.children.length; k++) dots.children[k].className = k === onbIdx ? 'on' : '';
  setHidden('onbNext', last);
  setHidden('calStart', !last);
  setHidden('onbBack', onbIdx === 0);
  var ring = $('artRing');
  if (ring.getElementsByTagName('i').length !== TOTAL_POINTS) {
    for (var p = 0; p < TOTAL_POINTS; p++) {
      var a = (-90 + p * 360 / TOTAL_POINTS) * Math.PI / 180, dot = document.createElement('i');
      dot.style.left = (50 + 46 * Math.cos(a)).toFixed(2) + '%';
      dot.style.top = (50 + 46 * Math.sin(a)).toFixed(2) + '%';
      ring.appendChild(dot);
    }
  }
}

function onbGo(delta) {
  var n = onbSteps().length, next = Math.max(0, Math.min(n - 1, onbIdx + delta));
  if (next === onbIdx) return;
  // the outgoing picture slides out the way we're moving
  var cur = document.querySelector('#onb .art.on');
  if (cur) cur.classList.toggle('before', delta > 0);
  onbIdx = next;
  renderOnb();
}

// The 25 points as dots on a circle around the disc (positions in % of the stage).
function buildCalDots() {
  var box = $('calDots');
  if (box.children.length === TOTAL_POINTS) return;
  box.innerHTML = '';
  for (var i = 0; i < TOTAL_POINTS; i++) {
    var a = (-90 + i * 360 / TOTAL_POINTS) * Math.PI / 180;
    var d = document.createElement('i');
    d.className = 'pt';
    d.style.left = (50 + 46.67 * Math.cos(a)).toFixed(2) + '%';
    d.style.top = (50 + 46.67 * Math.sin(a)).toFixed(2) + '%';
    box.appendChild(d);
  }
}

// ===================================================================
// [v3.3] the flow around the circle: breadcrumb, step 1 (placement), checkpoint, resume offers
// ===================================================================
function renderFlow(active, placing, saved) {
  var f = flowNow();
  setHidden('crumbs', !f);
  if (f) {
    var t = 'STEP ' + f + ' OF 6 · <b>' + esc(FLOW_STEPS[f - 1]) + '</b>';
    if ($('crumbT').innerHTML !== t) $('crumbT').innerHTML = t;
    $('crumbs').setAttribute('aria-label', 'Step ' + f + ' of 6: ' + FLOW_STEPS[f - 1]);
    var segs = $('crumbSegs').children;
    for (var i = 0; i < segs.length; i++) segs[i].className = i < f - 1 || (f === 4 && saved && i === 3) ? 'done' : i === f - 1 ? 'cur' : '';
  }
  setHidden('calPlace', !placing);
  if (placing) renderPlace();
  setHidden('upSaved', !saved);
  $('upContinue').disabled = state.conn !== 'connected';
  // resume offers on the start screen
  var rec = flowRecord(), show = !active && !placing && !saved && state.v33 && state.conn === 'connected' && !!rec &&
    (!rec.downDone || !rec.checkDone) && !(state.check && state.check.phase === 'run');
  setHidden('calResume', !show);
  if (show) {
    setHidden('resumeDown', !!rec.downDone);
    setHidden('resumeCheck', !!rec.checkDone);
    var txt = 'Your last calibration (' + fmtDate(rec.at) + ') is saved and ready to ride.' +
      (!rec.downDone ? ' Coming back down through the gears makes each gear switch where the console does.' : '') +
      (!rec.checkDone ? ' A short ride checks a few gears against the console.' : '');
    if ($('resumeText').textContent !== txt) $('resumeText').textContent = txt;
  }
}

function isIOS() {
  var ua = navigator.userAgent || '';
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}
function openPlace() {
  if (state.conn !== 'connected') { toast('Not connected'); return; }
  state.place = { x: null };
  send('v');                     // placement stream on (swing restarts from zero)
  setHidden('lockTip', !isIOS());
  keepAwake(true);
  render();
  try { $('main').scrollTop = 0; } catch (e) {}
}
function closePlace(stopStream) {
  if (!state.place) return;
  state.place = null;
  if (stopStream && state.conn === 'connected') send('v', true);   // placement stream off
}

function zoneOf(v, z) { return !fin(v) ? 'none' : v >= z.great ? 'great' : v >= z.good ? 'good' : 'weak'; }
var ZONE_WORD = { none: '', weak: 'Weak', good: 'Good', great: 'Great' };
function setCapsule(prefix, v, z, text) {
  var zone = zoneOf(v, z);
  $(prefix + 'V').textContent = text;
  $(prefix + 'Z').textContent = ZONE_WORD[zone];
  $(prefix + 'Z').className = 'z zone-' + zone;
  var f = $(prefix + 'F');
  f.style.transform = 'scaleX(' + (fin(v) ? Math.max(0.02, Math.min(1, v / z.max)) : 0).toFixed(3) + ')';
  f.className = 'fill-' + zone;
  $(prefix + 'T1').style.left = (z.good / z.max * 100).toFixed(1) + '%';
  $(prefix + 'T2').style.left = (z.great / z.max * 100).toFixed(1) + '%';
  return zone;
}
function renderPlace() {
  var x = state.place && state.place.x, stale = !x || Date.now() - x.at > 3000;
  var zs = PLACE_ZONES.swing;
  // arc gauge: zones as thin marks on the track, the value as a thick arc (pathLength 100)
  ['gzWeak', 'gzGood', 'gzGreat', 'gVal'].forEach(function (id) { $(id).setAttribute('pathLength', '100'); });
  var a = zs.good / zs.max * 100, b = zs.great / zs.max * 100;
  $('gzWeak').setAttribute('stroke-dasharray', a.toFixed(1) + ' 200');
  $('gzWeak').setAttribute('class', 'zn fill-weak');
  $('gzGood').setAttribute('stroke-dasharray', '0 ' + a.toFixed(1) + ' ' + (b - a).toFixed(1) + ' 200');
  $('gzGood').setAttribute('class', 'zn fill-good');
  $('gzGreat').setAttribute('stroke-dasharray', '0 ' + b.toFixed(1) + ' ' + (100 - b).toFixed(1) + ' 200');
  $('gzGreat').setAttribute('class', 'zn fill-great');
  var sw = x ? x.swing : NaN, swZone = zoneOf(sw, zs);
  var pct = fin(sw) ? Math.max(0, Math.min(100, sw / zs.max * 100)) : 0;
  $('gVal').setAttribute('stroke-dasharray', pct.toFixed(1) + ' 200');
  $('gVal').setAttribute('class', 'val fill-' + swZone);
  $('gNum').textContent = fin(sw) ? String(Math.round(sw)) : '--';
  $('gZone').textContent = fin(sw) && sw > 0 ? ZONE_WORD[swZone].toLowerCase() : 'move the lever';
  $('gZone').className = 'zone-' + swZone;
  $('gaugeSwing').setAttribute('aria-label', 'Lever swing ' + (fin(sw) ? Math.round(sw) + ' microtesla, ' + ZONE_WORD[swZone] : 'not measured yet'));
  var dipZone = setCapsule('mDip', x ? x.dip : NaN, PLACE_ZONES.dip, x && fin(x.dip) ? x.dip.toFixed(0) + ' µT' : '--');
  var headZone = setCapsule('mHead', x ? x.head : NaN, PLACE_ZONES.head, x && fin(x.head) ? Math.round(x.head) + '%' : '--');
  // verdict
  var cls = '', vt, vs, vi = '…';
  if (stale) {
    vt = x ? 'Waiting for the bridge…' : 'Waiting for readings';
    vs = 'Pedal and move the lever from the bottom to the top.';
  } else if (headZone === 'weak') {
    cls = 'weak'; vi = '!'; vt = 'Too close to the magnets';
    vs = 'The sensor is nearly saturated. Move the board a little further away.';
  } else if (swZone === 'weak') {
    cls = 'weak'; vi = '!'; vt = 'Move closer to the magnets';
    vs = 'Move the lever all the way from the bottom to the top first. If the swing stays low, mount the board closer to the magnets.';
  } else if (dipZone === 'weak') {
    cls = 'weak'; vi = '!'; vt = 'Move closer to the crank';
    vs = 'Keep pedalling. If the dip stays low, the bridge can’t count pedal turns reliably here.';
  } else {
    cls = 'good'; vi = '✓';
    vt = swZone === 'great' && dipZone === 'great' && headZone !== 'weak' ? 'Great spot' : 'Good spot';
    vs = 'Tap Next to start.';
  }
  $('placeVerdict').className = 'verdict' + (cls ? ' ' + cls : '');
  $('placeVi').textContent = vi;
  if ($('placeVt').textContent !== vt) $('placeVt').textContent = vt;
  if ($('placeVs').textContent !== vs) $('placeVs').textContent = vs;
  $('placeNext').disabled = state.conn !== 'connected';
  $('placeNext').textContent = cls === 'weak' ? 'Next anyway' : 'Next';
}

function renderCal() {
  var s = state.s, connected = state.conn === 'connected';
  // Staleness never switches the view: an active calibration stays on screen with the last values.
  var active = calRunning(s);   // [v3.3] cal 7 (checkpoint) shows the Saved card, not the circle
  var checkRun = !active && !!state.check && state.check.phase === 'run';   // [v3.2] gear check running
  if (active && state.place) closePlace(false);   // the calibration started: step 1 is over
  var placing = !!state.place && !active, saved = !!state.upSaved && !active;
  renderFlow(active, placing, saved);
  setHidden('calWait', !(active && !transferActive() && Date.now() - state.sAt > WAIT_NOTE_MS));
  setHidden('calIdle', active || checkRun || placing || saved);
  setHidden('calActive', !active);
  // [v3.2] a redo (or the gear check) keeps the circle at the top: hide the result card until it ends
  if (state.result) setHidden('resultCard', resultCardHidden());
  $('calStart').disabled = !connected || !s;
  $('calStart').textContent = connected ? 'Start calibration' : 'Connect first';
  var v3 = state.v3;   // latched per connection
  if (!active) renderOnb();

  // auto-capture toggle reflects the A flag
  var at = $('autoToggle');
  at.setAttribute('aria-checked', s ? (s.flags.A ? 'true' : 'false') : 'mixed');
  at.disabled = !connected;

  setHidden('pointsCard', (state.points.length === 0 && state.downPoints.length === 0 && !active) || checkRun);
  // focused screen while a calibration step is on: no tab bar, the (x) Calibrate Undo bar
  state.calFocus = active || placing || saved || checkRun;
  applyCalFocus();
  $('topX').setAttribute('aria-label', active ? 'Cancel calibration' : placing ? 'Back' : saved ? 'Later' : 'Skip the rest of the gear check');
  if (!active) { setHidden('topUndo', true); if (cancelArmedUntil) disarmCancel(); return; }

  buildCalDots();
  var now = Date.now(), auto = !!s.flags.A;
  // [v3.3] cal 6 step 0: a few more turns with the lever still (the noise), shown like learning
  var noiseTurns = state.v33 && s.cal === 6 && s.step === 0;
  var learning = s.cal === 3 || noiseTurns, confirming = s.cal === 4;
  // Crank mode: v3 firmware that found the crank (gear per pedal turn, keep pedalling).
  // After a failed crank learning it falls back to the v2 hold-still method.
  var crankMode = v3 && !state.learnFailed;
  // [v3.2] the pass: '' or 'u' up, 'd' down (step 22..1, prompt gear = step), 'ru' / 'rd' redo of one point
  var v32 = state.v32;
  var pass = v32 ? s.pass : '';
  var down = pass === 'd', redoing = pass === 'ru' || pass === 'rd';
  // [v3.2] B: go back past the point first (a redo, or the board went back to an overshot point)
  var mustPass = v32 && !!s.flags.B && s.cal === 1;
  var overshot = !!state.overshoot && !redoing && state.overshoot.step === s.step && state.overshoot.pass === s.pass;
  var step = learning || confirming ? 0 : s.step;
  var pGear = down || pass === 'rd' ? step : step + 1;   // the gear named in the prompt
  var stab = Math.round(s.stab);
  var turns = Math.max(0, Math.min(3, Math.round(stab / 100 * 3)));
  var flash = !learning && !confirming && state.capturedAt && now - state.capturedAt < CAPTURE_FLASH_MS;
  var justLearned = !learning && !confirming && step === 0 && !down && !redoing && state.learnDoneAt && now - state.learnDoneAt < LEARN_DONE_MS;
  // [v3.3] the flow step from the bridge; paused (O) is calm, and replaces the amber "keep pedalling"
  var v33 = state.v33, flow = v33 ? s.flow : 0;
  var sweeping = v33 && (s.cal === 6 ? s.step >= 1 : flow === 3) && !learning && !confirming;
  var paused = v33 && !!s.paused && !learning && !confirming;
  var stopped = crankMode && !v33 && !learning && !confirming && !s.pedalling && s.cal === 1;
  var checking = s.cal === 5;   // [v3.1] point check
  // [v3.3] where to be now: during a go-back (B) the gear to go back into, then (green) the target
  var back = backGear(s);
  var bFlash = v32 && !mustPass && state.bClearAt && now - state.bClearAt < B_CLEAR_MS && !flash;
  renderPointCheck(checking, s);
  if (paused || sweeping) setHidden('holdBanner', true);

  // disc look: learn | confirm | grey | blue | green | amber
  var look, head, sub;
  if (learning) {
    look = 'learn';
    head = noiseTurns ? 'Keep pedalling' : 'Pedal steadily';
    sub = noiseTurns ? 'Lever still for a few more turns' : 'Any comfortable pace, and keep the lever still';
  } else if (confirming) {
    look = 'confirm';
    head = 'Matches the console?';
    sub = 'Compare with the rpm on the Keiser';
  } else if (paused) {
    look = 'paused';
    head = 'Paused — pedal to continue';
    sub = 'Nothing is lost. Shift if you need to, then pedal again.';
  } else if (sweeping) {
    look = 'grey';
    var sweepDown = sweepIsDown(s);
    head = sweepDown ? 'Slowly back down to the bottom' : 'Slowly push the lever up';
    sub = sweepDown ? 'Keep pedalling, then tap Next' : 'As far as you can still pedal, then tap Next';
  } else if (flash || justLearned) {
    look = 'green';
    head = justLearned ? 'Crank learned' : 'Got it';
    sub = justLearned ? 'Now the 25 lever positions'
      : state.capturedDown ? 'Gear ' + (state.capturedPoint - 1) + ' (coming down) saved'
      : v32 && state.capturedPoint === TOTAL_POINTS && !redoing ? 'Top worked out from gears 23 and 24'
      : pointLabel(state.capturedPoint) + ' saved';
  } else if (bFlash) {
    // [v3.3] B cleared: the rider is back in the gear before; green, then on to the target
    look = 'green';
    head = 'That’s it';
    sub = 'Now ' + (down || pass === 'rd' ? 'down' : 'up') + ' to gear ' + pGear;
  } else if (stopped) {
    look = 'amber';
    head = 'Keep pedalling';
    sub = 'The gear is read on every pedal turn';
  } else if (!mustPass && (s.cal === 2 || stab > 0)) {
    look = 'blue';
    if (crankMode) {
      head = 'Hold it there';
      if (s.cal === 2) sub = 'Saving…';
      else if (v32) {
        // [v3.2] 2 agreeing turns (34, 67), then the check turn
        sub = turns >= 2 ? (auto ? 'Turn 3 of 3 · checking the lever has stopped…' : 'Tap CAPTURE to save') : 'Turn 1 of 3';
      } else {
        sub = turns >= 3 && !auto ? 'Tap CAPTURE to save'
          : turns >= 3 && state.v31 ? 'Checking the lever has stopped…' : 'Turn ' + Math.max(1, turns) + ' of 3';
      }
    } else {
      head = 'Hold still';
      sub = s.cal === 2 ? 'Saving…' : auto ? 'Saves when the ring fills' : 'Tap CAPTURE when ready';
    }
  } else {
    look = 'grey';
    var n = step + 1;
    var v31c = crankMode && state.v31;   // [v3.1] wording: "...FIRST shows gear N, then hold it there"
    var upw = !(down || pass === 'rd');
    if (mustPass) {
      // [v3.3] go back first (a redo, or the board went back to an overshot point): the circle shows
      // only the gear to be in now; the target comes after (green, then the target gear).
      head = 'Shift ' + (upw ? 'down' : 'up') + ' into gear ' + back;
      sub = 'Keep pedalling';
    } else if (redoing) {
      head = 'Now ' + (upw ? 'up' : 'down') + ' to gear ' + pGear;
      sub = 'Stop where the console FIRST shows ' + pGear + ', then hold it there';
    } else if (overshot) {
      head = 'Now ' + (upw ? 'up' : 'down') + ' to gear ' + pGear;
      sub = 'Stop where the console FIRST shows ' + pGear + ', then hold it there';
    } else if (down) {
      head = 'Shift down to ' + pGear;
      sub = (step >= DOWN_FIRST_STEP && !state.downPoints.length ? 'Now back down. ' : 'Keep pedalling. ') +
        'Move the lever DOWN to where the Keiser console FIRST shows ' + pGear + ', then hold it there';
    } else if (step === 0) { head = 'Lever all the way down'; sub = v31c ? 'Keep pedalling and hold it there' : crankMode ? 'Keep pedalling' : 'Then stop pedalling'; }
    else if (step >= TOTAL_POINTS - 1 && v32 && crankMode) { head = 'Working out the top'; sub = 'From gears 23 and 24. Keep pedalling'; }
    else if (step >= TOTAL_POINTS - 1) { head = 'Lever all the way up'; sub = v31c ? 'Keep pedalling and hold it there' : crankMode ? 'Keep pedalling' : 'Then stop pedalling'; }
    else if (v31c) { head = 'Shift up to ' + n; sub = 'Keep pedalling. Stop where the Keiser console FIRST shows ' + n + ', then hold it there'; }
    else { head = 'Shift up to ' + n; sub = 'Stop as soon as it shows ' + n + (crankMode ? '' : ', then stop pedalling'); }
  }
  $('calHead').textContent = head;
  $('calSub').textContent = sub;

  // [v3.2] one amber note next to the circle, most important first:
  // overshoot (the board went back), N,behind alone (gentle), or "still on gear N?" after 10 s.
  var bt = '', dirWord = down ? 'down' : 'up';
  var bh = !!state.behind && !checking && state.behind.step === s.step && state.behind.pass === s.pass;
  var stalled = !checking && !redoing && look === 'grey' && !overshot && !mustPass && !paused && !sweeping &&
    !!state.stallSince && state.stallKey === s.pass + s.step && now - state.stallSince > STALL_MS;
  if (paused || sweeping) {
    bt = '';
  } else if (overshot && !checking) {
    // [v3.3] the circle and the line under it say where to go; this just says why
    bt = v33
      ? '<b>Gear ' + pGear + ' was saved a little too far ' + (down ? 'down' : 'up') + '</b>, so it’s being redone.'
      : down
        ? '<b>Gear ' + pGear + ' was saved a little too far down.</b> Shift UP into gear ' + (pGear + 1) + ', then back down to where the console first shows gear ' + pGear + '.'
        : '<b>Gear ' + pGear + ' was saved a little too far up.</b> Shift DOWN into gear ' + (pGear - 1) + ', then back up to where the console first shows gear ' + pGear + '.';
  } else if (state.nstuck && state.nstuck.step === s.step && state.nstuck.pass === s.pass && !checking) {
    // [v3.3] N,stuck: the reading stays put although turns agree
    var upDir = !(down || pass === 'rd');
    bt = '<b>If the console already shows gear ' + pGear + '</b>, ease back into gear ' + (upDir ? pGear - 1 : pGear + 1) +
      ' and come ' + (upDir ? 'up' : 'down') + ' to it again.';
  } else if (bh) {
    bt = redoing
      ? '<b>This reading is behind the gear before it.</b> Check the console and move the lever on past it.'
      : '<b>Not quite there yet.</b> Keep moving the lever ' + dirWord + ' until the console first shows gear ' + pGear + '.';
  } else if (stalled) {
    // At the first down point the rider starts in gear 24 (the up pass ended on that edge), so the
    // gear before the target can be 24 or 23.
    var on = down ? pGear + 1 : pGear - 1;
    var onTxt = down && step >= DOWN_FIRST_STEP ? (TOTAL_POINTS - 1) + ' or ' + on : String(on);
    bt = '<b>Still on gear ' + onTxt + '?</b> Move ' + dirWord + ' until the console first shows gear ' + pGear +
      '. If it already shows ' + pGear + ', ease back ' + (down ? 'up' : 'down') + ' into gear ' + on + '.';
  }
  setHidden('behindHint', !bt);
  if (bt && $('behindHint').innerHTML !== bt) $('behindHint').innerHTML = bt;

  // disc
  $('disc').className = 'disc' + (look === 'blue' ? ' blue' : look === 'green' ? ' green' : look === 'amber' ? ' amber' : look === 'learn' ? ' learn' : look === 'paused' ? ' paused' : '') +
    ((flash || bFlash) && look === 'green' ? ' pop' : '') + (mustPass && look === 'grey' ? ' back' : '');
  var showNum = look !== 'learn' && (look !== 'green' || bFlash);
  setHidden('discNum', !showNum);
  setHidden('discCheck', look !== 'green' || bFlash);
  setHidden('discCrank', look !== 'learn');
  setHidden('discTurns', look !== 'learn');
  if (showNum) {
    if (confirming) {
      $('discLbl').textContent = 'RPM';
      $('discBig').textContent = fin(s.cad) && s.cad > 0 ? String(Math.round(s.cad)) : '--';
    } else if (sweeping) {
      $('discLbl').textContent = 'LEVER';
      $('discBig').textContent = sweepIsDown(s) ? '↓' : '↑';
    } else if (bFlash) {
      $('discLbl').textContent = 'GEAR';
      $('discBig').textContent = String(state.bClearGear || back);
    } else if (mustPass) {
      $('discLbl').textContent = 'GO TO';
      $('discBig').textContent = String(back);
    } else if (redoing || down) {
      $('discLbl').textContent = redoing ? 'REDO' : 'DOWN TO';
      $('discBig').textContent = String(Math.max(1, pGear));
    } else {
      $('discLbl').textContent = step === 0 ? 'BOTTOM' : step >= TOTAL_POINTS - 1 ? 'TOP' : 'GEAR';
      $('discBig').textContent = String(step === 0 ? 1 : Math.min(24, step + 1));
    }
  }
  if (look === 'learn') {
    $('discTurns').textContent = noiseTurns ? 'Lever still' : fin(s.lturns) ? Math.min(s.lturns, 6) + ' of 6 turns' : stab + '%';
  }
  // Three arcs (agreeing turns) in crank mode; a continuous ring for learning and the v2 hold timer.
  var useRing = look === 'learn' || (!crankMode && (look === 'blue' || look === 'grey'));
  var ringPct = s.cal === 2 ? 100 : stab;
  for (var k = 0; k < 3; k++) {
    setHidden('arc' + k, useRing);
    $('arc' + k).setAttribute('class', 'arc' + (look === 'green' || (look === 'blue' && (s.cal === 2 || k < turns)) ? ' on' : ''));
  }
  setHidden('ringTrack', !useRing);
  setHidden('ringFill', !useRing);
  if (useRing) $('ringFill').setAttribute('stroke-dashoffset', String(RING_C * (1 - ringPct / 100)));

  // the 25 dots
  var dots = $('calDots').children;
  if (down || redoing) {
    // [v3.2] all 25 green from the up pass; measured on the way down = settled blue;
    // the point being measured has a ring.
    // In the down pass every point above the one being measured is done coming down, even if this
    // page missed its C,down line (reloaded, reconnected, or resumed with #D).
    var downBy = {};
    state.downPoints.forEach(function (q) { downBy[q.point] = true; });
    for (var dj = 0; dj < TOTAL_POINTS; dj++) {
      var isDown = downBy[dj + 1] || (down && dj + 1 > step + 1 && dj + 1 <= TOTAL_POINTS - 2);
      var dc = 'pt ' + (isDown ? 'down' : 'done');
      if (dj === step && !flash) dc = 'pt cur ring' + (look === 'blue' ? ' blue' : '');
      dots[dj].className = dc;
    }
  } else {
    var doneCount = flash ? state.capturedPoint : step;
    for (var j = 0; j < TOTAL_POINTS; j++) {
      var cls = 'pt';
      if (!learning && !confirming && !sweeping) {
        if (j < doneCount) cls += ' done';
        else if (j === step && !flash) cls += ' cur' + (look === 'blue' ? ' blue' : '');
      }
      dots[j].className = cls;
    }
  }

  // cadence slider (crank mode only: the v2 method needs the flywheel still)
  setHidden('cadG', !crankMode || checking);
  if (crankMode) {
    var rpm = fin(s.cad) ? Math.round(s.cad) : 0, dotCls = '', cap, capCls = '';
    // [v3.2+] cadence guide: a green window for the gear to be in now (CAD_GUIDE)
    var guideGear = learning || confirming || sweeping ? (s.gear > 0 ? s.gear : 1) : mustPass ? back : pGear;
    var win = cadWindow(guideGear), guide = v32;
    if (stopped || paused || rpm <= 0) {
      dotCls = 'idle';
      cap = paused ? 'Paused' : stopped ? 'Not pedalling' : '';
      capCls = stopped ? 'warn' : '';
    } else if (rpm < CAD_LO || rpm > CAD_HI) {
      dotCls = 'bad'; capCls = 'bad';
      cap = rpm < CAD_LO ? 'Too slow — speed up a little' : 'Too fast — ease off a little';
    } else if (guide && (rpm < win[0] || rpm > win[1])) {
      dotCls = 'mid';
      cap = 'Comfortable here: ' + win[0] + '–' + win[1] + ' rpm';
    } else cap = '';
    // the line runs 20-130 rpm; the green window is the comfortable pace for this gear
    // (v3.1 has no guide: the workable range); the dot carries the rpm along it
    var sc = function (v) { return Math.max(0, Math.min(100, (v - 20) / (130 - 20) * 100)); };
    var wlo = guide ? win[0] : CAD_LO, whi = guide ? win[1] : CAD_HI;
    $('cadWin').style.left = sc(wlo).toFixed(1) + '%';
    $('cadWin').style.width = (sc(whi) - sc(wlo)).toFixed(1) + '%';
    $('cadMk').style.left = (dotCls === 'idle' ? 0 : sc(rpm)).toFixed(1) + '%';
    $('cadT1').style.left = sc(wlo).toFixed(1) + '%';
    $('cadT2').style.left = sc(whi).toFixed(1) + '%';
    if ($('cadT1').textContent !== String(wlo)) $('cadT1').textContent = String(wlo);
    if ($('cadT2').textContent !== String(whi)) $('cadT2').textContent = String(whi);
    var dot = $('cadDot');
    dot.parentNode.className = 'cadg-dot' + (dotCls ? ' ' + dotCls : '');
    dot.textContent = dotCls === 'idle' ? '--' : String(rpm);
    $('cadCap').textContent = cap;
    $('cadCap').className = 'cadg-cap' + (capCls ? ' ' + capCls : '');
    $('cadG').setAttribute('aria-label', dotCls === 'idle' ? (cap || 'Cadence: waiting for pedal turns') : 'Cadence ' + rpm + ' rpm' + (cap ? ', ' + cap : ''));
  }

  // buttons
  var noPoint = learning || confirming || sweeping;
  $('calActive').classList.toggle('nopoint', noPoint);
  $('calActive').classList.toggle('redoing', redoing);
  setHidden('calCount', noPoint);
  $('calCount').textContent = redoing ? 'Redoing ' + pointWords(pass === 'rd' ? 'd' : 'u', step + 1)
    : down ? 'Down pass: ' + Math.max(0, Math.min(DOWN_POINTS, DOWN_FIRST_STEP - step)) + ' of ' + DOWN_POINTS
    : step + ' of ' + TOTAL_POINTS;
  // [v3.3] on the gear steps: stopping is fine
  setHidden('stopNote', !(v33 && (flow === 4 || flow === 5) && !redoing && !paused && !checking));
  var relearnHere = state.learnFailed && v3 && s.cal === 1 && step === 0 && !down && !redoing && !sweeping;
  setHidden('confirmBtns', !(confirming || relearnHere || sweeping));
  setHidden('btnConfirm', !(confirming || sweeping));
  setHidden('btnRelearn', sweeping);
  $('btnConfirm').textContent = sweeping ? 'Next' : 'Yes, it matches';
  $('btnRelearn').textContent = confirming ? 'Learn again' : 'Try learning the crank again';
  $('btnConfirm').disabled = !connected;
  $('btnRelearn').disabled = !connected;
  $('calActive').classList.toggle('checking', checking);
  setHidden('btnCapture', noPoint || checking);
  setHidden('btnUndo', noPoint || checking || redoing);
  // [v3.2] down pass: save what's measured and skip the rest (s), with a second-tap confirm
  setHidden('btnSkipDown', !(down && !checking && (s.cal === 1 || s.cal === 2)));
  $('btnSkipDown').disabled = !connected;
  // Auto-capture on: a small secondary "Capture now", usable once 2 of 3 turns agree
  // (or the hold timer is two-thirds done). Off: the big CAPTURE button.
  var cap = $('btnCapture');
  cap.classList.toggle('lite', auto);
  cap.classList.toggle('primary', !auto);
  cap.textContent = auto ? 'Capture now' : 'CAPTURE';
  cap.disabled = !connected || s.cal !== 1 || (auto && stab < 67) || stopped || mustPass;
  // Undo: at the first down point it goes back to up point 24 (the board allows it).
  $('btnUndo').disabled = !connected || s.cal !== 1 || (!down && step === 0);
  $('btnCancel').disabled = !connected;
  setHidden('topUndo', $('btnUndo').hidden);
  $('topUndo').disabled = $('btnUndo').disabled;
}

function applyCalFocus() {
  document.body.classList.toggle('calfocus', !!state.calFocus && state.view === 'cal');
}

// [v3.1] Hold-still notice (M flag / W line): a non-blocking amber strip; the turns meter stays.
// cal=5 (P line, couldn't settle for 15 s): the big amber card replaces the disc.
// The redo banner stays until the redone point is captured.
var checkKey = '';
function renderPointCheck(checking, s) {
  setHidden('stage', checking);
  setHidden('calSay', checking);
  setHidden('calCheck', !checking);
  var n = checking ? s.step + 1 : 0;
  var pass = state.v32 ? s.pass : '';
  var downP = pass === 'd' || pass === 'rd';   // [v3.2] down point n = coming down to gear n-1
  if (checking) {
    if (pass + n !== checkKey) {   // only rewrite the card when it changes
      checkKey = pass + n;
      if (downP) {
        $('checkTitle').textContent = 'Gear ' + (n - 1) + ' (coming down): the reading keeps changing';
        $('checkBody').textContent = 'To redo it: move the lever UP above gear ' + (n - 1) + ', then down to where the console first shows gear ' + (n - 1) + ', then hold it there.';
        $('btnRedo').textContent = 'Redo gear ' + (n - 1);
      } else {
        $('checkTitle').textContent = 'Point ' + n + ': the reading keeps changing';
        $('checkBody').textContent = n >= TOTAL_POINTS
          ? 'To redo it: push the lever back down a little, then all the way up again and hold.'
          : 'To redo it: move the lever DOWN below gear ' + n + ', then up to where the console first shows gear ' + n + ', then hold it there.';
        $('btnRedo').textContent = 'Redo point ' + n;
      }
      setHidden('checkDrift', false);
      $('checkDrift').textContent = 'It kept changing for 15 seconds, so the bridge stopped waiting.';
    }
  } else checkKey = '';

  // hold-still strip: driven by the M flag, or a W for this point that hasn't been captured yet
  var holding = !checking && (s.cal === 1 || s.cal === 2) &&
    (!!s.flags.M || !!(state.w && !state.w.resolved && state.w.point === s.step + 1));
  setHidden('holdBanner', !holding);
  var connected = state.conn === 'connected';
  $('btnRedo').disabled = !connected;
  $('btnKeep').disabled = !connected;

  var redo = state.redo, txt = '';
  var redoDown = state.redoPass === 'd';
  var showRedo = !checking && !holding && redo > 0 && (s.cal === 1 || s.cal === 2) && s.step === redo - 1 &&
    (pass === 'd') === redoDown;
  if (showRedo) {
    txt = redoDown
      ? 'Redo gear ' + (redo - 1) + ' (coming down): lever UP above gear ' + (redo - 1) + ' first, then down to where the console first shows gear ' + (redo - 1) + ', then hold.'
      : redo >= TOTAL_POINTS
        ? 'Redo point 25: push the lever back down a little, then all the way up again and hold.'
        : 'Redo point ' + redo + ': lever DOWN below gear ' + redo + ' first, then up to where the console first shows gear ' + redo + ', then hold.';
  } else if (!checking && !holding && (pass === 'ru' || pass === 'rd')) {
    // [v3.2] #R redo of one point of the saved calibration
    var g = pass === 'ru' ? s.step + 1 : s.step;
    var lead = fixInRedo() ? 'Gear ' + g + (pass === 'rd' ? ' (coming down)' : '') + ' needs another look: ' : 'Redo gear ' + g + (pass === 'rd' ? ' (coming down)' : '') + ': ';
    showRedo = true;
    txt = pass === 'ru'
      ? lead + 'lever DOWN below gear ' + g + ' first, then up to where the console FIRST shows gear ' + g + ', then hold.'
      : lead + 'from above gear ' + g + ', down to where the console FIRST shows gear ' + g + ', then hold.';
  }
  setHidden('redoBanner', !showRedo);
  if (showRedo && $('redoBanner').textContent !== txt) $('redoBanner').textContent = txt;
}

function renderBadge() {
  var b = $('calBadge');
  var calActive = state.s && state.s.cal !== 0;
  b.hidden = state.view === 'cal' || !(calActive || (state.result && state.result.type) || reviewItems().length);
  var ph = diag.phase;
  setHidden('diagBadge', state.view === 'diag' || ph === 'idle' || ph === 'done' || ph === 'error');
}

function pointLabel(n) {
  if (n === 1) return 'Bottom';
  if (n === TOTAL_POINTS) return 'Top';
  return 'Gear ' + n;
}

// [v3.2] a point in plain words: up point N = gear N going up; down point N = gear N-1 coming down
function pointWords(pass, n) {
  if (pass === 'd') return 'gear ' + (n - 1) + ' (coming down)';
  if (n === 1) return 'the bottom (lever all the way down)';
  if (n === TOTAL_POINTS) return 'the top (lever all the way up)';
  return 'gear ' + n + ' (going up)';
}
function capFirst(t) { return t.charAt(0).toUpperCase() + t.slice(1); }

function renderPoints() {
  var list = $('plist');
  var pts = state.points.slice().sort(function (a, b) { return a.point - b.point; });
  var html = '';
  // [v3.2] down points under the up points: right column = gap to the same edge's up reading
  var downs = state.downPoints.slice().sort(function (a, b) { return b.point - a.point; });
  var upBy = {};
  pts.forEach(function (q) { upBy[q.point] = q; });
  for (var i = 0; i < pts.length; i++) {
    var p = pts[i], prev = i > 0 && pts[i - 1].point === p.point - 1 ? pts[i - 1] : null;
    var dist = NaN;
    if (prev && fin(p.x) && fin(p.y) && fin(p.z) && fin(prev.x) && fin(prev.y) && fin(prev.z)) {
      dist = Math.sqrt(Math.pow(p.x - prev.x, 2) + Math.pow(p.y - prev.y, 2) + Math.pow(p.z - prev.z, 2));
    }
    html += '<div class="prow"><span class="n">' + p.point + '</span><span>' + pointLabel(p.point) +
      '</span><span class="xyz">' + fmt(p.x, 1) + ', ' + fmt(p.y, 1) + ', ' + fmt(p.z, 1) +
      '</span><span class="d' + (fin(dist) && dist < MARGINAL_UT ? ' marg' : '') + '">' +
      (fin(dist) ? 'Δ ' + dist.toFixed(1) : '') + '</span></div>';
  }
  if (downs.length) {
    html += '<div class="prow"><span></span><span class="small muted" style="grid-column:2 / -1">Coming down (right: gap to the reading going up)</span></div>';
    downs.forEach(function (q) {
      var gap = dist3(q, upBy[q.point]);
      html += '<div class="prow"><span class="n">' + q.point + '</span><span>Gear ' + (q.point - 1) + ' ↓</span><span class="xyz">' +
        fmt(q.x, 1) + ', ' + fmt(q.y, 1) + ', ' + fmt(q.z, 1) + '</span><span class="d">' + (fin(gap) ? '↕ ' + gap.toFixed(1) : '') + '</span></div>';
    });
  }
  list.innerHTML = html;
  list.scrollTop = list.scrollHeight;
  renderCal();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}

function resultCardHidden() {
  return calRunning(state.s) || !!(state.check && state.check.phase === 'run');
}

function renderResult() {
  var card = $('resultCard'), r = state.result;
  if (!r) { card.hidden = true; card.innerHTML = ''; return; }
  card.hidden = resultCardHidden();
  var close = '<button class="x-btn" type="button" data-dismiss aria-label="Dismiss">×</button>';
  var html;
  if (r.type === 'K') {
    var marginal = r.ok && fin(r.minstep) && r.minstep < MARGINAL_UT;
    card.className = 'card result ' + (r.ok ? (marginal ? 'warn' : 'ok') : 'bad');
    html = '<h2>' + (r.ok ? 'Calibration saved' : 'Calibration rejected') + close + '</h2>';
    if (r.edit) html += '<p>Changed: ' + esc(r.edit) + '.</p>';
    if (!r.ok) html += '<p><b>' + esc(r.msg || 'No reason given') + '</b></p>';
    else if (r.msg && r.msg.toLowerCase() !== 'saved') html += '<p>' + esc(r.msg) + '</p>';
    html += '<div class="stats">' +
      '<div class="stat"><div class="v">' + fmt(r.span, 1) + '</div><div class="u">Span (µT)</div></div>' +
      '<div class="stat"><div class="v">' + fmt(r.minstep, 1) + '</div><div class="u">Smallest step (µT)' +
      (fin(r.minAt) ? ' (gear ' + r.minAt + ')' : '') + '</div></div></div>';
    // [v3.2] down pass
    if (r.ok && r.down >= 0 && !r.edit) {
      html += '<p class="downinfo">' + (r.down >= DOWN_POINTS ? 'Down pass: all ' + DOWN_POINTS + ' gears measured coming down.'
        : r.down > 0 ? 'Down pass: ' + r.down + ' of ' + DOWN_POINTS + ' gears measured coming down.'
        : 'Down pass skipped.') + '</p>';
    }
    if (marginal) {
      html += '<div class="marginal">Marginal: the smallest step (' + fmt(r.minstep, 1) + ' µT at gear ' +
        (fin(r.minAt) ? r.minAt : '?') + ') is under ' + MARGINAL_UT + ' µT. That gear may flicker. Consider moving the sensor closer to the magnet and recalibrating.</div>';
    }
    if (!r.ok) html += '<p class="small">Tap Start calibration to try again.</p>';
    if (r.recordId) {
      var rec = findRecord(r.recordId);
      html += rec
        ? '<p class="small" style="margin-top:12px">' + (rec.persisted ? 'Saved on this phone as ' : 'Kept for this session only as ') + esc(rec.filename) + '.</p>' + recActionsHtml(rec.id)
        : '<p class="small" style="margin-top:12px">Deleted from this phone.</p>';
    }
  } else {
    card.className = 'card result bad';
    html = '<h2>Calibration aborted' + close + '</h2><p><b>' + esc(r.reason) + '</b></p>' +
      '<p class="small">The previous calibration (if any) is unchanged.</p>';
    var prec = r.recordId ? findRecord(r.recordId) : null;
    if (prec) html += '<p class="small">The points captured so far were saved as ' + esc(prec.filename) + ' (' + esc(prec.summary) + ').</p>' + recActionsHtml(prec.id);
  }
  card.innerHTML = html;
}

// ===================================================================
// [v3.2] Review card: points the bridge's check flagged after saving (F lines)
// ===================================================================
var REASON_TEXT = {
  behind: 'isn’t past the gear before it',
  updown: 'its up and down readings don’t agree',
  offpath: 'is off the path the other gears make',
  pair: 'its up and down readings don’t agree, and it isn’t clear which is off',
  prior: 'moved since your last calibration'
};
function reviewItems() { return state.review ? state.review.items : []; }
function fixKey(it) { return it.pass + it.point; }
function fixCanRedo(it) { return it.point >= 2 && it.point <= (it.pass === 'd' ? TOTAL_POINTS - 2 : TOTAL_POINTS - 1); }
function fixGuess(it) { return fin(it.gx) ? { x: it.gx, y: it.gy, z: it.gz } : null; }
// The flagged point being redone right now (pass ru/rd matching the first item), or null.
function fixInRedo() {
  var s = state.s, it = reviewItems()[0];
  if (!it || !s || s.cal === 0 || (s.pass !== 'ru' && s.pass !== 'rd')) return null;
  return (s.pass === 'rd' ? 'd' : 'u') === it.pass && s.step + 1 === it.point ? it : null;
}

// Guided fixes: redo the first flagged point straight away; after FIX_MAX_TRIES redos of the same
// point (or when the rider cancelled, or the bridge refused) wait on the card for the rider.
var fixWaitT = 0;
function fixNext() {
  if (!state.review) return;
  state.review.items = state.review.items.filter(function (it) { return !state.reviewKept[fixKey(it)]; });
  var it = state.review.items[0];
  if (!it) { state.review = null; state.fixPaused = false; maybeOfferCheck(); render(); return; }
  var tries = state.fixTries[fixKey(it)] || 0;
  if (state.fixPaused || tries >= FIX_MAX_TRIES || !fixCanRedo(it) || state.conn !== 'connected' || state.edit) { renderReview(); return; }
  if (state.s && state.s.cal !== 0) {
    // K and the F list come just before the status line says the board is idle: try again shortly
    clearTimeout(fixWaitT);
    fixWaitT = setTimeout(fixNext, 300);
    renderReview();
    return;
  }
  state.fixTries[fixKey(it)] = tries + 1;
  startEdit('R', it.pass, it.point);
}

// Skip or Use best guess, from the card or from the redo screen (then the redo is cancelled first).
function fixAction(act) {
  var it = reviewItems()[0];
  if (!it) return;
  state.editErr = '';
  if (fixInRedo() || (state.edit && state.edit.kind === 'R')) {
    state.fixAfter = act;
    send('x');
    return;
  }
  if (act === 'skip') { state.reviewKept[fixKey(it)] = true; fixNext(); }
  else startEdit('G', it.pass, it.point, fixGuess(it));
  renderReview();
}

// The redo was cancelled because the rider chose Skip or Use best guess.
function redoStopped() {
  var act = state.fixAfter, it = reviewItems()[0];
  state.fixAfter = '';
  if (!it) return;
  if (act === 'skip') { state.reviewKept[fixKey(it)] = true; fixNext(); return; }
  // #G needs the board idle: wait for the status line to say so (at most ~3 s)
  var tries = 0;
  (function go() {
    if (state.s && state.s.cal !== 0 && tries++ < 12) { setTimeout(go, 250); return; }
    startEdit('G', it.pass, it.point, fixGuess(it));
  })();
}

var reviewKey = '';
function renderReview() {
  var card = $('reviewCard'), items = reviewItems();
  var active = calRunning(state.s);
  var checkRun = !!state.check && state.check.phase === 'run';
  var show = !active && !checkRun && items.length > 0 && !state.fixHold && !state.upSaved && !state.place;   // [v3.3] fixes wait for the down pass
  renderFixLinks();
  setHidden('reviewCard', !show);
  if (!show) { reviewKey = ''; return; }
  var connected = state.conn === 'connected', busy = !!state.edit;
  var it = items[0], words = pointWords(it.pass, it.point), key2 = fixKey(it);
  var tries = state.fixTries[key2] || 0, tired = tries >= FIX_MAX_TRIES || !fixCanRedo(it);
  var key = key2 + it.reason + '|' + items.length + '|' + tries + '|' + busy + '|' + state.editErr + '|' + connected + '|' + state.fixPaused;
  if (key === reviewKey) return;   // only rewrite when something changed (keeps focus and taps intact)
  reviewKey = key;
  var why = REASON_TEXT[it.reason] || 'looks wrong (' + it.reason + ')';
  var dis = !connected || busy ? ' disabled' : '';
  var html = '<h2>' + esc(capFirst(words.replace(/ \(.*\)$/, ''))) + ' needs another look' +
    '<button class="x-btn" type="button" data-review="dismiss" aria-label="Stop checking gears">×</button></h2>' +
    '<p class="rv-t">The bridge checked the saved calibration: <b>' + esc(words) + '</b> ' + esc(why) + '.</p>';
  if (tired && fixCanRedo(it)) html += '<p class="small muted">It still looks off after ' + tries + ' tries. Use the bridge’s best guess, or keep it as it is.</p>';
  else if (!busy) html += '<p class="small muted">Pedal it once more: the screen walks you through it.</p>';
  html += '<div class="btn-stack" style="margin-top:12px">' +
    (tired
      ? '<button class="btn primary wide" type="button" data-review="guess"' + dis + ' aria-label="Use the bridge’s best guess for ' + esc(words) + '">Use best guess</button>'
      : '<button class="btn primary wide" type="button" data-review="redo"' + dis + ' aria-label="Redo ' + esc(words) + ' by pedalling">Redo ' + esc(words.replace(/ \(.*\)$/, '')) + '</button>') +
    '</div><div class="rv-links">' +
    (tired ? '' : '<button class="linkbtn" type="button" data-review="guess"' + dis + '>Use best guess instead</button>') +
    '<button class="linkbtn" type="button" data-review="skip"' + (busy ? ' disabled' : '') + '>' + (tired ? 'Keep it as it is' : 'Skip') + '</button></div>';
  if (items.length > 1) html += '<p class="small muted" style="margin-top:8px">Then ' + (items.length - 1) + ' more to look at.</p>';
  if (busy) html += '<div class="rv-msg busy" role="status">' + (state.edit.kind === 'R' ? 'Starting the redo…' : 'Saving the best guess…') + '</div>';
  if (state.editErr) html += '<div class="rv-msg bad" role="alert">Not changed: ' + esc(state.editErr) + '</div>';
  card.innerHTML = html;
}

// On the redo screen of a flagged point: small "Use best guess instead" / "Skip" links.
function renderFixLinks() {
  var it = fixInRedo();
  setHidden('fixLinks', !it || !!state.fixAfter);
  $('fixGuess').disabled = state.conn !== 'connected';
  $('fixSkip').disabled = state.conn !== 'connected';
}

// Send #R (redo by pedalling) or #G (use the board's guess) for one point.
function startEdit(kind, pass, point, g) {
  if (state.conn !== 'connected') { toast('Not connected'); return; }
  if (state.edit) { toast('Still waiting for the bridge'); return; }
  if (state.s && state.s.cal !== 0) { toast('Finish or cancel the calibration first'); return; }
  state.editErr = '';
  var ed = { kind: kind, pass: pass, point: point, g: g || null, timer: 0 };
  ed.timer = setTimeout(function () {
    if (state.edit === ed && !ed.started && !ed.okd) {
      state.edit = null;
      state.editErr = 'no answer from the bridge (it needs firmware v3.2)';
      state.fixPaused = true;
      renderReview();
    }
  }, EDIT_TIMEOUT_MS);
  state.edit = ed;
  sendCmd('#' + kind + ',' + pass + ',' + point);
  renderReview();
}

// ===================================================================
// [v3.2] Gear check ("confirm ride"): app only, compares the bridge's
// live gear with the Keiser console at a few gears. Offered after a
// saved calibration once the review list is empty or dismissed.
// ===================================================================
function maybeOfferCheck() {
  if (state.checkDone || state.check || state.upSaved || state.fixHold) return;
  var r = state.result;
  if (!r || r.type !== 'K' || !r.ok || reviewItems().length) return;
  // [v3.3] the gear check is step 6 of the flow: it starts by itself (Skip is on screen)
  if (state.v33) { startGearCheck(); return; }
  state.check = { phase: 'offer', idx: 0, results: [], picking: false, val: 1, app: 0 };
  renderRideCheck();
}
function startGearCheck() {
  state.check = { phase: 'run', flow: !!state.v33, idx: 0, results: [], picking: false, val: 1, app: 0 };
  showView('cal');
  render();
}

function renderRideCheck() {
  var c = state.check, active = calRunning(state.s);
  var show = !!c && !active && !(c.phase === 'offer' && reviewItems().length);
  setHidden('rideCheck', !show);
  if (!show) return;
  setHidden('rckOffer', c.phase !== 'offer');
  setHidden('rckRun', c.phase !== 'run');
  setHidden('rckDone', c.phase !== 'done');
  var connected = state.conn === 'connected';
  $('rckStart').disabled = !connected;
  if (c.phase !== 'run') return;
  $('rckQuit').textContent = c.flow ? 'Skip this step' : 'Skip the rest';
  var st = RIDE_CHECKS[c.idx], s = state.s;
  $('rckStep').textContent = 'Check ' + (c.idx + 1) + ' of ' + RIDE_CHECKS.length + ' · ' + st.label;
  if ($('rckTask').textContent !== st.task) $('rckTask').textContent = st.task;
  var g = rideGear(), stale = isStale(), live = connected && g > 0 && !stale;
  var pedalling = !s || s.pedalling;
  $('rckGear').textContent = live ? String(g) : '--';
  $('rckGear').className = 'gear' + (live && pedalling ? '' : ' dim');
  $('rckRing').setAttribute('aria-label', live ? 'Bridge gear ' + g : 'Bridge gear not known');
  $('rckNote').textContent = !connected ? 'Not connected' : stale ? 'Waiting for the bridge…' : !live ? 'Not calibrated'
    : !pedalling ? 'Keep pedalling: the gear updates on each pedal turn' : '';
  // cadence line: the green window is the pace this check wants (faster: above the last check's pace)
  var crpm = s && fin(s.cad) ? Math.round(s.cad) : 0;
  var lastRpm = c.results.length ? c.results[c.results.length - 1].rpm : 0;
  var cw = cadWindow(st.gear);
  var clo = st.pace === 'fast' && lastRpm ? Math.min(CAD_HI - 5, lastRpm + CHECK_FASTER) : cw[0];
  var chi = st.pace === 'fast' && lastRpm ? CAD_HI : cw[1];
  var cidle = !pedalling || crpm <= 0;
  var ccls = cidle ? ' idle' : crpm < CAD_LO || crpm > CAD_HI ? ' bad' : crpm < clo || crpm > chi ? ' mid' : '';
  var csc = function (v) { return Math.max(0, Math.min(100, (v - 20) / (130 - 20) * 100)); };
  $('rckCadWin').style.left = csc(clo).toFixed(1) + '%';
  $('rckCadWin').style.width = (csc(chi) - csc(clo)).toFixed(1) + '%';
  $('rckCadMk').style.left = (cidle ? 0 : csc(crpm)).toFixed(1) + '%';
  $('rckCadMk').className = 'cadg-dot' + ccls;
  $('rckCadDot').textContent = cidle ? '--' : String(crpm);
  $('rckCadT1').style.left = csc(clo).toFixed(1) + '%';
  $('rckCadT2').style.left = csc(chi).toFixed(1) + '%';
  if ($('rckCadT1').textContent !== String(clo)) $('rckCadT1').textContent = String(clo);
  if ($('rckCadT2').textContent !== String(chi)) $('rckCadT2').textContent = String(chi);
  $('rckCad').setAttribute('aria-label', cidle ? 'Cadence: not pedalling' : 'Cadence ' + crpm + ' rpm, aim for ' + clo + ' to ' + chi);
  setHidden('rckAsk', c.picking);
  setHidden('rckPick', !c.picking);
  if (!c.picking) {
    // wait until the rider is at about the wanted gear, steady (and faster, for the 'fast' check)
    var now = Date.now();
    if (!c.stepAt) c.stepAt = now;
    if (live && pedalling) {
      if (g !== c.seenGear) { c.seenGear = g; c.steadySince = now; }
    } else { c.seenGear = 0; c.steadySince = 0; }
    var rpm = s && fin(s.cad) ? Math.round(s.cad) : 0;
    var prevRpm = st.pace === 'fast' && c.results.length ? c.results[c.results.length - 1].rpm : 0;
    var near = live && Math.abs(g - st.gear) <= CHECK_NEAR;
    var paceOk = st.pace !== 'fast' || !prevRpm || rpm >= prevRpm + CHECK_FASTER;
    var steady = !!c.steadySince && now - c.steadySince >= CHECK_STEADY_MS;
    var ready = live && pedalling && steady && ((near && paceOk) || now - c.stepAt >= CHECK_ANYWAY_MS);
    c.askGear = ready ? g : 0;
    var q = !live ? 'Waiting for the bridge’s gear…'
      : ready ? 'Does the Keiser console show gear ' + g + '?'
      : (!near || (g !== st.gear && !steady)) && now - c.stepAt < CHECK_ANYWAY_MS ? 'Shift until the console shows about gear ' + st.gear + '.'
      : !paceOk ? 'A little faster: ' + rpm + ' rpm now, ' + (prevRpm + CHECK_FASTER) + ' or more.'
      : 'Hold it there…';
    if ($('rckQ').textContent !== q) $('rckQ').textContent = q;
    $('rckBtns').style.visibility = ready ? '' : 'hidden';
    $('rckYes').disabled = !ready;
    $('rckNo').disabled = !ready;
  } else {
    $('rckVal').textContent = String(c.val);
    $('rckMinus').disabled = c.val <= 1;
    $('rckPlus').disabled = c.val >= 24;
  }
}

function checkAnswer(consoleGear) {
  var c = state.check;
  if (!c || c.phase !== 'run') return;
  var st = RIDE_CHECKS[c.idx];
  var app = c.picking ? c.app : (c.askGear || rideGear());
  var rpm = state.s && fin(state.s.cad) ? Math.round(state.s.cad) : 0;
  c.results.push({ label: st.label, target: st.gear, pace: st.pace, app: app, console: consoleGear, rpm: rpm });
  // [v3.3] the bridge echoes it to USB (J line) so the results land in the bike log
  if (state.v33 && state.conn === 'connected') sendCmd('#J,check,' + app + ',' + consoleGear + ',' + rpm);
  c.picking = false;
  c.stepAt = 0; c.seenGear = 0; c.steadySince = 0; c.askGear = 0;   // the next check waits afresh
  if (c.idx + 1 < RIDE_CHECKS.length) c.idx++;
  else finishCheck();
  renderRideCheck();
}

// The gear edge between two gears: bridge 12 / console 13 means edge 13 is set too high;
// bridge 12 / console 11 means edge 12 is set too low. Either way, redo the higher one.
function edgeGear(app, cons) { return Math.max(2, Math.min(TOTAL_POINTS - 1, Math.max(app, cons))); }

function finishCheck() {
  var c = state.check;
  if (!c) return;
  c.phase = 'done';
  c.picking = false;
  state.checkDone = true;
  if (state.v33) setFlowRecord({ checkDone: true });
  var res = c.results;
  var miss = res.filter(function (r) { return r.app !== r.console; });
  var rid = state.result && state.result.recordId, saved = false;
  if (res.length && rid) {
    var lines = ['gear_check: ' + res.length + ' of ' + RIDE_CHECKS.length + ' checks, ' + (res.length - miss.length) +
      ' matched (bridge gear vs Keiser console; watts read below the console on purpose and were not compared)'];
    res.forEach(function (r, i) {
      lines.push('gear_check ' + (i + 1) + ': ' + r.label + ' (asked ~' + r.target + ', ' + r.pace + '), bridge=' + r.app +
        ', console=' + r.console + ', rpm=' + (r.rpm || '') + ', ' + (r.app === r.console ? 'match' : 'MISMATCH'));
    });
    saved = appendRecordComments(rid, lines, 'gear check ' + (res.length - miss.length) + '/' + res.length + ' matched');
  }
  $('rckDoneTitle').textContent = !res.length ? 'Gear check skipped' : miss.length ? 'Some gears differ' : 'All gears match';
  var html = '', redone = {};
  res.forEach(function (r) {
    var ok = r.app === r.console;
    html += '<div class="rck-row' + (ok ? '' : ' miss') + '"><span class="k">' + esc(r.label) + '</span><span class="v">' +
      (ok ? 'Gear ' + r.app + ' on both ✓' : 'Bridge ' + r.app + ', console ' + r.console) + '</span></div>';
    if (!ok && state.v32) {
      var gg = edgeGear(r.app, r.console);
      if (!redone[gg]) {
        redone[gg] = true;
        html += '<button class="btn primary wide" type="button" data-rck-redo="' + gg + '" aria-label="Redo gear ' + gg + ' going up by pedalling">Redo gear ' + gg + '</button>';
      }
    }
  });
  if (miss.length) {
    html += '<p class="small muted" style="margin-top:10px">' + (state.v32
      ? 'Redo remeasures where the console first shows that gear, going up.'
      : 'If a gear is often off, calibrate again.') + '</p>';
  }
  $('rckSum').innerHTML = html;
  var rec = rid ? findRecord(rid) : null;
  $('rckSaved').textContent = saved && rec ? 'Saved with the calibration (' + rec.filename + ').' : '';
}

// ===================================================================
// Console log
// ===================================================================
function ts() {
  var d = new Date();
  function z(n) { return (n < 10 ? '0' : '') + n; }
  return z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds());
}
// Follow new lines unless the user has scrolled up to read history.
var logStick = true;
$('log').addEventListener('scroll', function () {
  var l = $('log');
  if (l.clientHeight > 0) logStick = l.scrollHeight - l.scrollTop - l.clientHeight < 40;
});
function logLine(text, kind) {
  var log = $('log');
  var div = document.createElement('div');
  div.className = 'ln' + (kind === 'raw' ? ' raw' : kind === 'rawbad' || kind === 'bad' ? ' bad' : kind === 'sent' ? ' sent' : kind === 'sys' ? ' sys' : '');
  var t = document.createElement('span'); t.className = 'ts'; t.textContent = ts();
  div.appendChild(t);
  div.appendChild(document.createTextNode(text));
  log.appendChild(div);
  while (log.childNodes.length > LOG_MAX) log.removeChild(log.firstChild);
  if (logStick) log.scrollTop = log.scrollHeight;
}

// ===================================================================
// Toast
// ===================================================================
var toastTimer = 0;
function toast(msg) {
  var t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove('show'); }, 1800);
}

// ===================================================================
// Tabs
// ===================================================================
function showView(v) {
  if (['ride', 'cal', 'diag', 'console'].indexOf(v) < 0) v = 'ride';
  state.view = v;
  var views = { ride: 'view-ride', cal: 'view-cal', diag: 'view-diag', console: 'view-console' };
  Object.keys(views).forEach(function (k) { $(views[k]).classList.toggle('active', k === v); });
  Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (b) {
    b.setAttribute('aria-selected', b.getAttribute('data-view') === v ? 'true' : 'false');
  });
  if (v === 'console') { var log = $('log'); logStick = true; log.scrollTop = log.scrollHeight; }
  try { localStorage.setItem('m3bridge.view', v); } catch (e) {}
  applyCalFocus();
  renderBadge();
}

// ===================================================================
// Event wiring
// ===================================================================
$('connectBtn').addEventListener('click', function () {
  if (state.conn === 'disconnected') reconnect(); else connectClick();
});
$('hdrBtn').addEventListener('click', disconnect);
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  $('metaScheme').content = t;
  $('metaTheme').content = t === 'light' ? '#f2f2f7' : '#000000';
  $('themeBtn').setAttribute('aria-label', t === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
}
applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
$('themeBtn').addEventListener('click', function () {
  var t = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  applyTheme(t);
  try { localStorage.setItem('m3theme', t); } catch (e) {}
});
Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (b) {
  b.addEventListener('click', function () { showView(b.getAttribute('data-view')); });
});
$('goCal').addEventListener('click', function () { showView('cal'); });

$('calStart').addEventListener('click', function () {
  if (state.v33) { onCalStarted(); openPlace(); return; }   // [v3.3] step 1 first: find a good spot
  onCalStarted();
  send('c');
});
// [v3.3] step 1 -> step 2: placement stream off, start the calibration
$('placeNext').addEventListener('click', function () {
  closePlace(true);
  onCalStarted();
  send('c');
  render();
});
$('placeBack').addEventListener('click', function () { closePlace(true); render(); });
// [v3.3] checkpoint after the up pass
$('upContinue').addEventListener('click', function () {
  if (state.s && state.s.cal === 7) send('n'); else sendCmd('#D');   // cal 7: the board waits at the checkpoint
});
$('upLater').addEventListener('click', function () {
  if (state.s && state.s.cal === 7) send('x');   // x at the checkpoint keeps the up pass saved
  state.upSaved = false;
  state.fixHold = false;
  if (reviewItems().length) state.fixPaused = true;   // flagged gears wait on their card
  render();
});
$('resumeDown').addEventListener('click', function () { sendCmd('#D'); });
$('resumeCheck').addEventListener('click', function () { state.checkDone = false; startGearCheck(); });
$('staleReload').addEventListener('click', function () { location.reload(); });
$('btnCapture').addEventListener('click', function () { send('n'); });
$('btnUndo').addEventListener('click', function () { send('u'); });
$('btnRedo').addEventListener('click', function () { send('u'); });   // [v3.1] cal=5: redo the questioned point
$('btnKeep').addEventListener('click', function () { send('n'); });   // [v3.1] cal=5: capture anyway
$('btnConfirm').addEventListener('click', function () {
  if (state.v33 && state.s && state.s.flow === 3) { state.sweepNexts++; render(); }   // [v3.3] sweep: up, then down
  send('n');
});
$('btnRelearn').addEventListener('click', function () { send('l'); });
$('autoToggle').addEventListener('click', function () { send('a'); });

var cancelArmedUntil = 0, cancelTimer = 0;
function disarmCancel() {
  cancelArmedUntil = 0;
  var b = $('btnCancel');
  b.classList.remove('armed');
  b.textContent = 'CANCEL';
  $('topX').classList.remove('armed');
}
function cancelTap() {
  var b = $('btnCancel');
  if (Date.now() < cancelArmedUntil) {
    clearTimeout(cancelTimer);
    disarmCancel();
    send('x');
  } else {
    cancelArmedUntil = Date.now() + 3000;
    b.classList.add('armed');
    b.textContent = 'TAP AGAIN TO CANCEL';
    $('topX').classList.add('armed');
    clearTimeout(cancelTimer);
    cancelTimer = setTimeout(disarmCancel, 3000);
  }
}
$('btnCancel').addEventListener('click', cancelTap);
// the top bar's (x): cancel while calibrating (tap twice), else leave the step it is on
$('topX').addEventListener('click', function () {
  if (calRunning(state.s)) cancelTap();
  else if (state.place) $('placeBack').click();
  else if (state.upSaved) $('upLater').click();
  else if (state.check && state.check.phase === 'run') $('rckQuit').click();
});
$('topUndo').addEventListener('click', function () { if (!$('btnUndo').disabled) send('u'); });

$('resultCard').addEventListener('click', function (ev) {
  var t = ev.target;
  if (t && t.closest && t.closest('[data-dismiss]')) { state.result = null; renderResult(); renderBadge(); }
});

// [v3.2] down pass: skip the rest and save (s), second tap confirms
$('btnSkipDown').addEventListener('click', function () {
  twoTap($('btnSkipDown'), 'Tap again to finish now', function () { send('s'); });
});

// [v3.2] review card
$('reviewCard').addEventListener('click', function (ev) {
  var b = ev.target && ev.target.closest ? ev.target.closest('[data-review]') : null;
  if (!b || b.disabled) return;
  var act = b.getAttribute('data-review');
  if (act === 'dismiss') {
    state.review = null;
    state.fixPaused = false;
  } else if (act === 'redo') {
    state.editErr = '';
    state.fixPaused = false;
    fixNext();
  } else if (act === 'guess' || act === 'skip') {
    state.fixPaused = false;
    fixAction(act);
  }
  if (!state.review) { state.editErr = ''; maybeOfferCheck(); }
  renderReview();
  renderRideCheck();
  renderBadge();
});

// [v3.2] guided fixes: links on the redo screen
$('fixGuess').addEventListener('click', function () { fixAction('guess'); render(); });
$('fixSkip').addEventListener('click', function () { fixAction('skip'); render(); });

// [v3.2] gear check
$('rckStart').addEventListener('click', function () {
  var c = state.check;
  if (!c) return;
  c.phase = 'run'; c.idx = 0; c.results = []; c.picking = false;
  render();
  try { $('rideCheck').scrollIntoView({ block: 'start' }); } catch (e) {}
});
$('rckSkip').addEventListener('click', function () { state.check = null; state.checkDone = true; render(); });
$('rckYes').addEventListener('click', function () { var c = state.check; if (c && c.askGear) checkAnswer(c.askGear); });
$('rckNo').addEventListener('click', function () {
  var c = state.check;
  if (!c || !c.askGear) return;
  c.app = c.askGear;
  c.val = c.app > 0 ? c.app : 12;
  c.picking = true;
  renderRideCheck();
});
$('rckMinus').addEventListener('click', function () { var c = state.check; if (c && c.val > 1) { c.val--; renderRideCheck(); } });
$('rckPlus').addEventListener('click', function () { var c = state.check; if (c && c.val < 24) { c.val++; renderRideCheck(); } });
$('rckSave').addEventListener('click', function () { var c = state.check; if (c) checkAnswer(c.val); });
$('rckQuit').addEventListener('click', function () { finishCheck(); render(); });
$('rckClose').addEventListener('click', function () { state.check = null; render(); });
$('rckSum').addEventListener('click', function (ev) {
  var b = ev.target && ev.target.closest ? ev.target.closest('[data-rck-redo]') : null;
  if (b && !b.disabled) startEdit('R', 'u', +b.getAttribute('data-rck-redo'));
});

// Saved-record actions anywhere on the page (saved list, result cards).
document.addEventListener('click', function (ev) {
  var b = ev.target && ev.target.closest ? ev.target.closest('[data-rec-act]') : null;
  if (b) doRecAction(b.getAttribute('data-rec-act'), b.getAttribute('data-id'), b);
});

$('onbNext').addEventListener('click', function () { onbGo(1); });
$('onbBack').addEventListener('click', function () { onbGo(-1); });
(function () {   // swipe between walkthrough pages
  var x0 = null;
  $('onb').addEventListener('pointerdown', function (e) { x0 = e.clientX; });
  $('onb').addEventListener('pointerup', function (e) {
    if (x0 === null) return;
    var dx = e.clientX - x0;
    x0 = null;
    if (Math.abs(dx) > 50) onbGo(dx < 0 ? 1 : -1);
  });
  $('onb').addEventListener('pointercancel', function () { x0 = null; });
})();
$('saveStored').addEventListener('click', requestStoredCal);
$('goSaved').addEventListener('click', function () {
  showView('diag');
  try { $('savedCard').scrollIntoView({ block: 'start' }); } catch (e) {}
});

// Diagnose
$('leanToggle').addEventListener('click', function () { diag.lean = !diag.lean; renderDiagIdleList(); });
$('diagStart').addEventListener('click', diagStart);
$('dNext').addEventListener('click', function () { if (diag.phase === 'running') nextStep(); });
$('dBack').addEventListener('click', function () { if (diag.phase === 'running') goStep(Math.max(0, diag.idx - 1)); });
$('dCancel').addEventListener('click', function () { twoTap($('dCancel'), 'TAP AGAIN TO CANCEL', diagCancel); });
$('diagResult').addEventListener('click', function (ev) {
  var b = ev.target && ev.target.closest ? ev.target.closest('[data-diag]') : null;
  if (!b) return;
  var a = b.getAttribute('data-diag');
  if (a === 'retry') requestDump();
  else if (a === 'discard') twoTap(b, 'Tap again', function () { diag.dump = null; setDiagPhase('idle'); });
  else if (a === 'dismiss') setDiagPhase('idle');
});
$('copyClose').addEventListener('click', function () { setHidden('copySheet', true); $('copyText').value = ''; });

$('rawToggle').addEventListener('click', function () {
  state.showRaw = !state.showRaw;
  $('rawToggle').setAttribute('aria-checked', state.showRaw ? 'true' : 'false');
});
Array.prototype.forEach.call(document.querySelectorAll('[data-cmd]'), function (b) {
  b.addEventListener('click', function () { send(b.getAttribute('data-cmd')); });
});
$('clearLog').addEventListener('click', function () { $('log').innerHTML = ''; });
$('sendForm').addEventListener('submit', function (ev) {
  ev.preventDefault();
  var inp = $('sendInput');
  var v = inp.value;
  if (!v) { toast('Type one character'); return; }
  if (v.charAt(0) === '#') sendCmd(v);   // [v3.2] edit commands, e.g. #G,u,20
  else send(v.charAt(0));
  inp.value = '';
});

// Re-render periodically so stale data is shown as stale.
setInterval(function () { if (state.s) render(); }, 500);

// ===================================================================
// Boot
// ===================================================================
var startView = 'ride';
try { startView = localStorage.getItem('m3bridge.view') || 'ride'; } catch (e) {}
loadRecords();
showView(startView);
renderPoints();
renderResult();
renderSaved();
renderDiag();
if (DEMO) {
  setConn('idle');
  logLine('Demo mode: no Bluetooth. URL options: &v3=1 firmware v3.3 (&v32=1 for v3.2, &v31=1 for v3.1), &review=1 flag two points after saving, &behind=1 an overshoot at point 8, &rest=1 short pedalling breaks, &uncal=1 start uncalibrated, &fast=1 short steps. See README.', 'sys');
} else if (!navigator.bluetooth) {
  setConn('unsupported');
} else {
  setConn('idle');
}
checkPageVersion();

// Expose a tiny hook for debugging in a desktop console.
// (bench/tests/app_harness drives the parser with real board lines through it: setConn + window.__m3Write)
window.M3Bridge = { state: state, diag: diag, handleLine: handleLine, send: send, sendCmd: sendCmd, renderSaved: renderSaved, addRecord: addRecord, onBytes: onBytes, setConn: setConn, render: render, demoConnect: typeof demoConnect === 'function' ? demoConnect : null, openPlace: openPlace, startGearCheck: startGearCheck, checkAnswer: checkAnswer, sim: function () { return typeof sim === 'undefined' ? null : sim; } };
