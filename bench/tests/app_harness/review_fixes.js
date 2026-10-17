// Regression checks for the bugs found in the 2026-10-17 app review (Bluetooth mode, lines fed by hand).
// Each scenario starts from a fresh page. Usage: node bench/tests/app_harness/review_fixes.js   (exit 1 on failure)
'use strict';
const { loadApp } = require('./harness');

let fail = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) fail++;
}

// v3.3 status line (16 fields)
function S(o) {
  o = Object.assign({ gear: 5, cad: '70.0', cal: 0, step: 0, stab: 0, flags: 'VR', src: 'B', pass: '-', flow: 0 }, o);
  return ['S', o.gear, '20.0', '120', o.cad, o.cal, o.step, o.stab, '0.5', o.flags, '0', o.src, '0', o.pass, o.flow, 6].join(',');
}
function mk() {
  const app = loadApp({ search: '' });
  app.connect();
  const toasts = [];
  const orig = app.win.toast;
  app.win.toast = function (m) { toasts.push(m); return orig.apply(this, arguments); };
  app.toasts = toasts;
  let t = 1;
  app.f = async (line, dt) => { t += dt === undefined ? 0.2 : dt; await app.feed(t, line); };
  app.cmds = () => app.commands().map((c) => c.cmd);
  app.recs = () => Object.keys(app.store).filter((k) => k.indexOf('m3bridge.rec.') === 0);
  app.titles = () => app.win.records.map((r) => r.title);
  // a complete up pass, ending at the checkpoint (cal 7); flagged: e.g. ['u,20']
  app.upPass = async (flagged) => {
    await app.f(S({}));
    await app.f(S({ cal: 3, flow: 2, pass: 'u' }));
    await app.f(S({ cal: 6, flow: 3, step: 1, pass: 'su' }));
    for (let p = 1; p <= 24; p++) {
      await app.f(S({ cal: 1, flow: 4, step: p - 1, pass: 'u' }));
      await app.f('C,' + p + ',' + (p * 3) + '.0,1.0,2.0');
    }
    await app.f('C,25,75.0,1.0,2.0');
    await app.f('K,1,120.0,3.00,6,saved');
    for (const it of flagged || []) await app.f('F,' + it + ',behind,1.0,2.0,3.0');
    await app.f('F,end,' + (flagged || []).length);
    await app.f(S({ cal: 7, flow: 4, step: 22, pass: 'd' }));
  };
  app.downPass = async (from, to) => {
    for (let p = from; p >= to; p--) {
      await app.f(S({ cal: 1, flow: 5, step: p - 1, pass: 'd' }));
      await app.f('C,down,' + p + ',' + (p * 3 - 1) + '.0,1.0,2.0');
    }
  };
  return app;
}
// a localStorage that throws past `quota` characters (keys + values)
function limitStorage(app, quota) {
  const store = app.store;
  const used = () => Object.keys(store).reduce((n, k) => n + k.length + store[k].length, 0);
  app.win.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      v = String(v);
      const old = k in store ? k.length + store[k].length : 0;
      if (used() - old + k.length + v.length > quota) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
      store[k] = v;
    },
    removeItem: (k) => { delete store[k]; },
  };
}
function addDiag(app, i, size) {
  return app.M3.addRecord({ id: 'r' + i, type: 'diag', source: 'run', ts: new Date().toISOString(), title: 'Diag ' + i,
    summary: 's', filename: 'keiser-diag-' + i + '.csv' }, 'x'.repeat(size));
}
const index = (app) => JSON.parse(app.store['m3bridge.records'] || '[]').map((r) => r.id);

