// M3 Bridge phone page: [v3.3] the calibration flow: steps and breadcrumb, gear and cadence helpers, step 1 (placement, X / Z),
// and the review card with its guided fixes (F lines, #R / #G).
// Classic script sharing the page's global scope; index.html loads the files in order (see its loader).
'use strict';

// ===================================================================
// [v3.3] flow steps, placement (X), survey (Z), checkpoints
// ===================================================================
// A calibration step is on screen (cal 7, the checkpoint after the up pass, shows the Saved card instead).
// [v3.3] sweep direction: pass su / sd from the board; Next taps counted here as a fallback
function sweepIsDown(s) { return s.pass === 'sd' || (s.pass !== 'su' && (s.pass === 'd' || state.sweepNexts >= 1)); }
function calRunning(s) { return !!(s && s.cal !== 0 && !(state.v33 && s.cal === 7)); }

// The gear the rider is asked for at this point, and the one to go back into first (flag B).
function promptGear(s) { return s.pass === 'd' || s.pass === 'rd' ? s.step : s.step + 1; }
function backGear(s) {
  var down = s.pass === 'd' || s.pass === 'rd', g = promptGear(s);
  return down ? Math.min(24, g + 1) : Math.max(1, g - 1);
}

// Cadence window for a gear (CAD_GUIDE): [lo, hi] rpm.
function cadWindow(gear) {
  var g = Math.max(1, Math.min(CAD_GUIDE.top, gear || 1));
  if (g <= CAD_GUIDE.flatTo) return CAD_GUIDE.low.slice();
  var f = (g - CAD_GUIDE.flatTo) / (CAD_GUIDE.top - CAD_GUIDE.flatTo);
  return [Math.round(CAD_GUIDE.low[0] + (CAD_GUIDE.high[0] - CAD_GUIDE.low[0]) * f),
    Math.round(CAD_GUIDE.low[1] + (CAD_GUIDE.high[1] - CAD_GUIDE.low[1]) * f)];
}

// Flow step shown in the breadcrumb (1-6), or 0 when not in the flow.
function flowNow() {
  var s = state.s;
  // Whenever the board is calibrating, its own step wins (a #D after the gear check is step 5, not 6).
  if (s && state.v33 && s.cal !== 0 && !(s.cal === 7 && !state.upSaved) && s.flow >= 1 && s.flow <= 6) return s.flow;   // (#81: Later)
  if (state.place) return 1;
  if (state.check && state.check.flow) return 6;   // the finish card, the check and its summary
  if (state.upSaved) return 4;
  return 0;
}

// Per-status-line flow bookkeeping (v3.3 only).
function onFlowStatus(s, prevCal, prevFlow) {
  // The first status line after a (re)connect: is the board's placement stream on (cal 0, flow 1)?
  // It survives a drop, and 'v' only toggles it: carry on with step 1, or switch it off.
  if (state.placeCheck) {
    state.placeCheck = false;
    // the board's USB log notes which phone page is connected (older pages never send this)
    if (state.conn === 'connected') sendCmd('#J,page,' + APP_BUILD);
    // [v3.4] which firmware: E,ok,v3.4 (or later) means press to capture; older bridges answer E,fail
    if (state.conn === 'connected') { state.vAskedAt = Date.now(); sendCmd('#V'); }
    if (state.wantReadback && state.result && state.result.ok && s.cal === 0 && state.conn === 'connected') {
      state.wantReadback = false; state.qFromEdit = true;
      requestStoredCal();
    }
    if (s.cal === 0 && s.flow === 1 && !state.place) {
      if (state.placeWas) state.place = { x: null };
      else send('v', true);
    }
    state.placeWas = false;
  }
  if (s.flow !== 3) state.sweepNexts = s.flow > 3 ? 1 : 0;
  // cal 7: the up pass is saved and the board waits at the checkpoint (n = down now, s/x = later)
  if (s.cal !== 7) state.checkpointAnswered = 0;
  else if (state.checkpointAnswered && Date.now() - state.checkpointAnswered > 3000) state.checkpointAnswered = 0;
  if (s.cal === 7 && !state.upSaved && !state.checkpointAnswered) { state.upSaved = true; state.fixHold = true; }
  if (prevCal === 7 && s.cal === 0) {   // stopped at the checkpoint (Later, or s/x from elsewhere)
    state.upSaved = false; state.fixHold = false;
    if (reviewItems().length) state.fixPaused = true;
  }
  if (s.flow === 5 && s.cal !== 0 && s.cal !== 7 && state.upSaved) { state.upSaved = false; state.fixHold = true; }   // down pass started
  // The board started calibrating again (e.g. #D after the gear check): the gear check gives way.
  if (s.cal !== 0 && s.cal !== 7 && s.flow >= 2 && s.flow <= 5 && state.check && state.check.phase === 'run') state.check = null;
  if (s.flow !== prevFlow) {
    if (s.flow === 3 && prevFlow === 2) logLine('Sweep: lever slowly up, then back down.', 'sys');
    if (s.flow === 4 && prevFlow === 3 && !chapterUpDue(s)) toast('Now up through the gears');   // (the part 2 card says it in press mode)
  }
}

