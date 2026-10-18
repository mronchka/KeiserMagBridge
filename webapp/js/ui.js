// M3 Bridge phone page, shared UI: render() for every screen, chips, the reload bar and page-version check, two-tap confirm,
// beeps, toast, tabs.
// Classic script sharing the page's global scope; index.html loads the files in order (see its loader).
'use strict';

// While calibrating: has the bridge been quiet long enough to say so? Right after a capture or a save
// it writes its flash (1.7-2.6 s, up to about 5 s seen) and sends no status lines, so that wait is longer.
function bridgeQuiet() {
  var saving = Math.max(state.capturedAt || 0, state.lastKAt || 0) >= state.sAt - 1500;
  return Date.now() - state.sAt > (saving ? SAVE_WAIT_MS : WAIT_NOTE_MS);
}

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
  renderGearList();
  renderBadge();
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