(async function main() {
  // ---------------------------------------------------------------- saved runs
  {
    const app = mk();
    limitStorage(app, 1000000);
    addDiag(app, 1, 300000); addDiag(app, 2, 300000); addDiag(app, 3, 300000);
    addDiag(app, 4, 1000001);   // can never fit
    const idx = index(app), keys = app.recs();
    check('storage: a run that never fits leaves an index that matches what is stored',
      idx.every((id) => keys.indexOf('m3bridge.rec.' + id) >= 0), 'index ' + idx + ' / data ' + keys);
  }
  {
    const app = mk();
    limitStorage(app, 800000);
    addDiag(app, 1, 300000);
    const id = addDiag(app, 2, 300000);
    const ok = app.win.appendRecordComments(id, ['x'.repeat(250000)], 'more');
    check('storage: adding lines to a full store removes the oldest other run, and keeps this one listed',
      ok && index(app).indexOf(id) >= 0 && app.store['m3bridge.rec.' + id].length > 500000 && index(app).indexOf('r1') < 0,
      'index ' + index(app));
  }
  {
    const app = mk();
    app.store['m3bridge.flow'] = '1';
    await app.upPass();
    check('storage: a corrupt flow record does not stop the calibration being saved', app.titles().indexOf('Calibration saved') >= 0, app.titles().join(' / '));
    const rec = app.win.records[0], build = app.win.APP_BUILD;
    check('saved runs say which page build saved them (CSV line and index)',
      (app.win.getCsv(rec.id) || '').indexOf('# page_build: ' + build + '\n') >= 0 && rec.build === build, build);
    check('the board\'s USB log is told the page build once per connection',
      app.cmds().filter((c) => c === '#J,page,' + build).length === 1, JSON.stringify(app.cmds().filter((c) => /^#J/.test(c))));
  }
  // ---------------------------------------------------------------- incomplete copies
  {
    const app = mk();
    await app.upPass();
    app.M3.setConn('disconnected');
    check('drop at the checkpoint: no "incomplete" copy of the saved up pass', app.recs().length === 1, app.titles().join(' / '));
    app.connect();
    await app.f(S({ cal: 7, flow: 4, step: 22, pass: 'd' }));
    app.$('upLater').click();
    await app.f(S({}));
    await app.advance(3);
    check('reconnect at the checkpoint, then Later: still no "incomplete" copy', app.recs().length === 1, app.titles().join(' / '));
    check('Later sends x once', app.cmds().filter((c) => c === 'x').length === 1, JSON.stringify(app.cmds()));
  }
  // ---------------------------------------------------------------- Bluetooth link
  {
    const app = mk();
    await app.f(S({ gear: 7 }));
    app.M3.setConn('disconnected');
    const dv = new DataView(new TextEncoder().encode(S({ gear: 9, cal: 1, flow: 4, pass: 'u' }) + '\n').buffer);
    app.win.onNotify({ target: { value: dv } });
    check('a notification after the drop is ignored', app.M3.state.s === null && app.M3.state.conn === 'disconnected');
  }
  {
    const app = mk();
    await app.f(S({}));
    app.$('calStart').click();               // step 1: placement stream on ('v')
    await app.f(S({ flow: 1 }));
    app.M3.setConn('disconnected');
    app.connect();
    await app.f(S({ flow: 1 }));             // the board kept its stream on across the drop
    check('drop in step 1: after reconnecting step 1 carries on without toggling the stream',
      !!app.M3.state.place && app.cmds().filter((c) => c === 'v').length === 1, JSON.stringify(app.cmds()));
    const app2 = mk();
    await app2.f(S({ flow: 1 }));            // stream on, but the page isn't on step 1 (e.g. after a reload)
    check('stream left on with no step 1 on the page: switched off once', app2.cmds().filter((c) => c === 'v').length === 1 && !app2.M3.state.place,
      JSON.stringify(app2.cmds()));
  }
  // ---------------------------------------------------------------- protocol
  {
    const app = mk();
    await app.f(S({ src: 'W', flags: 'VPA', cad: '82.0' }));
    check('pod cadence (src W) counts as pedalling', app.M3.state.s.pedalling === true);
    const n21 = S({}) + ',1,2,3,4,5';
    await app.f(n21);
    check('a newer bridge (21 fields) is read, not rejected', app.M3.state.s && app.M3.state.s.gear === 5 && app.M3.state.newerLines >= 1);
  }
  {
    const app = mk();
    await app.f(S({ cal: 1, flow: 4, step: 11, pass: 'u' }));
    await app.f('C,12,-123.4,456.7,-8S,5,30.0,100,70.0,1,12,0,0.5,VAR,0,B,0,u,4,6');
    check('a C line glued to the next line is dropped', !app.M3.state.points.some((p) => p.point === 12));
    await app.f(S({}));
    app.win.requestStoredCal();
    for (let p = 1; p <= 25; p++) if (p !== 13) await app.f('Q,' + p + ',' + p + '.0,1.0,2.0', 0.02);
    await app.f('Q,end,120.0,3.00,6', 0.02);
    check('a stored calibration read back with a point missing is not saved', app.recs().length === 0, app.titles().join(' / '));
  }
  // ---------------------------------------------------------------- calibration flow
  {
    const app = mk(); const st = app.M3.state;
    await app.f(S({}));
    await app.f(S({ cal: 3, flow: 2, pass: 'u' }));
    await app.f('L,0,2,0,1.2,no signal');
    for (let p = 1; p <= 25; p++) { await app.f(S({ cal: 1, flow: 4, step: Math.min(24, p - 1), pass: 'u' })); await app.f('C,' + p + ',' + p + '.0,1.0,2.0'); }
    await app.f('K,1,120.0,3.00,6,saved');
    await app.f('F,end,0');
    await app.f(S({}));
    check('hold-still method (crank not found): no Saved checkpoint, the gear check follows', !st.upSaved && !st.fixHold && !!st.check,
      'upSaved ' + st.upSaved + ' check ' + (st.check && st.check.phase));
  }
  {
    const app = mk(); const st = app.M3.state;
    await app.upPass(['u,20']);
    app.$('upLater').click();
    await app.f(S({}));
    app.$('resumeDown').click();
    await app.f('E,ok,down');
    check('E,ok,down is not taken for "saved"', app.toasts.indexOf('Redone and saved') < 0 && app.toasts.indexOf('Best guess used and saved') < 0);
    await app.f(S({ cal: 1, flow: 5, step: 22, pass: 'd' }));
    check('no Undo at the first point of a #D down pass', app.$('btnUndo').disabled === true);
    await app.downPass(23, 2);
    await app.f('K,1,120.0,3.00,6,saved');
    await app.f('F,u,20,behind,1.0,2.0,3.0');
    await app.f('F,end,1');
    await app.f(S({}));
    await app.advance(3);
    check('Later, then Continue down (#D): the guided redo starts after the down pass', app.cmds().some((c) => /^#R,u,20/.test(c)),
      JSON.stringify(app.cmds().slice(-3)) + ' fixPaused ' + st.fixPaused);
    await app.f('E,ok,redo');
    check('E,ok,redo (the redo starting) is not "Redone and saved"', app.toasts.indexOf('Redone and saved') < 0 && !(st.edit && st.edit.okd));
    await app.f(S({ cal: 1, flow: 4, step: 19, pass: 'ru', flags: 'VRB' }));
    await app.f(S({}));
    await app.advance(5);
    check('a redo that ends with no K or A is not waited for for ever', st.edit === null);
  }
  {
    const app = mk(); const st = app.M3.state;
    await app.upPass();
    app.$('upContinue').click();
    app.$('upContinue').click();
    await app.f(S({ cal: 7, flow: 4, step: 22, pass: 'd' }));   // still at the checkpoint
    check('Continue down sends n once', app.cmds().filter((c) => c === 'n').length === 1, JSON.stringify(app.cmds()));
    await app.downPass(23, 2);
    await app.f('K,1,120.0,3.00,6,saved');   // ... and its F,end is lost
    await app.f(S({}));
    await app.advance(6);
    check('the F,end after the down pass is lost: step 6 starts anyway', !!st.check && st.check.phase === 'run', st.check && st.check.phase);
  }
  {
    const app = mk(); const st = app.M3.state;
    await app.upPass(['u,20']);
    app.$('upLater').click();
    await app.f(S({}));
    const before = st.review && st.review.items.length;
    app.$('calStart').click();
    app.$('placeBack').click();
    check('Start calibration, then Back: the review list and result are kept', before === 1 && st.review && st.review.items.length === 1 && !!st.result);
  }
  {
    const app = mk(); const st = app.M3.state;
    await app.upPass();
    app.$('upContinue').click();
    await app.downPass(23, 2);
    await app.f('K,1,120.0,3.00,6,saved');
    await app.f('F,d,10,updown,1.0,2.0,3.0');
    await app.f('F,end,1');
    await app.f(S({}));
    st.resultHidden = true; app.win.renderResult();   // the result card's (x)
    app.win.fixAction('skip');
    if (!st.review) { st.editErr = ''; app.win.maybeOfferCheck(); }
    check('dismissing the result card does not stop step 6', !!st.check && st.check.phase === 'run');
  }
  // ---------------------------------------------------------------- gear check
  {
    const app = mk(); const st = app.M3.state;
    await app.upPass();
    app.$('upContinue').click();
    await app.downPass(23, 2);
    await app.f('K,1,120.0,3.00,6,saved');
    await app.f('F,end,0');
    await app.f(S({ gear: 1, flags: 'V', cad: '0.0', src: '-' }));
    for (let i = 0; i < 100; i++) await app.f(S({ gear: 1, flags: 'V', cad: '0.0', src: '-' }), 0.25);   // 25 s rest
    for (let i = 0; i < 16; i++) await app.f(S({ gear: 1, cad: '75.0' }), 0.25);                          // 4 s pedalling at gear 1
    check('gear check: a rest does not count toward "ask anyway"', !st.check.askGear, 'asked at gear ' + st.check.askGear);
    const rid = app.win.calRecordId();
    st.check.activeMs = 1e9;
    for (let i = 0; i < 16; i++) await app.f(S({ gear: 5, cad: '75.0' }), 0.25);
    while (st.check.phase === 'run') app.M3.checkAnswer(st.check.askGear || 5);
    app.$('rckClose').click();
    app.win.startGearCheck();
    while (st.check.phase === 'run') app.M3.checkAnswer(6);
    const csv = app.win.getCsv(rid) || '';
    check('a second gear check replaces the first one\'s lines', (csv.match(/^# gear_check:/gm) || []).length === 1 && /console=6/.test(csv));
  }
  {
    // after a reload: the page didn't see the up pass, so the down pass is read back (k) and saved; the gear check lands there
    const app = mk(); const st = app.M3.state;
    await app.f(S({}));
    app.win.sendCmd('#D');
    await app.f('E,ok,down');
    await app.downPass(23, 2);
    await app.f('K,1,120.0,3.00,6,saved');
    await app.f('F,end,0');
    for (let p = 1; p <= 25; p++) await app.f('Q,' + p + ',' + p + '.0,1.0,2.0', 0.02);
    for (let p = 23; p >= 2; p--) await app.f('Q,down,' + p + ',' + p + '.5,1.0,2.0', 0.02);
    await app.f('Q,end,120.0,3.00,6', 0.02);
    await app.f('F,end,0');
    await app.f(S({}));
    check('readback after #D: linked to the result, down count from the bridge', !!st.result.recordId && st.result.down === 22,
      'recordId ' + st.result.recordId + ' down ' + st.result.down);
    if (st.check && st.check.phase === 'run') while (st.check.phase === 'run') app.M3.checkAnswer(5);
    check('...and the gear check is saved with it', /# gear_check:/.test(app.win.getCsv(st.result.recordId) || ''), app.$('rckSaved').textContent);
  }
  {
    // resume offers only for a bridge that says it is calibrated
    const app = mk();
    app.store['m3bridge.flow'] = JSON.stringify({ downDone: false, checkDone: false, at: '2026-10-10T10:00:00Z' });
    await app.f(S({ gear: 0, flags: '' }));
    check('no resume offer while the bridge is uncalibrated', app.$('calResume').hidden === true);
    await app.f(S({}));
    check('...and it shows once it is calibrated', app.$('calResume').hidden === false);
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL crashed: ' + (e && e.stack || e)); process.exit(1); });
