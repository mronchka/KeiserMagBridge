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
const $ok = (el) => !!el && !el.hidden;
const index = (app) => JSON.parse(app.store['m3bridge.records'] || '[]').map((r) => r.id);
// after the down pass the gear list (#11) offers step 6: tap "Check a few gears"
const start6 = (app) => { if (app.M3.state.gearList) app.$('glCheck').click(); };

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
  {
    // round 2: the live page and the preview share mronchka.github.io's storage
    const a = mk(), b = mk();
    b.store = a.store; b.win.localStorage = a.win.localStorage;   // same origin
    addDiag(a, 1, 1000);
    addDiag(b, 2, 1000);
    check('two pages on one origin keep each other\'s saved runs', index(a).indexOf('r1') >= 0 && index(a).indexOf('r2') >= 0, 'index ' + index(a));
  }
  {
    // round 2: a calibration with no record of its own (its readback came incomplete) never gets the
    // gear check written into an older calibration's record
    const app = mk(); const st = app.M3.state;
    await app.upPass();
    app.$('upContinue').click();
    await app.downPass(23, 2);
    await app.f('K,1,120.0,3.00,6,saved');
    await app.f('F,end,0');
    await app.f(S({}));
    start6(app);
    while (st.check && st.check.phase === 'run') app.M3.checkAnswer(5);
    const older = app.win.records[0].id, olderCsv = app.win.getCsv(older);
    st.points = st.points.slice(0, 20);                          // as after a reload: the page didn't see the up pass
    await app.f(S({ cal: 1, flow: 5, step: 22, pass: 'd' }));
    await app.f('K,1,120.0,3.00,6,saved');
    await app.f('F,end,0');
    for (let p = 1; p <= 25; p++) if (p !== 13) await app.f('Q,' + p + ',' + p + '.0,1.0,2.0', 0.02);
    await app.f('Q,end,120.0,3.00,6', 0.02);
    await app.f('F,end,0');
    await app.f(S({}));
    if (!st.check || st.check.phase !== 'run') app.win.startGearCheck();
    while (st.check.phase === 'run') app.M3.checkAnswer(9);
    check('an incomplete readback: the gear check does not overwrite the older calibration\'s lines', app.win.getCsv(older) === olderCsv);
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
  // ---------------------------------------------------------------- reconnects and lost lines (tester B)
  {
    const app = mk(); const st = app.M3.state;
    await app.upPass(['u,20']);
    app.$('upContinue').click();
    await app.downPass(23, 2);
    await app.f('K,1,120.0,3.00,6,saved');
    await app.f('F,u,20,behind,1.0,2.0,3.0');
    await app.f('F,end,1');
    await app.f(S({}));
    await app.advance(1);   // the guided redo of gear 20 is sent
    await app.f('E,ok,redo');
    await app.f(S({ cal: 1, flow: 4, step: 19, pass: 'ru', flags: 'VRB' }));
    app.M3.setConn('disconnected');
    app.connect();
    await app.f('C,20,61.0,1.0,2.0');      // the redo's capture, save and K arrive before any status line
    await app.f('E,ok,saved');
    await app.f('K,1,120.0,3.00,6,saved');
    check('reconnect mid-redo, C/K before the first S: the other points are kept',
      st.points.length === 25 && st.downPoints.length === 22, 'up ' + st.points.length + ' down ' + st.downPoints.length);
  }
  {
    const app = mk();
    await app.upPass();
    app.$('upContinue').click();
    for (let p = 23; p >= 2; p--) {
      await app.f(S({ cal: 1, flow: 5, step: p - 1, pass: 'd' }));
      if (p !== 12) await app.f('C,down,' + p + ',' + (p * 3 - 1) + '.0,1.0,2.0');   // C,down,12 lost
    }
    await app.f('K,1,120.0,3.00,6,saved');
    await app.f('F,end,0');
    check('a down point lost on the way: the page reads the calibration back (k)', app.cmds().indexOf('k') >= 0, JSON.stringify(app.cmds().slice(-3)));
  }
  {
    const app = mk();
    await app.f('S,1,20.0,100,70.0,0,0,0,1.0,VAR,0,B,0,-');   // one clean 14-field line first
    await app.f(S({ cal: 1, flow: 2, pass: 'u' }));
    check('a 14-field line first does not lock out v3.3 status lines', app.M3.state.v33 && app.M3.state.s.cal === 1);
  }
  {
    const app = mk();
    await app.f(S({}));
    for (let p = 1; p <= 10; p++) { await app.f(S({ cal: 1, flow: 4, step: p - 1, pass: 'u' })); await app.f('C,' + p + ',' + p + '.0,1.0,2.0'); }
    await app.f(S({}));                                          // one stray idle line
    await app.f(S({ cal: 1, flow: 4, step: 10, pass: 'u' }));
    await app.advance(3);
    check('one stray idle status line mid-run saves no "incomplete" copy', app.recs().length === 0, app.titles().join(' / '));
  }
  {
    const app = mk();
    await app.upPass();
    await app.advance(4);                                        // quiet just after the save: the bridge writes its flash
    check('4 s of quiet right after a save: no "Waiting for the bridge" yet (#13)', !app.$('upContinue').disabled);
    await app.advance(3);                                        // still quiet: now it says so
    check('silence at the Saved checkpoint: Continue down says it is waiting', app.$('upContinue').disabled &&
      /Waiting/.test(app.$('upContinue').textContent), app.$('upContinue').textContent);
    await app.f(S({ cal: 7, flow: 4, step: 22, pass: 'd' }));
    check('...and comes back with the next status line', !app.$('upContinue').disabled && app.$('upContinue').textContent === 'Continue down');
  }
  // ---------------------------------------------------------------- tester A
  {
    const app = loadApp({ search: '' });
    check('before connecting, the walkthrough describes pedalling (not v2 stop-and-hold)',
      app.win.onbSteps()[0] === app.win.CAL_INTRO.crank[0], app.win.onbSteps()[0].title);
  }
  {
    const app = mk(); const st = app.M3.state;
    await app.upPass();
    app.$('upContinue').click();
    await app.downPass(23, 12);
    app.$('btnCancel').click(); app.$('btnCancel').click();   // (x) twice in the down pass: the board saves (K), as the firmware does
    await app.f('K,1,120.0,3.00,6,saved');
    await app.f('F,end,0');
    await app.f(S({}));
    await app.advance(2);
    check('stopping the down pass with (x) does not start the gear check by itself', !(st.check && st.check.phase === 'run'),
      st.check && st.check.phase);
    check('...the start screen offers it instead', app.$('calResume').hidden === false && app.$('resumeCheck').hidden === false);
    app.$('resumeCheck').click();
    while (st.check.phase === 'run') app.M3.checkAnswer(5);
    check('the gear check summary keeps the breadcrumb (step 6)', app.win.flowNow() === 6 && app.$('crumbs').hidden === false);
  }
  // ---------------------------------------------------------------- review round 2
  {
    const app = mk();
    await app.f(S({}));
    app.$('calStart').click();
    await app.f(S({ flow: 1 }));
    app.M3.setConn('disconnected');
    app.M3.setConn('connecting'); app.M3.setConn('disconnected', 'Reconnect failed');   // one failed attempt
    app.connect();
    await app.f(S({ flow: 1 }));
    check('a failed reconnect attempt keeps what the drop remembered (step 1 carries on)', !!app.M3.state.place &&
      app.cmds().filter((c) => c === 'v').length === 1, JSON.stringify(app.cmds()));
  }
  {
    const app = mk();
    await app.upPass();
    app.$('upContinue').click();                 // 'n' is lost with the link
    app.M3.setConn('disconnected');
    app.connect();
    await app.f(S({ cal: 7, flow: 4, step: 22, pass: 'd' }));
    app.$('upContinue').click();
    await app.advance(0.1);
    check('Continue down after a drop at the checkpoint sends n again', app.cmds().filter((c) => c === 'n').length === 2, JSON.stringify(app.cmds()));
  }
  {
    const app = mk(); const st = app.M3.state;
    await app.f(S({}));
    app.win.sendCmd('#D');
    await app.f('E,ok,down');
    await app.downPass(23, 2);
    await app.f('K,1,120.0,3.00,6,saved');       // a readback is wanted (the page didn't see the up pass)...
    app.M3.setConn('disconnected');               // ...but the link drops before the F list
    await app.advance(6);
    app.connect();
    await app.f(S({}));
    check('a readback still wanted when the link dropped is asked for after reconnecting', app.cmds().filter((c) => c === 'k').length === 1 && !st.wantReadback,
      JSON.stringify(app.cmds()));
    for (let p = 1; p <= 25; p++) if (p !== 7) await app.f('Q,' + p + ',' + p + '.0,1.0,2.0', 0.02);
    await app.f('Q,end,120.0,3.00,6', 0.02);
    await app.f('F,end,0');
    check('an incomplete readback the page asked for is read once more', app.cmds().filter((c) => c === 'k').length === 2, JSON.stringify(app.cmds()));
    for (let p = 1; p <= 25; p++) await app.f('Q,' + p + ',' + p + '.0,1.0,2.0', 0.02);
    await app.f('Q,end,120.0,3.00,6', 0.02);
    await app.f('F,end,0');
    check('...and the complete one becomes the run record', !!st.result.recordId && app.titles()[0] === 'Calibration saved', app.titles().join(' / '));
  }
  {
    const app = mk();
    await app.upPass();
    const rid = app.win.calRecordId();
    const app2 = loadApp({ search: '' });         // reload at the checkpoint (same phone storage)
    Object.assign(app2.store, app.store); app2.win.loadRecords(); app2.connect();
    await app2.feed(1, S({ cal: 7, flow: 4, step: 22, pass: 'd' }));
    check('a reload at the checkpoint keeps the up-pass record for the gear check', app2.win.calRecordId() === rid && app2.M3.state.upSaved);
  }
  // ---------------------------------------------------------------- tester B, round 2
  const readback = async (app, opts) => {   // the bridge answering k: 25 points, 22 down points, Q,end, an empty F list
    opts = opts || {};
    for (let p = 1; p <= 25; p++) await app.f('Q,' + p + ',' + p + '.0,1.0,2.0', 0.02);
    for (let p = 23; p >= 2; p--) await app.f('Q,down,' + p + ',' + p + '.5,1.0,2.0', 0.02);
    if (!opts.noEnd) await app.f('Q,end,120.0,3.00,6', 0.02);
    for (const it of opts.flagged || []) await app.f('F,' + it + ',behind,1.0,2.0,3.0', 0.02);
    await app.f('F,end,' + (opts.flagged || []).length, 0.02);
  };
  {
    const app = mk(); const st = app.M3.state;
    await app.upPass();
    app.$('upContinue').click();
    await app.downPass(23, 3);
    app.M3.setConn('disconnected'); app.connect();
    app.M3.setConn('disconnected'); app.connect();                 // a second drop before any status line
    await app.f('C,down,2,5.0,1.0,2.0');
    await app.f('K,1,120.0,3.00,6,saved');
    await app.f('F,end,0');
    await app.f(S({}));
    check('two drops in a row: the down pass\'s K is still taken as v3.3 (finish card, down points kept)',
      st.result.down === 22 && !!st.gearList, 'down ' + st.result.down + ' gear list ' + !!st.gearList);
  }
  {
    const app = mk(); const st = app.M3.state;
    await app.upPass();
    app.$('upContinue').click();
    await app.downPass(23, 2);                                     // ... and its K is lost
    await app.f(S({}));
    await app.advance(4);
    check('a down pass whose K never arrives: the page reads the calibration back', app.cmds().filter((c) => c === 'k').length === 1, JSON.stringify(app.cmds()));
    await readback(app);
    check('...and saves it as the run, with the whole down pass', /# down_points: 22 of 22/.test(app.win.getCsv(st.result.recordId) || ''),
      app.titles().join(' / '));
  }
  {
    const app = mk(); const st = app.M3.state;
    await app.upPass();
    app.$('upContinue').click();
    for (let p = 23; p >= 2; p--) { await app.f(S({ cal: 1, flow: 5, step: p - 1, pass: 'd' })); if (p !== 2) await app.f('C,down,' + p + ',1.0,1.0,2.0'); }
    await app.f('K,1,120.0,3.00,6,saved');                         // C,down,2 was lost
    await app.f('F,end,0');
    check('the last down point lost: read back too', app.cmds().indexOf('k') >= 0, JSON.stringify(app.cmds().slice(-2)));
    await readback(app);
    check('...and the page then works with the bridge\'s 22 down points', st.downPoints.length === 22);
  }
  {
    const app = mk(); const st = app.M3.state;
    await app.f(S({}));
    app.$('saveStored').click();
    await readback(app, { noEnd: true, flagged: ['u,20'] });       // Q,end lost, the F list arrives
    await app.f(S({}));
    await app.advance(2);
    check('Save stored calibration with Q,end lost starts no redo', !app.cmds().some((c) => /^#R/.test(c)), JSON.stringify(app.cmds()));
  }
  {
    const app = mk(); const st = app.M3.state;
    await app.upPass(['u,20']);
    app.$('upContinue').click();
    await app.downPass(23, 12);
    app.$('btnSkipDown').click(); app.$('btnSkipDown').click();   // Finish without the down pass
    await app.f('K,1,120.0,3.00,6,saved');
    await app.f('F,u,20,behind,1.0,2.0,3.0');
    await app.f('F,end,1');
    await app.f(S({}));
    await app.advance(2);
    check('stopping the down pass holds the guided redos too', !app.cmds().some((c) => /^#R/.test(c)) && st.fixPaused, JSON.stringify(app.cmds().slice(-3)));
  }
  // ---------------------------------------------------------------- tester A, round 2
  {
    const app = mk(); const st = app.M3.state;
    await app.upPass();
    app.$('upContinue').click();
    await app.downPass(23, 2);
    await app.f('K,1,120.0,3.00,6,saved');
    await app.f('F,end,0');
    await app.f(S({}));
    start6(app);
    app.M3.checkAnswer(6); app.M3.checkAnswer(12); app.M3.checkAnswer(14); app.M3.checkAnswer(19);   // two mismatches
    app.M3.setConn('disconnected');
    check('a drop on the gear check summary leaves focus mode (the Reconnect card fits)', !st.calFocus);
    app.connect();
    await app.f(S({}));
    app.win.startEdit('R', 'u', 6);                                // "Redo gear 6" in the summary
    await app.f('E,ok,redo');
    await app.f(S({ cal: 1, flow: 6, step: 5, pass: 'ru' }));
    await app.f('C,6,18.5,1.0,2.0');
    await app.f('E,ok,saved');
    await app.f('K,1,120.0,3.00,6,saved');
    await app.f('F,end,0');
    await app.f(S({}));
    const sum = app.$('rckSum').innerHTML;
    check('after a Redo from the gear check summary it comes back: that row Redone, the other still offered',
      st.check && st.check.phase === 'done' && /Redone/.test(sum) && /data-rck-redo="14"/.test(sum), sum.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 160));
  }
  // ---------------------------------------------------------------- GitHub issues from the first v3.3 bike calibration
  {
    // #2: the bottom (point 1) stays on screen as saved for ~2.5 s
    const app = mk();
    await app.f(S({}));
    await app.f(S({ cal: 1, flow: 4, step: 0, pass: 'u' }));
    await app.f('C,1,1.0,1.0,2.0', 0.1);
    await app.f(S({ cal: 1, flow: 4, step: 1, pass: 'u' }), 1.5);   // the board already asks for gear 2
    check('#2 the bottom shows as saved for over 1.5 s', /Bottom saved/.test(app.$('calSub').textContent), app.$('calSub').textContent);
    await app.f(S({ cal: 1, flow: 4, step: 1, pass: 'u' }), 1.2);
    check('#2 ...then the gear 2 prompt', !/saved/.test(app.$('calSub').textContent), app.$('calHead').textContent);
  }
  {
    // #9 / #10: after the down pass: a finish card; the checks start with the gears the calibration is least sure of
    const app = mk(); const st = app.M3.state;
    await app.upPass(['u,15']);
    app.$('upContinue').click();
    await app.downPass(23, 2);
    await app.f('K,1,120.0,3.00,6,saved');
    await app.f('F,u,15,behind,1.0,2.0,3.0');
    await app.f('F,end,1');
    await app.f(S({}));
    st.review = null; app.win.maybeOfferCheck();                     // (the flagged gear left as it is)
    check('#9 the finish (gear list): Check a few gears / Finish and ride, no start screen', !!st.gearList && !app.$('gearList').hidden &&
      app.$('calIdle').hidden && app.$('calResume').hidden && !app.$('glFinish').hidden);
    check('#11 the gear list shows the flagged gear red, and why when tapped', app.win.gearQuality()[15].level === 2 &&
      (app.$('glGrid').innerHTML.match(/class="gl-g q2[^"]*" type="button" data-gear="15"/) || []).length === 1, app.$('glLead').textContent);
    st.gearList.sel = 15; app.win.renderGearList();   // (a tap on chip 15: the DOM stub has no event targets)
    check('#11 ...tapping gear 15 says why', /Gear 15: Where it starts going up \(from gear 14\) isn.t past the gear below it/.test(app.$('glWhy').textContent), app.$('glWhy').textContent);
    app.$('glCheck').click();
    check('#10 the gear check starts with the gear the bridge flagged', st.check.list.some((c) => c.gear === 15),
      st.check.list.map((c) => c.gear + c.pace[0]).join(' '));
    while (st.check.phase === 'run') app.M3.checkAnswer(st.check.list[st.check.idx].gear === 15 ? 14 : 5);
    check('#10 the summary offers "Check a few more gears"', app.$('rckMore').hidden === false);
    app.$('rckMore').click();
    check('#10 ...which leaves out the gears that matched and keeps the earlier answers', st.check.phase === 'run' && st.check.prev.length === 4);
    app.$('rckQuit').click();
    app.$('rckClose').click();
    const app2 = mk(); const st2 = app2.M3.state;
    await app2.upPass();
    app2.$('upContinue').click();
    await app2.downPass(23, 2);
    await app2.f('K,1,120.0,3.00,6,saved');
    await app2.f('F,end,0');
    await app2.f(S({}));
    app2.$('glFinish').click();
    check('#9 Finish and ride: off to the Ride tab, nothing left to resume', st2.view === 'ride' && !st2.check &&
      (app2.win.flowRecord() || {}).checkDone === true);
  }
  {
    // #11: unsure (yellow) gears from the run itself, and a full improve pass over red and yellow
    const app = mk(); const st = app.M3.state;
    await app.f(S({}));
    await app.f(S({ cal: 3, flow: 2, pass: 'u' }));
    for (let p = 1; p <= 24; p++) {
      await app.f(S({ cal: 1, flow: 4, step: p - 1, pass: 'u' }));
      if (p === 5) { await app.f('W,5,1.4,1.6'); await app.f('W,5,1.2,1.0'); }   // gear 5 took 3 tries to settle
      await app.f('C,' + p + ',' + (p === 10 ? '27.5' : (p * 3).toFixed(1)) + ',1.0,2.0');   // gear 9 very narrow (0.5 vs 3 uT)
    }
    await app.f('C,25,75.0,1.0,2.0');
    await app.f('K,1,120.0,3.00,6,saved');
    await app.f('F,end,0');
    await app.f(S({ cal: 7, flow: 4, step: 22, pass: 'd' }));
    app.$('upContinue').click();
    await app.downPass(23, 2);
    await app.f('K,1,120.0,3.00,6,saved');
    await app.f('F,u,15,behind,1.0,2.0,3.0');
    await app.f('F,end,1');
    await app.f(S({}));
    const q = app.win.gearQuality();
    check('#11 quality: flagged gear red, a very narrow gear and a gear that took tries yellow, the rest green',
      q[15].level === 2 && q[9].level === 1 && q[5].level === 1 && [1, 2, 3, 4, 6, 7, 8, 10, 11, 12, 20, 24].every((g) => q[g].level === 0),
      [5, 9, 15].map((g) => g + ':' + q[g].level).join(' '));
    check('#11 the gear list offers "Improve 3 gears"', $ok(app.$('glImprove')) && app.$('glImprove').textContent === 'Improve 3 gears', app.$('glImprove').textContent);
    app.$('glImprove').click();
    const redo = async (point, x) => {                            // the bridge redoes one up point and saves
      await app.advance(0.5);
      await app.f('E,ok,redo');
      await app.f(S({ cal: 1, flow: 6, step: point - 1, pass: 'ru' }));
      await app.f('C,' + point + ',' + x + ',1.0,2.0');
      await app.f('E,ok,saved');
      await app.f('K,1,120.0,3.00,6,saved');
      await app.f('F,end,0');
      await app.f(S({}));
    };
    const sent = () => app.cmds().filter((c) => /^#R/.test(c));
    await redo(15, '45.0');
    await redo(5, '15.0');
    await redo(10, '30.0');
    check('#11 Improve redoes the red gear first, then the yellow ones in order', JSON.stringify(sent()) === '["#R,u,15","#R,u,5","#R,u,10"]', JSON.stringify(sent()));
    check('#11 ...then the gear list again: 3 of 3 improved, every gear good', !!st.gearList && /^3 of 3 gears improved\. Every gear looks good\.$/.test(app.$('glLead').textContent),
      app.$('glLead').textContent);
  }
  {
    // #12: the Calibrate tab opens on the stored calibration's gear list; after a reload the yellow
    // reasons from the run (hold-still tries, go-backs) come back from the saved file (# point_stats)
    const app = mk();
    const up = (p) => (p === 10 ? '27.5' : (p * 3).toFixed(1));
    await app.f(S({}));
    await app.f(S({ cal: 3, flow: 2, pass: 'u' }));
    for (let p = 1; p <= 24; p++) {
      await app.f(S({ cal: 1, flow: 4, step: p - 1, pass: 'u' }));
      if (p === 5) { await app.f('W,5,1.4,1.6'); await app.f('W,5,1.2,1.0'); }
      await app.f('C,' + p + ',' + up(p) + ',1.0,2.0');
    }
    await app.f('C,25,75.0,1.0,2.0');
    await app.f('K,1,120.0,3.00,6,saved');
    await app.f('F,end,0');
    await app.f(S({ cal: 7, flow: 4, step: 22, pass: 'd' }));
    app.$('upContinue').click();
    await app.downPass(23, 2);
    await app.f('K,1,120.0,3.00,6,saved');
    await app.f('F,u,15,behind,1.0,2.0,3.0');
    await app.f('F,end,1');
    await app.f(S({}));
    const csv = app.win.getCsv(app.win.calRecordId()) || '';
    check('#12 the saved calibration file carries the point stats', /^# point_stats: u5 w=2$/m.test(csv), (csv.match(/^# point_stats.*$/m) || ['none'])[0]);
    // reload: a fresh page on the same phone storage
    const app2 = loadApp({ search: '' }); Object.assign(app2.store, app.store); app2.win.loadRecords(); app2.connect();
    const st2 = app2.M3.state, nRec = app2.win.records.length;
    let t2 = 1; const f2 = async (l) => { t2 += 0.05; await app2.feed(t2, l); };
    await f2(S({}));
    app2.win.showView('cal'); app2.M3.render();
    await app2.advance(0.1);
    check('#12 opening Calibrate on a calibrated bridge reads the calibration back quietly', app2.commands().some((c) => c.cmd === 'k'));
    for (let p = 1; p <= 25; p++) await f2('Q,' + p + ',' + (p === 25 ? '75.0' : up(p)) + ',1.0,2.0');
    for (let p = 23; p >= 2; p--) await f2('Q,down,' + p + ',' + (p * 3 - 1) + '.0,1.0,2.0');
    await f2('Q,end,120.0,3.00,6');
    await f2('F,u,15,behind,1.0,2.0,3.0');
    await f2('F,end,1');
    await f2(S({}));
    const q2 = app2.win.gearQuality();
    check('#12 ...and opens on its gear list (Your calibration), not the walkthrough', !app2.$('gearList').hidden && app2.$('onb').hidden &&
      app2.$('glTitle').textContent === 'Your calibration' && !app2.$('glAgain').hidden && app2.$('glImprove').textContent === 'Improve calibration',
      app2.$('glTitle').textContent);
    check('#12 ...with the red flag, the narrow gear, and the hold-still tries restored from the saved file', q2[15].level === 2 && q2[9].level === 1 && q2[5].level === 1,
      [5, 9, 15].map((g) => g + ':' + q2[g].level).join(' '));
    check('#12 ...without saving a "Stored calibration" record or a review card', app2.win.records.length === nRec && app2.$('reviewCard').hidden && !st2.review);
    app2.$('glAgain').click();
    check('#12 Calibrate again shows the walkthrough', app2.$('gearList').hidden && !app2.$('onb').hidden);
  }
  {
    // pass 1 issues on the gear list (#11 / #12)
    const app = mk(); const st = app.M3.state;
    await app.upPass();
    app.$('upContinue').click();
    await app.downPass(23, 2);
    await app.f('K,1,120.0,3.00,6,saved');
    await app.f('F,end,0');
    await app.f(S({}));
    const csv = app.win.getCsv(app.win.calRecordId()) || '';
    check('#37 a clean run\'s file still has its point_stats line (none)', /^# point_stats: none$/m.test(csv));
    app.$('glCheck').click();
    app.M3.checkAnswer(5);
    st.check.picking = true; st.check.app = 12; st.check.val = 12; app.win.renderRideCheck();
    check('#28 after No, Save stays off until another gear is picked', app.$('rckSave').disabled === true);
    st.check.val = 13; app.win.renderRideCheck();
    check('#28 ...and comes on for another gear', app.$('rckSave').disabled === false);
    // #22: a reconnect reads the Calibrate tab's list again
    app.$('rckQuit').click(); app.$('rckClose').click(); app.$('glFinish').click();
    app.M3.setConn('disconnected'); app.connect();
    await app.f(S({}));
    app.win.showView('cal'); app.M3.render(); await app.advance(0.1);
    check('#22 after a reconnect the Calibrate tab reads the calibration again (k)', app.cmds().filter((c) => c === 'k').length === 1 &&
      app.$('gearList').hidden, JSON.stringify(app.cmds().slice(-2)));
    // #17: its F list never comes: the page stops waiting for it
    for (let p = 1; p <= 25; p++) await app.f('Q,' + p + ',' + (p * 3) + '.0,1.0,2.0', 0.02);
    for (let p = 23; p >= 2; p--) await app.f('Q,down,' + p + ',' + (p * 3 - 1) + '.0,1.0,2.0', 0.02);
    await app.f('Q,end,120.0,3.00,6', 0.02);   // ...and its F,end is lost
    await app.f(S({}), 6);
    check('#17 a lost quiet F list is not waited for (the next F list is not swallowed)', !st.qQuietF && !app.$('gearList').hidden);
  }
  {
    // #21: Use best guess on a gear still flagged after 2 redos ends the improve pass
    const app = mk(); const st = app.M3.state;
    await app.upPass();
    app.$('upContinue').click();
    await app.downPass(23, 2);
    await app.f('K,1,120.0,3.00,6,saved');
    await app.f('F,u,15,behind,1.0,2.0,3.0');
    await app.f('F,end,1');
    await app.f(S({}));
    app.$('glImprove').click();
    for (let i = 0; i < 2; i++) {                                 // two redos, still flagged
      await app.advance(0.5);
      await app.f('E,ok,redo');
      await app.f(S({ cal: 1, flow: 6, step: 14, pass: 'ru' }));
      await app.f('C,15,45.0,1.0,2.0');
      await app.f('E,ok,saved');
      await app.f('K,1,120.0,3.00,6,saved');
      await app.f('F,u,15,behind,1.0,2.0,3.0');
      await app.f('F,end,1');
      await app.f(S({}));
    }
    app.win.fixAction('guess');                                   // the card's Use best guess
    await app.f('E,ok,saved');
    await app.f('K,1,120.0,3.00,6,saved');
    await app.f('F,end,0');
    await app.f(S({}));
    check('#21 Use best guess after 2 redos ends the improve pass (back to the list)', !st.review && !!st.gearList,
      'review ' + (st.review && st.review.items.length) + ' list ' + !!st.gearList);
  }
  {
    // #41 keep it as it is; #39 the check after Improve; #40 a check mismatch shows on the list; #45 no old result card
    const app = mk(); const st = app.M3.state;
    await app.upPass();
    app.$('upContinue').click();
    await app.downPass(23, 2);
    await app.f('K,1,120.0,3.00,6,saved');
    await app.f('F,u,15,behind,1.0,2.0,3.0');
    await app.f('F,u,8,behind,1.0,2.0,3.0');
    await app.f('F,end,2');
    await app.f(S({}));
    check('#45 the gear list hides the old result card', app.$('resultCard').hidden);
    app.$('glImprove').click();                                   // first: gear 8
    await app.advance(0.5);
    await app.f('E,ok,redo');
    await app.f(S({ cal: 1, flow: 6, step: 7, pass: 'ru' }));
    app.win.fixAction('skip');                                    // Skip on the redo screen = keep gear 8 as it is
    await app.f('A,cancelled by user');                           // (the bridge cancels the redo)
    await app.f(S({}));
    await app.advance(1);
    await app.f('E,ok,redo');                                     // then gear 15, redone fine
    await app.f(S({ cal: 1, flow: 6, step: 14, pass: 'ru' }));
    await app.f('C,15,45.0,1.0,2.0'); await app.f('E,ok,saved'); await app.f('K,1,120.0,3.00,6,saved');
    await app.f('F,u,8,behind,1.0,2.0,3.0'); await app.f('F,end,1'); await app.f(S({}));
    check('#41 a gear kept as it is is no longer offered by Improve', !!st.gearList && app.$('glImprove').hidden, app.$('glImprove').textContent);
    app.$('glCheck').click();
    check('#39 the check after Improve includes the improved gears', st.check.list.some((c) => c.gear === 15) && st.check.list.some((c) => c.gear === 8),
      st.check.list.map((c) => c.gear).join(' '));
    while (st.check.phase === 'run') { const c = st.check.list[st.check.idx]; app.M3.checkAnswer(c.gear === 15 ? 16 : c.gear); }
    app.$('rckClose').click();
    check('#40 a gear the check found off shows on the list', app.win.gearQuality()[16].level === 2 && /console showed gear 16/.test(app.win.gearQuality()[16].why.join(' ')),
      JSON.stringify(app.win.gearQuality()[16].why));
  }
  {
    // #56: a match later in the same gear check doesn't erase that check's own mismatch; #30 Done -> "Your gears"
    const app = mk(); const st = app.M3.state;
    await app.upPass();
    app.$('upContinue').click();
    await app.downPass(23, 2);
    await app.f('K,1,120.0,3.00,6,saved');
    await app.f('F,end,0');
    await app.f(S({ gear: 12 }));
    app.$('glCheck').click();
    st.check.list = [{ gear: 12, pace: 'easy', label: 'Gear 12, easy', task: '' }, { gear: 12, pace: 'fast', label: 'Gear 12, faster', task: '' }];
    st.check.askGear = 12; app.M3.checkAnswer(13);               // bridge 12, console 13: the edge at 13 is off
    st.check.askGear = 13; app.M3.checkAnswer(13);               // then bridge 13, console 13 (same check)
    app.$('rckClose').click();
    check('#56 a later match in the same check keeps its mismatch on the list', app.win.gearQuality()[13].level === 2);
    check('#30 Done after the check: the list says "Your gears"', app.$('glTitle').textContent === 'Your gears', app.$('glTitle').textContent);
  }
  {
    // #20: a run deleted on another page (same origin) doesn't come back
    const a = mk(), b = mk();
    b.store = a.store; b.win.localStorage = a.win.localStorage;
    addDiag(a, 1, 1000); addDiag(a, 2, 1000);
    b.win.loadRecords();
    b.win.removeRecord(b.win.findRecord('r1')); b.win.saveIndex();
    addDiag(a, 3, 1000);
    check('#20 a run deleted on the other page stays deleted', index(a).indexOf('r1') < 0, 'index ' + index(a));
  }
  {
    // crank not found: the reason stays on screen; the hold-still notice and the circle agree
    const app = mk();
    await app.f(S({}));
    await app.f(S({ cal: 3, flow: 2, pass: 'u' }));
    await app.f('L,0,6,70,6.1,dip too shallow');
    await app.f(S({ cal: 1, flow: 4, step: 0, pass: 'u' }));
    check('crank not found: the reason stays on screen', /Crank not found: dip too shallow/.test(app.$('calCount').textContent), app.$('calCount').textContent);
  }
  {
    // #6: the real log of the first v3.3 bike calibration: two quick Undos straight after the start of the up pass
    const { readLog } = require('./harness');
    const path = require('path');
    const log = readLog(path.join(__dirname, '..', '..', 'logs', '2026-10-17_v3_3_cal.log'));
    const app = loadApp({ search: '' }); app.connect(); const st = app.M3.state;
    const seen = {};
    for (const [t, text] of log) {
      if (t > 260) break;
      await app.feed(t, text);
      if (/^C,1,/.test(text) && seen.c1t === undefined) seen.c1t = t;
      if (seen.c1t && t >= seen.c1t + 1.5 && seen.c1 === undefined) seen.c1 = app.$('calSub').textContent;   // 1.5 s later
      if (t >= 240.04 && t < 240.1) seen.afterUndo = st.points.length;
      if (t >= 241.14 && t < 241.2) seen.retaken = st.points.map((p) => p.point).join(',');
    }
    check('#6 replay: the bottom taken just after the sweep shows as saved', /Bottom saved/.test(seen.c1 || ''), seen.c1);
    check('#6 replay: two quick Undos leave no points, the bottom is taken again cleanly',
      seen.afterUndo === 0 && seen.retaken === '1' && app.errors.length === 0, JSON.stringify(seen));
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
    check('hold-still method (crank not found): no Saved checkpoint, the gear list follows', !st.upSaved && !st.fixHold && !!st.gearList,
      'upSaved ' + st.upSaved + ' gear list ' + !!st.gearList);
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
    app.$('glImprove').click();                                  // the gear list: Improve
    await app.advance(1);
    check('Later, then Continue down (#D): the gear list improves the flagged gear', app.cmds().some((c) => /^#R,u,20/.test(c)),
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
    check('the F,end after the down pass is lost: the gear list comes anyway', !!st.gearList, String(!!st.gearList));
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
    check('dismissing the result card does not stop the gear list (step 6 offer)', !!st.gearList);
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
    start6(app);
    const far = st.check.list[0].gear > 12 ? 1 : 24;   // a gear far from the first check's
    for (let i = 0; i < 100; i++) await app.f(S({ gear: far, flags: 'V', cad: '0.0', src: '-' }), 0.25);   // 25 s rest
    for (let i = 0; i < 16; i++) await app.f(S({ gear: far, cad: '75.0' }), 0.25);   // 4 s pedalling there
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
    start6(app);
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
