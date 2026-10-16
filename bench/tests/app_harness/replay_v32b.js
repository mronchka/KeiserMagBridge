// Replays the real v3.2b board output (bench/logs/2026-10-16_v3_2b.log) through the page's parser
// (webapp/index.html run in node by harness.js, virtual clock, writes captured).
// Checks: the guided redo starts after F,end (a #R reaches the board) and the down-pass dots turn blue.
// Usage: node bench/tests/app_harness/replay_v32b.js [logfile] [--page path]   (exit 1 on failure)
'use strict';
const path = require('path');
const { loadApp, readLog } = require('./harness');

const args = process.argv.slice(2);
const pageAt = args.indexOf('--page');
const page = pageAt >= 0 ? args.splice(pageAt, 2)[1] : undefined;
const LOG = args[0] || path.join(__dirname, '..', '..', 'logs', '2026-10-16_v3_2b.log');

let fail = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) fail++;
}

(async function main() {
  const lines = readLog(LOG);
  const app = loadApp({ search: '', page });
  app.connect();
  const dotProblems = [];
  let downSeen = 0, fEndAt = null;
  for (const [t, text] of lines) {
    await app.feed(t, text);
    if (/^F,end,/.test(text)) fEndAt = t;   // the last one: after the run's save
    // Down-pass dots: at every down-pass S line, each captured down point is blue (or the current ring).
    const s = app.M3.state.s;
    if (/^S,/.test(text) && s && s.pass === 'd' && s.cal !== 0) {
      downSeen++;
      const dots = app.$('calDots').children;
      for (const q of (app.M3.state.downPoints || [])) {
        const cls = dots[q.point - 1] ? dots[q.point - 1].className : '(no dot)';
        if (!/\b(down|cur)\b/.test(cls)) dotProblems.push(t.toFixed(1) + ' point ' + q.point + ': ' + cls);
      }
    }
  }
  await app.advance(5);

  const st = app.M3.state;
  check('replay ran without page errors', app.errors.length === 0, app.errors.map(String).join('; '));
  check('down points recorded', (st.downPoints || []).length === 22, (st.downPoints || []).length + ' of 22');
  check('down-pass dots turn blue', downSeen > 0 && dotProblems.length === 0, dotProblems.slice(0, 3).join(', '));
  const cmds = app.commands().filter((c) => fEndAt !== null && c.t >= fEndAt);
  const redo = cmds.find((c) => /^#R,[ud],\d+$/.test(c.cmd));
  check('guided redo starts after F,end', !!redo,
    redo ? redo.cmd + ' at ' + redo.t.toFixed(2) + ' s (F,end at ' + fEndAt + ' s)' : 'sent after F,end: ' + JSON.stringify(cmds.map((c) => c.cmd)));
  console.log('state: review=' + (st.review ? st.review.items.map((i) => i.pass + i.point).join(' ') : 'null') +
    ' edit=' + JSON.stringify(st.edit && { kind: st.edit.kind, pass: st.edit.pass, point: st.edit.point }) +
    ' fixPaused=' + st.fixPaused + ' editErr=' + JSON.stringify(st.editErr));
  process.exit(fail ? 1 : 0);
})();
