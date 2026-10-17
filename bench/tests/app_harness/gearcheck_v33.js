// Step 6 (gear check) in Bluetooth mode: the page asks "Does the console show gear N?" only once
// the bridge's gear is about the wanted one and steady; the 'faster' check waits for the pace;
// a bridge that never reads near the wanted gear is asked anyway after 20 s.
// Usage: node bench/tests/app_harness/gearcheck_v33.js [--page path]   (exit 1 on failure)
'use strict';
const { loadApp } = require('./harness');

const args = process.argv.slice(2);
const pageAt = args.indexOf('--page');
const page = pageAt >= 0 ? args.splice(pageAt, 2)[1] : undefined;

let fail = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) fail++;
}

(async function main() {
  const app = loadApp({ search: '', page });
  app.connect();
  const $ = app.$;
  let t = 1;
  // a calibrated, pedalling v3.3 bridge, idle (status line with step fields)
  const S = (gear, cad) => 'S,' + gear + ',20.0,120,' + cad.toFixed(1) + ',0,0,0,0.5,VR,0,B,0,-,0,6';
  const ready = () => $('rckBtns').style.visibility !== 'hidden' && !$('rckYes').disabled;
  async function ride(gear, cad, secs) {
    const seen = [];
    for (let k = 0; k < secs * 4; k++) {
      t += 0.25;
      await app.feed(t, S(gear, cad));
      seen.push({ t, gear, ready: ready(), q: $('rckQ').textContent });
    }
    return seen;
  }
  await ride(1, 75, 2);
  app.M3.startGearCheck();
  const st = app.M3.state;
  check('step 6 starts and takes the screen', st.check && st.check.phase === 'run' && st.calFocus, JSON.stringify(st.check && st.check.phase));

  // check 1 (about gear 5): shifting 1 -> 5, a gear a second, then holding 5
  let seen = [];
  for (const g of [1, 2, 3, 4]) seen = seen.concat(await ride(g, 75, 1));
  check('no question while shifting toward gear 5', seen.every((x) => !x.ready), seen.filter((x) => x.ready).map((x) => x.gear).join(','));
  const hold = await ride(5, 75, 4);
  const first = hold.find((x) => x.ready);
  check('asks about gear 5 once it has been steady ~3 s', first && first.t - hold[0].t >= 2.9 && /gear 5\?/.test(first.q),
    first ? (first.t - hold[0].t).toFixed(2) + ' s: ' + first.q : 'never asked');
  app.M3.checkAnswer(5);
  check('answer recorded against gear 5', st.check.results[0] && st.check.results[0].app === 5 && st.check.idx === 1,
    JSON.stringify(st.check.results[0]));

  // check 2 (about gear 12, easy)
  seen = [];
  for (const g of [7, 9, 11]) seen = seen.concat(await ride(g, 75, 1));
  check('check 2 waits while shifting', seen.every((x) => !x.ready));
  const h2 = await ride(12, 75, 4);
  check('check 2 asks at gear 12', h2.some((x) => x.ready && /gear 12\?/.test(x.q)));
  app.M3.checkAnswer(12);

  // check 3 (same gear, faster): not at the same pace, yes once it is 8+ rpm faster
  const same = await ride(12, 77, 5);
  check('faster check waits for the pace', same.every((x) => !x.ready) && /faster/i.test(same[same.length - 1].q), same[same.length - 1].q);
  const fast = await ride(12, 92, 2);
  check('faster check asks once the pace is up', fast.some((x) => x.ready));
  app.M3.checkAnswer(12);

  // check 4 (about gear 19), but the bridge stays at 12: asked anyway after 20 s
  const stuck = await ride(12, 78, 22);
  const late = stuck.find((x) => x.ready);
  check('asks anyway after ~20 s if the bridge never reads near the gear', late && late.t - stuck[0].t >= 19 && /gear 12\?/.test(late.q),
    late ? (late.t - stuck[0].t).toFixed(1) + ' s' : 'never');
  app.M3.checkAnswer(12);
  check('the gear check finishes', st.check.phase === 'done' && st.check.results.length === 4, st.check.phase);
  check('cadence line drawn in step 6', $('rckCadDot').textContent !== '' && $('rckCadT1').textContent !== '', $('rckCadDot').textContent + ' / ' + $('rckCadT1').textContent + '-' + $('rckCadT2').textContent);
  check('no page errors', app.errors.length === 0, app.errors.map(String).join('; '));
  process.exit(fail ? 1 : 0);
})();