// [v3.3] X,<fieldMag>,<swing>,<dip>,<headroomPct>,<noise>: placement stream ('v')
function onX(p) {
  var x = { field: num(p[1]), swing: num(p[2]), dip: num(p[3]), head: num(p[4]), noise: num(p[5]), at: Date.now() };
  if (!fin(x.swing) || !fin(x.head)) return false;
  if (state.place) { state.place.x = x; renderPlace(); }
  return true;
}

// [v3.3] Z,<noise>,<pathLen>,<spot>,<offMedian>,<verdict>: survey result after the sweep
function onZ(p) {
  var z = { noise: num(p[1]), pathLen: num(p[2]), spot: (p[3] || '').trim(), offMedian: num(p[4]), verdict: (p[5] || '').trim() };
  if (!fin(z.pathLen)) return false;
  state.survey = z;
  var words = { ok: 'good', weak: 'too weak', saturated: 'saturated', folded: 'folds back on itself' };
  logLine('Sweep: lever path ' + fmt(z.pathLen, 1) + ' µT, noise ' + fmt(z.noise, 2) + ' µT, ' +
    (z.spot === 'same' ? 'same spot as last time' : z.spot === 'new' ? 'the board has moved since last time' : 'first calibration here') +
    ', signal ' + (words[z.verdict] || z.verdict) + '.', 'sys');
  if (z.verdict && z.verdict !== 'ok') toast('Signal ' + (words[z.verdict] || z.verdict) + ': see the Console');
  return true;
}

