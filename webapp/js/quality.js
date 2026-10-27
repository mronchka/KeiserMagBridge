// M3 Bridge phone page: [v3.3] the gear list at the end of a calibration (#11): one chip per gear with
// how well its edges were captured (green good, yellow unsure, red bad), and a guided "improve" pass
// that redoes the yellow and red ones with the existing redo (#R) queue.
// Classic script sharing the page's global scope; index.html loads the files in order (see its loader).
'use strict';

var GEARS = TOTAL_POINTS - 1;   // 24 gears; gear g's bottom edge is up point g, its top edge down point g+1
var Q_TEXT = ['Good', 'Unsure', 'Needs another look'];
// #24 / #29: plain words for the why line (no "edges" or units)
var FLAG_WORDS = {
  behind: 'was saved too soon (too close to the gear below it)',
  updown: 'is in a different place going up and coming down',
  offpath: 'doesn\u2019t line up with the other gears',
  pair: 'is in a different place going up and coming down, and it isn\u2019t clear which is off',
  prior: 'moved since your last calibration'
};
// Up point N: where gear N starts going up; down point N: where gear N-1 starts coming down.
function edgeWords(pass, point) {
  if (pass === 'd') return 'Where it starts coming down (from gear ' + point + ')';
  if (point === 1) return 'The bottom of the lever';
  if (point === TOTAL_POINTS) return 'The top of the lever';
  return 'Where it starts going up (from gear ' + (point - 1) + ')';
}

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
    if (edge) { edge.gear = gear; edge.why = why; }   // (the review card names the gear the list marked, and why)
    if (edge && fixCanRedo(edge) && !q[gear].edges.some(function (e) { return e.pass === edge.pass && e.point === edge.point; })) q[gear].edges.push(edge);
  }
  var up = {}, dn = {};
  state.points.forEach(function (x) { up[x.point] = x; });
  state.downPoints.forEach(function (x) { dn[x.point] = x; });
  // red: the bridge's own check after saving (F lines). Down point N is gear N-1's top edge.
  (state.lastFlags || []).forEach(function (it) {
    var gear = Math.min(GEARS, it.pass === 'd' ? it.point - 1 : it.point);   // (up point 25, the top, is gear 24's end)
    var e = { pass: it.pass, point: it.point, reason: it.reason, gx: it.gx, gy: it.gy, gz: it.gz };
    mark(gear, 2, edgeWords(it.pass, it.point) + ' ' + (FLAG_WORDS[it.reason] || 'looks wrong') + '.' +
      (fixCanRedo(e) ? '' : ' It can\u2019t be redone on its own: calibrate again to change it.'), e);
  });
  // yellow: no reading on this phone for an edge (a readback that came incomplete) (#63)
  if (state.points.length) {
    for (p = 2; p <= GEARS; p++) if (!up[p]) mark(p, 1, 'Where it starts going up wasn\u2019t read from the bridge.', null);
    var los = state.downPoints.map(function (x) { return x.point; });
    if (los.length) {
      var lo = Math.min.apply(null, los);
      for (p = lo; p <= TOTAL_POINTS - 2; p++) if (!dn[p]) mark(p - 1, 1, 'Where it starts coming down wasn\u2019t read from the bridge.', null);
    }
  }
  // red: the gear check found the console on another gear (the edge between the two, redone going up)
  Object.keys(state.checkMisses || {}).forEach(function (gg) {
    var m = state.checkMisses[gg];
    mark(+gg, 2, 'In the gear check the bridge read gear ' + m.app + ' where the console showed gear ' + m.console + '.',
      { pass: 'u', point: +gg, reason: 'check' });
  });
  // yellow: a gear much narrower than most (its two edges very close together)
  var steps = [];
  for (p = 2; p <= GEARS; p++) if (up[p] && up[p - 1]) steps.push({ p: p, d: dist3(up[p], up[p - 1]) });
  var ms = median(steps.map(function (x) { return x.d; }).filter(fin));
  steps.forEach(function (x) {
    if (fin(x.d) && fin(ms) && x.d < 0.6 * ms) {
      mark(x.p - 1, 1, 'It is very narrow: the lever moves ' + Math.round(100 * x.d / ms) + '% as far to gear ' + x.p + ' as for most gears.',
        { pass: 'u', point: x.p, reason: 'narrow' });
    }
  });
  // yellow: an edge whose up and down readings are far apart (most differ by about one console stickiness)
  var gaps = [];
  for (p = 2; p <= TOTAL_POINTS - 2; p++) if (up[p] && dn[p]) gaps.push({ p: p, d: dist3(up[p], dn[p]) });
  var mg = median(gaps.map(function (x) { return x.d; }).filter(fin));
  gaps.forEach(function (x) {
    if (fin(x.d) && fin(mg) && x.d > Math.max(2 * mg, mg + 4)) {
      mark(x.p, 1, 'It starts in quite a different place going up and coming down (' + (x.d / mg).toFixed(1) + '\u00d7 the usual difference).',
        { pass: 'u', point: x.p, reason: 'gap' });
    }
  });
  // yellow: points that took a while (two or more hold-still notices) or were gone back to
  var st = state.pointStats || {};
  Object.keys(st).forEach(function (k) {
    var pass = k.charAt(0), point = +k.slice(1), s = st[k], gear = pass === 'd' ? point - 1 : point;
    var edge = edgeWords(pass, point);
    if (s.back) mark(gear, 1, edge + ' was saved a little too far and had to be gone back to.', { pass: pass, point: point, reason: 'back' });
    else if (s.w >= 2) mark(gear, 1, edge + ' took ' + s.w + ' tries to settle.', { pass: pass, point: point, reason: 'unsteady' });
  });
  return q;
}

