// Drives the page's simulator as a v3.4 bridge in press mode (?demo=1&fast=1): the page asks the
// firmware version (#V), turns press to capture on (#A,press), and the rider taps the circle at each
// gear. Checks the circle's wording, a tap too early (N,notmoved, then a second tap), Undo tap,
// nothing saving by itself, the switch back to auto, and a v3.3 bridge (#V refused quietly).
// Usage: node bench/tests/app_harness/demo_v34_press.js   (exit 1 on failure)
'use strict';
const { loadApp } = require('./harness');

let fail = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  (' + detail + ')' : ''));
  if (!ok) fail++;
}

(async function main() {
  const app = loadApp({ search: '?demo=1&fast=1' });
  const M3 = app.M3, st = M3.state, $ = app.$;
  // (to the simulator the page's commands show in the Console log as '> cmd')
  const sentOf = (a) => [...a.$('log').childNodes].map((n) => n.textContent).filter((t) => /> /.test(t)).map((t) => t.replace(/^.*?> /, ''));
  const cmds = () => sentOf(app);
  async function until(cond, maxSec, stepSec) {
    for (let t = 0; t < maxSec; t += stepSec || 0.25) { if (cond()) return true; await app.advance(stepSec || 0.25); }
    return cond();
  }
  const head = () => $('calHead').textContent, sub = () => $('calSub').textContent;

  M3.demoConnect();
  await until(() => st.captureMode === 'press', 5);
  check('the page asks the firmware version and turns press to capture on', st.v34 && cmds().includes('#V') && cmds().includes('#A,press') &&
    st.captureMode === 'press', JSON.stringify(cmds()));
  await until(() => st.s && st.s.flags.T, 3);
  check('the bridge says press mode (flag T, no A)', !!st.s.flags.T && !st.s.flags.A, st.s.flagStr);
  check('More options: the switch is "Save each gear by itself (no tap)", off', $('autoToggleT').textContent === 'Save each gear by itself (no tap)' &&
    $('autoToggle').getAttribute('aria-checked') === 'false', $('autoToggleT').textContent);

  // steps 1-3 as the buttons do
  M3.openPlace(); await app.advance(2);
  M3.state.place = null; M3.send('v', true); M3.send('c');
  await until(() => st.s.cal === 4, 30);
  M3.send('n');
  await until(() => st.s.flow === 3, 20);
  M3.send('n'); await app.advance(1); M3.send('n');
  await until(() => st.s.flow === 4 && st.s.cal === 1, 5);
  await app.advance(3);

  // the bottom: nothing saves by itself; the circle is the button
  check('up pass, press mode: "Tap to save" in the circle, the circle is a button, no CAPTURE button',
    st.discTap && /press/.test($('disc').className) && $('discTurns').textContent === 'Tap to save' && !$('discTurns').hidden &&
    $('disc').getAttribute('role') === 'button' && $('btnCapture').hidden, $('disc').className + ' / ' + $('discTurns').textContent);
  check('...and it says to tap', /tap the circle/i.test(sub()), head() + ' / ' + sub());
  await app.advance(6);
  check('nothing is saved by itself (still at the bottom after 6 s)', st.points.length === 0 && st.s.step === 0, 'points ' + st.points.length);

  // a tap: Measuring…, then Got it
  $('disc').click();
  check('a tap shows "Measuring…" at once', head() === 'Measuring…' && /blue/.test($('disc').className), head());
  check('...and sends n', cmds()[cmds().length - 1] === 'n');
  await until(() => st.s.flags.I, 3, 0.1);
  check('the bridge measures (flag I)', !!st.s.flags.I);
  await until(() => st.points.length === 1, 10, 0.1);
  check('...and saves the bottom (C,1)', st.points.length === 1);

  // a tap too early (still at gear 1): N,notmoved, the note, a second tap saves it anyway
  await until(() => st.s.step === 1, 5, 0.1);
  await app.advance(0.2);   // (a tap during "Got it", while the rider is still moving to gear 2)
  $('disc').click();
  await until(() => !!st.pressRefused, 10, 0.1);
  check('a tap at the previous gear: the bridge refuses (N,notmoved) and the note says why',
    !!st.pressRefused && !$('behindHint').hidden && /where gear 1 was saved/.test($('behindHint').textContent), $('behindHint').textContent);
  check('...without a toast', !app.win.document.getElementById('toast') || !/Not saved/.test($('toast').textContent));
  await app.advance(1);
  $('disc').click();
  await until(() => st.points.length === 2, 10, 0.1);
  check('...and a second tap saves it anyway', st.points.length === 2 && $('behindHint').hidden);

  // Undo tap while measuring: the point isn't saved, and isn't undone
  await until(() => st.s.step === 2, 5, 0.1);
  await app.advance(2.5);
  $('disc').click();
  await until(() => st.s.flags.I, 3, 0.1);
  check('measuring: Undo reads "UNDO TAP"', $('btnUndo').textContent === 'UNDO TAP' && !$('btnUndo').disabled, $('btnUndo').textContent);
  $('btnUndo').click();
  await app.advance(1);
  check('...a tap on it cancels the measurement, the saved points stay', !st.s.flags.I && st.points.length === 2 && st.s.step === 2,
    'I ' + !!st.s.flags.I + ' points ' + st.points.length + ' step ' + st.s.step);

  // the rest of the up pass, one tap per gear
  for (let i = 0; i < 30 && st.s.cal !== 7; i++) {
    const n0 = st.points.length;
    await app.advance(2.5);
    if (st.discTap) $('disc').click();
    await until(() => st.points.length > n0 || st.s.cal === 7, 10, 0.1);
  }
  check('the whole up pass by taps, to the checkpoint', st.s.cal === 7 && st.points.length === 25, 'cal ' + st.s.cal + ' points ' + st.points.length);

  // down pass: taps too
  $('upContinue').click();
  await until(() => st.s.flow === 5 && st.s.cal === 1, 5);
  await app.advance(2.5);
  check('down pass, press mode: the circle is a button', st.discTap && /tap the circle/i.test(sub()), sub());
  for (let i = 0; i < 3; i++) {
    const n0 = st.downPoints.length;
    $('disc').click();
    await until(() => st.downPoints.length > n0, 10, 0.1);
    await app.advance(2.5);
  }
  check('three down points by taps', st.downPoints.length === 3, String(st.downPoints.length));

  // waiting long without a tap: the note asks for it
  await app.advance(12);
  check('no tap for a while: no extra note (the line under the circle says to tap)', $('behindHint').hidden && /tap the circle/i.test($('calSub').textContent), $('calSub').textContent);

  // back to auto from More options: kept on this phone, sent to the bridge, the next gear saves by itself
  $('autoToggle').click();
  await until(() => st.captureMode === 'auto', 3);
  check('the switch: #A,auto, kept on this phone', cmds().includes('#A,auto') && app.store['m3bridge.capture'] === 'auto');
  const d0 = st.downPoints.length;
  await until(() => st.downPoints.length > d0, 15, 0.1);
  check('...and the next gear saves by itself', st.downPoints.length > d0 && !st.s.flags.T && !st.discTap, String(st.downPoints.length));
  check('no page errors', app.errors.length === 0, JSON.stringify(app.errors).slice(0, 300));

  // a v3.3 bridge: #V is refused quietly; the page works as before
  const old = loadApp({ search: '?demo=1&fast=1&v33=1' });
  old.M3.demoConnect();
  await old.advance(3);
  const os = old.M3.state, oc = sentOf(old);
  check('a v3.3 bridge: #V asked, refused quietly (no press mode, no "Not changed" toast)', oc.includes('#V') && !os.v34 && !oc.includes('#A,press') &&
    !/Not changed/.test(old.$('toast') ? old.$('toast').textContent : ''), JSON.stringify(oc));
  check('...auto-capture as before (flag A, no T)', !!os.s.flags.A && !os.s.flags.T, os.s.flagStr);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL crashed: ' + (e && e.stack || e)); process.exit(1); });