// ===================================================================
// [v3.3] the flow around the circle: breadcrumb, step 1 (placement), checkpoint, resume offers
// ===================================================================
function renderFlow(active, placing, saved) {
  var f = flowNow();
  setHidden('crumbs', !f);
  if (f) {
    var rs = state.s && state.s.cal !== 0 && redoPass(state.s.pass);
    var rg = rs ? (state.s.pass === 'rd' ? state.s.step : state.s.step + 1) : 0;
    // Setup's three parts: Get ready (steps 1-3), Up through the gears (4), Back down (5); the gear check
    // and a redo are no part
    var part = rs ? 0 : setupPart(f), PARTS = ['Get ready', 'Up through the gears', 'Back down'];
    var title = rs ? 'Redo gear ' + rg : part ? PARTS[part - 1] : FLOW_STEPS[f - 1];
    var t = !part ? '<b>' + esc(title) + '</b>'
      : 'PART ' + part + ' OF 3 · <b>' + esc(part === 1 ? FLOW_STEPS[f - 1] : title) + '</b>';   // (part 1: its step; "Get ready" is under the bar)
    setHidden('crumbSegs', !part);
    setHidden('crumbL', !part);
    if ($('crumbT').innerHTML !== t) $('crumbT').innerHTML = t;
    $('crumbs').setAttribute('aria-label', part ? 'Part ' + part + ' of 3: ' + title : title);
    var segs = $('crumbSegs').children, labs = $('crumbL').children, upDone = part === 2 && saved;
    for (var i = 0; i < segs.length; i++) {
      var done = i < part - 1 || (upDone && i === 1), cur = i === part - 1 && !done;
      segs[i].className = done ? 'done' : cur ? 'cur' : '';
      labs[i].className = cur ? 'cur' : '';
      var lt = ['Get ready', 'Up', 'Down'][i] + (done ? ' ✓' : '');
      if (labs[i].textContent !== lt) labs[i].textContent = lt;
    }
  }
  setHidden('calPlace', !placing);
  if (placing) renderPlace();
  setHidden('upSaved', !saved);
  // a silent link at the checkpoint: say so (the circle's "Waiting for the bridge" note isn't on screen here)
  var cpWait = saved && state.conn === 'connected' && bridgeQuiet();
  $('upContinue').disabled = state.conn !== 'connected' || cpWait;
  var cpText = cpWait ? 'Waiting for the bridge…' : 'Continue down';
  if ($('upContinue').textContent !== cpText) $('upContinue').textContent = cpText;
  // resume offers on the start screen
  // (only while the bridge says it is calibrated: not for a new, erased or different bridge)
  var rec = flowRecord(), show = !active && !placing && !saved && state.v33 && state.conn === 'connected' && !!rec &&
    !!(state.s && state.s.flags.V) &&
    (!rec.downDone || !rec.checkDone) && !(state.check && (state.check.phase === 'run' || state.check.flow)) && !state.gearList && !homeListShown() && !state.homeWalk && !state.improving;   // (#58: Start a new calibration hides it)
  setHidden('calResume', !show);
  if (show) {
    setHidden('resumeDown', !!rec.downDone);
    setHidden('resumeCheck', !!rec.checkDone);
    var txt = 'Your last calibration (' + fmtDate(rec.at) + ') is saved and ready to ride.' +
      (!rec.downDone ? ' Coming back down through the gears makes each gear switch where the console does.' : '') +
      (!rec.checkDone ? ' A short ride checks a few gears against the console.' : '');
    if ($('resumeText').textContent !== txt) $('resumeText').textContent = txt;
  }
}

function isIOS() {
  var ua = navigator.userAgent || '';
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}
function openPlace() {
  if (state.conn !== 'connected') { toast('Not connected'); return; }
  state.place = { x: null };
  // placement stream on (swing restarts from zero), unless the board says it already is
  if (!(state.v33 && state.s && state.s.cal === 0 && state.s.flow === 1)) send('v');
  setHidden('lockTip', !isIOS());
  keepAwake(true);
  render();
  try { $('main').scrollTop = 0; } catch (e) {}
}
function closePlace(stopStream) {
  if (!state.place) return;
  state.place = null;
  if (stopStream && state.conn === 'connected') send('v', true);   // placement stream off
}

