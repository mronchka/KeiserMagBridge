// M3 Bridge phone page: Setup (the Calibrate tab, renamed): the first-run welcome and plan, the intro
// card before "Up through the gears", the three-part progress, and the returning rider's hub
// ("Ready to ride" / "Tuned" / "Dialled in", the gears, Make it better).
// Classic script sharing the page's global scope; index.html loads the files in order (see its loader).
'use strict';

var setupPage = 'welcome';   // the first-run pages: 'welcome', then 'plan'

// The welcome and the plan stand where the old walkthrough did (same rules for when they show).
function renderSetupIntro(show) {
  setHidden('setupIntro', !show);
  if (!show) return;
  var connected = state.conn === 'connected';
  if (state.homeWalk) setupPage = 'plan';   // "Start over": straight to the plan
  setHidden('suWelcome', setupPage !== 'welcome');
  setHidden('suPlan', setupPage !== 'plan');
  $('suConn').textContent = connected ? 'Bridge connected' : 'Bridge not connected';
  $('suConn').className = 'su-conn' + (connected ? ' on' : '');
  $('suStart').disabled = !connected || !state.s;
  $('suStart').textContent = connected ? 'Start part 1' : 'Connect the bridge first';
  setHidden('suPart3', !!state.s && !state.v32);   // (a bridge without a down pass)
  var up = pressPreferred() ? 'Gear 1 to 24. One tap at each.' : 'Gear 1 to 24. Hold each until it saves.';
  if ($('suUpText').textContent !== up) $('suUpText').textContent = up;
  setHidden('suBackHome', !(state.homeWalk && !!(state.s && state.s.flags.V)));   // (#104: also before the hub's re-read)
}

// The intro card before part 2 (press mode: nothing is saved until the first tap, so the board can wait)
function chapterUpDue(s) {
  return !!s && isV33() && s.cal === 1 && s.flow === 4 && s.step === 0 && s.pass === 'u' && !state.points.length &&
    !!s.flags.T && !s.flags.I && !state.learnFailed && !state.chapterUpSeen;
}

// The three parts of setup, for the bar at the top: Get ready (steps 1-3), Up (4), Down (5).
function setupPart(f) { return f >= 1 && f <= 3 ? 1 : f === 4 ? 2 : f === 5 ? 3 : 0; }

// The hub's words for how far the calibration has got (C's levels)
function setupLevel(bad, unsure, noDown) {
  var rec = flowRecord() || {};
  if (noDown) return 'Ready to ride';
  if (!bad && !unsure && rec.checked) return 'Dialled in';   // (#101: a gear check done, not just skipped)
  return 'Tuned';
}
function shortDate(iso) {
  var d = new Date(iso);
  if (!isFinite(d.getTime())) return '';
  return d.getDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
}
// The hub's status block and "Make it better" rows (on the "Your calibration" list)
function renderSetupHub(q, bad, unsure, fixable, noDown) {
  var word = setupLevel(bad, unsure, noDown);
  // (#113: one stable line that says what the icon says)
  var when = bad ? bad + ' gear' + (bad === 1 ? ' needs' : 's need') + ' another look'
    : unsure ? unsure + ' gear' + (unsure === 1 ? ' is' : 's are') + ' unsure' : 'Every gear looks good';
  var html = '<span class="su-ico ' + (bad ? 'warn' : 'ok') + '" aria-hidden="true">' + (bad
      ? '<svg width="20" height="20" viewBox="0 0 20 20"><path d="M10 5 V11 M10 14.5 V15" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>'
      : '<svg width="20" height="20" viewBox="0 0 20 20"><path d="M4 10.5 L8 14.5 L16 5.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>') +
    '</span><span><span class="su-word">' + esc(word) + '</span><span class="su-when">' + esc((noDown ? 'Going up' : 'Up and down') + ' · ' + when) + '</span></span>';
  if ($('glStatus').innerHTML !== html) $('glStatus').innerHTML = html;
  var redoList = [];
  for (var g = 1; g <= GEARS; g++) if (q[g].level && q[g].edges.some(function (e) { return !(state.keptEdges || {})[e.pass + e.point]; })) redoList.push(g);
  var rows = [];
  if (fixable) {
    var names = redoList.length <= 3 ? 'gear' + (redoList.length === 1 ? ' ' : 's ') + redoList.join(redoList.length === 2 ? ' and ' : ', ') : fixable + ' gears';
    rows.push({ act: 'improve', dot: bad ? 'bad' : 'warn', t: 'Redo ' + names, s: 'About ' + Math.max(1, fixable) + ' min' });
  }
  if (noDown) rows.push({ act: 'down', dot: 'accent', t: 'Back down through the gears', s: 'About 5 min · recommended' });
  rows.push({ act: 'check', dot: 'accent', t: 'Check a few gears as you ride', s: '3 min' + ((flowRecord() || {}).checked ? '' : ' · not done yet') });
  rows.push({ act: 'again', dot: 'none', t: 'Moved the bridge? Start over', s: 'About 15 min' });
  var connected = state.conn === 'connected' && !!state.homeRead;
  var more = '<div class="su-kick">Make it better</div><div class="su-rows">' + rows.map(function (r) {
    return '<button class="su-row" type="button" data-su="' + r.act + '"' + (connected ? '' : ' disabled') + '><span class="su-dot ' + r.dot + '"></span>' +
      '<span class="su-rt"><span class="t">' + esc(r.t) + '</span><span class="s">' + esc(r.s) + '</span></span><span class="su-chev" aria-hidden="true">›</span></button>';
  }).join('') + '</div>';
  if ($('glMore').innerHTML !== more) $('glMore').innerHTML = more;
}
function setupHubAct(act) {
  state.hubNote = '';
  if (act === 'improve') startImprove();
  else if (act === 'down') sendDownCmd();
  else if (act === 'check') { state.gearList = null; startGearCheck(); if (state.check) state.check.fromHub = true; }
  else if (act === 'again') calibrateAgain();
  render();
}
