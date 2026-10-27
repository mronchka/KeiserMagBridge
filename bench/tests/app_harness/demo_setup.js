// Setup (2026-10-27 design A) with the simulator: the welcome and the plan, Start part 1, the intro card
// before part 2, "Ready to ride" at the checkpoint, the returning rider's hub, and the gear sheet (the
// ruler) with Redo / Use best guess / Check on a ride.
// Usage: node bench/tests/app_harness/demo_setup.js   (exit 1 on failure)
'use strict';
const { loadApp } = require('./harness');

let fail = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  (' + detail + ')' : ''));
  if (!ok) fail++;
}

(async function main() {
  // ---------------------------------------------------------------- first run
  {
    const app = loadApp({ search: '?demo=1&fast=1&uncal=1' });
    const M3 = app.M3, st = M3.state, $ = app.$;
    const until = async (cond, maxSec, step) => { for (let t = 0; t < maxSec; t += step || 0.25) { if (cond()) return true; await app.advance(step || 0.25); } return cond(); };
    M3.demoConnect();
    await until(() => st.captureMode === 'press', 6);
    app.win.showView('cal'); M3.render();
    check('Setup, first run: the welcome', !$('setupIntro').hidden && !$('suWelcome').hidden && $('suPlan').hidden && $('onb').hidden);
    $('suGo').click();
    check('Get started: the plan, three parts, part 3 recommended', !$('suPlan').hidden && $('suWelcome').hidden && !$('suPart3').hidden &&
      /One tap at each/.test($('suUpText').textContent), $('suUpText').textContent);
    $('suBack').click();
    check('...Back: the welcome again', !$('suWelcome').hidden);
    $('suGo').click();
    $('suStart').click();
    await app.advance(1);
    check('Start part 1: the bridge\'s spot (part 1 of 3)', !!st.place && /PART 1 OF 3/.test($('crumbT').textContent), $('crumbT').textContent);
    M3.state.place = null; M3.send('v', true); M3.send('c');
    await until(() => st.s && st.s.cal === 4, 30);
    M3.send('n');
    await until(() => st.s.flow === 3, 20);
    M3.send('n'); await app.advance(1); M3.send('n');
    await until(() => st.s.flow === 4 && st.s.cal === 1, 5);
    await app.advance(0.5);
    check('before gear 1: the part 2 intro card, nothing else on the step screen', !$('chapterCard').hidden && $('calActive').classList.contains('chapter') &&
      /PART 2 OF 3/.test($('crumbT').textContent), $('crumbT').textContent);
    $('chapterGo').click();
    check('Start at gear 1: the circle', $('chapterCard').hidden && !$('calActive').classList.contains('chapter'));
    check('no page errors (first run)', app.errors.length === 0, JSON.stringify(app.errors).slice(0, 300));
  }

  // ---------------------------------------------------------------- the hub and the gear sheet
  {
    const app = loadApp({ search: '?demo=1&fast=1&review=1' });
    const M3 = app.M3, st = M3.state, $ = app.$;
    const until = async (cond, maxSec, step) => { for (let t = 0; t < maxSec; t += step || 0.25) { if (cond()) return true; await app.advance(step || 0.25); } return cond(); };
    const sent = () => [...$('log').childNodes].map((n) => n.textContent).filter((t) => /> /.test(t)).map((t) => t.replace(/^.*?> /, ''));
    M3.demoConnect();
    await until(() => st.v35, 6);
    app.win.showView('cal'); M3.render();
    await until(() => !$('gearList').hidden && st.homeRead, 15);
    check('returning: Setup\'s hub with a status, the gears and "Make it better"', $('glTitle').textContent === 'Setup' && !$('glStatus').hidden &&
      /Tuned|Ready to ride|Dialled in/.test($('glStatus').textContent) && /Redo gears? 20/.test($('glMore').textContent) && /Start over/.test($('glMore').textContent),
      $('glStatus').textContent + ' / ' + $('glMore').textContent);
    // tap gear 20 (flagged by the simulated check, with a best guess)
    app.win.openGearSheet(20);
    check('a tapped gear opens its sheet: title, colour, a verdict', !$('gearSheet').hidden && $('gsTitle').textContent === 'Gear 20' &&
      $('gsPill').textContent === 'Needs another look' && $('gsVerdict').textContent.length > 20, $('gsVerdict').textContent);
    check('...the ruler draws the gear among its neighbours (and the best guess)', /rz/.test($('rulerViz').innerHTML) && />20</.test($('rulerViz').innerHTML) &&
      /best guess/.test($('rulerViz').innerHTML));
    check('...Redo gear 20, Use best guess, Check on a ride', !$('gsRedo').hidden && $('gsRedo').textContent === 'Redo gear 20' && !$('gsGuess').hidden && !$('gsCheck').hidden);
    $('gsGuess').click();
    await until(() => sent().some((c) => /^#G,u,20/.test(c)), 5, 0.1);
    check('Use best guess sends #G for that point', sent().some((c) => /^#G,u,20/.test(c)), JSON.stringify(sent().slice(-3)));
    await until(() => !!st.gearList, 10, 0.1);
    check('...and comes back to the hub ("best guess in use") with its sheet', !st.gearList && /Gear 20: the bridge’s best guess is in use/.test($('glLead').textContent) && st.sheetGear === 20,
      $('glLead').textContent);
    check('a gear on the best guess stays "unsure", with Check on a ride first', app.win.gearQuality()[20].level === 1 &&
      /best guess, not a measurement/.test($('gsVerdict').textContent) && /primary/.test($('gsCheck').className), $('gsVerdict').textContent);
    // a good gear: Redo is there but not the main button; no best guess
    app.win.openGearSheet(10);
    check('a good gear: "Looks right", Redo (secondary), no best guess', /Looks right/.test($('gsVerdict').textContent) && $('gsGuess').hidden && /secondary/.test($('gsRedo').className),
      $('gsVerdict').textContent);
    $('gsCheck').click();
    await app.advance(0.5);
    check('Check on a ride: a gear check of just that gear', !!st.check && st.check.phase === 'run' && st.check.list.length === 2 && st.check.list.every((c) => c.gear === 10) && $('gearSheet').hidden,
      JSON.stringify(st.check && st.check.list.map((c) => c.gear)));
    check('...titled "Check gear 10"', $('crumbT').textContent === 'Check gear 10', $('crumbT').textContent);
    st.check.activeMs = 1e9;
    await until(() => st.s && st.s.gear === 10, 30, 0.25);   // (the simulated rider shifts there)
    await app.advance(2);
    while (st.check && st.check.phase === 'run') M3.checkAnswer(10);   // (the console agrees with the bridge)
    check('...its summary: "Gear 10 matches"', $('rckDoneTitle').textContent === 'Gear 10 matches', $('rckDoneTitle').textContent);
    $('rckClose').click();
    check('...and Done ends on the hub with a line on it', !st.gearList && !st.check && /Gear 10 matches the console/.test($('glLead').textContent), $('glLead').textContent);
    check('no page errors (hub)', app.errors.length === 0, JSON.stringify(app.errors).slice(0, 300));
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL crashed: ' + (e && e.stack || e)); process.exit(1); });
