// M3 Bridge phone page: one gear, explained (the "Ruler" sheet): the gear drawn along the lever
// among its neighbours, its width against the usual width, its coming-down copy, the bridge's best
// guess, with Redo / Use best guess / Check on a ride.
// Classic script sharing the page's global scope; index.html loads the files in order (see its loader).
'use strict';

// Positions along the lever: the distance travelled along the path through the up points (µT),
// so a gear is the stretch from where it starts (up point g) to where the next one does.
function leverPath() {
  var pts = state.points.slice().sort(function (a, b) { return a.point - b.point; });
  var s = {}, segs = [], acc = 0;
  for (var i = 0; i < pts.length; i++) {
    if (i > 0) {
      var d = dist3(pts[i], pts[i - 1]);
      if (!fin(d)) continue;
      segs.push({ a: pts[i - 1], b: pts[i], s0: acc, len: d });
      acc += d;
    }
    s[pts[i].point] = acc;
  }
  return { s: s, segs: segs, pts: pts };
}
// A reading (a down point, a best guess) placed on the path: how far along, and how far off it.
function onPath(path, p) {
  var best = null;
  path.segs.forEach(function (sg) {
    var ux = sg.b.x - sg.a.x, uy = sg.b.y - sg.a.y, uz = sg.b.z - sg.a.z, L2 = ux * ux + uy * uy + uz * uz;
    var t = L2 > 0 ? ((p.x - sg.a.x) * ux + (p.y - sg.a.y) * uy + (p.z - sg.a.z) * uz) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    var q = { x: sg.a.x + t * ux, y: sg.a.y + t * uy, z: sg.a.z + t * uz }, off = dist3(p, q);
    if (!best || off < best.off) best = { s: sg.s0 + t * sg.len, off: off };
  });
  return best;
}

// Everything the sheet says and draws about gear g.
function gearStory(g) {
  var path = leverPath(), s = path.s, q = gearQuality()[g];
  var widths = [];
  for (var k = 2; k <= GEARS - 1; k++) if (fin(s[k]) && fin(s[k + 1])) widths.push(s[k + 1] - s[k]);
  widths.sort(function (a, b) { return a - b; });
  var medw = widths.length ? widths[widths.length >> 1] : 0;
  var w = fin(s[g]) && fin(s[g + 1]) ? s[g + 1] - s[g] : NaN;
  var dn = {};
  state.downPoints.forEach(function (x) { var o = onPath(path, x); if (o) dn[x.point] = o.s; });
  var flags = (state.lastFlags || []).filter(function (f) { return itemGear(f) === g; });
  var guesses = flags.filter(function (f) { return fin(f.gx); }).map(function (f) {
    var o = onPath(path, { x: f.gx, y: f.gy, z: f.gz });
    return o ? { pass: f.pass, point: f.point, s: o.s } : null;
  }).filter(Boolean);
  var reasons = flags.map(function (f) { return f.reason; });
  (q.edges || []).forEach(function (e) { if (e.reason && reasons.indexOf(e.reason) < 0) reasons.push(e.reason); });
  var miss = (state.checkMisses || {})[g];
  var st = (state.pointStats || {})['u' + g] || {};
  var unread = !fin(s[g]) && g >= 2;
  var lowDown = state.downPoints.length ? Math.min.apply(null, state.downPoints.map(function (x) { return x.point; })) : 99;
  var downUnread = !unread && isV32() && state.downPoints.length > 0 && g + 1 <= TOTAL_POINTS - 2 && g + 1 >= lowDown &&
    !state.downPoints.some(function (x) { return x.point === g + 1; });   // (#106: in the down pass's range, but not on this phone)
  var off = flags.some(function (f) { return f.pass === 'u' && f.reason === 'offpath'; });
  var pct = fin(w) && medw > 0 ? Math.round(100 * w / medw) : NaN;
  var flag = function (r) { return flags.filter(function (f) { return f.reason === r; })[0]; };
  var has = function (r) { return reasons.indexOf(r) >= 0; };
  // the verdict: the gear's most serious reason first (the bridge's flags and a check miss are red;
  // the list's own reasons yellow), in a sentence
  var v, fb = flag('behind'), fo = flag('offpath');
  var guessed = !!(state.guessed || {})[g];
  if (unread) v = 'Where gear ' + g + ' starts didn’t reach this phone. The bridge most likely has it.';
  else if (guessed && !miss) v = 'Gear ' + g + ' uses the bridge\u2019s best guess, not a measurement. Check it on a ride.';
  else if (downUnread) v = 'Where gear ' + g + ' ends coming down didn’t reach this phone. The bridge most likely has it.';
  else if (miss) v = 'In the gear check the bridge read gear ' + miss.app + ' where the console showed ' + miss.console + '.';
  else if (fb) v = fb.pass === 'd' ? 'Coming down, gear ' + g + ' was saved before the lever got past gear ' + (g + 1) + '.'
    : 'Gear ' + g + ' was saved before the lever got past gear ' + (g - 1) + ', so the two overlap.';
  else if (fo) v = fo.pass === 'd' ? 'Coming down, gear ' + g + ' ends off to one side of the other gears.'
    : 'Where gear ' + g + ' starts is off to one side of the line the other gears make.';
  else if (flag('pair') || flag('updown')) v = 'Going up and coming down, gear ' + g + ' changes at quite different spots.';
  else if (flag('prior')) v = 'Gear ' + g + ' has moved since your last calibration.';
  else if (q.level === 0) v = 'Looks right' + (fin(pct) ? ': a normal size' : '') + ', and in line with the gears around it.';
  else if (has('narrow') && fin(pct)) v = 'Gear ' + g + ' is about ' + pct + '% of the usual size, so a small nudge of the lever skips it.';
  else if (has('gap')) v = 'Going up and coming down, gear ' + g + ' changes at quite different spots.';
  else if (st.back || has('back')) v = 'Gear ' + g + ' was saved too far and had to be gone back to.';
  else if (st.w >= 2 || has('unsteady')) v = 'Gear ' + g + ' took ' + (st.w || 2) + ' tries to settle when it was saved.';
  else v = q.why.join(' ');
  unread = unread || downUnread;
  return { g: g, level: q.level, verdict: v, guessed: guessed, s: s, dn: dn, medw: medw, w: w, pct: pct, guesses: guesses, off: off,
    unread: unread, ghost: fin(dn[g]) && fin(dn[g + 1]), narrow: fin(pct) && pct < 80 };
}

