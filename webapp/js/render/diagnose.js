// M3 Bridge phone page: Diagnose screen: the diagnostic run and the saved list.
// Classic script sharing the page's global scope; index.html loads the files in order (see its loader).
'use strict';

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
