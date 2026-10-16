// Runs webapp/index.html's main script in node with a tiny DOM stub and a virtual clock,
// so real board lines can be fed through the page's own parser (handleLine).
//
//   const app = loadApp({ search: '' });        // '' = Bluetooth mode, '?demo=1&v3=1' = simulator
//   app.connect();                               // state.conn = 'connected'; writes go to app.writes
//   await app.feed(12.34, 'S,1,...');            // advance the clock to t=12.34 s, then handleLine
//   await app.advance(5);                            // run timers for 5 more seconds
//   app.$('calHead').textContent, app.M3.state ...
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PAGE = path.join(__dirname, '..', '..', '..', 'webapp', 'index.html');

function loadApp(opts) {
  opts = opts || {};
  const html = fs.readFileSync(opts.page || PAGE, 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let main = scripts[scripts.length - 1];
  // Older pages (e.g. `git show f371c10:webapp/index.html`) lack the test hooks: patch them in.
  if (main.indexOf('__m3Write') < 0) {
    main = main.replace('function writeChar(c) {',
      "function writeChar(c) {\n    if (typeof window.__m3Write === 'function') { window.__m3Write(c); return Promise.resolve(); }");
  }
  if (!/setConn: setConn/.test(main)) {
    main = main.replace(/\}\)\(\);\s*$/, 'window.M3Bridge.setConn = setConn; window.M3Bridge.render = render;\n})();');
  }

  // ---------- virtual clock ----------
  let now = 1.8e12;
  let timers = [];
  let nextId = 1;
  function setT(fn, ms, repeat) {
    const id = nextId++;
    timers.push({ id, fn, at: now + Math.max(0, +ms || 0), every: repeat ? Math.max(1, +ms || 0) : 0 });
    return id;
  }
  function clearT(id) { timers = timers.filter((t) => t.id !== id); }
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  async function runUntil(t) {
    await flush();
    for (let guard = 0; guard < 100000; guard++) {
      let due = null;
      for (const tm of timers) if (tm.at <= t && (!due || tm.at < due.at)) due = tm;
      if (!due) break;
      now = Math.max(now, due.at);
      if (due.every) due.at += due.every; else clearT(due.id);
      try { due.fn(); } catch (e) { errors.push(e); }
      await flush();
    }
    now = Math.max(now, t);
  }
  const errors = [];

  // ---------- DOM stub ----------
  const byId = {};
  class HTMLElement {
    constructor(tag, id) {
      this.tagName = (tag || 'div').toUpperCase(); this.id = id || ''; this.hidden = false;
      this._text = ''; this._html = ''; this.className = ''; this.value = ''; this.disabled = false;
      this.style = {}; this.dataset = {}; this.attrs = {}; this.childNodes = []; this.parentNode = null;
      this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0; this.content = '';
      const self = this;
      this.classList = {
        add(...c) { const s = new Set(self.className.split(/\s+/).filter(Boolean)); c.forEach((x) => s.add(x)); self.className = [...s].join(' '); },
        remove(...c) { self.className = self.className.split(/\s+/).filter((x) => x && c.indexOf(x) < 0).join(' '); },
        toggle(c, on) { const has = this.contains(c); if (on === undefined) on = !has; if (on) this.add(c); else this.remove(c); return on; },
        contains(c) { return self.className.split(/\s+/).indexOf(c) >= 0; },
      };
    }
    get children() { return this.childNodes.filter((c) => c instanceof HTMLElement); }
    get firstChild() { return this.childNodes[0] || null; }
    get textContent() { return this._text + this.childNodes.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.childNodes = []; }
    get innerHTML() { return this._html; }
    set innerHTML(v) { this._html = String(v); this._text = String(v).replace(/<[^>]*>/g, ''); this.childNodes = []; }
    get innerText() { return this.textContent; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'hidden') this.hidden = true; }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; if (k === 'hidden') this.hidden = false; }
    hasAttribute(k) { return k in this.attrs; }
    addEventListener() {} removeEventListener() {}
    appendChild(c) { this.childNodes.push(c); c.parentNode = this; return c; }
    removeChild(c) { this.childNodes = this.childNodes.filter((x) => x !== c); return c; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    getElementsByTagName(t) { return this.children.filter((c) => c.tagName === t.toUpperCase()); }
    closest() { return null; }
    scrollIntoView() {} focus() {} select() {} setSelectionRange() {} click() {}
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  }
  // Every id the page's HTML defines exists; a cadence dot needs a parent.
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) byId[m[1]] = new HTMLElement('div', m[1]);
  if (byId.cadDot) byId.cadDot.parentNode = new HTMLElement('b');
  const docEl = new HTMLElement('html');
  const document = {
    documentElement: docEl, body: new HTMLElement('body'), visibilityState: 'visible',
    getElementById: (id) => byId[id] || null,
    createElement: (t) => new HTMLElement(t),
    createTextNode: (t) => ({ textContent: String(t) }),
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {},
  };
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const writes = [];
  const win = {
    document, localStorage, navigator: { vibrate() { return true; } },
    location: { search: opts.search || '' },
    URLSearchParams, TextEncoder, TextDecoder, HTMLElement, console,
    performance: { now: () => now },
    setTimeout: (f, ms) => setT(f, ms, false), clearTimeout: clearT,
    setInterval: (f, ms) => setT(f, ms, true), clearInterval: clearT,
    Promise, Blob: function () {}, URL: { createObjectURL: () => '', revokeObjectURL() {} },
    __m3Write: (c) => { writes.push({ t: (now - 1.8e12) / 1000, text: c }); },
  };
  win.window = win;
  const RealDate = Date;
  win.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [now])); }
    static now() { return now; }
  };
  const ctx = vm.createContext(win);
  vm.runInContext(main, ctx, { filename: 'index.html<script>' });
  const M3 = win.M3Bridge;
  return {
    M3, writes, errors, store,
    $: (id) => byId[id],
    t: () => (now - 1.8e12) / 1000,
    connect() { M3.setConn('connected'); },
    async feed(tSec, line) { await runUntil(1.8e12 + tSec * 1000); M3.handleLine(line); await flush(); },
    async advance(sec) { await runUntil(now + sec * 1000); },
    // all '#...' commands as complete strings (pieces joined up to \n)
    commands() {
      const out = []; let buf = null;
      for (const w of writes) for (const ch of w.text) {
        if (buf !== null) { if (ch === '\n') { out.push({ t: w.t, cmd: buf }); buf = null; } else buf += ch; }
        else if (ch === '#') buf = '#';
        else out.push({ t: w.t, cmd: ch });
      }
      return out;
    },
  };
}

// Board log lines: "  801.03  K,1,..." -> [t, text]. Drops ### / >>> notes and the R / T streams.
function readLog(file) {
  const out = [];
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([\d.]+)  (.*)$/.exec(raw);
    if (!m) continue;
    const text = m[2];
    if (text.startsWith('###') || text.startsWith('>>>') || /^[RT],/.test(text)) continue;
    out.push([+m[1], text]);
  }
  return out;
}

module.exports = { loadApp, readLog };
