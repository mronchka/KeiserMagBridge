// M3 Bridge phone page: Calibrate screen: walkthrough, the circle and its dots, the point check, result card.
// Classic script sharing the page's global scope; index.html loads the files in order (see its loader).
'use strict';

var RING_C = 2 * Math.PI * 112;
// Any steady cadence works while calibrating (crank mode). Outside these limits the
// dot turns red: below ~30 a turn takes over 2 s and may time out (3 s); above ~120
// the dip detector risks counting twice per turn (learning rejects over 130).
var CAD_LO = 30, CAD_HI = 120;

// Calibration walkthrough: one step per page. Kept free of firmware details that may
// change (how the top point is taken) so it stays true. Steps marked v32 show only
// with firmware v3.2 (the down pass).
var CAL_INTRO = {
  crank: [
    { art: 'pedal', title: 'Keep pedalling', text: 'The bridge reads the gear on every pedal turn, so pedal the whole time at a steady pace.' },
    { art: 'check', title: 'A quick cadence check', text: 'First it learns your pedal stroke. Then check the rpm matches your Keiser console.' },
    { art: 'shift', title: 'One gear at a time', text: 'Shift up until the console just shows the next gear, then hold it. The circle turns green when it’s saved.' },
    { art: 'ring', title: 'Bottom to top', text: 'Start with the lever all the way down and work up. It takes a few minutes.' },
    { art: 'ring', v32: true, title: 'Then back down', text: 'From the top, come back down the same way: move the lever down until the console first shows each lower gear. You can finish early.' }
  ],
  still: [
    { art: 'ring', title: 'Bottom to top', text: 'You’ll set the lever at each gear, starting all the way down and working up.' },
    { art: 'shift', title: 'One gear at a time', text: 'Shift up until the console just shows the next gear. The circle turns green when it’s saved.' },
    { art: 'still', title: 'Then stop and hold', text: 'At each gear stop pedalling and keep the lever still for a couple of seconds.' }
  ]
};
var onbIdx = 0, onbKey = '';

function onbSteps() {
  var known = !!state.s;   // no status line yet (not connected, or just reconnected): assume current firmware
  return state.v3 || !known ? CAL_INTRO.crank.filter(function (st) { return !st.v32 || state.v32 || !known; }) : CAL_INTRO.still;
}

function renderOnb() {
  var steps = onbSteps();
  if (onbIdx > steps.length - 1) onbIdx = steps.length - 1;
  var st = steps[onbIdx], last = onbIdx === steps.length - 1;
  var arts = document.querySelectorAll('#onb .art');
  for (var i = 0; i < arts.length; i++) arts[i].classList.toggle('on', arts[i].getAttribute('data-art') === st.art);
  var key = (steps === CAL_INTRO.still ? 'still' : 'crank' + steps.length) + '-' + onbIdx;  // the step list switches once the firmware is known (#68)
  if (key !== onbKey) {
    $('onbTitle').textContent = st.title;
    $('onbText').textContent = st.text;
    onbKey = key;
  }
  var dots = $('onbDots');
  if (dots.children.length !== steps.length) {
    dots.innerHTML = '';
    for (var d = 0; d < steps.length; d++) dots.appendChild(document.createElement('i'));
  }
  for (var k = 0; k < dots.children.length; k++) dots.children[k].className = k === onbIdx ? 'on' : '';
  setHidden('onbNext', last);
  setHidden('calStart', !last);
  setHidden('onbBack', onbIdx === 0);
  var ring = $('artRing');
  if (ring.getElementsByTagName('i').length !== TOTAL_POINTS) {
    for (var p = 0; p < TOTAL_POINTS; p++) {
      var a = (-90 + p * 360 / TOTAL_POINTS) * Math.PI / 180, dot = document.createElement('i');
      dot.style.left = (50 + 46 * Math.cos(a)).toFixed(2) + '%';
      dot.style.top = (50 + 46 * Math.sin(a)).toFixed(2) + '%';
      ring.appendChild(dot);
    }
  }
}

function onbGo(delta) {
  var n = onbSteps().length, next = Math.max(0, Math.min(n - 1, onbIdx + delta));
  if (next === onbIdx) return;
  // the outgoing picture slides out the way we're moving
  var cur = document.querySelector('#onb .art.on');
  if (cur) cur.classList.toggle('before', delta > 0);
  onbIdx = next;
  renderOnb();
}

// The 25 points as dots on a circle around the disc (positions in % of the stage).
function buildCalDots() {
  var box = $('calDots');
  if (box.children.length === TOTAL_POINTS) return;
  box.innerHTML = '';
  for (var i = 0; i < TOTAL_POINTS; i++) {
    var a = (-90 + i * 360 / TOTAL_POINTS) * Math.PI / 180;
    var d = document.createElement('i');
    d.className = 'pt';
    d.style.left = (50 + 46.67 * Math.cos(a)).toFixed(2) + '%';
    d.style.top = (50 + 46.67 * Math.sin(a)).toFixed(2) + '%';
    box.appendChild(d);
  }
}

