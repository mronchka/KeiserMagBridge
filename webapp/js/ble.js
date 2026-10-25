// M3 Bridge phone page: Bluetooth link: command writes (one character each, # commands in <=20-byte pieces), connect,
// reconnect, the connection UI and the screen wake lock.
// Classic script sharing the page's global scope; index.html loads the files in order (see its loader).
'use strict';

// ===================================================================
// Command writes: one char per write (# commands in 20-byte pieces), serialized through a promise queue
// ===================================================================
var writeChain = Promise.resolve();
// Bumped on every connect and drop: writes queued on an earlier link are dropped, not sent on the next one.
var linkGen = 0;
var enc = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;

function send(str, quiet) {
  if (state.conn !== 'connected') { toast('Not connected'); return; }
  var chars = String(str).split(''), gen = linkGen;
  chars.forEach(function (c) {
    var code = c.charCodeAt(0);
    if (code < 32 || code > 126) return;
    if (!quiet) logLine('> ' + c, 'sent');
    if (c === 't') state.tShown = 0;   // T-line logging cap restarts each time Turns is toggled
    writeChain = writeChain
      .then(function () { return gen === linkGen ? writeChar(c) : null; })
      .catch(function (err) {
        logLine('Write failed (' + c + '): ' + (err && err.message ? err.message : err), 'bad');
      });
  });
  return writeChain;
}

// [v3.2] Multi-character command (e.g. "#R,u,20"): ends with \n and goes out in <=20-byte
// writes, in order, each awaited, through the same queue as single characters. If a piece
// fails the rest is dropped and a lone \n is sent so the board discards the partial line.
function sendCmd(str) {
  if (state.conn !== 'connected') { toast('Not connected'); return null; }
  var text = String(str).replace(/[\r\n]+/g, '') + '\n';
  logLine('> ' + text.slice(0, -1), 'sent');
  var pieces = [];
  for (var i = 0; i < text.length; i += 20) pieces.push(text.slice(i, i + 20));   // commands are ASCII: 1 char = 1 byte
  var failed = false, gen = linkGen;
  pieces.forEach(function (piece) {
    writeChain = writeChain
      .then(function () { return failed || gen !== linkGen ? null : writeChar(piece); })
      .catch(function (err) {
        failed = true;
        logLine('Write failed (' + text.slice(0, -1) + '): ' + (err && err.message ? err.message : err), 'bad');
        return writeChar('\n').catch(function () {});
      });
  });
  return writeChain;
}

// Write one character, or one <=20-byte piece of a # command.
function writeChar(c) {
  if (DEMO) { sim.receive(c); return Promise.resolve(); }
  if (typeof window.__m3Write === 'function') { window.__m3Write(c); return Promise.resolve(); }   // test harness
  if (!rxChar) return Promise.reject(new Error('not connected'));
  var data = enc ? enc.encode(c) : new Uint8Array(String(c).split('').map(function (ch) { return ch.charCodeAt(0) & 255; }));
  var props = rxChar.properties || {};
  if (typeof rxChar.writeValueWithoutResponse === 'function' && props.writeWithoutResponse !== false) {
    return rxChar.writeValueWithoutResponse(data);
  }
  if (typeof rxChar.writeValueWithResponse === 'function' && props.write) {
    return rxChar.writeValueWithResponse(data);
  }
  return rxChar.writeValue(data);
}

// ===================================================================
// Bluetooth transport
// ===================================================================
var device = null, rxChar = null, txChar = null, userDisconnect = false;
var CONNECT_TIMEOUT_MS = 20000;   // gatt.connect() never gives up by itself on iOS
var connectAttempt = 0;

function errText(e) {
  if (!e) return 'Unknown error';
  if (e.name === 'NotFoundError') return 'No bridge selected.';
  if (e.name === 'SecurityError') return 'Bluetooth was blocked. The page must be opened over https or from a local file, and Bluetooth permission must be allowed.';
  if (e.name === 'NetworkError') return 'Could not reach the bridge. Make sure it is powered and in range, then try again.';
  return e.message || String(e);
}

function connectClick() {
  if (DEMO) { demoConnect(); return; }
  if (!navigator.bluetooth) { setConn('unsupported'); return; }
  if (device && state.conn === 'disconnected') { reconnect(); return; }
  setConn('connecting', 'Choose "' + NAME_PREFIX + '" in the list.');
  // requestDevice must be the first await inside the user gesture.
  navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: NAME_PREFIX }],
    optionalServices: [NUS_SERVICE]
  }).then(function (dev) {
    if (device && device !== dev) {
      try { device.removeEventListener('gattserverdisconnected', onGattDisconnected); } catch (e) {}
    }
    device = dev;
    device.removeEventListener('gattserverdisconnected', onGattDisconnected);
    device.addEventListener('gattserverdisconnected', onGattDisconnected);
    return openGatt();
  }).catch(function (e) {
    setConn(device ? 'disconnected' : 'idle', errText(e), e && e.name !== 'NotFoundError');
  });
}

