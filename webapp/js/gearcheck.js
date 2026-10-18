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
  // [v3.3] the calibration is done: a finish card offers step 6 (Check a few gears) or Finish and ride.
  // (Not after the rider stopped the down pass: the start screen offers what is left.)
  if (isV33() && state.noAutoCheck) return;
  if (isV33()) { openGearList(); return; }   // #11: the gear list (with Check a few gears) is the finish
  state.check = { phase: 'offer', flow: isV33(), v32: isV32(), idx: 0, results: [], picking: false, val: 1, app: 0, list: pickChecks() };
  if (state.check.flow) showView('cal');
  render();
}
// prev: a finished check whose results are kept ("Check a few more gears": its matched gears aren't asked again)
function startGearCheck(prev) {
  var skip = {};
  if (prev) prev.results.forEach(function (r) { if (r.app === r.console) skip[r.target] = true; });
  state.check = { phase: 'run', flow: isV33(), v32: isV32(), idx: 0, results: [], picking: false, val: 1, app: 0,
    list: pickChecks(skip, prev ? prev.redone : state.improvedGears), prev: prev ? (prev.prev || []).concat(prev.results) : [], redone: prev ? prev.redone : null };
  showView('cal');
  render();
}

// [v3.3] Which gears to check: first the ones this calibration is least sure of (flagged by the bridge's
// check after saving, redone, or with the smallest steps to the gear below), the rest from about 5 / 12 / 19.
// Three gears, the middle one twice (easy, then faster). With nothing to go on: RIDE_CHECKS.
function pickChecks(skip, redone) {
  skip = skip || {};
  var score = {};
  function add(g, v) { if (g >= 2 && g <= TOTAL_POINTS - 1 && !skip[g]) score[g] = (score[g] || 0) + v; }
  (state.lastFlags || []).forEach(function (it) { add(it.pass === 'd' ? it.point - 1 : it.point, 3); });   // down point N = gear N-1
  if (redone) Object.keys(redone).forEach(function (g) { add(+g, 2); });
  var pts = state.points.slice().sort(function (a, b) { return a.point - b.point; }), steps = [];
  for (var i = 1; i < pts.length; i++) {
    if (pts[i].point !== pts[i - 1].point + 1 || pts[i].point > TOTAL_POINTS - 1) continue;
    var d = dist3(pts[i], pts[i - 1]);
    if (fin(d)) steps.push({ g: pts[i].point, d: d });
  }
  steps.sort(function (a, b) { return a.d - b.d; });
  var median = steps.length ? steps[steps.length >> 1].d : 0;
  steps.slice(0, 3).forEach(function (st, k) { if (st.d < 0.75 * median) add(st.g, 1.5 - k * 0.25); });   // only a step clearly smaller than most
  var ranked = Object.keys(score).map(Number).sort(function (a, b) { return score[b] - score[a] || a - b; });
  if (!ranked.length && !Object.keys(skip).length) return RIDE_CHECKS;
  var gears = [];
  function take(g) { if (gears.length < 3 && !skip[g] && gears.every(function (x) { return Math.abs(x - g) >= 2; })) gears.push(g); }
  ranked.forEach(take);
  [5, 12, 19, 8, 16, 3, 22].forEach(take);
  gears.sort(function (a, b) { return a - b; });
  var g0 = gears[0], g1 = gears[1], g2 = gears[2];
  return [
    { gear: g0, pace: 'easy', label: 'Gear ' + g0, task: 'Shift to about gear ' + g0 + ' and pedal at an easy pace.' },
    { gear: g1, pace: 'easy', label: 'Gear ' + g1 + ', easy', task: 'Shift to about gear ' + g1 + ' and pedal at an easy pace.' },
    { gear: g1, pace: 'fast', label: 'Gear ' + g1 + ', faster', task: 'Stay in that gear and pedal faster.' },
    { gear: g2, pace: 'steady', label: 'Gear ' + g2, task: 'Shift to about gear ' + g2 + ' and pedal steadily.' }
  ];
}
function checkList(c) { return c && c.list ? c.list : RIDE_CHECKS; }

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
  if (c.phase === 'offer') {
    // [v3.3] the finish card of the flow; [v3.2] the offer after saving
    var t1 = c.flow ? 'Calibration done' : 'Check a few gears';
    var t2 = c.flow ? 'Saved on the bridge and ready to ride. A short ride (about a minute) can check a few gears against the Keiser console, starting with the ones this calibration is least sure of.'
      : 'Ride for about a minute and compare the bridge\u2019s gear with the Keiser console at four gears.';
    if ($('rckOfferTitle').textContent !== t1) $('rckOfferTitle').textContent = t1;
    if ($('rckOfferText').textContent !== t2) $('rckOfferText').textContent = t2;
    $('rckStart').textContent = c.flow ? 'Check a few gears' : 'Start the gear check';
    $('rckSkip').textContent = c.flow ? 'Finish and ride' : 'Skip';
  }
  setHidden('rckMore', !(c.phase === 'done' && c.flow && connected));
  if (c.phase !== 'run') return;
  $('rckQuit').textContent = c.flow ? 'Skip this step' : 'Skip the rest';
  var list = checkList(c), st = list[c.idx], s = state.s;
  $('rckStep').textContent = 'Check ' + (c.idx + 1) + ' of ' + list.length + ' · ' + st.label;
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
      : (!near || (g !== st.gear && !steady)) && !anyway ? 'The bridge reads gear ' + g + ' now.'
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
    $('rckSave').disabled = c.val === c.app;   // #28: "No" means the console shows another gear
  }
}

function checkAnswer(consoleGear) {
  var c = state.check;
  if (!c || c.phase !== 'run') return;
  var list = checkList(c), st = list[c.idx];
  var app = c.picking ? c.app : (c.askGear || rideGear());
  var rpm = c.askRpm || (state.s && fin(state.s.cad) ? Math.round(state.s.cad) : 0);
  c.results.push({ label: st.label, target: st.gear, pace: st.pace, app: app, console: consoleGear, rpm: rpm });
  // [v3.3] the bridge echoes it to USB (J line) so the results land in the bike log
  if (state.v33 && state.conn === 'connected') sendCmd('#J,check,' + app + ',' + consoleGear + ',' + rpm);
  c.picking = false;
  c.activeMs = 0; c.lastTick = 0; c.seenGear = 0; c.steadySince = 0; c.askGear = 0; c.askRpm = 0;   // the next check waits afresh
  if (c.idx + 1 < list.length) c.idx++;
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
  var res = (c.prev || []).concat(c.results);   // (with "Check a few more gears": the earlier answers too)
  if (c.flow) {
    state.checkMisses = state.checkMisses || {};
    var fresh = {};
    c.results.forEach(function (r) { if (r.app !== r.console) fresh[edgeGear(r.app, r.console)] = { app: r.app, console: r.console }; });
    c.results.forEach(function (r) {   // a match clears an EARLIER check's miss at that gear (#56: not this check's)
      if (r.app === r.console) [r.app, r.app + 1].forEach(function (g) { if (!fresh[g]) delete state.checkMisses[g]; });
    });
    Object.keys(fresh).forEach(function (g) { state.checkMisses[g] = fresh[g]; });
  }
  var miss = res.filter(function (r) { return r.app !== r.console; });
  var rid = calRecordId(), saved = false;
  if (c.results.length && rid) {
    var lines = ['gear_check: ' + res.length + ' checks, ' + (res.length - miss.length) +
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
    : c.results.length ? 'Not added to a saved calibration on this phone (the bridge’s USB log has it).' : '';
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