function zoneOf(v, z) { return !fin(v) ? 'none' : v >= z.great ? 'great' : v >= z.good ? 'good' : 'weak'; }
var ZONE_WORD = { none: '', weak: 'Weak', good: 'Good', great: 'Great' };
function setCapsule(prefix, v, z, text) {
  var zone = zoneOf(v, z);
  $(prefix + 'V').textContent = text;
  $(prefix + 'Z').textContent = ZONE_WORD[zone];
  $(prefix + 'Z').className = 'z zone-' + zone;
  var f = $(prefix + 'F');
  f.style.transform = 'scaleX(' + (fin(v) ? Math.max(0.02, Math.min(1, v / z.max)) : 0).toFixed(3) + ')';
  f.className = 'fill-' + zone;
  $(prefix + 'T1').style.left = (z.good / z.max * 100).toFixed(1) + '%';
  $(prefix + 'T2').style.left = (z.great / z.max * 100).toFixed(1) + '%';
  return zone;
}
function renderPlace() {
  var x = state.place && state.place.x, stale = !x || Date.now() - x.at > 3000;
  var zs = PLACE_ZONES.swing;
  // arc gauge: zones as thin marks on the track, the value as a thick arc (pathLength 100)
  ['gzWeak', 'gzGood', 'gzGreat', 'gVal'].forEach(function (id) { $(id).setAttribute('pathLength', '100'); });
  var a = zs.good / zs.max * 100, b = zs.great / zs.max * 100;
  $('gzWeak').setAttribute('stroke-dasharray', a.toFixed(1) + ' 200');
  $('gzWeak').setAttribute('class', 'zn fill-weak');
  $('gzGood').setAttribute('stroke-dasharray', '0 ' + a.toFixed(1) + ' ' + (b - a).toFixed(1) + ' 200');
  $('gzGood').setAttribute('class', 'zn fill-good');
  $('gzGreat').setAttribute('stroke-dasharray', '0 ' + b.toFixed(1) + ' ' + (100 - b).toFixed(1) + ' 200');
  $('gzGreat').setAttribute('class', 'zn fill-great');
  var sw = x ? x.swing : NaN, swZone = zoneOf(sw, zs);
  var pct = fin(sw) ? Math.max(0, Math.min(100, sw / zs.max * 100)) : 0;
  $('gVal').setAttribute('stroke-dasharray', pct.toFixed(1) + ' 200');
  $('gVal').setAttribute('class', 'val fill-' + swZone);
  $('gNum').textContent = fin(sw) ? String(Math.round(sw)) : '--';
  $('gZone').textContent = fin(sw) && sw > 0 ? ZONE_WORD[swZone].toLowerCase() : 'move the lever';
  $('gZone').className = 'zone-' + swZone;
  $('gaugeSwing').setAttribute('aria-label', 'Lever signal ' + (fin(sw) ? Math.round(sw) + ' microtesla, ' + ZONE_WORD[swZone] : 'not measured yet'));
  var dipZone = setCapsule('mDip', x ? x.dip : NaN, PLACE_ZONES.dip, x && fin(x.dip) ? x.dip.toFixed(0) + ' µT' : '--');
  var headZone = setCapsule('mHead', x ? x.head : NaN, PLACE_ZONES.head, x && fin(x.head) ? Math.round(x.head) + '%' : '--');
  // verdict
  var cls = '', vt, vs, vi = '…';
  if (stale) {
    vt = x ? 'Waiting for the bridge…' : 'Waiting for readings';
    vs = 'Pedal and move the lever from the bottom to the top.';
  } else if (headZone === 'weak') {
    cls = 'weak'; vi = '!'; vt = 'Too close to the magnets';
    vs = 'The sensor is nearly saturated. Move the board a little further away.';
  } else if (swZone === 'weak') {
    cls = 'weak'; vi = '!'; vt = 'Move closer to the magnets';
    vs = 'Move the lever all the way from the bottom to the top first. If the swing stays low, mount the board closer to the magnets.';
  } else if (dipZone === 'weak') {
    cls = 'weak'; vi = '!'; vt = 'Move closer to the crank';
    vs = 'Keep pedalling. If the dip stays low, the bridge can’t count pedal turns reliably here.';
  } else {
    cls = 'good'; vi = '✓';
    vt = swZone === 'great' && dipZone === 'great' && headZone !== 'weak' ? 'Great spot' : 'Good spot';
    vs = 'Tap Next to start.';
  }
  $('placeVerdict').className = 'verdict' + (cls ? ' ' + cls : '');
  $('placeVi').textContent = vi;
  if ($('placeVt').textContent !== vt) $('placeVt').textContent = vt;
  if ($('placeVs').textContent !== vs) $('placeVs').textContent = vs;
  $('placeNext').disabled = state.conn !== 'connected';
  $('placeNext').textContent = cls === 'weak' ? 'Next anyway' : 'Next';
}