function openGatt() {
  setConn('connecting', 'Connecting to ' + (device.name || 'bridge') + '...');
  var attempt = ++connectAttempt, timer = 0;
  function current() { if (attempt !== connectAttempt) throw new Error('superseded'); }
  var timeout = new Promise(function (resolve, reject) {
    timer = setTimeout(function () {
      reject(new Error('No answer from the bridge. Make sure it is powered and in range, then try again.'));
    }, CONNECT_TIMEOUT_MS);
  });
  var dev = device;
  var link = device.gatt.connect().then(function (server) {
    current();
    return server.getPrimaryService(NUS_SERVICE);
  }).then(function (svc) {
    current();
    return Promise.all([svc.getCharacteristic(NUS_RX), svc.getCharacteristic(NUS_TX)]);
  }).then(function (chars) {
    current();
    rxChar = chars[0];
    if (txChar) { try { txChar.removeEventListener('characteristicvaluechanged', onNotify); } catch (e) {} }
    txChar = chars[1];
    resetRx();
    txChar.addEventListener('characteristicvaluechanged', onNotify);
    return txChar.startNotifications();
  });
  // A connect that answers after it was given up (and no newer attempt runs): close that link again.
  link.catch(function () {
    if (connectAttempt === attempt + 1 && state.conn !== 'connected' && state.conn !== 'connecting') {
      try { if (dev.gatt.connected) dev.gatt.disconnect(); } catch (x) {}
    }
  });
  return Promise.race([link, timeout]).then(function () {
    clearTimeout(timer);
    current();
    linkGen++;
    writeChain = Promise.resolve();
    setConn('connected');
    send('1', true); // status stream on
  }).catch(function (e) {
    clearTimeout(timer);
    if (attempt === connectAttempt) connectAttempt++;   // a late answer to this attempt is ignored
    try { if (dev.gatt) dev.gatt.disconnect(); } catch (x) {}   // also aborts a connect still pending
    rxChar = null;
    throw e;
  });
}

function reconnect() {
  if (DEMO) { demoConnect(); return; }
  if (!device) { connectClick(); return; }
  openGatt().catch(function (e) {
    // The next tap opens the chooser again (another bridge, or this one after it restarted).
    try { device.removeEventListener('gattserverdisconnected', onGattDisconnected); } catch (x) {}
    device = null;
    setConn('disconnected', 'Reconnect failed: ' + errText(e), true);
  });
}

function onGattDisconnected() {
  rxChar = null;
  linkGen++;
  var msg = userDisconnect ? 'Disconnected.' : 'Connection lost. Tap Reconnect.';
  userDisconnect = false;
  if (state.conn !== 'connecting') setConn('disconnected', msg, false);
}

function disconnect() {
  userDisconnect = true;
  if (DEMO) { sim.disconnect(); onGattDisconnected(); return; }
  try { if (device && device.gatt && device.gatt.connected) device.gatt.disconnect(); else onGattDisconnected(); } catch (e) { onGattDisconnected(); }
}