// The edges to redo for every yellow or red gear: red first, then by gear.
function improveEdges(q) {
  var out = [], kept = state.keptEdges || {};
  [2, 1].forEach(function (level) {
    for (var g = 1; g <= GEARS; g++) {
      if (q[g].level !== level) continue;
      q[g].edges.forEach(function (e) {
        if (!kept[e.pass + e.point] && !out.some(function (x) { return x.pass === e.pass && x.point === e.point; })) out.push(e);
      });
    }
  });
  return out;
}
function qualityLevels(q) { var l = {}; for (var g = 1; g <= GEARS; g++) l[g] = q[g].level; return l; }

// The list replaces the finish card when a v3.3 calibration is done (maybeOfferCheck).
function openGearList() {
  var gl = { sel: 0 };
  if (state.improving && state.improving.picked) {
    gl.redone = state.improving.picked;   // #90: the gear the rider picked
    (state.improvedGears = state.improvedGears || {})[gl.redone] = true;
    state.sheetGear = gl.redone;   // (its sheet again: how it looks now)
    state.improving = null;
  } else if (state.improving) {
    // back from the improve pass: what got better
    var now = qualityLevels(gearQuality()), before = state.improving.before, total = 0, better = 0;
    for (var g = 1; g <= GEARS; g++) if (before[g] > 0) { total++; if (now[g] < before[g]) better++; }
    gl.improved = { better: better, total: total };
    state.improvedGears = {};
    for (var k = 1; k <= GEARS; k++) if (before[k] > 0) state.improvedGears[k] = true;
    state.improving = null;
  }
  state.gearList = gl;
  if (state.points.length && (state.points.length < TOTAL_POINTS || downPointsMissing())) rereadSoon();   // (lines lost on the way)
  showView('cal');
  render();
}

// #90: one gear the rider picked on the list, whatever its colour: where it starts going up, then
// where it starts coming down (down point g+1, when the down pass measured it). The bottom (point 1)
// isn't redone this way, and gears 23 and 24 have no down point above them.
function gearRedoEdges(g) {
  var out = [];
  if (g >= 2) out.push({ pass: 'u', point: g, reason: 'rider', gear: g });
  var dn = g + 1;
  var lowDown = state.downPoints.length ? Math.min.apply(null, state.downPoints.map(function (x) { return x.point; })) : 99;
  if (isV32() && !state.learnFailed && dn <= TOTAL_POINTS - 2 && dn >= lowDown) {   // (#106: measured, or missing within the down pass)
    out.push({ pass: 'd', point: dn, reason: 'rider', gear: g });
  }
  return out;
}
function startGearRedo(g) {
  var edges = gearRedoEdges(g);
  if (!edges.length) return;
  startImprove(edges, g);
}