function renderCal() {
  var s = state.s, connected = state.conn === 'connected';
  // Staleness never switches the view: an active calibration stays on screen with the last values.
  var active = calRunning(s);   // [v3.3] cal 7 (checkpoint) shows the Saved card, not the circle
  var checkRun = !active && !!state.check && state.check.phase === 'run';   // [v3.2] gear check running
  var checkDone = !active && !!state.check && state.check.phase === 'done' && !!state.check.flow;   // [v3.3] its summary
  var checkOffer = !active && !!state.check && state.check.phase === 'offer' && !!state.check.flow;   // [v3.3] the finish card
  var gearsShown = !active && !!state.gearList && !state.check && !reviewItems().length;   // [v3.3] the gear list (#11)
  if (active && state.place) closePlace(false);   // the calibration started: step 1 is over
  var placing = !!state.place && !active, saved = !!state.upSaved && !active;
  renderFlow(active, placing, saved);
  setHidden('calWait', !(active && !transferActive() && bridgeQuiet()));
  setHidden('calIdle', active || checkRun || checkDone || checkOffer || gearsShown || placing || saved);
  var lostRun = linkBack() && !!(state.dropS && state.dropS.cal !== 0);   // #69 (#77: until the first status line)
  setHidden('calLost', !lostRun);
  setHidden('onb', lostRun || homeListShown() || !!state.improving || (!$('calResume').hidden && !state.homeWalk));   // #12 (#38: nor under an Improve pass; #58: nor under the resume card): the stored calibration's gear list instead of the walkthrough (Calibrate again shows it)
  setHidden('onbHome', !(state.homeWalk && state.homeRead && state.points.length === TOTAL_POINTS));   // #26: and back
  setHidden('calActive', !active);
  // [v3.2] a redo (or the gear check) keeps the circle at the top: hide the result card until it ends
  if (state.result) setHidden('resultCard', resultCardHidden());
  $('calStart').disabled = !connected || !s;
  $('calStart').textContent = connected ? 'Start calibration' : 'Connect first';
  var v3 = state.v3;   // latched per connection
  if (!active) renderOnb();

  // auto-capture toggle reflects the A flag
  var at = $('autoToggle');
  at.setAttribute('aria-checked', s ? (s.flags.A ? 'true' : 'false') : 'mixed');
  at.disabled = !connected;

  setHidden('pointsCard', (state.points.length === 0 && state.downPoints.length === 0 && !active) || checkRun);
  // focused screen while a calibration step is on: no tab bar, the (x) Calibrate Undo bar
  state.calFocus = active || placing || saved || ((checkRun || checkDone || checkOffer || gearsShown) && connected);
  applyCalFocus();
  $('topX').setAttribute('aria-label', active ? 'Cancel calibration' : placing ? 'Back' : saved ? 'Later' : checkDone ? 'Close' : checkOffer || gearsShown ? 'Finish and ride' : 'Stop the gear check');
  if (!active) { setHidden('topUndo', true); if (cancelArmedUntil) disarmCancel(); return; }

  buildCalDots();
  var now = Date.now(), auto = !!s.flags.A;
  // [v3.3] cal 6 step 0: a few more turns with the lever still (the noise), shown like learning
  var noiseTurns = state.v33 && s.cal === 6 && s.step === 0;
  var learning = s.cal === 3 || noiseTurns, confirming = s.cal === 4;
  // Crank mode: v3 firmware that found the crank (gear per pedal turn, keep pedalling).
  // After a failed crank learning it falls back to the v2 hold-still method.
  var crankMode = v3 && !state.learnFailed;
  // [v3.2] the pass: '' or 'u' up, 'd' down (step 22..1, prompt gear = step), 'ru' / 'rd' redo of one point
  var v32 = state.v32;
  var pass = v32 ? s.pass : '';
  var down = pass === 'd', redoing = pass === 'ru' || pass === 'rd';
  // [v3.2] B: go back past the point first (a redo, or the board went back to an overshot point)
  var mustPass = v32 && !!s.flags.B && s.cal === 1;
  var overshot = !!state.overshoot && !redoing && state.overshoot.step === s.step && state.overshoot.pass === s.pass;
  var step = learning || confirming ? 0 : s.step;
  var pGear = down || pass === 'rd' ? step : step + 1;   // the gear named in the prompt
  var stab = Math.round(s.stab);
  var turns = Math.max(0, Math.min(3, Math.round(stab / 100 * 3)));
  var flash = !learning && !confirming && state.capturedAt && now - state.capturedAt < (state.capturedFlashMs || CAPTURE_FLASH_MS);
  var justLearned = !learning && !confirming && step === 0 && !down && !redoing && state.learnDoneAt && now - state.learnDoneAt < LEARN_DONE_MS;
  // [v3.3] the flow step from the bridge; paused (O) is calm, and replaces the amber "keep pedalling"
  var v33 = state.v33, flow = v33 ? s.flow : 0;
  var sweeping = v33 && (s.cal === 6 ? s.step >= 1 : flow === 3) && !learning && !confirming;
  var paused = v33 && !!s.paused && !learning && !confirming;
  var stopped = crankMode && !v33 && !learning && !confirming && !s.pedalling && s.cal === 1;
  var checking = s.cal === 5;   // [v3.1] point check
  // [v3.3] where to be now: during a go-back (B) the gear to go back into, then (green) the target
  var back = backGear(s);
  var bFlash = v32 && !mustPass && state.bClearAt && now - state.bClearAt < B_CLEAR_MS && !flash;
  renderPointCheck(checking, s);
  if (paused || sweeping) setHidden('holdBanner', true);
  var holdNote = !$('holdBanner').hidden;   // "Hold the lever still": the circle says the same

  // disc look: learn | confirm | grey | blue | green | amber
  var look, head, sub;
  if (learning) {
    look = 'learn';
    head = noiseTurns ? 'Keep pedalling' : 'Pedal steadily';
    sub = noiseTurns ? 'Lever still for a few more turns' : 'Any comfortable pace, and keep the lever still';
  } else if (confirming) {
    look = 'confirm';
    head = 'Matches the console?';
    sub = 'Compare with the rpm on the Keiser';
  } else if (paused) {
    look = 'paused';
    head = 'Paused — pedal to continue';
    sub = 'Nothing is lost. Shift if you need to, then pedal again.';
  } else if (sweeping) {
    look = 'grey';
    var sweepDown = sweepIsDown(s);
    head = sweepDown ? 'Slowly back down to the bottom' : 'Slowly push the lever up';
    sub = sweepDown ? 'Keep pedalling, then tap Next' : 'As far as you can still pedal, then tap Next';
  } else if (flash || justLearned) {
    look = 'green';
    head = justLearned ? 'Crank learned' : 'Got it';
    sub = justLearned ? 'Now the 25 lever positions'
      : state.capturedDown ? 'Gear ' + (state.capturedPoint - 1) + ' (coming down) saved'
      : v32 && state.capturedPoint === TOTAL_POINTS && !redoing ? 'Top worked out from gears 23 and 24'
      : pointLabel(state.capturedPoint) + ' saved';
  } else if (bFlash) {
    // [v3.3] B cleared: the rider is back in the gear before; green, then on to the target
    look = 'green';
    head = 'That’s it';
    sub = 'Now ' + (down || pass === 'rd' ? 'down' : 'up') + ' to gear ' + pGear;
  } else if (stopped) {
    look = 'amber';
    head = 'Keep pedalling';
    sub = 'The gear is read on every pedal turn';
  } else if (!mustPass && (s.cal === 2 || stab > 0)) {
    look = 'blue';
    if (crankMode) {
      head = 'Hold it there';
      if (s.cal === 2) sub = 'Saving…';
      else if (v32) {
        // [v3.2] 2 agreeing turns (34, 67), then the check turn
        sub = turns >= 2 ? (auto ? 'Turn 3 of 3 · checking the lever has stopped…' : 'Tap CAPTURE to save') : 'Turn 1 of 3';
      } else {
        sub = turns >= 3 && !auto ? 'Tap CAPTURE to save'
          : turns >= 3 && state.v31 ? 'Checking the lever has stopped…' : 'Turn ' + Math.max(1, turns) + ' of 3';
      }
    } else {
      head = 'Hold still';
      sub = s.cal === 2 ? 'Saving…' : auto ? 'Saves when the ring fills' : 'Tap CAPTURE when ready';
    }
    if (holdNote) { head = 'Hold the lever still'; sub = 'It saves once the reading settles'; }
  } else {
    look = 'grey';
    var n = step + 1;
    var v31c = crankMode && state.v31;   // [v3.1] wording: "...FIRST shows gear N, then hold it there"
    var upw = !(down || pass === 'rd');
    if (mustPass) {
      // [v3.3] go back first (a redo, or the board went back to an overshot point): the circle shows
      // only the gear to be in now; the target comes after (green, then the target gear).
      head = 'Shift ' + (upw ? 'down' : 'up') + ' into gear ' + back;
      sub = 'Keep pedalling';
    } else if (redoing) {
      head = 'Now ' + (upw ? 'up' : 'down') + ' to gear ' + pGear;
      sub = 'Move the lever until the console FIRST shows ' + pGear + ', then hold';
    } else if (overshot) {
      head = 'Now ' + (upw ? 'up' : 'down') + ' to gear ' + pGear;
      sub = 'Move the lever until the console FIRST shows ' + pGear + ', then hold';
    } else if (down) {
      head = 'Shift down to ' + pGear;
      sub = (step >= DOWN_FIRST_STEP && !state.downPoints.length ? 'Now back down. ' : 'Keep pedalling. ') +
        'Move the lever DOWN to where the Keiser console FIRST shows ' + pGear + ', then hold it there';
    } else if (step === 0) { head = 'Lever all the way down'; sub = v31c ? 'Keep pedalling and hold it there' : crankMode ? 'Keep pedalling' : 'Then stop pedalling'; }
    else if (step >= TOTAL_POINTS - 1 && v32 && crankMode) { head = 'Working out the top'; sub = 'From gears 23 and 24. Keep pedalling'; }
    else if (step >= TOTAL_POINTS - 1) { head = 'Lever all the way up'; sub = v31c ? 'Keep pedalling and hold it there' : crankMode ? 'Keep pedalling' : 'Then stop pedalling'; }
    else if (v31c) { head = 'Shift up to ' + n; sub = 'Keep pedalling. Move the lever until the console FIRST shows ' + n + ', then hold'; }
    else { head = 'Shift up to ' + n; sub = 'Stop the lever as soon as it shows ' + n + (crankMode ? '' : ', then stop pedalling'); }
  }
  $('calHead').textContent = head;
  $('calSub').textContent = sub;

  // [v3.2] one amber note next to the circle, most important first:
  // overshoot (the board went back), N,behind alone (gentle), or "still on gear N?" after 10 s.
  var bt = '', dirWord = down ? 'down' : 'up';
  var bh = !!state.behind && !checking && state.behind.step === s.step && state.behind.pass === s.pass;
  var stalled = !checking && !redoing && look === 'grey' && !overshot && !mustPass && !paused && !sweeping &&
    !!state.stallSince && state.stallKey === s.pass + s.step && now - state.stallSince > STALL_MS;
  if (paused || sweeping) {
    bt = '';
  } else if (overshot && !checking) {
    // [v3.3] the circle and the line under it say where to go; this just says why
    bt = v33
      ? '<b>Gear ' + pGear + ' was saved a little too far ' + (down ? 'down' : 'up') + '</b>, so it’s being redone.'
      : down
        ? '<b>Gear ' + pGear + ' was saved a little too far down.</b> Shift UP into gear ' + (pGear + 1) + ', then back down to where the console first shows gear ' + pGear + '.'
        : '<b>Gear ' + pGear + ' was saved a little too far up.</b> Shift DOWN into gear ' + (pGear - 1) + ', then back up to where the console first shows gear ' + pGear + '.';
  } else if (state.nstuck && state.nstuck.step === s.step && state.nstuck.pass === s.pass && !checking) {
    // [v3.3] N,stuck: the reading stays put although turns agree
    var upDir = !(down || pass === 'rd');
    bt = '<b>If the console already shows gear ' + pGear + '</b>, ease back into gear ' + (upDir ? pGear - 1 : pGear + 1) +
      ' and come ' + (upDir ? 'up' : 'down') + ' to it again.';
  } else if (bh) {
    bt = redoing
      ? '<b>This reading is behind the gear before it.</b> Check the console and move the lever on past it.'
      : '<b>Not quite there yet.</b> Keep moving the lever ' + dirWord + ' until the console first shows gear ' + pGear + '.';
  } else if (stalled) {
    // At the first down point the rider starts in gear 24 (the up pass ended on that edge), so the
    // gear before the target can be 24 or 23.
    var on = down ? pGear + 1 : pGear - 1;
    var onTxt = down && step >= DOWN_FIRST_STEP ? (TOTAL_POINTS - 1) + ' or ' + on : String(on);
    bt = '<b>Still on gear ' + onTxt + '?</b> Move ' + dirWord + ' until the console first shows gear ' + pGear +
      '. If it already shows ' + pGear + ', ease back ' + (down ? 'up' : 'down') + ' into gear ' + on + '.';
  }
  setHidden('behindHint', !bt);
  if (bt && $('behindHint').innerHTML !== bt) $('behindHint').innerHTML = bt;

  // disc
  $('disc').className = 'disc' + (look === 'blue' ? ' blue' : look === 'green' ? ' green' : look === 'amber' ? ' amber' : look === 'learn' ? ' learn' : look === 'paused' ? ' paused' : '') +
    ((flash || bFlash) && look === 'green' ? ' pop' : '') + (mustPass && look === 'grey' ? ' back' : '');
  var showNum = look !== 'learn' && (look !== 'green' || bFlash);
  setHidden('discNum', !showNum);
  setHidden('discCheck', look !== 'green' || bFlash);
  setHidden('discCrank', look !== 'learn');
  setHidden('discTurns', look !== 'learn');
  if (showNum) {
    if (confirming) {
      $('discLbl').textContent = 'RPM';
      $('discBig').textContent = fin(s.cad) && s.cad > 0 ? String(Math.round(s.cad)) : '--';
    } else if (sweeping) {
      $('discLbl').textContent = 'LEVER';
      $('discBig').textContent = sweepIsDown(s) ? '↓' : '↑';
    } else if (bFlash) {
      $('discLbl').textContent = 'GEAR';
      $('discBig').textContent = String(state.bClearGear || back);
    } else if (mustPass) {
      $('discLbl').textContent = 'GO TO';
      $('discBig').textContent = String(back);
    } else if (redoing || down) {
      $('discLbl').textContent = redoing ? 'REDO' : 'DOWN TO';
      $('discBig').textContent = String(Math.max(1, pGear));
    } else {
      $('discLbl').textContent = step === 0 ? 'BOTTOM' : step >= TOTAL_POINTS - 1 ? 'TOP' : 'GEAR';
      $('discBig').textContent = String(step === 0 ? 1 : Math.min(24, step + 1));
    }
  }
  if (look === 'learn') {
    $('discTurns').textContent = noiseTurns ? 'Lever still' : fin(s.lturns) ? Math.min(s.lturns, 6) + ' of 6 turns' : stab + '%';
  }
  // Three arcs (agreeing turns) in crank mode; a continuous ring for learning and the v2 hold timer.
  var useRing = look === 'learn' || (!crankMode && (look === 'blue' || look === 'grey'));
  var ringPct = s.cal === 2 ? 100 : stab;
  for (var k = 0; k < 3; k++) {
    setHidden('arc' + k, useRing);
    $('arc' + k).setAttribute('class', 'arc' + (look === 'green' || (look === 'blue' && (s.cal === 2 || k < turns)) ? ' on' : ''));
  }
  setHidden('ringTrack', !useRing);
  setHidden('ringFill', !useRing);
  if (useRing) $('ringFill').setAttribute('stroke-dashoffset', String(RING_C * (1 - ringPct / 100)));

  // the 25 dots
  var dots = $('calDots').children;
  if (down || redoing) {
    // [v3.2] all 25 green from the up pass; measured on the way down = settled blue;
    // the point being measured has a ring.
    // In the down pass every point above the one being measured is done coming down, even if this
    // page missed its C,down line (reloaded, reconnected, or resumed with #D).
    var downBy = {};
    state.downPoints.forEach(function (q) { downBy[q.point] = true; });
    for (var dj = 0; dj < TOTAL_POINTS; dj++) {
      var isDown = downBy[dj + 1] || (down && dj + 1 > step + 1 && dj + 1 <= TOTAL_POINTS - 2);
      var dc = 'pt ' + (isDown ? 'down' : 'done');
      if (dj === step && !flash) dc = 'pt cur ring' + (look === 'blue' ? ' blue' : '');
      dots[dj].className = dc;
    }
  } else {
    var doneCount = flash ? state.capturedPoint : step;
    for (var j = 0; j < TOTAL_POINTS; j++) {
      var cls = 'pt';
      if (!learning && !confirming && !sweeping) {
        if (j < doneCount) cls += ' done';
        else if (j === step && !flash) cls += ' cur' + (look === 'blue' ? ' blue' : '');
      }
      dots[j].className = cls;
    }
  }

  // cadence slider (crank mode only: the v2 method needs the flywheel still)
  setHidden('cadG', !crankMode || checking);
  if (crankMode) {
    var rpm = fin(s.cad) ? Math.round(s.cad) : 0, dotCls = '', cap, capCls = '';
    // [v3.2+] cadence guide: a green window for the gear to be in now (CAD_GUIDE)
    var guideGear = learning || confirming || sweeping ? (s.gear > 0 ? s.gear : 1) : mustPass ? back : pGear;
    var win = cadWindow(guideGear), guide = v32;
    if (stopped || paused || rpm <= 0) {
      dotCls = 'idle';
      cap = paused ? 'Paused' : stopped ? 'Not pedalling' : '';
      capCls = stopped ? 'warn' : '';
    } else if (rpm < CAD_LO || rpm > CAD_HI) {
      dotCls = 'bad'; capCls = 'bad';
      cap = rpm < CAD_LO ? 'Too slow — speed up a little' : 'Too fast — ease off a little';
    } else if (guide && (rpm < win[0] || rpm > win[1])) {
      dotCls = 'mid';
      cap = 'Comfortable here: ' + win[0] + '–' + win[1] + ' rpm';
    } else cap = '';
    // the line runs 20-130 rpm; the green window is the comfortable pace for this gear
    // (v3.1 has no guide: the workable range); the dot carries the rpm along it
    var sc = function (v) { return Math.max(0, Math.min(100, (v - 20) / (130 - 20) * 100)); };
    var wlo = guide ? win[0] : CAD_LO, whi = guide ? win[1] : CAD_HI;
    $('cadWin').style.left = sc(wlo).toFixed(1) + '%';
    $('cadWin').style.width = (sc(whi) - sc(wlo)).toFixed(1) + '%';
    $('cadMk').style.left = (dotCls === 'idle' ? 0 : sc(rpm)).toFixed(1) + '%';
    $('cadT1').style.left = sc(wlo).toFixed(1) + '%';
    $('cadT2').style.left = sc(whi).toFixed(1) + '%';
    if ($('cadT1').textContent !== String(wlo)) $('cadT1').textContent = String(wlo);
    if ($('cadT2').textContent !== String(whi)) $('cadT2').textContent = String(whi);
    var dot = $('cadDot');
    dot.parentNode.className = 'cadg-dot' + (dotCls ? ' ' + dotCls : '');
    dot.textContent = dotCls === 'idle' ? '--' : String(rpm);
    $('cadCap').textContent = cap;
    $('cadCap').className = 'cadg-cap' + (capCls ? ' ' + capCls : '');
    $('cadG').setAttribute('aria-label', dotCls === 'idle' ? (cap || 'Cadence: waiting for pedal turns') : 'Cadence ' + rpm + ' rpm' + (cap ? ', ' + cap : ''));
  }

  // buttons
  var noPoint = learning || confirming || sweeping;
  $('calActive').classList.toggle('nopoint', noPoint);
  $('calActive').classList.toggle('redoing', redoing);
  setHidden('calCount', noPoint);
  $('calCount').textContent = redoing ? 'Redoing ' + pointWords(pass === 'rd' ? 'd' : 'u', step + 1)
    : down ? 'Down pass: ' + Math.max(0, Math.min(DOWN_POINTS, DOWN_FIRST_STEP - step)) + ' of ' + DOWN_POINTS
    // (the hold-still method after the crank wasn't found: why, where 0 of 25 would be)
    : state.learnFailed && v3 && step === 0 && state.learnWhy ? 'Crank not found: ' + learnWhyText()
    : step + ' of ' + TOTAL_POINTS + ' positions saved';   // #33 (25 positions: the bottom, 23 gear changes, the top)
  // [v3.3] on the gear steps: stopping is fine
  var holdMethod = state.learnFailed && v3 && !redoing;
  setHidden('stopNote', !((v33 && (flow === 4 || flow === 5) && !redoing && !paused && !checking) || holdMethod));
  var whyShown = step === 0 && !!state.learnWhy;   // (calCount says it there)
  var sn = holdMethod ? (whyShown ? 'So ' : 'Crank not found' + (state.learnWhy ? ' (' + learnWhyText() + ')' : '') + ': ') +
      (v33 ? 'the sweep is skipped, and ' : '') + 'you stop pedalling at each gear.'
    : 'Stop pedalling to shift any time you like.';
  if ($('stopNote').textContent !== sn) $('stopNote').textContent = sn;
  var relearnHere = state.learnFailed && v3 && s.cal === 1 && step === 0 && !down && !redoing && !sweeping;
  setHidden('confirmBtns', !(confirming || relearnHere || sweeping));
  setHidden('btnConfirm', !(confirming || sweeping));
  setHidden('btnRelearn', sweeping);
  $('btnConfirm').textContent = sweeping ? 'Next' : 'Yes, it matches';
  $('btnRelearn').textContent = confirming ? 'Learn again' : 'Try learning the crank again';
  $('btnConfirm').disabled = !connected;
  $('btnRelearn').disabled = !connected;
  $('calActive').classList.toggle('checking', checking);
  setHidden('btnCapture', noPoint || checking);
  setHidden('btnUndo', noPoint || checking || redoing);
  // [v3.2] down pass: save what's measured and skip the rest (s), with a second-tap confirm
  setHidden('btnSkipDown', !(down && !checking && (s.cal === 1 || s.cal === 2)));
  $('btnSkipDown').disabled = !connected;
  // Auto-capture on: a small secondary "Capture now", usable once 2 of 3 turns agree
  // (or the hold timer is two-thirds done). Off: the big CAPTURE button.
  var cap = $('btnCapture');
  cap.classList.toggle('lite', auto);
  cap.classList.toggle('primary', !auto);
  cap.textContent = auto ? 'Capture now' : 'CAPTURE';
  cap.disabled = !connected || s.cal !== 1 || (auto && stab < 67) || stopped || mustPass;
  // Undo: at the first down point it goes back to up point 24 (the board allows it).
  // Not at the first point of a down pass resumed with #D (the board doesn't go back into the up pass there).
  $('btnUndo').disabled = !connected || s.cal !== 1 || (!down && step === 0) || (down && step === state.downResumeStep);
  $('btnCancel').disabled = !connected;
  setHidden('topUndo', $('btnUndo').hidden);
  $('topUndo').disabled = $('btnUndo').disabled;
}