// The picture: absolutely placed boxes in #rulerViz (its own width), like the design's ruler.
function drawRuler(story) {
  var box = $('rulerViz'), W = box.clientWidth || 345, H = 128;
  var s = story.s, g = story.g, col = ['var(--ok)', 'var(--warn)', 'var(--bad)'][story.level];
  var fill = ['var(--ok)', 'var(--warn-fill)', 'var(--bad)'][story.level], ink = ['var(--ok-ink)', 'var(--warn-ink)', 'var(--bad-ink)'][story.level];
  var ks = Object.keys(s).map(Number).sort(function (a, b) { return a - b; });
  if (ks.length < 3) { box.innerHTML = ''; return; }
  // the window: two usual gears either side of this one
  var lo = fin(s[g]) ? s[g] : s[ks.filter(function (k) { return k < g; }).pop()] || 0;
  var hi = fin(s[g + 1]) ? s[g + 1] : lo + story.medw;
  var pad = Math.max(story.medw * 1.6, (hi - lo) * 0.8, 1);
  var a = lo - pad, b = hi + pad, sc = W / (b - a), X = function (v) { return (v - a) * sc; };
  var html = '', TY = 34, TH = 34;
  function el(css, text) { html += '<div class="rz" style="' + css + '">' + (text ? esc(text) : '') + '</div>'; }
  for (var i = 0; i < ks.length - 1; i++) {
    var k = ks[i], k2 = ks[i + 1];
    if (s[k2] < a || s[k] > b) continue;
    var x1 = X(s[k]) + 1.5, w = Math.max(4, X(s[k2]) - 1.5 - x1);
    var single = k2 === k + 1, sel = single && k === g, merged = !single && g >= k && g < k2;
    el('left:' + x1 + 'px;top:' + TY + 'px;width:' + w + 'px;height:' + TH + 'px;border-radius:6px;' +
      'background:' + (sel ? fill : 'var(--surface2)') + ';' + (merged ? 'border:2px solid ' + col + ';background-image:repeating-linear-gradient(135deg,var(--line) 0 2px,transparent 2px 6px);' : '') +
      'color:' + (sel ? ink : 'var(--muted)') + ';line-height:' + TH + 'px;font-weight:' + (sel ? 700 : 600),
      single ? (w >= 18 ? String(k) : '') : (w >= 56 ? k + '–' + (k2 - 1) + ' ?' : (w >= 14 ? '?' : '')));
    if (sel && w < 22) el('left:' + (x1 + w / 2 - 30) + 'px;top:' + (TY - 20) + 'px;width:60px;height:16px;color:' + col + ';font-weight:700', 'gear ' + g);
  }
  if (story.unread) {
    var pk = ks.filter(function (k) { return k < g; }).pop(), nk = ks.filter(function (k) { return k > g; })[0];
    if (fin(s[pk]) && fin(s[nk])) el('left:' + X(s[pk]) + 'px;top:' + (TY - 22) + 'px;width:' + (X(s[nk]) - X(s[pk])) + 'px;height:16px;color:' + col + ';font-weight:700', 'gear ' + g + ' starts in here');
  }
  if (story.off && fin(s[g])) {
    var xo = X(s[g]);
    el('left:' + (xo - 1) + 'px;top:10px;width:0;height:' + (TY - 10) + 'px;border-left:1px dashed ' + col);
    el('left:' + (xo - 6) + 'px;top:2px;width:12px;height:12px;border-radius:6px;background:' + col);
    el('left:' + (xo + 10) + 'px;top:0;width:110px;height:16px;text-align:left;color:' + col + ';font-weight:700', 'off the line');
  }
  story.guesses.forEach(function (gs) {
    var xg = X(gs.s);
    el('left:' + (xg - 1) + 'px;top:' + (TY - 8) + 'px;width:0;height:' + (TH + 16) + 'px;border-left:1px dashed var(--muted)');
    el('left:' + (xg - 40) + 'px;top:' + (TY - 24) + 'px;width:80px;height:14px;color:var(--muted);font-weight:500', 'best guess');
  });
  var y2 = TY + TH + 14;
  if (story.ghost) {
    var d1 = X(story.dn[g]) + 1.5, d2 = X(story.dn[g + 1]) - 1.5;
    el('left:' + d1 + 'px;top:' + y2 + 'px;width:' + Math.max(4, d2 - d1) + 'px;height:22px;border-radius:6px;border:2px dashed ' + col + ';color:' + col + ';line-height:18px;font-weight:700', String(g));
    el('left:' + Math.max(0, Math.min(d1, W - 200)) + 'px;top:' + (y2 + 26) + 'px;width:200px;height:16px;text-align:left;color:var(--muted)', 'the same gear, coming down');
  } else if (story.narrow && fin(s[g])) {
    var xu = X(s[g]), wu = story.medw * sc;
    el('left:' + xu + 'px;top:' + y2 + 'px;width:' + wu + 'px;height:2px;background:var(--muted)');
    el('left:' + xu + 'px;top:' + (y2 - 5) + 'px;width:2px;height:12px;background:var(--muted)');
    el('left:' + (xu + wu - 2) + 'px;top:' + (y2 - 5) + 'px;width:2px;height:12px;background:var(--muted)');
    el('left:' + xu + 'px;top:' + (y2 + 10) + 'px;width:120px;height:16px;text-align:left;color:var(--muted)', 'usual size');
  }
  box.style.height = H + 'px';
  box.innerHTML = html;
}