// ===================================================================
// [v3.2] Review card: points the bridge's check flagged after saving (F lines)
// ===================================================================
var REASON_TEXT = {
  behind: 'isn’t past the gear before it',
  updown: 'its up and down readings don’t agree',
  offpath: 'is off the path the other gears make',
  pair: 'its up and down readings don’t agree, and it isn’t clear which is off',
  prior: 'moved since your last calibration',
  // [#11] the gear list's own reasons (Improve)
  narrow: 'starts very close to the gear below it (that gear is very narrow)',
  gap: 'reads far apart going up and coming down',
  back: 'was saved a little too far and had to be gone back to',
  unsteady: 'took several tries to settle'
};
function reviewItems() { return state.review ? state.review.items : []; }
function fixKey(it) { return it.pass + it.point; }
function fixCanRedo(it) { return it.point >= 2 && it.point <= (it.pass === 'd' ? TOTAL_POINTS - 2 : TOTAL_POINTS - 1); }
function fixGuess(it) { return fin(it.gx) ? { x: it.gx, y: it.gy, z: it.gz } : null; }
// The flagged point being redone right now (pass ru/rd matching the first item), or null.
function fixInRedo() {
  var s = state.s, it = reviewItems()[0];
  if (!it || !s || s.cal === 0 || !redoPass(s.pass)) return null;
  if (gearPass(s.pass)) return itemGear(it) === s.step + 1 ? it : null;   // [v3.5] the whole gear
  return (s.pass === 'rd' ? 'd' : 'u') === it.pass && s.step + 1 === it.point ? it : null;
}

// Guided fixes: redo the first flagged point straight away; after FIX_MAX_TRIES redos of the same
// point (or when the rider cancelled, or the bridge refused) wait on the card for the rider.
var fixWaitT = 0;
function fixNext() {
  if (!state.review) return;
  state.review.items = state.review.items.filter(function (it) { return !state.reviewKept[fixKey(it)]; });
  var it = state.review.items[0];
  if (!it) {
    state.review = null; state.fixPaused = false;
    if (state.improving) openGearList(); else maybeOfferCheck();   // #11: the improve pass is done
    render();
    return;
  }
  var gk = 'g' + itemGear(it);   // (tries count per gear: a whole-gear redo measures both its points)
  var tries = state.fixTries[gk] || 0;
  var force = state.redoAgain === gk; state.redoAgain = '';   // ("Try again" on the result card: past the limit too)
  if (state.fixPaused || state.redoResult || (tries >= FIX_MAX_TRIES && !force) || !fixCanRedo(it) || state.conn !== 'connected' || state.edit) { renderReview(); return; }
  if (state.s && state.s.cal !== 0) {
    // K and the F list come just before the status line says the board is idle: try again shortly
    clearTimeout(fixWaitT);
    fixWaitT = setTimeout(fixNext, 300);
    renderReview();
    return;
  }
  state.fixTries[gk] = tries + 1;
  // what the gear looked like before this redo: the result card says what changed
  if (state.review.source === 'improve') state.redoBefore = { gear: itemGear(it), level: gearQuality()[itemGear(it)].level };
  if (state.v35) startEdit('R', 'g', itemGear(it));   // [v3.5] the whole gear, by taps
  else startEdit('R', it.pass, it.point);
}

// Skip or Use best guess, from the card or from the redo screen (then the redo is cancelled first).
function fixAction(act) {
  var it = reviewItems()[0];
  if (!it) return;
  state.editErr = '';
  if (fixInRedo() || (state.edit && state.edit.kind === 'R')) {
    state.fixAfter = act;
    send('x');
    return;
  }
  if (act === 'skip' || !fixGuess(it)) { keepAsIs(it); fixNext(); }   // (no guess to use: same as Skip)
  else startEdit('G', it.pass, it.point, fixGuess(it));
  renderReview();
}