function applyCalFocus() {
  document.body.classList.toggle('calfocus', !!state.calFocus && state.view === 'cal');
}

// [v3.1] Hold-still notice (M flag / W line): a non-blocking amber strip; the turns meter stays.
// cal=5 (P line, couldn't settle for 15 s): the big amber card replaces the disc.
// The redo banner stays until the redone point is captured.
var checkKey = '';
function renderPointCheck(checking, s) {
  setHidden('stage', checking);
  setHidden('calSay', checking);
  setHidden('calCheck', !checking);
  var n = checking ? s.step + 1 : 0;
  var pass = state.v32 ? s.pass : '';
  var downP = pass === 'd' || pass === 'rd';   // [v3.2] down point n = coming down to gear n-1
  if (checking) {
    if (pass + n !== checkKey) {   // only rewrite the card when it changes
      checkKey = pass + n;
      if (downP) {
        $('checkTitle').textContent = 'Gear ' + (n - 1) + ' (coming down): the reading keeps changing';
        $('checkBody').textContent = 'To redo it: move the lever UP above gear ' + (n - 1) + ', then down to where the console first shows gear ' + (n - 1) + ', then hold it there.';
        $('btnRedo').textContent = 'Redo gear ' + (n - 1);
      } else {
        $('checkTitle').textContent = 'Point ' + n + ': the reading keeps changing';
        $('checkBody').textContent = n >= TOTAL_POINTS
          ? 'To redo it: push the lever back down a little, then all the way up again and hold.'
          : 'To redo it: move the lever DOWN below gear ' + n + ', then up to where the console first shows gear ' + n + ', then hold it there.';
        $('btnRedo').textContent = 'Redo point ' + n;
      }
      setHidden('checkDrift', false);
      $('checkDrift').textContent = 'It kept changing for 15 seconds, so the bridge stopped waiting.';
    }
  } else checkKey = '';

  // hold-still strip: driven by the M flag, or a W for this point that hasn't been captured yet
  var holding = !checking && (s.cal === 1 || s.cal === 2) &&
    (!!s.flags.M || !!(state.w && !state.w.resolved && state.w.point === s.step + 1));
  setHidden('holdBanner', !holding);
  var connected = state.conn === 'connected';
  $('btnRedo').disabled = !connected;
  $('btnKeep').disabled = !connected;

  var redo = state.redo, txt = '';
  var redoDown = state.redoPass === 'd';
  var showRedo = !checking && !holding && redo > 0 && (s.cal === 1 || s.cal === 2) && s.step === redo - 1 &&
    (pass === 'd') === redoDown;
  if (showRedo) {
    txt = redoDown
      ? 'Redo gear ' + (redo - 1) + ' (coming down): lever UP above gear ' + (redo - 1) + ' first, then down to where the console first shows gear ' + (redo - 1) + ', then hold.'
      : redo >= TOTAL_POINTS
        ? 'Redo point 25: push the lever back down a little, then all the way up again and hold.'
        : 'Redo point ' + redo + ': lever DOWN below gear ' + redo + ' first, then up to where the console first shows gear ' + redo + ', then hold.';
  } else if (!checking && !holding && (pass === 'ru' || pass === 'rd')) {
    // [v3.2] #R redo of one point of the saved calibration
    var g = pass === 'ru' ? s.step + 1 : s.step;
    var lead = fixInRedo() ? 'Gear ' + g + (pass === 'rd' ? ' (coming down)' : '') + ' needs another look: ' : 'Redo gear ' + g + (pass === 'rd' ? ' (coming down)' : '') + ': ';
    showRedo = true;
    txt = pass === 'ru'
      ? lead + 'lever DOWN below gear ' + g + ' first, then up to where the console FIRST shows gear ' + g + ', then hold.'
      : lead + 'from above gear ' + g + ', down to where the console FIRST shows gear ' + g + ', then hold.';
  }
  setHidden('redoBanner', !showRedo);
  if (showRedo && $('redoBanner').textContent !== txt) $('redoBanner').textContent = txt;
}

