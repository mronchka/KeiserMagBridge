// M3 Bridge phone page: Ride screen.
// Classic script sharing the page's global scope; index.html loads the files in order (see its loader).
'use strict';

// Calibrated for display. Once a calibrated line has been seen on this connection, a run of
// uncalibrated S lines must last UNCAL_HOLD_MS before the page says "Not calibrated"; until
// then the last good gear stays. One odd line can't flash the warning.
function rideCalibrated() {
  var s = state.s;
  if (!s) return false;
  if (s.gear > 0 && s.flags.V) return true;
  return state.calSeen && state.lastGear > 0 && !!state.uncalSince && Date.now() - state.uncalSince < UNCAL_HOLD_MS;
}
function rideGear() {
  var s = state.s;
  if (!s) return 0;
  if (s.gear > 0 && s.flags.V) return s.gear;
  return rideCalibrated() ? state.lastGear : 0;
}

function renderRide() {
  var s = state.s, stale = isStale(), connected = state.conn === 'connected';
  var gearEl = $('gear'), note = $('gearNote'), goCal = $('goCal');
  // Late S lines never change what is shown: the last values stay, with a small note.
  var f = s ? s.flags : {};
  var calibrated = rideCalibrated();
  setChip('chipP', !!f.P);
  setChip('chipZ', !!f.Z);
  setChip('chipV', calibrated);
  setHidden('chipS', !f.S);
  setHidden('chipH', !f.H);
  setHidden('chipG', !f.G);
  setHidden('chipY', !(f.Y || diag.phase === 'dumping'));
  $('chipHText').textContent = 'Hold, off ' + fmt(s ? s.off : NaN, 1) + ' µT';

  gearEl.className = 'gear';
  note.className = 'gear-note';
  setHidden('goCal', !(s && !calibrated && !transferActive()));

  if (!s) {
    gearEl.textContent = '--';
    gearEl.classList.add('dim');
    note.textContent = connected ? 'Waiting for data' : 'Not connected';
    $('watts').textContent = '--'; $('cad').textContent = '--'; $('res').textContent = '--';
    return;
  }
  $('watts').textContent = fin(s.watts) ? String(s.watts) : '--';
  $('cad').textContent = fmt(s.cad, 0);
  $('res').textContent = fmt(s.res, 0);
  // [v3] cadence source under the cadence
  var cs = $('cadSrc');
  setHidden('cadSrc', !s.src);
  cs.className = 'src' + (s.src && !s.pedalling ? ' off' : '');
  cs.textContent = !s.src ? '' : !s.pedalling ? 'not pedalling' : s.src === 'B' ? 'from crank magnet' : 'from Wahoo pod';

  var gearNow = rideGear();
  if (transferActive()) {
    gearEl.textContent = calibrated ? String(gearNow) : '--';
    gearEl.classList.add('dim');
    note.textContent = 'Sending diagnostics recording...';
    return;
  }
  if (!calibrated) {
    gearEl.textContent = '--';
    gearEl.classList.add('dim');
    note.textContent = s.cal !== 0 ? 'Calibration in progress' : 'Not calibrated — go to Setup';
    note.classList.add('warn');
    if (stale) note.textContent = 'Waiting for the bridge…';
    return;
  }
  gearEl.textContent = String(gearNow);
  if (s.flags.S) {
    note.textContent = 'Magnetometer saturated';
    note.classList.add('bad');
  } else if (s.src && !s.pedalling && s.cal === 0) {
    // [v3] gear comes from whole pedal turns, so it only updates while pedalling
    gearEl.classList.add('dim');
    note.textContent = 'Not pedalling — showing the last gear';
  } else if (s.flags.H) {
    gearEl.classList.add('hold');
    note.textContent = 'Holding last good gear (off ' + fmt(s.off, 1) + ' µT)';
    note.classList.add('warn');
  } else if (s.cal !== 0) {
    note.textContent = 'Calibration in progress';
  } else {
    note.textContent = '';
  }
  if (stale) { note.className = 'gear-note warn'; note.textContent = 'Waiting for the bridge…'; }
}