// The rider keeps a flagged point as it is: not asked again (and the gear list, #41, stops offering it).
function keepAsIs(it) {
  state.reviewKept[fixKey(it)] = true;
  (state.keptEdges = state.keptEdges || {})[fixKey(it)] = true;
}

// The redo was cancelled because the rider chose Skip or Use best guess.
function redoStopped() {
  var act = state.fixAfter, it = reviewItems()[0];
  state.fixAfter = '';
  if (!it) return;
  if (act === 'skip' || !fixGuess(it)) { keepAsIs(it); fixNext(); return; }   // (no guess: as Skip)
  // #G needs the board idle: wait for the status line to say so (at most ~3 s)
  var tries = 0;
  (function go() {
    if (state.s && state.s.cal !== 0 && tries++ < 12) { setTimeout(go, 250); return; }
    startEdit('G', it.pass, it.point, fixGuess(it));
  })();
}

var reviewKey = '';
function renderReview() {
  var card = $('reviewCard'), items = reviewItems();
  var active = calRunning(state.s);
  var checkRun = !!state.check && state.check.phase === 'run';
  if (state.redoResult && !active && !checkRun) return renderRedoResult(card);
  var show = !active && !checkRun && items.length > 0 && !state.fixHold && !state.upSaved && !state.place &&   // [v3.3] fixes wait for the down pass
    !(isV33() && !$('calResume').hidden);   // (#58: and while the start screen offers to pick it up)
  renderFixLinks();
  setHidden('reviewCard', !show);
  if (!show) { reviewKey = ''; return; }
  card.className = 'card review';
  var connected = state.conn === 'connected', busy = !!state.edit;
  var it = items[0], words = pointWords(it.pass, it.point), key2 = fixKey(it);
  var tries = state.fixTries['g' + itemGear(it)] || 0, tired = tries >= FIX_MAX_TRIES || !fixCanRedo(it);
  var key = key2 + it.reason + '|' + items.length + '|' + tries + '|' + busy + '|' + state.editErr + '|' + connected + '|' + state.fixPaused;
  if (key === reviewKey) return;   // only rewrite when something changed (keeps focus and taps intact)
  reviewKey = key;
  var why = REASON_TEXT[it.reason] || 'looks wrong (' + it.reason + ')';
  // #23: only a gear the bridge's check flagged has a best guess; the gear list's own reasons don't
  var guessable = !!fixGuess(it), improving = state.review && state.review.source === 'improve';
  var dis = !connected || busy ? ' disabled' : '';
  var named = improving && it.gear ? 'Gear ' + it.gear : capFirst(words.replace(/ \(.*\)$/, ''));
  var unsure = improving && /^(narrow|gap|back|unsteady)$/.test(it.reason);
  var picked = it.reason === 'rider';   // #90: a gear the rider tapped on the list
  var html = '<h2>' + (picked ? 'Redo gear ' + esc(String(it.gear)) : esc(named) + (unsure ? ' is unsure' : ' needs another look')) +
    '<button class="x-btn" type="button" data-review="dismiss" aria-label="Stop checking gears">×</button></h2>' +
    (picked ? '<p class="rv-t">' + (it.pass === 'u' ? 'Where it starts going up.' : 'Where it starts coming down.') + '</p>'
      : improving && it.why ? '<p class="rv-t">' + esc(it.why) + '</p>'
      : '<p class="rv-t">The bridge checked the saved calibration: <b>' + esc(words) + '</b> ' + esc(why) + '.</p>');
  if (tired && fixCanRedo(it)) html += '<p class="small muted">It still looks off after ' + tries + ' tries. ' + (guessable ? 'Use the bridge’s best guess, or keep it as it is.' : 'Keep it as it is, or try it again.') + '</p>';
  else if (!busy) html += '<p class="small muted">Pedal it once more: the screen walks you through it.</p>';
  html += '<div class="btn-stack" style="margin-top:12px">' +
    (tired && guessable
      ? '<button class="btn primary wide" type="button" data-review="guess"' + dis + ' aria-label="Use the bridge’s best guess for ' + esc(words) + '">Use best guess</button>'
      : '<button class="btn primary wide" type="button" data-review="redo"' + dis + ' aria-label="Redo ' + esc(words) + ' by pedalling">' + (improving && it.gear ? 'Redo it' : 'Redo ' + esc(words.replace(/ \(.*\)$/, ''))) + '</button>') +
    '</div><div class="rv-btns">' +
    (tired || !guessable ? '' : '<button class="btn secondary" type="button" data-review="guess"' + dis + '>Use best guess</button>') +
    '<button class="btn secondary" type="button" data-review="skip"' + (busy ? ' disabled' : '') + '>' + (tired ? 'Keep it as it is' : 'Skip') + '</button></div>';
  if (items.length > 1) html += '<p class="small muted" style="margin-top:8px">Then ' + (items.length - 1) + ' more to look at.</p>';
  if (busy) html += '<div class="rv-msg busy" role="status">' + (!connected ? 'Connection lost: reconnect to carry on.'
    : state.edit.kind === 'R' ? 'Starting the redo…' : 'Saving the best guess…') + '</div>';
  if (state.editErr) html += '<div class="rv-msg bad" role="alert">Not changed: ' + esc(state.editErr) + '</div>';
  card.innerHTML = html;
}