// #77: the link is down, or back but its first status line hasn't come yet
function linkBack() { return state.conn !== 'connected' || !state.s; }

function renderBadge() {
  var b = $('calBadge');
  var calActive = state.s && state.s.cal !== 0;
  var r = state.result;
  var resultWaits = r && r.type && !state.resultHidden && !(isV33() && r.type === 'K' && r.ok);   // (#78: v3.3: the gear list has it)
  b.hidden = state.view === 'cal' || !(calActive || resultWaits || reviewItems().length);
  var ph = diag.phase;
  setHidden('diagBadge', state.view === 'diag' || ph === 'idle' || ph === 'done' || ph === 'error');
}

function pointLabel(n) {
  if (n === 1) return 'Bottom';
  if (n === TOTAL_POINTS) return 'Top';
  return 'Gear ' + n;
}

// [v3.2] a point in plain words: up point N = gear N going up; down point N = gear N-1 coming down
function pointWords(pass, n) {
  if (pass === 'd') return 'gear ' + (n - 1) + ' (coming down)';
  if (n === 1) return 'the bottom (lever all the way down)';
  if (n === TOTAL_POINTS) return 'the top (lever all the way up)';
  return 'gear ' + n + ' (going up)';
}
function capFirst(t) { return t.charAt(0).toUpperCase() + t.slice(1); }

