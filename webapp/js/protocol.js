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
    // (at the v3.3 checkpoint, cal 7, the up pass is already saved)
    else if (s.step > 0 && state.points.length) state.calEnded = cal === 7;
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
  if (state.check && state.check.phase === 'run') finishCheck();   // keep the answers given so far
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