// After each redo of an Improve pass: what it did to the gear, and the rider picks what's next.
// From the second try on, the bridge's best guess (or keeping it) is the main button.
var redoResultKey = '';
function renderRedoResult(card) {
  var r = state.redoResult, g = r.gear, connected = state.conn === 'connected', busy = !!state.edit;
  var mine = reviewItems().filter(function (it) { return itemGear(it) === g; });
  var others = reviewItems().filter(function (it) { return itemGear(it) !== g; });
  var tries = state.fixTries['g' + g] || 0;
  var guessIt = mine.filter(function (it) { return !!fixGuess(it); })[0];
  var key = JSON.stringify(r) + '|' + mine.length + '|' + others.length + '|' + tries + '|' + connected + '|' + busy + '|' + state.editErr;
  setHidden('reviewCard', false);
  if (key === redoResultKey) return;
  redoResultKey = key;
  var good = r.after === 0, better = r.after < r.before, still = !good;
  var next = others.length ? 'Next: gear ' + itemGear(others[0]) : 'Back to your gears';
  var dis = !connected || busy ? ' disabled' : '';
  var html = '<h2>' + (good ? 'Gear ' + g + ' looks good now <span class="rv-done" aria-hidden="true">✓</span>'
      : better ? 'Gear ' + g + ' is better' : r.after === 2 ? 'Gear ' + g + ' still needs another look' : 'Gear ' + g + ' is still unsure') + '</h2>';
  if (still) html += '<p class="rv-t">' + esc(r.why || '') + '</p><p class="small muted">' +
    (tries >= FIX_MAX_TRIES ? 'Redone ' + tries + ' times. ' + (guessIt ? 'The bridge’s best guess is probably better than another try.' : 'Another try is unlikely to change it: keep it as it is.')
      : 'Redone once.' + (better ? '' : ' Check the console shows gear ' + g + ' at each tap, then try again.')) + '</p>';
  else html += '<p class="small muted">It was ' + (r.before === 2 ? 'red' : 'yellow') + ' before this redo.</p>';
  var btns = [];
  if (good || (better && r.after === 1 && tries < FIX_MAX_TRIES && !mine.length)) btns.push(['next', next, true]);
  else if (tries >= FIX_MAX_TRIES) {
    if (guessIt) btns.push(['guess', 'Use best guess', true]);
    btns.push(['keep', 'Keep it as it is', !guessIt]);
    btns.push(['again', 'Try again', false]);
  } else {
    btns.push(['again', 'Try again', true]);
    if (guessIt) btns.push(['guess', 'Use best guess', false]);
    btns.push(['keep', others.length ? 'Keep it, next gear' : 'Keep it as it is', false]);
  }
  html += '<div class="rv-btns">' + btns.map(function (b) {
    return '<button class="btn ' + (b[2] ? 'primary' : 'secondary') + '" type="button" data-review="' + b[0] + '"' + (b[0] === 'next' || b[0] === 'keep' ? '' : dis) + '>' + esc(b[1]) + '</button>';
  }).join('') + '</div>';
  if (busy) html += '<div class="rv-msg busy" role="status">' + (!connected ? 'Connection lost: reconnect to carry on.' : 'Saving the best guess…') + '</div>';
  if (state.editErr) html += '<div class="rv-msg bad" role="alert">Not changed: ' + esc(state.editErr) + '</div>';
  card.className = 'card review' + (good ? ' rv-ok' : '');
  card.innerHTML = html;
}