function renderPoints() {
  var list = $('plist');
  var pts = state.points.slice().sort(function (a, b) { return a.point - b.point; });
  var html = '';
  // [v3.2] down points under the up points: right column = gap to the same edge's up reading
  var downs = state.downPoints.slice().sort(function (a, b) { return b.point - a.point; });
  var upBy = {};
  pts.forEach(function (q) { upBy[q.point] = q; });
  for (var i = 0; i < pts.length; i++) {
    var p = pts[i], prev = i > 0 && pts[i - 1].point === p.point - 1 ? pts[i - 1] : null;
    var dist = NaN;
    if (prev && fin(p.x) && fin(p.y) && fin(p.z) && fin(prev.x) && fin(prev.y) && fin(prev.z)) {
      dist = Math.sqrt(Math.pow(p.x - prev.x, 2) + Math.pow(p.y - prev.y, 2) + Math.pow(p.z - prev.z, 2));
    }
    html += '<div class="prow"><span class="n">' + p.point + '</span><span>' + pointLabel(p.point) +
      '</span><span class="xyz">' + fmt(p.x, 1) + ', ' + fmt(p.y, 1) + ', ' + fmt(p.z, 1) +
      '</span><span class="d' + (fin(dist) && dist < MARGINAL_UT ? ' marg' : '') + '">' +
      (fin(dist) ? 'Δ ' + dist.toFixed(1) : '') + '</span></div>';
  }
  if (downs.length) {
    html += '<div class="prow"><span></span><span class="small muted" style="grid-column:2 / -1">Coming down (right: gap to the reading going up)</span></div>';
    downs.forEach(function (q) {
      var gap = dist3(q, upBy[q.point]);
      html += '<div class="prow"><span class="n">' + q.point + '</span><span>Gear ' + (q.point - 1) + ' ↓</span><span class="xyz">' +
        fmt(q.x, 1) + ', ' + fmt(q.y, 1) + ', ' + fmt(q.z, 1) + '</span><span class="d">' + (fin(gap) ? '↕ ' + gap.toFixed(1) : '') + '</span></div>';
    });
  }
  list.innerHTML = html;
  list.scrollTop = list.scrollHeight;
  renderCal();
}

