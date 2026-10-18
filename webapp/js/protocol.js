// M3 Bridge phone page: Board lines: notification bytes -> lines, handleLine() and the handler for each machine line
// (bench/PROTOCOL.md). X / Z are handled in flow.js, G / M / Y / D in diag.js.
// Classic script sharing the page's global scope; index.html loads the files in order (see its loader).
'use strict';

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
  if (state.conn !== 'connected' && state.conn !== 'connecting') return;   // a late notification after a drop
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
  // lines has 24 or more fields, so up to 23 is taken as "newer", not as damage.)
  var v33line = n >= 16 && n <= 23 && /^\d$/.test((p[14] || '').trim()) && /^\d$/.test((p[15] || '').trim());
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
  else if (state.v32) { if (!v33line && (n !== 14 || !PASS_RE.test(passRaw))) return false; }   // (v3.3 lines still upgrade it)
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
    // src B / W: live cadence from the crank / the pod ('-' none). (Flag R is the crank's own
    // pedalling and is never set with W.)
    pedalling: src ? src !== '-' : true
  };
  var prevCal = state.s ? state.s.cal : 0;
  var prevPass = state.s ? state.s.pass : '';
  var prevFlow = state.s ? state.s.flow : 0;
  var dropCal = state.dropS ? state.dropS.cal : 0;   // first status line after a drop: the run that was on then
  var dropFlow = state.dropS ? state.dropS.flow : 0;
  state.dropS = null; state.dropV = null;
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
  if (state.v33) onFlowStatus(s, prevCal || dropCal, prevFlow);
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
  if (s.pass === 'd' && cal !== 0 && cal !== 7 && (prevPass === 'u' || prevCal === 7)) {
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
  if (cal === 0) { state.redo = 0; state.downResumeStep = -1; }
  else if (state.v33 && (s.flow === 5 && cal !== 7 || s.pass === 'ru' || s.pass === 'rd') &&
           !(state.lastKAt && Date.now() - state.lastKAt < 2000)) state.awaitK = true;   // its K is due (not a line left over from just before K)
  else if (state.downResumePending && s.pass === 'd') { state.downResumePending = false; state.downResumeStep = s.step; }
  if (prevCal === 0 && cal !== 0) {
    // A fresh calibration starts at step 0. A later step after a reconnect is the same run continuing.
    // [v3.2] A redo (#R) of one point of the saved calibration is not a new run.
    // [v3.3] Nor is the down pass started from the checkpoint ('n') or later (#D).
    if (s.pass === 'ru' || s.pass === 'rd') onRedoStarted(s);
    else if (state.v33 && s.flow === 5) {
      state.calEnded = true; state.upSaved = false; state.fixHold = true;
      state.fixPaused = false;   // flagged gears get their guided redos once this pass is saved
      state.noAutoCheck = false; state.stopSent = false;
      state.checkDone = false;   // and step 6 follows, even if a gear check was done in between
      if (state.check && state.check.phase !== 'run') state.check = null;
    }
    // (at the v3.3 checkpoint, cal 7, the up pass is already saved; also after a reload)
    else if (state.v33 && cal === 7) state.calEnded = true;
    else if (s.step > 0 && state.points.length) state.calEnded = false;
    else onCalStarted();
    // however it started (the page, the bridge's button, #D, a reconnect): show it, full screen
    if (state.view !== 'cal') showView('cal');
  }
  if ((prevCal !== 0 || dropCal !== 0) && cal === 0 && state.v33 && state.awaitK) {
    // the down pass or a redo ended, but its K hasn't come (lost, or sent while the link was down)
    setTimeout(function () {
      if (!state.awaitK || state.conn !== 'connected' || state.q || (state.s && state.s.cal !== 0)) return;
      state.awaitK = false;
      if (!(state.result && state.result.type === 'K' && state.result.ok)) return;
      logLine('The end of that pass never arrived: reading the calibration back from the bridge.', 'sys');
      state.qFromEdit = true;
      requestStoredCal();
    }, 3000);
  }
  if ((prevCal !== 0 || dropCal !== 0) && cal === 0) {   // (also when it ended while the link was down)
    if (state.v33 && (prevFlow || dropFlow) === 5 && state.fixHold) { state.fixHold = false; state.upSaved = false; }
    // Ended: K or A normally arrives just before this. If neither does, keep what was captured
    // (unless the board is calibrating again by then: one stray idle line isn't an end).
    setTimeout(function () { if (!state.calEnded && (!state.s || state.s.cal === 0)) savePartialCal('ended without a result'); }, 1500);
    // [v3.2] a redo that ended without E/K/A (e.g. cancelled): stop waiting for it
    var ed0 = state.edit;
    if (ed0 && ed0.kind === 'R' && ed0.started) {
      setTimeout(function () {
        if (state.edit === ed0 && ed0.okd) {   // saved (E,ok,saved) but its K was lost: the awaitK readback catches up
          state.edit = null;
          renderReview(); render();
        } else if (state.edit === ed0 && !ed0.okd) {
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
  if (!fin(point) || point < 1 || point > TOTAL_POINTS || p.length !== 5) return false;
  var pt = { point: point, x: num(p[2]), y: num(p[3]), z: num(p[4]) };
  if (!fin(pt.x) || !fin(pt.y) || !fin(pt.z)) return false;
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
  // (the bottom longer: it is taken moments after the sweep, and the rider must see it was)
  state.capturedFlashMs = point === 1 && !isRedoing() ? BOTTOM_FLASH_MS : CAPTURE_FLASH_MS;
  if (state.w && state.w.point === point) state.w.resolved = true;   // settled and captured
  if (state.stuck && state.stuck.point === point) state.stuck = null;
  if (state.redo === point) state.redo = 0;                            // redone
  setTimeout(render, state.capturedFlashMs + 50);
  try { if (navigator.vibrate) navigator.vibrate(40); } catch (e) {}
  renderPoints();
  render();
  return true;
}

// [v3.2] C,down,<point>,<x>,<y>,<z>: down point captured (23 down to 2)
function onCDown(p) {
  var point = int(p[2]);
  if (!fin(point) || point < 2 || point > TOTAL_POINTS - 1 || p.length !== 6) return false;
  var pt = { point: point, x: num(p[3]), y: num(p[4]), z: num(p[5]) };
  if (!fin(pt.x) || !fin(pt.y) || !fin(pt.z)) return false;
  // Down points come 23, 22, ... 2: anything at or below this one is from before an undo.
  state.downPoints = state.downPoints.filter(function (q) { return isRedoing() ? q.point !== point : q.point > point; });
  state.downPoints.push(pt);
  state.behind = null; state.overshoot = null;
  state.capturedAt = Date.now(); state.capturedPoint = point; state.capturedDown = true; state.capturedFlashMs = CAPTURE_FLASH_MS;
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
  var s = state.s || state.dropS;   // (right after a reconnect: the redo that was going on)
  return !!(s && (s.pass === 'ru' || s.pass === 'rd')) || !!(state.edit && state.edit.kind === 'R' && state.edit.started);
}
// [v3.2] down points come 23, 22, ... : one missing in between was lost on the way
function downPointsMissing() {
  var d = state.downPoints;
  if (!d.length) return false;
  var low = Math.min.apply(null, d.map(function (q) { return q.point; }));
  return d.length < (TOTAL_POINTS - 2) - low + 1;
}

// [v3.2] the board started a #R redo: one point of the saved calibration, by pedalling
function onRedoStarted(s) {
  var pass = s.pass === 'rd' ? 'd' : 'u', point = s.step + 1;
  var again = !!(state.edit && state.edit.kind === 'R' && state.edit.started && state.edit.pass === pass && state.edit.point === point);   // (after a reconnect)
  if (!state.edit || state.edit.kind !== 'R') state.edit = { kind: 'R', pass: pass, point: point };
  state.edit.started = true;
  clearTimeout(state.edit.timer);   // the redo can take a while; E arrives when it is saved
  state.calEnded = true;            // not a new run: never saved as an incomplete calibration
  if (!again) pointStatClear(pass, point);   // (#11 quality: this point's tries count afresh; #49: not when picked up again)
  if (pass === 'u' && state.checkMisses) delete state.checkMisses[point];   // (#40: redone)
  if (state.keptEdges) delete state.keptEdges[pass + point];
  state.behind = null; state.capturedAt = 0; state.learnDoneAt = 0;
  state.w = null; state.stuck = null; state.redo = 0; state.editErr = '';
  if (state.check && state.check.phase === 'run') finishCheck();   // keep the answers given so far
  else if (state.check && state.check.phase === 'done' && state.check.flow && pass === 'u') {
    // a Redo from the gear check's summary: that row says Redone, and the summary comes back after it
    (state.check.redone = state.check.redone || {})[point] = true;
    renderCheckSummary();
  }
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
  // (right after a reconnect, before any status line, the firmware level is the one from before the drop)
  var v32 = isV32(), v33 = isV33();
  var sNow = state.s || state.dropS;
  r.down = v32 && !state.learnFailed ? state.downPoints.length : -1;   // no down pass with the hold-still method
  state.qRetried = false;
  state.result = r;
  state.resultHidden = false;
  state.awaitK = false; state.lastKAt = Date.now();
  if (r.ok) state.homeRead = true;   // #12: the page has this calibration (no quiet readback needed)
  state.calEnded = true;
  state.wantReadback = false;
  logLine(r.ok
    ? 'Calibration saved' + (r.edit ? ' (' + r.edit + ')' : '') + ': span ' + fmt(r.span, 1) + ' µT, smallest step ' + fmt(r.minstep, 1) + ' µT at gear ' + (fin(r.minAt) ? r.minAt : '?')
    : 'Calibration rejected: ' + (r.msg || 'no reason given'), 'sys');
  if (r.ok && r.msg === 'save failed') {
    logLine('The bridge could not write its flash: this calibration is kept only until the bridge restarts.', 'bad');
    toast('Not stored on the bridge: flash write failed');
  }
  try { if (navigator.vibrate) navigator.vibrate(r.ok ? [60, 60, 60] : [300]); } catch (e) {}
  // [v3.3] which step just saved: the up pass (checkpoint) or the down pass (then fixes, then the gear check)
  var flowAt = v33 && sNow ? sNow.flow : 0;
  // (with the hold-still method, after the crank wasn't found, there is no checkpoint or down pass)
  if (r.ok && !r.edit && flowAt === 4 && !state.learnFailed) {
    r.down = -1;             // the down pass hasn't started yet: nothing to say about it
    state.upSaved = true;
    state.fixHold = true;    // flagged gears wait until the down pass is done (or Later)
    setFlowRecord({ downDone: false, checkDone: false });
    try { if (navigator.vibrate) navigator.vibrate([60, 60, 60, 60, 120]); } catch (e) {}
  } else if (r.ok && !r.edit && v33 && state.learnFailed) {
    setFlowRecord({ downDone: true, checkDone: false });   // hold-still method: no down pass to come back for
  } else if (r.ok && !r.edit && flowAt === 5) {
    state.upSaved = false;
    state.fixHold = false;
    if (state.stopSent) { state.noAutoCheck = true; state.fixPaused = true; }   // the rider stopped it (x / Finish without the down pass): flagged gears and step 6 wait
    var finished = state.downPoints.some(function (q) { return q.point === 2; });
    setFlowRecord({ downDone: finished, checkDone: false });
  }
  // (also when a down point was lost on the way: the bridge has it, the page doesn't)
  if (r.edit && state.points.length < TOTAL_POINTS ||
      (v33 && !r.edit && r.ok && (state.points.length < TOTAL_POINTS || downPointsMissing() ||
        (flowAt === 5 && !state.stopSent && state.downPoints.length && !state.downPoints.some(function (q) { return q.point === 2; }))))) {
    // Edited (or finished the down pass of) a calibration this page didn't watch being made, e.g.
    // after a reload or with #D: read the stored one back once the F list is in, instead of
    // saving a partial copy.
    state.wantReadback = true;
  } else {
    try {
      r.recordId = saveCalRecord('run', { ok: r.ok, span: r.span, minstep: r.minstep, minAt: r.minAt, msg: r.msg, edit: r.edit, down: v32 ? state.downPoints : null }, state.points);
      if (r.ok) noteCalRecord(r.recordId, v33);
    } catch (e) { console.warn('save failed', e); }
  }
  // [v3.2] the F list follows K; if even its F,end is lost (an empty list is just that line), finish it anyway
  if (r.ok && v32) {
    clearTimeout(state.fTimer);
    state.fTimer = setTimeout(function () {
      if (state.result !== r || state.qFromEdit || state.q) return;
      logLine('The check list after saving never arrived: using the ' + (state.fList || []).length + ' points received.', 'bad');
      onF(['F', 'end', String((state.fList || []).length)]);
      render();
    }, 5000);
  }
  // Older firmware sends no F list: offer the gear check straight away.
  if (r.ok && !v32) { state.review = null; maybeOfferCheck(); }
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
    if (state.q && (state.q.points.length || state.q.down.length)) {
      // Q lines came but their Q,end was lost: this F list is the readback's, not a new run's
      clearTimeout(state.q.timer); state.q = null;
      if (state.qQuiet) {   // #18: the quiet readback for the gear list: no message, read again later
        state.qQuiet = false; state.qJustEnded = false;
        if ((state.homeTries = (state.homeTries || 0) + 1) < 3) state.homeAsked = false;
        state.review = null;
        render();
        return true;
      }
      logLine('The stored calibration arrived without its end line.', 'bad');
      if (state.qFromEdit && !state.qRetried) { state.qRetried = true; requestStoredCal(); return true; }
      state.qJustEnded = true;
      if (!state.qFromEdit) toast('Stored calibration incomplete: try again');
    }
    if (state.qQuietF) {   // #12: the quiet readback's F list: its flags color the gear list, nothing more
      state.qQuietF = false; state.qJustEnded = false; clearTimeout(state.qQuietT); clearTimeout(state.qQuietT); clearTimeout(state.qQuietT);
      state.review = null;
      state.lastFlags = items.slice();
      render();
      return true;
    }
    if (state.qRetryAfterF) {   // the F list of an incomplete readback: read it again (qFromEdit stays)
      state.qRetryAfterF = false; state.qJustEnded = false;
      requestStoredCal();
      return true;
    }
    if (items.length !== count) logLine('Check list: expected ' + count + ' flagged point' + (count === 1 ? '' : 's') + ', received ' + items.length + '.', 'bad');
    var flagged = items.filter(function (it) { return !state.reviewKept[it.pass + it.point]; });
    state.lastFlags = items.slice();
    // A stored readback the rider asked for doesn't start a redo by itself; one the page asked for
    // after an edit (wantReadback) carries on with the guided fixes.
    var stored = state.qJustEnded && !state.qFromEdit;
    var improveQueue = state.review && state.review.source === 'improve' ? state.review.items : null;
    state.review = { items: flagged, source: stored ? 'stored' : 'run' };
    state.qJustEnded = false;
    state.qFromEdit = false;
    if (items.length) {
      logLine('The bridge flagged ' + items.length + ' point' + (items.length === 1 ? '' : 's') + ': ' +
        items.map(function (it) { return pointWords(it.pass, it.point) + ' (' + it.reason + ')'; }).join('; ') + '.', 'sys');
    }
    if (improveQueue && !state.wantReadback && !stored) {
      // #11 improve pass: the gear just redone leaves the queue (it comes back if the bridge still flags it)
      var rest = improveQueue.filter(function (it) { return fixKey(it) !== state.improveLast; });
      flagged.forEach(function (it) { if (!rest.some(function (x) { return fixKey(x) === fixKey(it); })) rest.unshift(it); });
      state.review = { items: rest, source: 'improve' };
      state.improveLast = '';
      fixNext();
    } else if (state.wantReadback) {
      // save the edited calibration first; its F list (after Q,end) drives what comes next
      state.wantReadback = false;
      state.qFromEdit = true;
      requestStoredCal();
    } else if (flagged.length && isV33() && !stored && !state.fixHold && state.result && state.result.type === 'K' && state.result.ok && !state.result.edit) {
      // [v3.3] the end of a calibration: the gear list shows what the bridge flagged and asks before redoing (#11)
      state.review = null;
      maybeOfferCheck();
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
  if (kind === 'ok' && /^(redo|down)$/.test(text)) {
    // the bridge accepted #R / #D and starts it; E,ok,saved and K come when it is done
    if (ed) clearTimeout(ed.timer);
    if (text === 'down') { state.downResumePending = true; state.dPending = 0; }
    logLine(text === 'redo' ? 'Redo started.' : 'Down pass started.', 'sys');
    return true;
  }
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
      toast(text === 'save failed' ? 'Changed, but not stored on the bridge: flash write failed'
        : ed.kind === 'R' ? 'Redone and saved' : 'Best guess used and saved');
    }
    logLine('Edit done' + (text ? ' (' + text + ')' : '') + '.', 'sys');
  } else if (kind === 'fail') {
    state.dPending = 0;
    if (ed) { clearTimeout(ed.timer); state.edit = null; }
    logLine('Edit refused: ' + (text || 'no reason given'), 'bad');
    if (ed && ed.kind === 'R' && state.fixAfter) {
      redoStopped();   // the rider chose Skip / Use best guess: this is just the redo being cancelled
    } else {
      if (/down pass already done/.test(text)) setFlowRecord({ downDone: true });
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
  state.awaitK = false;
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
  if (state.calEnded && state.result && state.result.type === 'K' && state.result.ok) {
    // [v3.3] the down pass stopped: the up pass and every down point measured are already saved
    logLine('Stopped: ' + (reason || 'no reason given') + '. Everything measured so far is saved.', 'sys');
    state.fixHold = false; state.upSaved = false;
    state.noAutoCheck = true;   // the rider stopped: step 6 waits on the start screen ("Check a few gears")
    if (reviewItems().length) state.fixPaused = true;
    render();
    return true;
  }
  state.result = { type: 'A', reason: reason || 'no reason given' };
  state.resultHidden = false;
  onbIdx = 0;
  state.fixHold = false; state.upSaved = false;
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
    pointStat(down ? 'd' : 'u', step + 1, 'back');   // (#11 quality)
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
  state.learnWhy = ok ? '' : reason || 'no reason given';
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
  pointStat(state.s && (state.s.pass === 'd' || state.s.pass === 'rd') ? 'd' : 'u', point, 'w');   // (#11 quality)
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
  state.result = null; state.resultHidden = false; state.noAutoCheck = false; state.stopSent = false;
  state.downResumePending = false; state.qRetried = false; state.awaitK = false; state.lastFlags = [];
  state.pointStats = {}; state.gearList = null; state.improving = null; state.homeWalk = false; state.homeSel = 0;
  state.checkMisses = {}; state.keptEdges = {}; state.improvedGears = null;
  state.homeRead = false; state.homeRecordId = null; state.homeAsked = false; state.homeTries = 0;   // #46
  forgetCalRecord();
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
// Q: stored calibration (reply to 'k')
// Q,<point>,<x>,<y>,<z> ... Q,end,<span>,<minstep>,<minstepAt>   or   Q,none
// ===================================================================
// quiet === true: the page reads it for the Calibrate tab's gear list (#12): nothing saved, no messages.
function requestStoredCal(quiet) {
  quiet = quiet === true;   // (as a click handler it gets the event)
  if (state.conn !== 'connected') { if (!quiet) toast('Not connected'); return; }
  if (state.q) clearTimeout(state.q.timer);
  if (!quiet) setHidden('storedMsg', true);
  state.qQuiet = quiet;
  state.q = { points: [], down: [], timer: 0 };
  state.q.timer = setTimeout(function () {
    if (state.q) { state.q = null; if (!quiet) toast('No reply. The bridge may need firmware v2.'); }
    if (quiet && state.qQuiet) quietGiveUp();
  }, 10000);
  send('k', quiet);
}
// #48: the quiet readback got no (complete) answer: try again later, at most twice more on this link
function quietGiveUp() {
  state.qQuiet = false;
  if ((state.homeTries = (state.homeTries || 0) + 1) < 3) state.homeAsked = false;
  render();
}
// The F list after a quiet readback belongs to it (its flags colour the gear list); if it never comes, stop waiting.
function quietFList() {
  state.qQuietF = true;
  clearTimeout(state.qQuietT);
  state.qQuietT = setTimeout(function () { state.qQuietF = false; }, 5000);
}
// The page's copy of a calibration read back from the bridge: points, down points, and how each
// point went (from the matching saved file on this phone, if there is one).
function adoptStoredCal(q) {
  var key = function (a) { return a.map(function (x) { return x.point + ':' + fmt(x.x, 1) + ',' + fmt(x.y, 1) + ',' + fmt(x.z, 1); }).sort().join('|'); };
  if (key(q.points) !== key(state.points) || key(q.down) !== key(state.downPoints)) {
    // another calibration than the page knew (or the first one it reads): nothing carried over from before
    state.checkMisses = {}; state.keptEdges = {}; state.improvedGears = null; state.lastFlags = [];
  }
  state.points = q.points.slice(); state.downPoints = q.down.slice();
  var m = savedPointStatsFor(q.points, q.down);
  state.pointStats = m ? m.stats : {};   // (nothing from another attempt: only what belongs to these points)
  state.homeRecordId = m ? m.id : null;
}

function onQ(p) {
  var kind = (p[1] || '').trim();
  if (kind === 'none') {
    if (state.q) clearTimeout(state.q.timer);
    state.q = null;
    if (state.qQuiet) { state.qQuiet = false; return true; }   // (the gear list just doesn't show)
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
    if (state.qQuiet) {
      // #12: the Calibrate tab's gear list; the F list that follows gives the bridge's flags
      state.qQuiet = false;
      quietFList();   // its F list follows either way: swallow it (with a time limit)
      if (q.points.length !== TOTAL_POINTS) {
        logLine('The stored calibration arrived incomplete: the gear list waits for the next read.', 'sys');
        if ((state.homeTries = (state.homeTries || 0) + 1) < 3) state.homeAsked = false;   // (read it again, at most twice more on this link)
        return true;
      }
      adoptStoredCal(q);
      state.homeRead = true;
      render();
      return true;
    }
    if (q.points.length !== TOTAL_POINTS && state.qFromEdit && !state.qRetried) {
      // the page's own readback (after an edit or #D): read it once more, after this one's F list
      state.qRetried = true; state.qRetryAfterF = true;
      logLine('The stored calibration arrived incomplete (' + q.points.length + ' of ' + TOTAL_POINTS + ' points): reading it again.', 'sys');
      return true;
    }
    if (q.points.length !== TOTAL_POINTS) {
      // a line was lost on the way: don't keep an incomplete copy as if it were the calibration
      logLine('The stored calibration arrived incomplete (' + q.points.length + ' of ' + TOTAL_POINTS + ' points). Tap Save stored calibration to read it again.', 'bad');
      toast('Stored calibration incomplete: try again');
      return true;
    }
    var info = { ok: true, span: num(p[2]), minstep: num(p[3]), minAt: int(p[4]), msg: 'stored', crank: q.crank || null,
      down: state.v32 || q.down.length ? q.down : null };
    var kr = state.result && state.result.type === 'K' && state.result.ok ? state.result : null;
    var id;
    if (state.qFromEdit && kr) {
      // the page read it back after an edit or a #D down pass it didn't watch from the start:
      // this is that run's record (the gear check adds its lines to it)
      info.msg = kr.msg; info.edit = kr.edit;
      id = saveCalRecord('run', info, q.points);
      kr.recordId = id;
      kr.down = q.down.length;
      // from now on the page works with the bridge's copy (a later redo is saved from it)
      if (state.pointStats && Object.keys(state.pointStats).length) { state.points = q.points.slice(); state.downPoints = q.down.slice(); }
      else adoptStoredCal(q);
      if (state.v33 && q.down.some(function (x) { return x.point === 2; })) setFlowRecord({ downDone: true });   // the bridge has the whole down pass
      noteCalRecord(id, state.v33);
      renderResult();
    } else id = saveCalRecord('stored', info, q.points);
    var rec = findRecord(id);
    if (rec && rec.persisted) toast(state.qFromEdit && kr ? 'Calibration saved on this phone' : 'Stored calibration saved');
    return true;
  }
  if (kind === 'down') {
    // [v3.2] Q,down,<point>,<x>,<y>,<z>: stored down point (23..2)
    var dp = int(p[2]);
    if (!fin(dp) || dp < 2 || dp > TOTAL_POINTS - 1 || p.length !== 6) return false;
    var dq = { point: dp, x: num(p[3]), y: num(p[4]), z: num(p[5]) };
    if (!fin(dq.x) || !fin(dq.y) || !fin(dq.z)) return false;
    if (!state.q) state.q = { points: [], down: [], timer: 0 };
    state.q.down = state.q.down.filter(function (x) { return x.point !== dp; });
    state.q.down.push(dq);
    return true;
  }
  if (kind === 'crank') {
    // [v3] Q,crank,<ux>,<uy>,<uz>,<depth>,<sign>
    var crank = { ux: num(p[2]), uy: num(p[3]), uz: num(p[4]), depth: num(p[5]), sign: int(p[6]) };
    if (p.length !== 7 || !fin(crank.ux) || !fin(crank.uy) || !fin(crank.uz)) return false;
    if (!state.q) state.q = { points: [], down: [], timer: 0 };
    state.q.crank = crank;
    return true;
  }
  var point = int(kind);
  if (!fin(point) || point < 1 || point > TOTAL_POINTS || p.length !== 5) return false;
  if (!fin(num(p[2])) || !fin(num(p[3])) || !fin(num(p[4]))) return false;
  if (!state.q) state.q = { points: [], down: [], timer: 0 }; // 'k' typed in the console
  clearTimeout(state.q.timer);
  state.q.timer = setTimeout(function () { state.q = null; if (state.qQuiet) quietGiveUp(); }, 10000);
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
