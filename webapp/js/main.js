// M3 Bridge phone page: Event wiring and boot. Loaded last (after js/demo-sim.js with ?demo=1). Exposes window.M3Bridge
// for bench/tests/app_harness and a desktop console.
// Classic script sharing the page's global scope; index.html loads the files in order (see its loader).
'use strict';

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
  if (state.v33) { openPlace(); return; }   // [v3.3] step 1 first: find a good spot (Next starts the run)
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
// One answer per checkpoint: a second tap (or a status line still saying cal 7) doesn't send again.
// (An answer counts for 3 s, or until the link drops: then the board, still at cal 7, is asked again.)
// #D likewise goes out once until the bridge answers it.
function sendDownCmd() {
  if (state.dPending && Date.now() - state.dPending < 5000) return;
  state.dPending = Date.now();
  sendCmd('#D');
}
$('upContinue').addEventListener('click', function () {
  if (state.checkpointAnswered) return;
  if (state.s && state.s.cal === 7) { state.checkpointAnswered = Date.now(); send('n'); }   // cal 7: the board waits at the checkpoint
  else sendDownCmd();
});
$('upLater').addEventListener('click', function () {
  if (state.s && state.s.cal === 7 && !state.checkpointAnswered) { state.checkpointAnswered = Date.now(); send('x'); }   // keeps the up pass saved
  state.upSaved = false;
  state.fixHold = false;
  if (reviewItems().length) state.fixPaused = true;   // flagged gears wait on their card
  render();
});
$('resumeDown').addEventListener('click', sendDownCmd);
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
    if (state.s && state.s.pass === 'd' && state.s.cal !== 7) state.stopSent = true;   // ends the down pass (K): no auto step 6
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
  else if (state.check && state.check.phase === 'done') $('rckClose').click();
  else if (state.check && state.check.phase === 'offer') $('rckSkip').click();
});
$('topUndo').addEventListener('click', function () { if (!$('btnUndo').disabled) send('u'); });

$('resultCard').addEventListener('click', function (ev) {
  var t = ev.target;
  // hide it only: the gear check still needs to know the calibration was saved
  if (t && t.closest && t.closest('[data-dismiss]')) { state.resultHidden = true; renderResult(); renderBadge(); }
});

// [v3.2] down pass: skip the rest and save (s), second tap confirms
$('btnSkipDown').addEventListener('click', function () {
  twoTap($('btnSkipDown'), 'Tap again to finish now', function () { state.stopSent = true; send('s'); });
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
  c.phase = 'run'; c.idx = 0; c.results = []; c.picking = false; c.v32 = c.v32 || !!state.v32;
  if (!c.list) c.list = pickChecks();
  render();
  try { $('rideCheck').scrollIntoView({ block: 'start' }); } catch (e) {}
});
// [v3.3] "Finish and ride" on the finish card: done, off to the Ride tab
$('rckSkip').addEventListener('click', function () {
  var c = state.check;
  state.check = null; state.checkDone = true;
  if (c && c.flow) { setFlowRecord({ checkDone: true }); showView('ride'); }
  render();
});
$('rckMore').addEventListener('click', function () { if (state.check) startGearCheck(state.check); });
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