function resultCardHidden() {
  return calRunning(state.s) || !!(state.check && (state.check.phase === 'run' || state.check.flow)) ||
    !!state.upSaved || !!state.resultHidden || !!state.place || !!state.gearList || !!state.homeWalk ||   // #25
    !!state.improving || homeListShown() ||   // #45 (the list says it all; the file is under Saved runs)
    (linkBack() && !!(state.dropS && state.dropS.cal !== 0)) ||   // #69: a dropped run (#77: and while it comes back)
    (state.v33 && !!state.result && state.result.type === 'K' && state.result.ok && !calRunning(state.s));
}

function renderResult() {
  var card = $('resultCard'), r = state.result;
  if (!r) { card.hidden = true; card.innerHTML = ''; return; }
  card.hidden = resultCardHidden();
  var close = '<button class="x-btn" type="button" data-dismiss aria-label="Dismiss">×</button>';
  var html;
  if (r.type === 'K') {
    var marginal = r.ok && fin(r.minstep) && r.minstep < MARGINAL_UT;
    var flashFailed = r.ok && r.msg === 'save failed';   // in the bridge's memory only, until it restarts
    card.className = 'card result ' + (r.ok ? (marginal || flashFailed ? 'warn' : 'ok') : 'bad');
    html = '<h2>' + (flashFailed ? 'Calibrated until the bridge restarts' : r.ok ? 'Calibration saved' : 'Calibration rejected') + close + '</h2>';
    if (flashFailed) html += '<p>The bridge could not write it to its flash. Calibrate again to keep it.</p>';
    if (r.edit) html += '<p>Changed: ' + esc(r.edit) + '.</p>';
    if (!r.ok) html += '<p><b>' + esc(r.msg || 'No reason given') + '</b></p>';
    else if (r.msg && r.msg.toLowerCase() !== 'saved' && !flashFailed) html += '<p>' + esc(r.msg) + '</p>';
    html += '<div class="stats">' +
      '<div class="stat"><div class="v">' + fmt(r.span, 1) + '</div><div class="u">Span (µT)</div></div>' +
      '<div class="stat"><div class="v">' + fmt(r.minstep, 1) + '</div><div class="u">Smallest step (µT)' +
      (fin(r.minAt) ? ' (gear ' + r.minAt + ')' : '') + '</div></div></div>';
    // [v3.2] down pass
    if (r.ok && r.down >= 0 && !r.edit) {
      html += '<p class="downinfo">' + (r.down >= DOWN_POINTS ? 'Down pass: all ' + DOWN_POINTS + ' gears measured coming down.'
        : r.down > 0 ? 'Down pass: ' + r.down + ' of ' + DOWN_POINTS + ' gears measured coming down.'
        : 'Down pass skipped.') + '</p>';
    }
    if (marginal) {
      html += '<div class="marginal">Marginal: the smallest step (' + fmt(r.minstep, 1) + ' µT at gear ' +
        (fin(r.minAt) ? r.minAt : '?') + ') is under ' + MARGINAL_UT + ' µT. That gear may flicker. Consider moving the sensor closer to the magnet and recalibrating.</div>';
    }
    if (!r.ok) html += '<p class="small">Tap Start calibration to try again.</p>';
    if (r.recordId) {
      var rec = findRecord(r.recordId);
      html += rec
        ? '<p class="small" style="margin-top:12px">' + (rec.persisted ? 'Saved on this phone as ' : 'Kept for this session only as ') + esc(rec.filename) + '.</p>' + recActionsHtml(rec.id)
        : '<p class="small" style="margin-top:12px">Deleted from this phone.</p>';
    }
  } else {
    // #27: stopped by the rider is not an error
    var byRider = /cancel/i.test(r.reason);
    card.className = 'card result first' + (byRider ? '' : ' bad');
    html = '<h2>' + (byRider ? 'Calibration stopped' : 'Calibration aborted') + close + '</h2>' + (byRider ? '' : '<p><b>' + esc(r.reason) + '</b></p>') +
      '<p class="small">The previous calibration (if any) is unchanged.</p>';
    var prec = r.recordId ? findRecord(r.recordId) : null;
    if (prec) html += byRider ? '<p class="small">The points so far are kept under Saved runs.</p>'
      : '<p class="small">The points captured so far were saved as ' + esc(prec.filename) + ' (' + esc(prec.summary) + ').</p>' + recActionsHtml(prec.id);
  }
  card.innerHTML = html;
}
