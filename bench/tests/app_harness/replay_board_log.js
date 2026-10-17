// Plays a real bike log (bench/kmb_live.py format, with the phone's S status lines) through the page
// in Bluetooth mode and reports what the page showed: steps, focused screen, Undo, errors, the
// review card and the gear check. Usage: node bench/tests/app_harness/replay_board_log.js LOG [--page path]
'use strict';
const { loadApp, readLog } = require('./harness');

const args = process.argv.slice(2);
const pageAt = args.indexOf('--page');
const page = pageAt >= 0 ? args.splice(pageAt, 2)[1] : undefined;
const LOG = args[0];

let fail = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) fail++;
}

(async function main() {
  const lines = readLog(LOG);
  const app = loadApp({ search: '', page });
  const $ = app.$;
  let connected = false, nS = 0, calS = 0, focus = 0, undoOnPoints = 0, points = 0, stepsSeen = new Set();
  let reviewShown = null, checkStarted = null, lastHead = '', heads = [];
  for (const [t, text] of lines) {
    if (!connected && /App connected|phone console connected/.test(text)) { app.connect(); connected = true; }
    if (!connected) continue;
    await app.feed(t, text);
    const st = app.M3.state;
    if (/^S,/.test(text)) {
      nS++;
      const f = text.split(',');
      const cal = +f[5];
      if (cal !== 0 && cal !== 7) {
        calS++;
        if (st.calFocus && st.view === 'cal') focus++;
        if (cal === 1 && /^[ud]$/.test(f[13]) && +f[6] > 0) { points++; if (!$('topUndo').hidden) undoOnPoints++; }
      }
      const m = /STEP (\d) OF 6/.exec($('crumbs').hidden ? '' : $('crumbT').textContent);
      if (m) stepsSeen.add(+m[1]);
      if (!$('reviewCard').hidden && reviewShown === null) reviewShown = t;
      if (st.check && st.check.phase === 'run' && checkStarted === null) checkStarted = t;
      const h = $('calHead').textContent;
      if (cal !== 0 && h && h !== lastHead) { heads.push(t.toFixed(0) + ' ' + h); lastHead = h; }
    }
  }
  await app.advance(5);
  check('page ran the whole log without errors', app.errors.length === 0, app.errors.slice(0, 3).map(String).join('; '));
  check('status lines reached the page', nS > 1000, nS + ' S lines');
  check('focused screen while calibrating', calS > 0 && focus >= 0.97 * calS, focus + '/' + calS);
  check('Undo in the top bar on the gear points', points > 0 && undoOnPoints >= 0.9 * points, undoOnPoints + '/' + points);
  check('breadcrumb went through steps 2-5', [2, 3, 4, 5].every((s) => stepsSeen.has(s)), [...stepsSeen].sort().join(','));
  console.log('INFO review card first shown at ' + reviewShown + ' s; gear check started at ' + checkStarted + ' s');
  console.log('INFO review items at the end: ' + JSON.stringify((app.M3.state.review || { items: [] }).items.map((i) => i.pass + i.point + ':' + i.reason)));
  console.log('INFO headings seen: ' + heads.length);
  process.exit(fail ? 1 : 0);
})();