function startImprove(pick, picked) {
  var q = gearQuality(), edges = Array.isArray(pick) ? pick : improveEdges(q);
  if (!edges.length) return;
  state.improving = { before: qualityLevels(q), picked: Array.isArray(pick) ? picked : 0 };
  state.gearList = null;
  state.reviewKept = {}; state.fixTries = {}; state.fixPaused = false; state.editErr = ''; state.redoResult = null; state.redoBefore = null;
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
  var rec = flowRecord();
  return state.v33 && state.conn === 'connected' && !!s && s.cal === 0 && !!s.flags.V && !state.place && !state.upSaved &&
    !state.check && !reviewItems().length && !state.gearList && !state.homeWalk && !state.improving && !state.edit &&
    !(rec && rec.downDone === false);
}
// (#22: only once read on this link, or calibrated on it)
function homeListShown() {
  if (state.points.length !== TOTAL_POINTS || state.gearList || state.homeWalk || state.improving) return false;
  // (while it is read again: the last one, then the new; #75: not once the reads gave up)
  if (homeListDue()) return !!state.homeRead || (!!state.homeShownBefore && (state.homeTries || 0) < 3);
  // #65: a drop: keep showing it (its buttons are off until the link is back)
  return (state.conn !== 'connected' || !state.s) && !!state.homeShownBefore && !state.place && !state.check && !calRunning(state.s);   // (#77: until the first status line)
}
function calibrateAgain() { state.homeWalk = true; state.homeSel = 0; onbIdx = 0; setupPage = 'plan'; state.sheetGear = 0; render(); }   // (#80: from page 1; Setup: the plan)

