// M3 Bridge phone page: Gear check (step 6): the bridge's gear against the Keiser console at a few gears.
// Classic script sharing the page's global scope; index.html loads the files in order (see its loader).
'use strict';

// ===================================================================
// [v3.2] Gear check ("confirm ride"): app only, compares the bridge's
// live gear with the Keiser console at a few gears. Offered after a
// saved calibration once the review list is empty or dismissed.
// ===================================================================
function maybeOfferCheck() {
  if (state.checkDone || state.check || state.upSaved || state.fixHold) return;
  var r = state.result;   // (still set when its card was dismissed: resultHidden)
  if (!r || r.type !== 'K' || !r.ok || reviewItems().length) return;
  // [v3.3] the gear check is step 6 of the flow: it starts by itself (Skip is on screen)
  if (isV33()) { if (!state.noAutoCheck) startGearCheck(); return; }
  state.check = { phase: 'offer', v32: isV32(), idx: 0, results: [], picking: false, val: 1, app: 0 };
  renderRideCheck();
}
function startGearCheck() {
  state.check = { phase: 'run', flow: isV33(), v32: isV32(), idx: 0, results: [], picking: false, val: 1, app: 0 };
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
  // the 'fast' check: CHECK_FASTER above the last check's pace (kept below CAD_HI so it can be met)
  var prevRpm = st.pace === 'fast' && c.results.length ? c.results[c.results.length - 1].rpm : 0;
  var need = prevRpm ? Math.min(CAD_HI - 5, prevRpm + CHECK_FASTER) : 0;
  var cw = cadWindow(st.gear);
  var clo = need ? need : cw[0];
  var chi = need ? CAD_HI : cw[1];
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
    // "ask anyway" counts only time spent pedalling with a known gear (not a rest or a drop)
    var now = Date.now();
    if (c.lastTick && live && pedalling) c.activeMs = (c.activeMs || 0) + Math.min(1000, now - c.lastTick);
    c.lastTick = now;
    var anyway = (c.activeMs || 0) >= CHECK_ANYWAY_MS;
    if (live && pedalling) {
      if (g !== c.seenGear) { c.seenGear = g; c.steadySince = now; }
    } else { c.seenGear = 0; c.steadySince = 0; }
    var rpm = s && fin(s.cad) ? Math.round(s.cad) : 0;
    var near = live && Math.abs(g - st.gear) <= CHECK_NEAR;
    var paceOk = !need || rpm >= need;
    var steady = !!c.steadySince && now - c.steadySince >= CHECK_STEADY_MS;
    var ready = live && pedalling && steady && ((near && paceOk) || anyway);
    c.askGear = ready ? g : 0;
    if (ready) c.askRpm = rpm;   // the pace when asked (kept while the rider picks the console's gear)
    var q = !live ? 'Waiting for the bridge’s gear…'
      : ready ? 'Does the Keiser console show gear ' + g + '?'
      : (!near || (g !== st.gear && !steady)) && !anyway ? 'Shift until the console shows about gear ' + st.gear + '.'
      : !paceOk ? 'A little faster: ' + rpm + ' rpm now, ' + need + ' or more.'
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
  var rpm = c.askRpm || (state.s && fin(state.s.cad) ? Math.round(state.s.cad) : 0);
  c.results.push({ label: st.label, target: st.gear, pace: st.pace, app: app, console: consoleGear, rpm: rpm });
  // [v3.3] the bridge echoes it to USB (J line) so the results land in the bike log
  if (state.v33 && state.conn === 'connected') sendCmd('#J,check,' + app + ',' + consoleGear + ',' + rpm);
  c.picking = false;
  c.activeMs = 0; c.lastTick = 0; c.seenGear = 0; c.steadySince = 0; c.askGear = 0; c.askRpm = 0;   // the next check waits afresh
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
  if (c.flow) setFlowRecord({ checkDone: true });   // (c.flow, not state.v33: that is cleared by a drop)
  var res = c.results;
  var miss = res.filter(function (r) { return r.app !== r.console; });
  var rid = calRecordId(), saved = false;
  if (res.length && rid) {
    var lines = ['gear_check: ' + res.length + ' of ' + RIDE_CHECKS.length + ' checks, ' + (res.length - miss.length) +
      ' matched (bridge gear vs Keiser console; watts read below the console on purpose and were not compared)'];
    res.forEach(function (r, i) {
      lines.push('gear_check ' + (i + 1) + ': ' + r.label + ' (asked ~' + r.target + ', ' + r.pace + '), bridge=' + r.app +
        ', console=' + r.console + ', rpm=' + (r.rpm || '') + ', ' + (r.app === r.console ? 'match' : 'MISMATCH'));
    });
    // a second gear check of the same calibration replaces the first one's lines
    saved = appendRecordComments(rid, lines, 'gear check ' + (res.length - miss.length) + '/' + res.length + ' matched',
      { line: 'gear_check', summary: 'gear check ' });
  }
  renderCheckSummary();
  var rec = rid ? findRecord(rid) : null;
  $('rckSaved').textContent = saved && rec ? 'Saved with the calibration (' + rec.filename + ').'
    : res.length ? 'Not added to a saved calibration on this phone (the bridge’s USB log has it).' : '';
}

// The summary: one row per check; a mismatch carries its Redo button in the row (four of them still
// fit the screen), or "Redone" once its redo was started from here.
function renderCheckSummary() {
  var c = state.check;
  if (!c) return;
  var res = c.results, done = c.redone || {};
  var miss = res.filter(function (r) { return r.app !== r.console; });
  $('rckDoneTitle').textContent = !res.length ? 'Gear check skipped' : miss.length ? 'Some gears differ' : 'All gears match';
  var html = '', redone = {};
  res.forEach(function (r) {
    var ok = r.app === r.console, btn = '';
    if (!ok && (c.v32 || state.v32)) {
      var gg = edgeGear(r.app, r.console);
      if (!redone[gg]) {
        redone[gg] = true;
        btn = done[gg] ? '<span class="v">Redone ✓</span>'
          : '<button class="btn primary" type="button" data-rck-redo="' + gg + '" aria-label="Redo gear ' + gg + ' going up by pedalling">Redo gear ' + gg + '</button>';
      }
    }
    var v = ok ? 'Gear ' + r.app + ' on both ✓' : 'Bridge ' + r.app + ', console ' + r.console;
    html += '<div class="rck-row' + (ok ? '' : ' miss') + '">' + (btn
      ? '<span class="k">' + esc(r.label) + '<span class="sub">' + v + '</span></span>' + btn
      : '<span class="k">' + esc(r.label) + '</span><span class="v">' + v + '</span>') + '</div>';
  });
  if (miss.length) {
    html += '<p class="small muted" style="margin-top:10px">' + (c.v32 || state.v32
      ? 'Redo remeasures where the console first shows that gear, going up.'
      : 'If a gear is often off, calibrate again.') + '</p>';
  }
  $('rckSum').innerHTML = html;
}
