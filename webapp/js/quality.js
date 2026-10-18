// M3 Bridge phone page: [v3.3] the gear list at the end of a calibration (#11): one chip per gear with
// how well its edges were captured (green good, yellow unsure, red bad), and a guided "improve" pass
// that redoes the yellow and red ones with the existing redo (#R) queue.
// Classic script sharing the page's global scope; index.html loads the files in order (see its loader).
'use strict';

var GEARS = TOTAL_POINTS - 1;   // 24 gears; gear g's bottom edge is up point g, its top edge down point g+1
var Q_TEXT = ['Good', 'Unsure', 'Needs another look'];

// How each point went while it was measured (this run): hold-still notices (W) and go-backs.
// Keyed like the review items: 'u12' (up point 12), 'd12' (down point 12 = gear 11 coming down).
function pointStat(pass, point, field) {
  var k = pass + point, st = state.pointStats || (state.pointStats = {});
  if (!st[k]) st[k] = { w: 0, back: 0 };
  st[k][field]++;
}
// A point measured again (a redo): what happened before no longer says anything about it.
function pointStatClear(pass, point) {
  if (state.pointStats) delete state.pointStats[pass + point];
}

function median(a) {
  var s = a.slice().sort(function (x, y) { return x - y; });
  return s.length ? s[s.length >> 1] : NaN;
}

// Per gear: { level: 0 good / 1 unsure / 2 bad, why: [text], edges: [{pass, point, reason}] } (the edges to redo).
function gearQuality() {
  var q = {}, g, p;
  for (g = 1; g <= GEARS; g++) q[g] = { level: 0, why: [], edges: [] };
  function mark(gear, level, why, edge) {
    if (!q[gear]) return;
    q[gear].level = Math.max(q[gear].level, level);
    q[gear].why.push(why);
    if (edge && fixCanRedo(edge) && !q[gear].edges.some(function (e) { return e.pass === edge.pass && e.point === edge.point; })) q[gear].edges.push(edge);
  }
  var up = {}, dn = {};
  state.points.forEach(function (x) { up[x.point] = x; });
  state.downPoints.forEach(function (x) { dn[x.point] = x; });
  // red: the bridge's own check after saving (F lines). Down point N is gear N-1's top edge.
  (state.lastFlags || []).forEach(function (it) {
    var gear = it.pass === 'd' ? it.point - 1 : it.point;
    mark(gear, 2, (it.pass === 'd' ? 'Its top edge ' : 'Its bottom edge ') + (REASON_TEXT[it.reason] || 'looks wrong (' + it.reason + ')') + '.',
      { pass: it.pass, point: it.point, reason: it.reason, gx: it.gx, gy: it.gy, gz: it.gz });
  });
  // yellow: a gear much narrower than most (its two edges very close together)
  var steps = [];
  for (p = 2; p <= GEARS; p++) if (up[p] && up[p - 1]) steps.push({ p: p, d: dist3(up[p], up[p - 1]) });
  var ms = median(steps.map(function (x) { return x.d; }).filter(fin));
  steps.forEach(function (x) {
    if (fin(x.d) && fin(ms) && x.d < 0.6 * ms) {
      mark(x.p - 1, 1, 'It is very narrow: ' + x.d.toFixed(1) + ' µT to gear ' + x.p + ', where most gears are ' + ms.toFixed(1) + ' µT.',
        { pass: 'u', point: x.p, reason: 'narrow' });
    }
  });
  // yellow: an edge whose up and down readings are far apart (most differ by about one console stickiness)
  var gaps = [];
  for (p = 2; p <= TOTAL_POINTS - 2; p++) if (up[p] && dn[p]) gaps.push({ p: p, d: dist3(up[p], dn[p]) });
  var mg = median(gaps.map(function (x) { return x.d; }).filter(fin));
  gaps.forEach(function (x) {
    if (fin(x.d) && fin(mg) && x.d > Math.max(2 * mg, mg + 4)) {
      mark(x.p, 1, 'Going up and coming down, its bottom edge reads ' + x.d.toFixed(1) + ' µT apart (most: ' + mg.toFixed(1) + ').',
        { pass: 'u', point: x.p, reason: 'gap' });
    }
  });
  // yellow: points that took a while (two or more hold-still notices) or were gone back to
  var st = state.pointStats || {};
  Object.keys(st).forEach(function (k) {
    var pass = k.charAt(0), point = +k.slice(1), s = st[k], gear = pass === 'd' ? point - 1 : point;
    var edge = (pass === 'd' ? 'Its top edge' : 'Its bottom edge');
    if (s.back) mark(gear, 1, edge + ' was saved a little too far and gone back to.', { pass: pass, point: point, reason: 'back' });
    else if (s.w >= 2) mark(gear, 1, edge + ' took ' + s.w + ' tries to settle.', { pass: pass, point: point, reason: 'unsteady' });
  });
  return q;
}

// The edges to redo for every yellow or red gear: red first, then by gear.
function improveEdges(q) {
  var out = [];
  [2, 1].forEach(function (level) {
    for (var g = 1; g <= GEARS; g++) {
      if (q[g].level !== level) continue;
      q[g].edges.forEach(function (e) {
        if (!out.some(function (x) { return x.pass === e.pass && x.point === e.point; })) out.push(e);
      });
    }
  });
  return out;
}
function qualityLevels(q) { var l = {}; for (var g = 1; g <= GEARS; g++) l[g] = q[g].level; return l; }