// The sheet: open on a tapped gear (the end-of-run list or "Your calibration")
function openGearSheet(g) { state.sheetGear = g; renderGearSheet(); }
function closeGearSheet() {
  var g = state.sheetGear;
  state.sheetGear = 0;
  renderGearSheet();
  renderGearList();
  var chip = g && document.querySelector ? document.querySelector('.gl-g[data-gear="' + g + '"]') : null;
  if (chip && chip.focus) chip.focus();   // (back where the rider was)
}
var sheetKey = '', sheetWasShown = false;
function sheetInert(on) {
  ['main', 'header', 'nav'].forEach(function (sel) {
    var el = document.querySelector ? document.querySelector(sel) : null;
    if (el) { if (on) el.setAttribute('inert', ''); else el.removeAttribute('inert'); }
  });
}
function renderGearSheet() {
  var g = state.sheetGear;
  var show = !!g && state.view === 'cal' && !calRunning(state.s) && !state.check && state.points.length > 0;
  setHidden('gearSheet', !show);
  document.body.classList.toggle('sheet-open', show);
  if (show !== sheetWasShown) {   // (a dialog: the rest of the page waits; focus goes in)
    sheetWasShown = show;
    sheetInert(show);
    if (show) setTimeout(function () { var d = document.querySelector ? document.querySelector('#gearSheet .gs') : null; if (d && d.focus) d.focus(); }, 0);
  }
  if (!show) { sheetKey = ''; return; }
  var story = gearStory(g), connected = state.conn === 'connected';
  var flagsG = (state.lastFlags || []).filter(function (f) { return itemGear(f) === g && fin(f.gx); });
  var canRedo = gearRedoEdges(g).length > 0;
  var live = connected && (!!state.homeRead || !!state.gearList);   // (#103: not on a remembered copy)
  var key = JSON.stringify([g, story.level, story.verdict, flagsG.length, live, canRedo, $('rulerViz').clientWidth, story.guessed]);
  if (key === sheetKey) return;
  sheetKey = key;
  $('gsTitle').textContent = 'Gear ' + g;
  var pill = $('gsPill');
  pill.textContent = Q_TEXT[story.level];
  pill.className = 'gs-pill q' + story.level;
  $('gsVerdict').textContent = story.verdict;
  drawRuler(story);
  // Redo: the main button when the gear is flagged; the best guess when the bridge has one; a check ride
  var redo = $('gsRedo'), guess = $('gsGuess'), check = $('gsCheck');
  redo.textContent = story.unread ? 'Read it again' : 'Redo gear ' + g;
  redo.className = 'btn ' + (story.level && !story.guessed ? 'primary' : 'secondary') + ' wide';
  check.className = 'btn ' + (story.guessed ? 'primary' : 'secondary');   // (#111: a guess is checked on a ride)
  setHidden('gsNote', live);   // (#109: why the buttons are off)
  setHidden('gsRedo', !canRedo && !story.unread);
  setHidden('gsGuess', !flagsG.length || story.unread);
  redo.disabled = guess.disabled = check.disabled = !live;
}
// Redo / best guess / a check ride of just this gear, from the sheet
function sheetRedo() {
  var g = state.sheetGear;
  closeGearSheet();
  if (gearStory(g).unread) { state.rereadTries = 0; rereadSoon(); return; }
  startGearRedo(g);
}
function sheetOnHub() { return !state.gearList && homeListShown(); }
function sheetGuess() {
  var g = state.sheetGear, f = (state.lastFlags || []).filter(function (x) { return itemGear(x) === g && fin(x.gx); })[0];
  closeGearSheet();
  if (!f) return;
  // as a picked gear of Improve, so the list comes back with "Gear N redone" afterwards (no redo first)
  state.improving = { before: qualityLevels(gearQuality()), picked: g, fromHub: sheetOnHub(), gears: 1 };
  state.gearList = null;
  state.reviewKept = {}; state.fixTries = {}; state.fixPaused = false; state.editErr = ''; state.redoResult = null; state.redoBefore = null;
  state.improving.guessOnly = true;   // (#102: only the bridge's guesses, no redo after them)
  state.review = { items: (state.lastFlags || []).filter(function (x) { return itemGear(x) === g && fin(x.gx); }).map(function (x) {
    return { pass: x.pass, point: x.point, reason: x.reason, gx: x.gx, gy: x.gy, gz: x.gz, gear: g, action: 'guess' };
  }), source: 'improve' };
  fixAction('guess');
  render();
}
function sheetCheck() {
  var g = state.sheetGear, hub = sheetOnHub();
  closeGearSheet();
  state.gearList = null;
  startGearCheck(null, [
    { gear: g, pace: 'easy', label: 'Easy pace', task: 'Shift to gear ' + g + ' and pedal at an easy pace.' },
    { gear: g, pace: 'fast', label: 'Faster', task: 'Stay in that gear and pedal faster.' }
  ]);
  if (state.check) { state.check.single = g; state.check.fromHub = hub; }   // (#101: one gear, not "a gear check done"; #112)
}
