// M3 Bridge phone page: Diagnostics: the recording lines (G / M / Y / D) and the guided diagnostic run.
// Classic script sharing the page's global scope; index.html loads the files in order (see its loader).
'use strict';

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