// The list replaces the finish card when a v3.3 calibration is done (maybeOfferCheck).
function openGearList() {
  var gl = { sel: 0 };
  if (state.improving) {
    // back from the improve pass: what got better
    var now = qualityLevels(gearQuality()), before = state.improving.before, total = 0, better = 0;
    for (var g = 1; g <= GEARS; g++) if (before[g] > 0) { total++; if (now[g] < before[g]) better++; }
    gl.improved = { better: better, total: total };
    state.improving = null;
  }
  state.gearList = gl;
  showView('cal');
  render();
}

function startImprove() {
  var q = gearQuality(), edges = improveEdges(q);
  if (!edges.length) return;
  state.improving = { before: qualityLevels(q) };
  state.gearList = null;
  state.reviewKept = {}; state.fixTries = {}; state.fixPaused = false; state.editErr = '';
  state.review = { items: edges, source: 'improve' };
  fixNext();
  render();
}

function finishGearList() {
  state.gearList = null;
  state.checkDone = true;
  setFlowRecord({ checkDone: true });
  showView('ride');
  render();
}

// #12: the Calibrate tab opens on the stored calibration's gear list (a calibrated v3.3 bridge, idle,
// nothing else on the Calibrate screen). The page reads the calibration back quietly when it hasn't got it.
function homeListDue() {
  var s = state.s;
  return state.v33 && state.conn === 'connected' && !!s && s.cal === 0 && !!s.flags.V && !state.place && !state.upSaved &&
    !state.check && !reviewItems().length && !state.gearList && !state.homeWalk && !state.improving && !state.edit;
}
function homeListShown() { return homeListDue() && state.points.length === TOTAL_POINTS; }
function calibrateAgain() { state.homeWalk = true; state.homeSel = 0; render(); }

var gearListKey = '';
function renderGearList() {
  var home = !state.gearList && homeListShown();
  if (!state.gearList && homeListDue() && state.view === 'cal' && state.points.length < TOTAL_POINTS && !state.homeAsked && !state.q) {
    state.homeAsked = true;
    requestStoredCal(true);
  }
  var gl = state.gearList || (home ? { sel: state.homeSel || 0, home: true } : null);
  var show = !!gl && !calRunning(state.s) && !state.check && !reviewItems().length;
  setHidden('gearList', !show);
  if (!show) { gearListKey = ''; return; }
  var q = gearQuality(), bad = 0, unsure = 0, g;
  for (g = 1; g <= GEARS; g++) { if (q[g].level === 2) bad++; else if (q[g].level === 1) unsure++; }
  var edges = improveEdges(q), connected = state.conn === 'connected';
  var key = JSON.stringify(qualityLevels(q)) + '|' + gl.sel + '|' + edges.length + '|' + connected + '|' + JSON.stringify(gl.improved || '') + '|' + !!gl.home;
  if (key === gearListKey) return;
  gearListKey = key;
  var lead = gl.improved ? gl.improved.better + ' of ' + gl.improved.total + ' gear' + (gl.improved.total === 1 ? '' : 's') + ' improved. '
    : gl.home ? 'The calibration on the bridge. ' : 'Saved on the bridge and ready to ride. ';
  lead += !bad && !unsure ? 'Every gear looks good.'
    : (bad ? bad + ' gear' + (bad === 1 ? '' : 's') + ' need' + (bad === 1 ? 's' : '') + ' another look' : '') + (bad && unsure ? ', ' : '') +
      (unsure ? unsure + ' ' + (unsure === 1 ? 'is' : 'are') + ' unsure' : '') + '. Tap a gear to see why.';
  $('glTitle').textContent = gl.improved ? 'Your gears now' : gl.home ? 'Your calibration' : 'Calibration done';
  $('glLead').textContent = lead;
  var html = '';
  for (g = 1; g <= GEARS; g++) {
    html += '<button class="gl-g q' + q[g].level + (gl.sel === g ? ' sel' : '') + '" type="button" data-gear="' + g + '" aria-label="Gear ' + g +
      ': ' + Q_TEXT[q[g].level] + '">' + g + '</button>';
  }
  $('glGrid').innerHTML = html;
  var sel = gl.sel && q[gl.sel];
  $('glWhy').textContent = !sel ? '' : 'Gear ' + gl.sel + ': ' + (sel.why.length ? sel.why.join(' ') : 'both edges look good.');
  setHidden('glImprove', !edges.length);
  $('glImprove').textContent = gl.home ? 'Improve calibration' : 'Improve ' + (bad + unsure) + ' gear' + (bad + unsure === 1 ? '' : 's');
  setHidden('glFinish', !!gl.home);
  setHidden('glAgain', !gl.home);
  $('glAgain').disabled = !connected;
  $('glImprove').disabled = !connected;
  $('glCheck').className = 'btn ' + (edges.length ? '' : 'primary ') + 'wide';
  $('glCheck').disabled = !connected;
}
