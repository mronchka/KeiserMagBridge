// Drives the page's simulator as a v3.5 bridge (?demo=1&fast=1&review=1, calibrated): a whole gear
// redone by taps (#R,g): down into the gear below, tap; up to where it first shows, tap; up into the
// gear above, tap; back down to where it first shows, tap. Checks the circle at each stage, a tap
// too early, the points kept until the bridge saves, one stage back (u), a cancel (x), gear 1's two
// stages, Improve and the gear check using #R,g, and #H following the Console tab.
// Usage: node bench/tests/app_harness/demo_v35_gear.js   (exit 1 on failure)
'use strict';
const { loadApp } = require('./harness');

let fail = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  (' + detail + ')' : ''));
  if (!ok) fail++;
}

(async function main() {
  const app = loadApp({ search: '?demo=1&fast=1&review=1' });
  const M3 = app.M3, st = M3.state, $ = app.$;
  // (to the simulator the page's commands show in the Console log as '> cmd')
  const cmds = () => [...$('log').childNodes].map((n) => n.textContent).filter((t) => /> /.test(t)).map((t) => t.replace(/^.*?> /, ''));
  const redos = () => cmds().filter((c) => /^#R/.test(c));
  async function until(cond, maxSec, stepSec) {
    for (let t = 0; t < maxSec; t += stepSec || 0.25) { if (cond()) return true; await app.advance(stepSec || 0.25); }
    return cond();
  }
  const pass = () => (st.s ? st.s.pass : '');
  const head = () => $('calHead').textContent;
  const pt = (n) => st.points.find((q) => q.point === n);
  const dpt = (n) => st.downPoints.find((q) => q.point === n);
  async function tapWhenReady() {   // wait for the simulated rider to reach the gear, then tap
    await app.advance(2.5);
    await until(() => st.discTap, 3, 0.1);
    $('disc').click();
  }
  async function stage(p) { return until(() => pass() === p, 15, 0.1); }

  M3.demoConnect();
  await until(() => st.v35 && st.captureMode, 6);
  check('a v3.5 bridge: the page turns its text off (#H,0)', st.v35 && cmds().includes('#H,0'), JSON.stringify(cmds()));
  M3.render(); app.win.showView('console');
  check('...on while the Console tab is open (#H,1)', cmds()[cmds().length - 1] === '#H,1');
  app.win.showView('cal'); M3.render();
  check('...and off again when it closes', cmds()[cmds().length - 1] === '#H,0');
  await until(() => !$('gearList').hidden && st.homeRead, 15);
  check('Setup opens on its hub', !$('gearList').hidden && $('glTitle').textContent === 'Setup', $('glTitle').textContent);

  // gear 10, picked on the list
  const up10 = JSON.stringify(pt(10));
  st.homeSel = 10; app.win.renderGearList();
  check('a tapped gear: "Redo gear 10"', $('glImprove').textContent === 'Redo gear 10');
  $('glImprove').click();
  await stage('g1');
  check('#R,g,10 is sent, the bridge starts at stage 1', redos().join(' ') === '#R,g,10' && pass() === 'g1', redos().join(' '));
  await app.advance(0.3);
  check('stage 1: "Down into gear 9", DOWN TO 9, step 1 of 4, "Redo gear 10" on top',
    head() === 'Down into gear 9' && $('discLbl').textContent === 'DOWN TO' && $('discBig').textContent === '9' &&
    $('calCount').textContent === 'Redo gear 10 · step 1 of 4' && $('crumbT').textContent === 'Redo gear 10',
    [head(), $('discLbl').textContent, $('discBig').textContent, $('calCount').textContent, $('crumbT').textContent].join(' / '));
  check('...the circle is a button ("Tap when there"), no explanation box', st.discTap && $('discTurns').textContent === 'Tap when there' && $('redoBanner').hidden);

  // a tap before the rider got there: refused, the note says so
  await until(() => st.discTap, 3, 0.05);
  $('disc').click();
  await until(() => !!st.pressRefused, 10, 0.1);
  check('a tap too early: "Not in gear 9 yet"', /Not in gear 9 yet/.test($('behindHint').textContent) && pass() === 'g1', $('behindHint').textContent);
  await tapWhenReady();
  await stage('g2');
  check('stage 2: "Up to gear 10", UP TO 10, step 2 of 4', head() === 'Got it' || head() === 'Up to gear 10', head());
  await app.advance(1.5);
  check('...then "Up to gear 10", step 2 of 4', head() === 'Up to gear 10' && $('calCount').textContent === 'Redo gear 10 · step 2 of 4', head() + ' / ' + $('calCount').textContent);
  await tapWhenReady();
  await stage('g3');
  check('stage 2 measured (C,10), but the page keeps the old point until the bridge saves', JSON.stringify(pt(10)) === up10 && !!(st.gearPending && st.gearPending.u),
    JSON.stringify(st.gearPending));
  await app.advance(1.5);
  check('stage 3: "Up into gear 11", UP TO 11', head() === 'Up into gear 11' && $('discBig').textContent === '11', head());
  await tapWhenReady();
  await stage('g4');
  await app.advance(1.5);
  check('stage 4: "Back down to gear 10", BACK TO 10, step 4 of 4', head() === 'Back down to gear 10' && $('discLbl').textContent === 'BACK TO' &&
    $('calCount').textContent === 'Redo gear 10 · step 4 of 4', head() + ' / ' + $('calCount').textContent);
  const pendU = JSON.stringify(st.gearPending && st.gearPending.u);
  await tapWhenReady();
  await until(() => !!st.gearList, 15, 0.1);
  check('saved: the measured points go into the page\'s copy, back on the list "Gear 10 redone"',
    !st.gearPending && JSON.stringify(pt(10)) === pendU && !!dpt(11) && /^Gear 10 redone\./.test($('glLead').textContent),
    $('glLead').textContent);
  check('...one #R,g for the whole gear', redos().join(' ') === '#R,g,10', redos().join(' '));

  // one stage back, then cancel: nothing changes
  const up12 = JSON.stringify(pt(12));
  st.gearList.sel = 12; app.win.renderGearList();
  $('glImprove').click();
  await stage('g1');
  await tapWhenReady(); await stage('g2');
  await tapWhenReady(); await stage('g3');
  M3.send('u');
  await stage('g2');
  check('u between stages: back to stage 2, the points unchanged', pass() === 'g2' && JSON.stringify(pt(12)) === up12 && !(st.gearPending && st.gearPending.u),
    pass() + ' ' + JSON.stringify(st.gearPending));
  M3.send('x');
  await until(() => st.s.cal === 0 && !st.edit, 8, 0.1);
  await app.advance(1);
  check('x: cancelled, the stored point unchanged on the phone', JSON.stringify(pt(12)) === up12 && !st.gearPending, JSON.stringify(pt(12)));

  // gear 1: only the down edge (stages 3-4)
  app.win.openGearList(); st.gearList.sel = 1; app.win.renderGearList();
  $('glImprove').click();
  await stage('g3');
  check('gear 1: starts at stage 3, "step 1 of 2"', $('calCount').textContent === 'Redo gear 1 · step 1 of 2' && head() === 'Up into gear 2',
    $('calCount').textContent + ' / ' + head());
  M3.send('x');
  await until(() => st.s.cal === 0 && !st.edit, 8, 0.1);
  await app.advance(1);

  // Improve: red gears by #R,g (the review flags up point 20 and down point 23, i.e. gears 20 and 22)
  app.win.openGearList(); st.gearList.sel = 0; app.win.renderGearList();
  const n0 = redos().length;
  $('glImprove').click();
  await until(() => redos().length > n0, 5, 0.1);
  check('Improve redoes a flagged gear by #R,g', /^#R,g,(20|22)$/.test(redos()[n0] || ''), redos().slice(n0).join(' '));
  check('no page errors', app.errors.length === 0, JSON.stringify(app.errors).slice(0, 300));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL crashed: ' + (e && e.stack || e)); process.exit(1); });
