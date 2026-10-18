// M3 Bridge phone page: demo simulator. index.html loads this file only with ?demo=1, just before js/main.js.
// Classic script sharing the page's global scope (DEMO_* flags come from the app's constants).
'use strict';

// ===================================================================
// Demo simulator (?demo=1). Emits protocol lines as <=20-byte chunks
// through the same onBytes() -> handleLine() path as Bluetooth.
// ===================================================================
function Simulator(startCalibrated) {
  var encoder = new TextEncoder();
  var connected = false, stream = false, debug = false, auto = true, calValid = startCalibrated;
  var cal = 0, step = 0, stab = 0, phase = 'move', phaseT = 0, capT = 0;
  var t = 0, gear = 7, cad = 0, timer = 0;
  // [v3] turn detection from the crank magnet
  var turnAcc = 0, turnMs = 0, agree = 0, tStream = false, pedal = true;
  var lturns = 0, learnFails = DEMO_LEARNFAIL ? 1 : 0;   // [v3.1] turn-based crank learning
  var wPlan = {}, wSent = 0, mflag = false, firstW = 0, stuckDone = false;   // [v3.1] hold-still check
  var pauseUntil = 0;   // status lines held back until this time (simulated Bluetooth stall)
  this.pauseStatus = function (ms) { pauseUntil = Date.now() + ms; };
  // [v3.2] passes, down points, the check (F), edits (#R / #G)
  var passName = '-';          // - u d ru rd
  var downPts = {};            // down point (23..2) -> [x, y, z]
  var resolved = {};           // 'u20' etc.: flagged point fixed by #R or #G
  var redoInfo = null;         // {pass, point, bUntil}: B flag until bUntil
  var behindSent = false, backUntil = 0;   // &behind=1: overshoot at point 7; B until backUntil
  var cmdBuf = null;           // '#...' command being received, up to \n
  // [v3.3] flow step (S field 15), pause, sweep, placement stream
  var flowStep = 0, stillTicks = 0, sweepT = 0, xOn = false, placeT = 0, noiseN = 0, nstuckSent = false;

  // A plausible calibration path: 25 points, total ~146 µT, smallest step 3.8 µT at gear 6.
  var PATH = (function () {
    var pts = [[38.2, -14.6, 22.4]];
    var dflt = (146.0 - 3.8) / 23;
    for (var i = 1; i < TOTAL_POINTS; i++) {
      var d = (i === 5) ? 3.8 : dflt;
      var a = 0.07 * i, ux = Math.cos(a), uy = Math.sin(a), uz = 0.35;
      var n = Math.sqrt(ux * ux + uy * uy + uz * uz);
      var p = pts[i - 1];
      pts.push([p[0] + d * ux / n, p[1] - d * uy / n, p[2] + d * uz / n]);
    }
    return pts;
  })();

  // [v3.2] down point k: the same edge as up point k, approached from above. It sits a little
  // towards the lower gear (the console's stickiness). Point 23 is off with &review=1 (updown).
  function downXYZ(k) {
    var a = PATH[k - 1], b = PATH[k - 2], f = DEMO_REVIEW && k === 23 && !resolved.d23 ? 0.9 : 0.3;
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }
  if (DEMO_V32 && startCalibrated) for (var dk = 2; dk <= TOTAL_POINTS - 2; dk++) downPts[dk] = downXYZ(dk);

  // One FIFO of <=20-byte notification chunks, like the real TX characteristic.
  // Items may also be functions (run in order, e.g. "transfer finished").
  var txq = [], txHead = 0, pumping = false;
  function enqueueText(text) {
    var b = encoder.encode(text);
    for (var i = 0; i < b.length; i += 20) txq.push(b.subarray(i, i + 20));
    schedule();
  }
  function enqueueFn(fn) { txq.push(fn); schedule(); }
  function schedule() { if (!pumping) { pumping = true; setTimeout(pump, 0); } }
  function pump() {
    pumping = false;
    var n = 0;
    while (txHead < txq.length && n < 800) {
      var it = txq[txHead++];
      if (typeof it === 'function') it();
      else if (connected) onBytes(it);
      n++;
    }
    if (txHead >= txq.length) { txq = []; txHead = 0; } else schedule();
  }
  function out(line) {
    if (!connected) return;
    enqueueText(line + '\r\n');
  }
  function jitter(a) { return (Math.random() * 2 - 1) * a; }

  // ---- diagnostics recording (25 Hz, 0.1 uT ints) ----
  var REC_CAP = 12000, REC_PERIOD = 40;
  var recording = false, dumping = false, samples = [], markers = [], recTimer = 0;
  var recLast = 0, recStart = 0, markerAt = 0, revsF = 0, crank = 0, crank6Base = 0, dumpsSent = 0;

  function lerpPath(f) {           // f: 0 (lever down) .. 1 (lever up)
    var x = Math.max(0, Math.min(1, f)) * (TOTAL_POINTS - 1);
    var i = Math.min(TOTAL_POINTS - 2, Math.floor(x)), u = x - i;
    var a = PATH[i], b = PATH[i + 1];
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
  }

  function sampleTick() {
    if (!recording) return;
    var now = performance.now();
    var dt = samples.length ? Math.min(255, Math.round(now - recLast)) : 0;
    recLast = now;
    var k = markers.length;
    var el = (now - markerAt) / 1000 * FAST;  // seconds into the step, on the nominal timeline
    var lever = 0, rpm = 0, lean = 0, crankDeg;
    switch (k) {
      case 0: case 1: case 5: lever = 0; break;
      case 2: lever = el / 15; break;
      case 3: lever = 1; break;
      case 4: lever = 1 - el / 15; break;
      case 6:   // one slow revolution by hand, pausing at each quarter
        lever = 0;
        crankDeg = crank6Base + (Math.floor(el / 5) + Math.min(1, (el % 5) / 2)) * 90;
        if (crankDeg > crank6Base + 360) crankDeg = crank6Base + 360;
        break;
      case 7: lever = Math.min(0.46, el / 8 * 0.46); rpm = 70; break;
      case 8: lever = 0.46; rpm = 60; break;
      case 9: lever = 0.46; rpm = 95; break;
      case 10: lever = 0.46; rpm = Math.max(0, 95 - el * 30); break;
      default: lever = 0.46; lean = el < 5 ? 1 : el < 10 ? 0 : -1; break;
    }
    var prevCrank = crank;
    if (crankDeg !== undefined) crank = crankDeg;
    else crank += rpm / 60 * 360 * dt / 1000;
    if (k !== 6) crank6Base = crank;
    revsF += Math.max(0, crank - prevCrank) / 360;
    var p = lerpPath(lever);
    var th = crank * Math.PI / 180;
    var fx = p[0] + 0.9 * Math.sin(th) + 1.6 * lean + jitter(0.35);
    var fy = p[1] + 0.5 * Math.cos(th) + jitter(0.35);
    var fz = p[2] + 0.4 * Math.sin(2 * th) - 0.8 * lean + jitter(0.35);
    samples.push([Math.round(fx * 10), Math.round(fy * 10), Math.round(fz * 10), Math.floor(revsF) % 65536, dt]);
    if (samples.length >= REC_CAP) stopRecording('full');
  }

  function recDuration() {
    var s = 0;
    for (var i = 0; i < samples.length; i++) s += samples[i][4];
    return s;
  }
  function stopRecording(kind) {
    if (!recording) return;
    recording = false;
    clearInterval(recTimer);
    out('G,' + kind + ',' + samples.length + ',' + recDuration());
  }

  function sendRecording() {
    if (recording) stopRecording('stop');
    dumping = true;
    var n = samples.length, sum = 0;
    var lines = ['Y,begin,' + n + ',' + REC_PERIOD + ',' + markers.length];
    markers.forEach(function (m, i) { lines.push('Y,m,' + (i + 1) + ',' + m); });
    var dropAt = DEMO_DROP && dumpsSent === 0 && n > 10 ? Math.floor(n / 2) : -1;
    for (var i = 0; i < n; i++) {
      var s = samples[i];
      sum += s[0] + s[1] + s[2];
      if (i === dropAt) continue;   // simulate a lost notification
      lines.push('D,' + s[0] + ',' + s[1] + ',' + s[2] + ',' + s[3] + ',' + s[4]);
    }
    lines.push('Y,end,' + n + ',' + (((sum % 65536) + 65536) % 65536));
    dumpsSent++;
    enqueueText(lines.join('\r\n') + '\r\n');
    enqueueFn(function () { dumping = false; });
  }
  function gearToRes(g) { return Math.min(100, 2.5 + (g - 1) * 4.25); }

  function tick() {
    t++;
    var res, watts, off, flags = '';
    var hold = false, sat = false;

    if (DEMO_V3 && cal !== 0) {
      // [v3] calibration while pedalling: learn the crank (cal=3), then 3 agreeing turns per point
      // [v3.3] &rest=1: a short break now and then from the sweep on (flag O after 2 s)
      var restP = FAST > 1 ? 60 : 140, restL = FAST > 1 ? 16 : 24;
      pedal = !(DEMO_REST && DEMO_V33 && flowStep >= 3 && (t % restP) >= restP - restL);
      stillTicks = pedal ? 0 : stillTicks + 1;
      cad = pedal ? DEMO_CAD + jitter(2) : 0;
      if (DEMO_V33 && flowStep === 3) {
        // [v3.3] the sweep: the lever goes slowly up, then down (just for the numbers on screen)
        sweepT++;
        gear = passName === 'sd' ? Math.max(1, 22 - Math.floor(sweepT / 3)) : Math.min(22, 1 + Math.floor(sweepT / 3));
      }
      if (cal === 3) {
        // [v3.1] learning ends once 6 regular turns are seen (onTurn counts them)
        stab = Math.min(95, Math.round(lturns * 100 / 6));
        if (lturns >= 6) {
          if (learnFails > 0) {
            learnFails--;
            out('L,0,6,' + Math.round(cad) + ',6.1,dip too shallow');
            out('Crank magnet not detected well enough. Send l to try again.');
            cal = 1; step = 0; stab = 0; agree = 0; phase = 'move'; phaseT = 0;
            if (DEMO_V33) flowStep = 4;   // the hold-still method: the gear step
          } else {
            out('L,1,6,' + Math.round(cad) + ',58.0,ok');
            out('Crank learned. Check that the cadence matches the Keiser console.');
            cal = 4; stab = 100;
          }
        }
      } else if (cal === 4) {
        stab = 100;                                   // waiting for n (matches) or l (learn again)
      } else if (cal === 2) {
        if (--capT <= 0) capturePoint();
      } else if (cal === 6 || cal === 7) {
        stab = 0;                                     // [v3.3] survey / checkpoint: no points
      } else if (cal === 5) {
        stab = 0;                                     // [v3.1] waiting for u (redo) or n (capture anyway)
      } else if (phase === 'move') {
        stab = 0; agree = 0;
        if (pedal && ++phaseT >= 6) { phase = 'settle'; phaseT = 0; }
      }
      var tgt = step <= 0 ? 1 : step >= 24 ? 24 : step + 1;
      if (passName === 'd' || passName === 'rd') tgt = Math.max(1, step);   // [v3.2] coming down to gear step
      if (cal < 3 && !(DEMO_V33 && flowStep === 3)) gear = tgt;
      res = gearToRes(gear) + (phase === 'move' && cal === 1 ? jitter(1.5) : jitter(0.1));
      watts = Math.round(cad * (0.4 + res * 0.045));
      off = phase === 'move' && cal === 1 ? 3 + Math.random() * 8 : 0.2 + Math.random() * 0.5;
    } else if (DEMO_V3) {
      // [v3] riding, with a short stop every ~40 s. During the gear check (step 6) the rider
      // shifts toward the wanted gear, a gear every 1.5 s, holds it, and pedals faster when asked.
      var want = state.check && state.check.phase === 'run' && !state.check.picking ? checkList(state.check)[state.check.idx] : null;
      pedal = want ? true : (t % 160) < 136;
      if (want) {
        if (t % 6 === 0 && gear !== want.gear) gear += want.gear > gear ? 1 : -1;
      } else if (t % 12 === 0 && pedal) {
        gear += Math.random() < 0.5 ? -1 : 1;
        gear = Math.max(1, Math.min(24, gear));
      }
      cad = pedal ? (want && want.pace === 'fast' ? 94 : 78) + 5 * Math.sin(t / 22) + jitter(1.5) : 0;
      res = gearToRes(gear) + jitter(0.3);
      watts = pedal ? Math.round(cad * (0.4 + res * 0.045)) : 0;
      off = 0.3 + Math.random() * 0.9;
    } else if (cal !== 0) {
      if (cal === 2) {
        stab = 100;
        if (--capT <= 0) capturePoint();
      } else if (phase === 'move') {
        stab = 0;
        if (++phaseT >= 6) { phase = 'settle'; phaseT = 0; }
      } else if (phase === 'settle') {
        stab = Math.min(100, stab + 12.5 + jitter(2));
        if (stab >= 100) { stab = 100; if (auto) beginCapture(); }
      }
      cad = phase === 'move' && cal === 1 ? 50 + jitter(5) : Math.max(0, cad * 0.6);
      var target = step <= 0 ? 1 : step >= 24 ? 24 : step + 1;
      gear = target;
      res = gearToRes(target) + (phase === 'move' ? jitter(1.5) : jitter(0.1));
      watts = Math.round(cad * (0.4 + res * 0.045));
      off = phase === 'move' ? 3 + Math.random() * 8 : 0.2 + Math.random() * 0.5;
    } else {
      if (t % 12 === 0) {
        gear += Math.random() < 0.5 ? -1 : 1;
        if (t % 96 === 0) gear += Math.random() < 0.5 ? -4 : 4;
        gear = Math.max(1, Math.min(24, gear));
      }
      cad = 86 + 6 * Math.sin(t / 22) + jitter(1.5);
      res = gearToRes(gear) + jitter(0.3);
      watts = Math.round(cad * (0.4 + res * 0.045));
      hold = (t % 120) >= 100 && (t % 120) < 110;
      sat = (t % 400) >= 380 && (t % 400) < 386;
      off = hold ? 6 + Math.random() * 3 : 0.3 + Math.random() * 0.9;
    }
    if (DEMO_V3 && pedal && cad > 0) {
      turnAcc += cad / 60 * 0.25;
      while (turnAcc >= 1) { turnAcc -= 1; onTurn(Math.round(60000 / cad)); }
    }
    if (calValid) flags += 'V';
    if (!DEMO_V3) flags += 'P';   // v3 demo: no pod, cadence from the crank magnet
    if (DEMO_V3 && pedal) flags += 'R';
    if (t > 20) flags += 'Z';
    if (sat) flags += 'S';
    if (hold && calValid) flags += 'H';
    if (auto) flags += 'A';
    if (mflag && cal !== 0) flags += 'M';
    if (recording) flags += 'G';
    if (dumping) flags += 'Y';
    if (cal !== 0 && ((redoInfo && Date.now() < redoInfo.bUntil) || Date.now() < backUntil)) flags += 'B';   // [v3.2] go back past the point first
    if (DEMO_V33 && cal !== 0 && cal !== 7 && stillTicks >= 8) flags += 'O';   // [v3.3] paused: no pedal turn for 2 s

    // [v3.3] placement stream ('v'): X lines at 4 Hz; the swing grows as the lever goes up and down
    if (xOn) {
      placeT++;
      var sw = Math.min(DEMO_V33 ? 142 : 0, placeT * (FAST > 1 ? 9 : 4)) + jitter(0.4);
      out(['X', (128 + jitter(1)).toFixed(1), Math.max(0, sw).toFixed(1), (placeT > 4 ? 46 + jitter(3) : 0).toFixed(1),
        (58 + jitter(1)).toFixed(0), (0.35 + Math.random() * 0.05).toFixed(2)].join(','));
    }

    if (DEMO_STALL && t % 48 === 0) pauseUntil = Date.now() + 3000;
    if (stream && !dumping && Date.now() >= pauseUntil) {   // status lines pause during a transfer or a stall
      var cadOut = DEMO_V3 && cal === 3 && lturns === 0 ? 0 : cad;   // no rpm until the first turns
      out(['S', calValid ? gear : 0, res.toFixed(1), Math.max(0, watts), cadOut.toFixed(1),
        cal, cal ? step : 0, Math.round(stab), off.toFixed(1), flags, samples.length]
        .concat(DEMO_V3 ? [pedal ? 'B' : '-', cal === 3 ? lturns : 0] : [])
        .concat(DEMO_V32 ? [cal === 0 ? '-' : passName] : [])
        .concat(DEMO_V33 ? [cal === 0 ? (xOn ? 1 : 0) : flowStep, 6] : []).join(','));
    }
    if (debug && t % 4 === 0) {
      var p = PATH[Math.max(0, Math.min(24, gear - 1))];
      out('dbg B=(' + (p[0] + jitter(.3)).toFixed(1) + ', ' + (p[1] + jitter(.3)).toFixed(1) + ', ' +
        (p[2] + jitter(.3)).toFixed(1) + ') µT  off=' + off.toFixed(1) + ' µT  gear=' + (calValid ? gear : 0));
    }
  }

  function beginCapture() { cal = 2; capT = 2; if (DEMO_V32) stab = 100; }

  // [v3] one detected pedal turn
  function onTurn(period) {
    turnMs += period;
    if (tStream) {
      var p = PATH[Math.max(0, Math.min(24, gear - 1))];
      out(['T', turnMs, period, (p[0] + jitter(0.2)).toFixed(1), (p[1] + jitter(0.2)).toFixed(1), (p[2] + jitter(0.2)).toFixed(1),
        calValid ? gear : 0, gearToRes(gear).toFixed(1)].join(','));
    }
    if (cal === 3) lturns++;
    if (DEMO_V33 && cal === 6) {
      // [v3.3] cal 6: a few still turns (the noise), then the sweep keeps every turn; no points
      if (step === 0 && ++noiseN >= 5) { step = 1; passName = 'su'; flowStep = 3; sweepT = 0; out('Sweep: pedal and slowly push the lever up as far as you can still pedal, then tap Next.'); }
      return;
    }
    if (cal === 7) return;
    if (DEMO_NSTUCK && DEMO_V33 && cal === 1 && phase === 'settle' && passName === 'u' && step === 4 && !nstuckSent && agree >= 1) {
      nstuckSent = true;
      out('N,stuck');
      out('If the console already shows gear 5, ease back into gear 4 and come up to it again.');
    }
    if (cal === 1 && phase === 'settle') {
      // [v3.2] redo: turns don't count until the reading has been past the point (B flag)
      if (redoInfo && Date.now() < redoInfo.bUntil) { agree = 0; stab = 0; return; }
      // [v3.2] &behind=1: point 7 was taken too far up, so at point 8 the agreeing turns sit behind it.
      // The board goes back to point 7 by itself (N,behind, U,6) and sets B until the lever has gone
      // back down far enough.
      if (DEMO_BEHIND && DEMO_V32 && passName === 'u' && step === 7 && !behindSent && agree >= 1) {
        behindSent = true;
        out('N,behind');
        step = 6; agree = 0; stab = 0; phase = 'settle'; mflag = false; wSent = 0;
        backUntil = Date.now() + (FAST > 1 ? 2000 : 4000);
        out('U,6');
        out('Point 7 went too far: going back to it. Shift down into gear 6, then up to where gear 7 first shows.');
        return;
      }
      if (Date.now() < backUntil) { agree = 0; stab = 0; return; }
      var need = DEMO_V32 ? 2 : 3;   // [v3.2] 2 agreeing turns, then the check turn
      if (agree < need) {
        agree++;
        stab = DEMO_V32 ? [0, 34, 67][agree] : [0, 34, 68, 100][agree];
      } else if (auto) {
        // [v3.1] one more turn at stab 100: did the lever really stop?
        var stuckHere = DEMO_STUCK && step === 5 && !stuckDone;
        if (wPlan[step] === undefined) wPlan[step] = DEMO_SUSPECT && step > 0 && step % 4 === 3 ? 1 + (step % 8 === 3 ? 1 : 0) : 0;
        if (stuckHere || wSent < wPlan[step]) {
          // still moving: drop this capture, keep waiting (non-blocking)
          if (!wSent) firstW = Date.now();
          wSent++; mflag = true;
          agree = 1; stab = 34;
          out('W,' + (step + 1) + ',' + (1.1 + Math.random()).toFixed(1) + ',' + (0.5 + Math.random() * 0.6).toFixed(1));
          if (stuckHere && Date.now() - firstW >= 15000 / (FAST > 1 ? 5 : 1)) {
            cal = 5; stab = 0;
            out('P,' + (step + 1));
            out('Point ' + (step + 1) + ': the reading keeps changing. u = redo, n = capture anyway.');
          }
        } else beginCapture();
      }
    }
  }

  function xyzStr(p, j) { return (p[0] + jitter(j)).toFixed(1) + ',' + (p[1] + jitter(j)).toFixed(1) + ',' + (p[2] + jitter(j)).toFixed(1); }

  // [v3.2] the check after saving: F lines, then F,end
  function sendF() {
    var list = sendFList();
    list.forEach(function (f) {
      var a = PATH[f.point - 1], b = PATH[f.point - 2];   // guess: the up reading, or the usual up/down offset
      var g = f.pass === 'u' ? a : [a[0] + (b[0] - a[0]) * 0.3, a[1] + (b[1] - a[1]) * 0.3, a[2] + (b[2] - a[2]) * 0.3];
      out('F,' + f.pass + ',' + f.point + ',' + (f.pass === 'u' ? 'behind' : 'updown') + ',' + xyzStr(g, 0));
    });
    out('F,end,' + list.length);
  }
  // [v3.3] start (or resume) the down pass: from the highest down point not measured yet
  function startDown() {
    var k = TOTAL_POINTS - 2;
    while (k >= 2 && downPts[k]) k--;
    if (k < 2) { downPts = {}; k = TOTAL_POINTS - 2; }
    passName = 'd'; step = k - 1; cal = 1; flowStep = 5; stab = 0; agree = 0; phase = 'move'; phaseT = 0; mflag = false; wSent = 0;
    out('Back down through the gears: move the lever DOWN to where the console FIRST shows gear ' + step + '.');
  }
  function saveAll(human) {
    cal = 0; step = 0; stab = 0; calValid = true; passName = '-'; redoInfo = null; flowStep = 0;
    out(human || 'Calibration complete: 25 points, span 146.0 µT, smallest step 3.8 µT at gear 6.');
    out('K,1,146.0,3.8,6,saved');
    sendF();
  }

  function capturePoint() {
    if (DEMO_V32 && (passName === 'd' || passName === 'rd')) {
      // [v3.2] down point step+1: coming down to gear step
      var dp = step + 1;
      if (passName === 'rd') resolved['d' + dp] = true;
      downPts[dp] = downXYZ(dp);
      out('C,down,' + dp + ',' + xyzStr(downPts[dp], 0.05));
      out('Down point ' + dp + ' (gear ' + step + ' coming down) captured.');
      mflag = false; wSent = 0;
      if (passName === 'rd') { redoInfo = null; out('E,ok,saved'); saveAll('Redo saved.'); return; }
      step--;
      if (step < 1) { saveAll('Calibration complete: 25 points up, ' + Object.keys(downPts).length + ' down.'); return; }
      cal = 1; stab = 0; agree = 0; phase = 'move'; phaseT = 0;
      return;
    }
    if (DEMO_V32 && passName === 'ru') {
      if (!(DEMO_STUBBORN && step + 1 === 20)) resolved['u' + (step + 1)] = true;   // &stubborn=1: gear 20 stays flagged
      out('C,' + (step + 1) + ',' + xyzStr(PATH[step], 0.05));
      redoInfo = null;
      out('E,ok,saved');   // as the firmware: E,ok,redo when the redo starts, E,ok,saved when it is saved
      saveAll('Redo saved.');
      return;
    }
    var p = PATH[step];
    out(['C', step + 1, (p[0] + jitter(0.05)).toFixed(1), (p[1] + jitter(0.05)).toFixed(1), (p[2] + jitter(0.05)).toFixed(1)].join(','));
    out('Point ' + (step + 1) + ' captured.');
    mflag = false; wSent = 0;
    if (DEMO_STUCK && step === 5) stuckDone = true;
    step++;
    if (DEMO_V32 && step === TOTAL_POINTS - 1) {
      // [v3.2] the top point is worked out from 23 and 24, then straight into the down pass
      // the top: 0.3 x the 23->24 step beyond point 24
      var p23 = PATH[22], p24 = PATH[23];
      out('C,25,' + xyzStr([p24[0] + 0.3 * (p24[0] - p23[0]), p24[1] + 0.3 * (p24[1] - p23[1]), p24[2] + 0.3 * (p24[2] - p23[2])], 0));
      if (DEMO_V33) {
        // [v3.3] checkpoint: the up pass is saved now; the down pass starts on Next (n) or later (#D)
        out('Top point worked out from points 23 and 24.');
        out('Up through the gears: saved. Next = come back down now.');
        calValid = true; redoInfo = null;
        out('K,1,146.0,3.8,6,saved');
        sendF();
        cal = 7; passName = 'd'; step = DOWN_FIRST_STEP; stab = 0; flowStep = 4;   // [v3.3] waiting at the checkpoint
        return;
      }
      out('Top point worked out from points 23 and 24. Now come back down: point 23 first.');
      passName = 'd'; step = DOWN_FIRST_STEP; cal = 1; stab = 0; agree = 0; phase = 'move'; phaseT = 0;
      return;
    }
    if (step >= TOTAL_POINTS) {
      cal = 0; step = 0; stab = 0; calValid = true;
      out('Calibration complete: 25 points, span 146.0 µT, smallest step 3.8 µT at gear 6.');
      out('K,1,146.0,3.8,6,saved');
      return;
    }
    cal = 1; stab = 0; phase = 'move'; phaseT = 0;
  }

  // Writes arrive as single characters, or as <=20-byte pieces of a '#...\n' command.
  this.receive = function (str) {
    if (!connected) return;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charAt(i);
      if (cmdBuf !== null) {
        if (ch === '\n' || ch === '\r') { var cmd = cmdBuf; cmdBuf = null; hashCmd(cmd); }
        else if (cmdBuf.length < 64) cmdBuf += ch;
        continue;
      }
      if (ch === '#' && DEMO_V32) { cmdBuf = ''; continue; }
      if (ch === '\n' || ch === '\r') continue;
      receiveChar(ch);
    }
  };

  // [v3.2] '#' edit commands (without the '#')
  function hashCmd(cmd) {
    var a = cmd.split(','), k = a[0], pass = a[1], point = parseInt(a[2], 10);
    if (k === 'J' && DEMO_V33) { out('J,' + a.slice(1).join(',')); return; }   // [v3.3] echo for the USB log
    if (k === 'M' && DEMO_V33) { out('Board moved: the next calibration starts fresh.'); out('E,ok,moved'); return; }
    if (k === 'D' && DEMO_V33) {
      if (cal !== 0) { out('E,fail,busy calibrating'); return; }
      if (!calValid) { out('E,fail,no calibration'); return; }
      out('E,ok,down');
      startDown();
      return;
    }
    if (k === 'X') { out('E,ok,cleared'); return; }
    if (k === 'P') { out('E,ok,staged'); return; }
    if (k === 'W') { out('E,ok,saved'); out('K,1,146.0,3.8,6,saved'); sendF(); return; }
    if (k !== 'R' && k !== 'G') { out('E,fail,unknown command'); return; }
    if (pass !== 'u' && pass !== 'd') { out('E,fail,bad pass'); return; }
    if (cal !== 0) { out('E,fail,calibrating'); return; }
    if (!calValid) { out('E,fail,no calibration'); return; }
    if (k === 'G') {
      var flagged = sendFList();
      var hit = flagged.some(function (f) { return f.pass === pass && f.point === point; });
      if (!hit) { out('E,fail,no guess for that point'); return; }
      resolved[pass + point] = true;
      if (pass === 'd') downPts[point] = downXYZ(point);
      out('Using the best guess for ' + (pass === 'd' ? 'down' : 'up') + ' point ' + point + '.');
      out('E,ok,saved');
      out('K,1,146.0,3.8,6,saved');
      sendF();
      return;
    }
    if (!(point >= 2 && point <= (pass === 'd' ? TOTAL_POINTS - 2 : TOTAL_POINTS - 1))) { out('E,fail,bad point'); return; }
    passName = 'r' + pass; step = point - 1; cal = 1; stab = 0; agree = 0; phase = 'move'; phaseT = 0; mflag = false; wSent = 0;
    redoInfo = { pass: pass, point: point, bUntil: Date.now() + (FAST > 1 ? 1500 : 3500) };
    if (DEMO_V33) flowStep = 6;   // a redo shows step 6
    out('E,ok,redo');
    out(pass === 'u'
      ? 'Redo gear ' + point + ': move the lever DOWN below gear ' + point + ', then up to where the console FIRST shows gear ' + point + ', and hold it there.'
      : 'Redo: from above, down to where the console first shows gear ' + (point - 1) + ', and hold it there.');
  }
  // the current F list without sending it
  function sendFList() {
    var l = [];
    if (DEMO_REVIEW) {
      if (!resolved.u20) l.push({ pass: 'u', point: 20 });
      if (!resolved.d23 && downPts[23]) l.push({ pass: 'd', point: 23 });
    }
    return l;
  }

  function receiveChar(c) {
    if (DEMO_OLDFW && 'kgmey'.indexOf(c) >= 0) { out("Unknown command '" + c + "'. h = help."); return; }
    switch (c) {
      case '1': stream = true; break;
      case '0': stream = false; out('Status stream off.'); break;
      case 'c':
        if (cal !== 0) { out('Already calibrating. x = abort.'); break; }
        if (DEMO_V3) {
          cal = 3; step = 0; stab = 0; agree = 0; lturns = 0; wPlan = {}; wSent = 0; mflag = false; stuckDone = false;
          passName = 'u'; redoInfo = null; behindSent = false; backUntil = 0; flowStep = DEMO_V33 ? 2 : 0; xOn = false; nstuckSent = false;
          if (DEMO_V32) { downPts = {}; resolved = {}; }
          out(DEMO_V32 ? 'Calibration started. Pedal steadily so the bridge can learn your crank.'
            : 'Calibration started. Pedal steadily at 60-80 rpm so the bridge can learn your crank.');
          break;
        }
        cal = 1; step = 0; stab = 0; phase = 'move'; phaseT = 0;
        out('Calibration started: 25 points. Auto-capture is ' + (auto ? 'ON' : 'OFF') + '.');
        break;
      case 'n':
        if (cal === 7) { startDown(); break; }   // [v3.3] checkpoint: Next = down pass
        if (cal === 0) { out('Not calibrating. c = start.'); break; }
        if (cal === 3) { out('Still learning the crank. Keep pedalling.'); break; }
        if (cal === 5) { capturePoint(); break; }   // [v3.1] capture anyway
        if (cal === 4 && DEMO_V33) {
          // [v3.3] cal 6: a few still turns (noise, step 0), then the sweep (step 1 up, Next, step 2 down, Next)
          cal = 6; step = 0; stab = 0; agree = 0; passName = 'u'; noiseN = 0;
          out('Cadence confirmed. Keep pedalling with the lever still for a few more turns.');
          break;
        }
        if (cal === 6 && step === 0) { step = 1; passName = 'su'; flowStep = 3; sweepT = 0; out('Sweep: slowly push the lever up, then tap Next.'); break; }
        if (cal === 6) {
          if (step === 1) { step = 2; passName = 'sd'; sweepT = 0; out('Now slowly back down to the bottom, then tap Next.'); break; }
          out('Z,0.36,146.0,' + (calValid ? 'same' : 'first') + ',0.4,ok');
          out('Sweep done: path 146.0 uT. Now up through the gears.');
          cal = 1; flowStep = 4; passName = 'u'; step = 0; stab = 0; agree = 0; phase = 'move'; phaseT = 0;
          break;
        }
        if (cal === 4) {
          cal = 1; step = 0; stab = 0; agree = 0; phase = 'move'; phaseT = 0;
          out(DEMO_V32 ? 'Cadence confirmed: keep pedalling. Points 1 to 24 going up, then back down.'
            : 'Cadence confirmed: keep pedalling through all 25 points.');
          break;
        }
        if (redoInfo && Date.now() < redoInfo.bUntil) { out('Not captured: go past the gear first.'); break; }
        if (cal === 1) {
          // [v3.1] manual captures get the same checks as auto-capture
          if (step > 0 && phase === 'move') { out('Not captured: the lever has not moved from the previous point.'); out('N,notmoved'); break; }
          if (DEMO_V3 && agree === 0) { out('No full pedal turn yet - keep pedalling.'); out('N,noturn'); break; }
          beginCapture(); out('Capturing point ' + (step + 1) + '...');
        }
        break;
      case 'l':
        if (!DEMO_V3 || !(cal === 4 || (cal === 1 && step === 0))) break;
        cal = 3; step = 0; stab = 0; agree = 0; lturns = 0;
        if (DEMO_V33) flowStep = 2;
        out('Learning the crank again.');
        break;
      case 'u':
        if (cal === 0) { out('Not calibrating.'); break; }
        if (passName === 'ru' || passName === 'rd') { out('Nothing to undo in a redo. x = cancel.'); break; }
        if (cal === 7) {
          passName = 'u'; step = TOTAL_POINTS - 2; cal = 1; flowStep = 4; stab = 0; agree = 0; phase = 'move'; phaseT = 0;
          out('U,' + step); out('Undo: back to point 24.');
          break;
        }
        var dn = DEMO_V32 && passName === 'd' ? ',d' : '';   // [v3.2] U,<step>,d in the down pass
        if (cal === 5) {
          // [v3.1] redo: same step; after moving the lever down and back up it settles
          cal = 1; stab = 0; agree = 0; phase = 'move'; phaseT = 0;
          mflag = false; wSent = 0; stuckDone = true;
          out('U,' + step + dn);
          out(dn ? 'Redo: first move the lever UP above this gear.' : 'Redo: first move the lever DOWN below this gear.');
          break;
        }
        if (dn) {
          if (step >= DOWN_FIRST_STEP) {
            // [v3.2] back from the first down point to up point 24
            passName = 'u'; step = TOTAL_POINTS - 2; cal = 1; stab = 0; agree = 0; phase = 'move'; phaseT = 0; mflag = false; wSent = 0;
            if (DEMO_V33) flowStep = 4;
            out('U,' + step);
            out('Undo: back to point 24 going up.');
            break;
          }
          step++; delete downPts[step + 1];
          cal = 1; stab = 0; agree = 0; phase = 'move'; phaseT = 0; mflag = false; wSent = 0;
          out('U,' + step + ',d');
          out('Undo: back to down point ' + (step + 1) + ' (gear ' + step + ').');
          break;
        }
        if (step === 0) { out('Nothing to undo.'); break; }
        step--; cal = 1; stab = 0; agree = 0; phase = 'move'; phaseT = 0; mflag = false; wSent = 0;
        out('U,' + step);
        out('Undo: back to point ' + (step + 1) + '.');
        break;
      case 's':
        // [v3.2] skip the rest of the down pass and save
        if (cal === 7) { cal = 0; flowStep = 0; passName = '-'; step = 0; out('Up pass saved. #D does the down pass later.'); break; }
        if (!DEMO_V32 || passName !== 'd' || cal === 0) { out('s: only in the down pass.'); break; }
        saveAll('Down pass stopped early: saved with ' + Object.keys(downPts).length + ' down points.');
        break;
      case 'x':
        if (cal === 7) { cal = 0; flowStep = 0; passName = '-'; step = 0; out('Up pass saved. #D does the down pass later.'); break; }
        if (cal === 0) { out('Not calibrating.'); break; }
        if (DEMO_V33 && passName === 'd') {
          // [v3.3] stopping the down pass keeps the down points measured so far
          saveAll('Down pass stopped: saved with ' + Object.keys(downPts).length + ' down points. #D carries on later.');
          break;
        }
        if (passName === 'ru' || passName === 'rd') {
          // [v3.2] cancel a redo: the saved calibration is unchanged
          cal = 0; step = 0; stab = 0; passName = '-'; redoInfo = null;
          out('E,fail,redo cancelled');
          break;
        }
        cal = 0; step = 0; stab = 0; passName = '-'; flowStep = 0;
        out('A,cancelled by user');
        break;
      case 'v':
        // [v3.3] placement stream on/off (the swing restarts from zero)
        if (!DEMO_V33) { out("Unknown command 'v'. h = help."); break; }
        xOn = !xOn; placeT = 0;
        out('Placement stream ' + (xOn ? 'ON' : 'OFF') + '.');
        break;
      case 'a':
        auto = !auto;
        out('Auto-capture ' + (auto ? 'ON' : 'OFF') + '.');
        if (auto && cal === 1 && stab >= 100) beginCapture();
        break;
      case 'p':
        if (!calValid) { out('No valid calibration stored.'); break; }
        out('Calibration (point, x, y, z in µT):');
        PATH.forEach(function (p, i) {
          out('  ' + (i < 9 ? ' ' : '') + (i + 1) + '  (' + p[0].toFixed(1) + ', ' + p[1].toFixed(1) + ', ' + p[2].toFixed(1) + ')');
        });
        out('  span = 146.0 µT, smallest step = 3.8 µT at gear 6');
        break;
      case 'k':
        if (!calValid) { out('Q,none'); break; }
        PATH.forEach(function (p, i) {
          out('Q,' + (i + 1) + ',' + p[0].toFixed(1) + ',' + p[1].toFixed(1) + ',' + p[2].toFixed(1));
        });
        if (DEMO_V32) {
          for (var qd = TOTAL_POINTS - 2; qd >= 2; qd--) if (downPts[qd]) out('Q,down,' + qd + ',' + xyzStr(downPts[qd], 0));
        }
        if (DEMO_V3) out('Q,crank,0.612,-0.354,0.707,4.8,-1');
        out('Q,end,146.0,3.8,6');
        if (DEMO_V32) sendF();
        break;
      case 'g':
        if (dumping) { out('Busy sending the recording.'); break; }
        clearInterval(recTimer);
        samples = []; markers = []; recording = true;
        recStart = recLast = markerAt = performance.now();
        revsF = 1234; crank = 0; crank6Base = 0;
        recTimer = setInterval(sampleTick, REC_PERIOD);
        out('G,start,' + REC_CAP + ',' + REC_PERIOD);
        break;
      case 'm':
        if (!recording || markers.length >= 32) break;
        markers.push(samples.length);
        markerAt = performance.now();
        out('M,' + markers.length + ',' + samples.length);
        break;
      case 'e':
        if (!recording) { out('Not recording.'); break; }
        stopRecording('stop');
        break;
      case 'y':
        if (dumping) break;
        sendRecording();
        break;
      case 'h': case '?':
        out('Commands: 1/0=status stream on/off  c=calibrate  n=capture point');
        out('          u=undo point  x=abort  a=auto-capture on/off');
        out('          p=show calibration  k=calibration as Q lines');
        out('          g=start recording  m=marker  e=stop  y=send recording');
        out('          d=debug stream on/off  h=help' + (DEMO_V3 ? '  t=turn stream on/off' : ''));
        if (DEMO_V32) out('          s=finish without the rest of the down pass  #R,u|d,N  #G,u|d,N');
        if (DEMO_V33) out('          v=placement meters on/off  #D=down pass (or resume)  #J,text=echo  #M=board moved');
        break;
      case 't':
        if (!DEMO_V3) { out("Unknown command 't'. h = help."); break; }
        tStream = !tStream;
        out('Turn stream ' + (tStream ? 'ON' : 'OFF') + '.');
        break;
      case 'd': debug = !debug; out('Debug stream ' + (debug ? 'ON' : 'OFF') + '.'); break;
      default: out("Unknown command '" + c + "'. h = help.");
    }
  };

  this.connect = function () {
    connected = true; stream = false; debug = false;
    clearInterval(timer);
    timer = setInterval(tick, 250);
    out('');
    out('Keiser M3 Bridge - phone console connected.');
    out('Simulated firmware ' + (DEMO_V33 ? 'v3.3 (one flow of 6 steps: spot, crank, sweep, up, down, check)' : DEMO_V32 ? 'v3.2 (calibration while pedalling, up and down)' : DEMO_V3 ? 'v3.1 (calibration while pedalling)' : 'v2') + '. Type h for help.');
  };
  this.disconnect = function () {
    connected = false; stream = false; debug = false;
    clearInterval(timer);
    txq = []; txHead = 0;
    dumping = false;            // a transfer in flight is lost; the recording itself is kept
  };
}

var sim = null;
function demoConnect() {
  if (!sim) sim = new Simulator(!DEMO_UNCAL);
  setConn('connecting', 'Starting simulator...');
  setTimeout(function () {
    resetRx();
    sim.connect();
    writeChain = Promise.resolve();
    setConn('connected');
    send('1', true);
  }, 400);
}