// The result card's buttons: next (leave this gear for now), keep (as it is), again, guess.
function redoResultAct(act) {
  var rr = state.redoResult;
  if (!rr) return;
  state.redoResult = null; redoResultKey = '';
  var g = rr.gear, mine = reviewItems().filter(function (it) { return itemGear(it) === g; });
  if (act === 'next') state.review.items = reviewItems().filter(function (it) { return itemGear(it) !== g; });
  else if (act === 'keep') { mine.forEach(keepAsIs); state.review.items = reviewItems().filter(function (it) { return itemGear(it) !== g; }); }
  else {
    // this gear first again (the bridge may not flag it, e.g. a yellow gear: its edges from the list)
    if (!mine.length) mine = gearRedoEdges(g).map(function (e) { e.reason = 'rider'; return e; });
    if (act === 'guess') mine.sort(function (a, b) { return (fixGuess(b) ? 1 : 0) - (fixGuess(a) ? 1 : 0); });   // (the point the bridge has a guess for)
    state.review.items = mine.concat(reviewItems().filter(function (it) { return itemGear(it) !== g; }));
    if (act === 'again') state.redoAgain = 'g' + g;
  }
  state.fixPaused = false; state.editErr = '';
  if (act === 'guess') fixAction('guess'); else fixNext();
}

// On the redo screen of a flagged point: small "Use best guess instead" / "Skip" links.
function renderFixLinks() {
  var it = fixInRedo();
  setHidden('fixLinks', !it || !!state.fixAfter);
  setHidden('fixGuess', !it || !fixGuess(it));   // #23: only a gear the bridge flagged has a best guess
  $('fixGuess').disabled = state.conn !== 'connected';
  $('fixSkip').disabled = state.conn !== 'connected';
}

// Send #R (redo by pedalling) or #G (use the board's guess) for one point.
function startEdit(kind, pass, point, g) {
  if (state.review && state.review.source === 'improve') state.improveLast = pass + point;   // #21 ([v3.5] 'g' + gear)
  if (state.conn !== 'connected') { toast('Not connected'); return; }
  if (state.edit) { toast('Still waiting for the bridge'); return; }
  if (state.s && state.s.cal !== 0) { toast('Finish or cancel the calibration first'); return; }
  state.editErr = '';
  var ed = { kind: kind, pass: pass, point: point, g: g || null, timer: 0 };
  ed.timer = setTimeout(function () {
    if (state.edit === ed && !ed.started && !ed.okd) {
      state.edit = null;
      state.editErr = 'no answer from the bridge (it needs firmware v3.2)';
      state.fixPaused = true;
      renderReview();
    }
  }, EDIT_TIMEOUT_MS);
  state.edit = ed;
  sendCmd('#' + kind + ',' + pass + ',' + point);
  renderReview();
}