// ===================================================================
// Connection UI
// ===================================================================
function setConn(c, msg, isErr) {
  var was = state.conn, hadS = !!state.s;   // (state.s is cleared below when the link drops)
  state.conn = c;
  var dot = $('connDot'), txt = $('connText'), card = $('connCard'), btn = $('connectBtn'), cm = $('connMsg'), hb = $('hdrBtn');
  dot.className = 'dot';
  hb.hidden = true;
  btn.disabled = false;
  cm.className = isErr ? 'err' : 'muted';
  setHidden('demoHint', true);
  var label = DEMO ? ' (demo)' : '';
  switch (c) {
    case 'idle':
      txt.textContent = 'Not connected' + label;
      card.classList.add('show');
      btn.textContent = DEMO ? 'Connect to simulator' : 'Connect';
      cm.textContent = msg || (DEMO ? 'Demo mode: a built-in simulator stands in for the bridge.' : 'Connect to your Keiser M3 Bridge to begin.');
      break;
    case 'connecting':
      dot.classList.add('busy');
      txt.textContent = 'Connecting' + label;
      card.classList.add('show');
      btn.textContent = 'Connecting...';
      btn.disabled = true;
      cm.textContent = msg || 'Connecting...';
      break;
    case 'connected':
      state.placeCheck = true;   // [v3.3] see onFlowStatus
      dot.classList.add('on');
      txt.textContent = DEMO ? 'Simulator' : 'Connected';
      card.classList.remove('show');
      hb.hidden = false;
      keepAwake(true);
      logLine(DEMO ? 'Connected to simulator.' : 'Connected.', 'sys');
      break;
    case 'disconnected':
      dot.classList.add('off');
      txt.textContent = 'Disconnected' + label;
      card.classList.add('show');
      btn.textContent = 'Reconnect';
      cm.textContent = msg || 'Disconnected.';
      // A calibration in progress: keep its points as an incomplete record (once).
      // Not after it was saved (the v3.3 checkpoint, the down pass, a redo): calEnded is set then.
      if (state.s && state.s.cal !== 0 && !state.calEnded) savePartialCal('connection lost');
      // Until the first status line after reconnecting, C / E / K lines still belong to the run
      // that was going on (a redo's C and K can come before any S line).
      // (only with a status line on this link: a second drop before one keeps the first drop's)
      if (was === 'connected' && hadS) { state.dropS = state.s; state.dropV = { v32: state.v32, v33: state.v33 }; }
      state.s = null;
      state.v3 = false;          // re-detected from the next S lines
      state.v31 = false;
      state.v32 = false;
      state.v33 = false; state.newerLines = 0; state.bWas = null;
      state.v34 = false; state.captureMode = ''; state.pressSentAt = 0; state.pressRefused = null;   // [v3.4] asked again (#V)
      state.rereadTries = 0; state.qReread = false; clearTimeout(state.rereadT);
      state.v35 = false;
      // [v3.3] the board keeps its placement stream across a drop ('v' toggles it): the first
      // status line after reconnecting decides (onFlowStatus)
      if (was === 'connected' && hadS) state.placeWas = !!state.place;
      state.place = null;
      state.calSeen = false; state.uncalSince = 0;
      state.behind = null; state.fList = null; state.overshoot = null; state.stallSince = 0;
      clearTimeout(state.fTimer);           // (a readback still wanted is asked for again after reconnecting)
      state.checkpointAnswered = 0;         // an answer that may not have gone out: ask again
      state.downResumePending = false; state.dPending = 0;
      // #12 / #22: the gear list is read again on the next link (another bridge, or one recalibrated meanwhile)
      state.homeAsked = false; state.homeRead = false; state.homeTries = 0; state.qQuiet = false; state.qQuietF = false;
      if (state.qFromEdit && state.q) state.wantReadback = true;
      state.fixAfter = ''; state.qFromEdit = false; state.qJustEnded = false;
      // a redo the bridge already started carries on (its E / K may come after reconnecting); any other edit is dropped
      if (state.edit) { clearTimeout(state.edit.timer); if (!state.edit.started) state.edit = null; }
      state.lastTurn = null;
      renderTurnInfo();
      keepAwake(false);
      logLine(msg || 'Disconnected.', 'sys');
      diagOnDisconnect();
      if (state.q) { clearTimeout(state.q.timer); state.q = null; }
      break;
    case 'unsupported':
      txt.textContent = 'Bluetooth unavailable';
      card.classList.add('show');
      btn.textContent = 'Connect';
      btn.disabled = true;
      cm.className = 'err';
      cm.textContent = 'This browser has no Web Bluetooth. Open this page in Bluefy on iPhone, or Chrome on Android/desktop.';
      setHidden('demoHint', false);
      break;
  }
  render();
  renderDiag();
}

// ===================================================================
// Screen wake lock
// ===================================================================
var wakeLock = null, wakePending = false;
function keepAwake(on) {
  if (!('wakeLock' in navigator)) return;
  try {
    if (on && !wakeLock && !wakePending) {
      wakePending = true;
      navigator.wakeLock.request('screen').then(function (wl) {
        wakePending = false;
        // dropped while the request was pending: nothing to keep awake for
        if (state.conn !== 'connected') { wl.release().catch(function () {}); return; }
        wakeLock = wl;
        wl.addEventListener('release', function () { if (wakeLock === wl) wakeLock = null; });
      }).catch(function () { wakePending = false; });
    } else if (!on && wakeLock) {
      var w = wakeLock; wakeLock = null;
      w.release().catch(function () {});
    }
  } catch (e) {}
}
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible' && state.conn === 'connected') keepAwake(true);
  if (document.visibilityState === 'visible') checkPageVersion();   // [v3.3] a tab left open keeps old code
});