var gearListKey = '';
function renderGearList() {
  var home = !state.gearList && homeListShown();
  if (!state.gearList && homeListDue() && state.view === 'cal' && !state.homeRead && !state.homeAsked && !state.q) {
    state.homeAsked = true;
    requestStoredCal(true);
  }
  var gl = state.gearList || (home ? { sel: state.homeSel || 0, home: true } : null);
  if (home) state.homeShownBefore = true;
  var show = !!gl && !calRunning(state.s) && !state.check && !reviewItems().length;
  setHidden('gearList', !show);
  if (!show) { gearListKey = ''; return; }
  var q = gearQuality(), bad = 0, unsure = 0, g;
  for (g = 1; g <= GEARS; g++) { if (q[g].level === 2) bad++; else if (q[g].level === 1) unsure++; }
  var edges = improveEdges(q), connected = state.conn === 'connected';
  var reading = !!gl.home && connected && !state.homeRead;   // #75: the last list shown, while the bridge's is read
  var live = connected && !reading;
  var key = JSON.stringify(qualityLevels(q)) + '|' + gl.sel + '|' + edges.length + '|' + connected + '|' + JSON.stringify(gl.improved || '') + '|' + !!gl.home + '|' + !!gl.checked + '|' + reading + '|' + (gl.redone || 0) +
    '|' + (state.sheetGear || 0) + '|' + JSON.stringify(state.keptEdges || {}) + '|' + !!(flowRecord() || {}).checked;
  if (key === gearListKey) return;
  gearListKey = key;
  var lead = gl.redone ? 'Gear ' + gl.redone + ' redone. '
    : gl.improved ? gl.improved.better + ' of ' + gl.improved.total + ' gear' + (gl.improved.total === 1 ? '' : 's') + ' improved. '
    : reading ? 'The last one read from the bridge (reading it again). '
    : gl.home ? 'The calibration on the bridge. ' : 'Saved on the bridge and ready to ride. ';
  var downs = state.downPoints.map(function (x) { return x.point; });
  var noDown = isV33() && !state.learnFailed && state.points.length > 0 && !downs.length;   // #83: the down pass not done
  lead += !bad && !unsure ? (noDown ? 'Every gear looks good going up; coming down isn\u2019t measured yet.' : 'Every gear looks good. Tap one to redo it.')
    : (bad ? bad + ' gear' + (bad === 1 ? '' : 's') + ' need' + (bad === 1 ? 's' : '') + ' another look' : '') + (bad && unsure ? ', ' : '') +
      (unsure ? unsure + ' ' + (unsure === 1 ? 'is' : 'are') + ' unsure' : '') + '. ' + (noDown ? 'Coming down isn\u2019t measured yet. ' : '') + 'Tap a gear to see why.';
  // Setup's hub (a returning rider): its own count line under the status
  if (gl.home && !gl.redone && !gl.improved) {
    lead = reading ? 'Reading the bridge\u2019s calibration\u2026' : !bad && !unsure ? 'All ' + GEARS + ' gears look good. Tap one to see it.'
      : (GEARS - bad - unsure) + ' gears look good · ' + (bad + unsure) + ' could be better. Tap one to see why.';
  }
  $('glTitle').textContent = gl.improved || gl.redone ? 'Your gears now' : gl.home ? 'Setup' : gl.checked ? 'Your gears' : 'Calibration done';
  $('glLead').textContent = lead;
  var html = '';
  for (g = 1; g <= GEARS; g++) {
    html += '<button class="gl-g q' + q[g].level + (gl.sel === g || state.sheetGear === g ? ' sel' : '') + '" type="button" data-gear="' + g + '" aria-label="Gear ' + g +
      ': ' + Q_TEXT[q[g].level] + '">' + g + '</button>';
  }
  $('glGrid').innerHTML = html;
  var sel = gl.sel && q[gl.sel];
  var keptHere = sel && sel.edges.length && sel.edges.every(function (e) { return (state.keptEdges || {})[e.pass + e.point]; });
  var downRead = !isV33() || state.learnFailed || gl.sel + 1 > TOTAL_POINTS - 2 || downs.indexOf(gl.sel + 1) >= 0;
  $('glWhy').textContent = !sel ? '' : 'Gear ' + gl.sel + ': ' + (sel.why.length ? sel.why.join(' ')
    : downRead ? 'looks good going up and coming down.' : 'looks good going up; coming down isn\u2019t measured yet.') +
    (keptHere ? ' You chose to keep it as it is.' : '');
  $('glLead').hidden = !!sel;   // #43: the why takes the lead's place
  var fixable = 0;   // #36: gears with something Improve can redo
  var kept = state.keptEdges || {};
  for (g = 1; g <= GEARS; g++) if (q[g].level && q[g].edges.some(function (e) { return !kept[e.pass + e.point]; })) fixable++;
  // #90: with a gear tapped, the main button redoes that gear (any colour)
  var pickRedo = !!gl.sel && gearRedoEdges(gl.sel).length > 0;
  setHidden('glImprove', !edges.length && !pickRedo);
  $('glImprove').textContent = pickRedo ? 'Redo gear ' + gl.sel : gl.home ? 'Improve calibration' : 'Improve ' + fixable + ' gear' + (fixable === 1 ? '' : 's');
  $('glImprove').className = 'btn ' + (edges.length || pickRedo ? 'primary ' : '') + 'wide';
  setHidden('glFinish', !!gl.home);
  setHidden('glAgain', !gl.home);
  $('glAgain').disabled = !live;
  $('glImprove').disabled = !live;
  $('glCheck').className = 'btn ' + (edges.length || pickRedo ? '' : 'primary ') + 'wide';
  $('glCheck').disabled = !live;
  // the hub: status and "Make it better" in place of the buttons
  setHidden('glStatus', !gl.home);
  setHidden('glMore', !gl.home);
  setHidden('glBtns', !!gl.home);
  if (gl.home) renderSetupHub(q, bad, unsure, fixable, noDown);
}
