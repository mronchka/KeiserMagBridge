// Drives the page's built-in v3.3 simulator (?demo=1&v3=1&fast=1&review=1&rest=1) through the whole
// calibration flow in node, on a virtual clock, and checks what the page shows at each step:
// breadcrumb, placement meters, sweep, pause, checkpoint, down-pass dots, guided redo, gear check.
// Usage: node bench/tests/app_harness/demo_v33_flow.js   (exit 1 on failure)
'use strict';
const { loadApp } = require('./harness');

let fail = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  (' + detail + ')' : ''));
  if (!ok) fail++;
}

(async function main() {
  const app = loadApp({ search: '?demo=1&v3=1&fast=1&review=1&rest=1&nstuck=1' });
  const M3 = app.M3, st = M3.state, $ = app.$;
  const crumb = () => ($('crumbs').hidden ? '' : $('crumbT').textContent);
  async function until(cond, maxSec, stepSec) {
    for (let t = 0; t < maxSec; t += stepSec || 0.25) { if (cond()) return true; await app.advance(stepSec || 0.25); }
    return cond();
  }

  M3.demoConnect();
  await app.advance(1.5);
  check('connected to the simulator, v3.3 detected', st.conn === 'connected' && st.v33, 'v33=' + st.v33);

  // Step 1: placement
  M3.openPlace();
  await app.advance(4);
  check('step 1 breadcrumb', /STEP 1 OF 6/.test(crumb()), crumb());
  check('placement meters fed by X lines', !!(st.place && st.place.x) && $('gNum').textContent !== '--', 'swing ' + $('gNum').textContent + ' µT, dip ' + $('mDipV').textContent + ', headroom ' + $('mHeadV').textContent);
  await app.advance(15);
  check('verdict says good spot', /spot/i.test($('placeVt').textContent), $('placeVt').textContent);

  // Step 2: start (as the Next button does)
  M3.state.place = null; M3.send('v', true); M3.send('c');
  await until(() => st.s && st.s.cal === 4, 30);
  check('step 2 (learn your pedalling) reaches the cadence check', st.s.cal === 4 && /STEP 2 OF 6/.test(crumb()), crumb());
  M3.send('n');
  await until(() => st.s.cal === 6 && st.s.step === 0, 5);
  check('noise turns (cal 6, step 0) shown as part of step 2', /STEP 2 OF 6/.test(crumb()) && /lever still/i.test(app.$('calSub').textContent), crumb() + ' / ' + app.$('calSub').textContent);
  await until(() => st.s.flow === 3, 20);
  check('step 3 sweep: up (pass su)', /STEP 3 OF 6/.test(crumb()) && st.s.pass === 'su' && /push the lever up/i.test($('calHead').textContent), st.s.pass + ' ' + $('calHead').textContent);
  M3.send('n');
  await app.advance(1);
  check('step 3 sweep: down (pass sd, no Next count needed)', st.s.pass === 'sd' && /back down/i.test($('calHead').textContent), st.s.pass + ' ' + $('calHead').textContent);
  M3.send('n');
  await until(() => st.s.flow === 4, 5);
  check('survey result (Z) read', !!st.survey && st.survey.verdict === 'ok', JSON.stringify(st.survey));
  check('step 4 breadcrumb', /STEP 4 OF 6/.test(crumb()), crumb());

  // Up pass, with pauses (&rest=1)
  let sawPause = false, pauseText = '', sawStopNote = false, stuckHint = '';
  await until(() => {
    if (!$('behindHint').hidden && /already shows gear/.test($('behindHint').textContent)) stuckHint = $('behindHint').textContent;
    if (st.s.flags.O) { sawPause = true; pauseText = $('calHead').textContent; }
    if (!$('stopNote').hidden) sawStopNote = true;
    return st.upSaved;
  }, 400);
  check('paused (flag O) shown calmly', sawPause && /Paused — pedal to continue/.test(pauseText) && !/amber/.test($('disc').className), pauseText);
  check('"you can stop any time" note on the gear steps', sawStopNote);
  check('N,stuck hint shown', /If the console already shows gear 5, ease back into gear 4 and come up to it again/.test(stuckHint), stuckHint);
  await app.advance(1);
  check('checkpoint after the up pass (cal 7): Saved card, breadcrumb step 4', st.upSaved && st.s.cal === 7 && !$('upSaved').hidden && $('calActive').hidden && /STEP 4 OF 6/.test(crumb()), 'cal ' + st.s.cal + ' ' + crumb());
  check('flagged gears wait during the checkpoint', $('reviewCard').hidden && !st.edit, 'review ' + (st.review ? st.review.items.length : 0));

  // Continue down (as the button does: board is idle after the save, so #D or n)
  M3.send('n');
  await until(() => st.s.flow === 5 && st.s.cal !== 0, 5);
  check('step 5 breadcrumb', /STEP 5 OF 6/.test(crumb()), crumb());
  await until(() => st.downPoints.length >= 3, 120);
  const dots = $('calDots').children.map((d) => d.className);
  const blue = st.downPoints.filter((q) => /\bdown\b|\bcur\b/.test(dots[q.point - 1] || '')).length;
  check('down-pass dots turn blue', blue === st.downPoints.length && blue >= 3, blue + ' of ' + st.downPoints.length);

  // Finish the down pass; the review list (u20, d23) then drives guided redos
  await until(() => st.s.cal === 0 && st.s.flow === 0, 400);
  await until(() => st.s.pass === 'ru' || st.s.pass === 'rd', 10);
  check('guided redo starts after the down pass', st.s.pass === 'ru' || st.s.pass === 'rd', 'pass ' + st.s.pass + ' step ' + st.s.step);
  // B (go back first): the circle shows the gear to go back into
  const sawGoTo = await until(() => $('discLbl').textContent === 'GO TO', 5, 0.1);
  check('during B the circle shows the gear to go back into', sawGoTo, $('discLbl').textContent + ' ' + $('discBig').textContent + ' / ' + $('calHead').textContent);
  const sawGreen = await until(() => /green/.test($('disc').className) && !$('discNum').hidden, 8, 0.1);
  check('when B clears it turns green on that gear', sawGreen, $('discBig').textContent);
  await until(() => !st.review && st.s.cal === 0, 120);
  await until(() => st.check && st.check.phase === 'run', 10);
  check('step 6 (gear check) starts after the fixes', !!st.check && st.check.phase === 'run' && /STEP 6 OF 6/.test(crumb()), crumb());

  // E2: the board starts calibrating again during step 6 (#D): the breadcrumb follows the board
  M3.sendCmd('#D');
  await until(() => st.s.cal !== 0, 5);
  await app.advance(0.5);
  check('#D during the gear check: breadcrumb follows the board (step 5)', st.s.flow === 5 && /STEP 5 OF 6/.test(crumb()), 'board ' + st.s.flow + ', page ' + crumb());
  check('no page errors', app.errors.length === 0, app.errors.map(String).join('; '));
  process.exit(fail ? 1 : 0);
})();
