// M3 Bridge phone page: Saved runs on this phone (localStorage), CSV files, Share / Download / Copy, and the flow record
// behind the resume offers.
// Classic script sharing the page's global scope; index.html loads the files in order (see its loader).
'use strict';

// ===================================================================
// Saved records (localStorage, ~4 MB cap, oldest dropped first)
// ===================================================================
var STORE_IDX = 'm3bridge.records';
var STORE_PREFIX = 'm3bridge.rec.';
var STORE_CAP = 4 * 1024 * 1024;   // characters
var records = [];                  // newest first: {id, type, source, ts, title, summary, filename, size, persisted}
var memCsv = {};                   // id -> csv (this session)

function loadRecords() {
  try {
    var j = localStorage.getItem(STORE_IDX);
    var a = j ? JSON.parse(j) : [];
    records = Array.isArray(a) ? a.filter(function (r) { return r && r.id && r.filename; }) : [];
    records.forEach(function (r) { r.persisted = true; });
  } catch (e) { records = []; }
}
// Another page on this origin (the published page and a preview, or a second tab) may have saved
// runs since this one loaded: keep those whose data is still there (minus what this page removed).
var removedIds = {};
function adoptOtherPagesRecords() {
  var stored;
  try { stored = JSON.parse(localStorage.getItem(STORE_IDX)); } catch (e) { stored = null; }
  if (!Array.isArray(stored)) return;
  var known = {};
  records.forEach(function (r) { known[r.id] = true; });
  var added = false;
  stored.forEach(function (r) {
    if (!r || !r.id || !r.filename || known[r.id] || removedIds[r.id]) return;
    var has = false;
    try { has = localStorage.getItem(STORE_PREFIX + r.id) !== null; } catch (e) {}
    if (!has) return;
    r.persisted = true;
    records.push(r); added = true;
  });
  if (added) records.sort(function (a, b) { return a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0; });   // newest first
}
function saveIndex() {
  adoptOtherPagesRecords();
  // runs whose data another page removed (deleted, or dropped for room) leave this page's list too
  records = records.filter(function (r) {
    if (!r.persisted) return true;
    try { return localStorage.getItem(STORE_PREFIX + r.id) !== null; } catch (e) { return true; }
  });
  try {
    localStorage.setItem(STORE_IDX, JSON.stringify(records.filter(function (r) { return r.persisted; })));
    return true;
  } catch (e) { return false; }
}
function getCsv(id) {
  if (memCsv[id]) return memCsv[id];
  try { return localStorage.getItem(STORE_PREFIX + id); } catch (e) { return null; }
}
function findRecord(id) {
  for (var i = 0; i < records.length; i++) if (records[i].id === id) return records[i];
  return null;
}
function oldestPersisted(except) {
  for (var i = records.length - 1; i >= 0; i--) if (records[i].persisted && records[i] !== except) return records[i];
  return null;
}
function removeRecord(r) {
  removedIds[r.id] = true;
  try { localStorage.removeItem(STORE_PREFIX + r.id); } catch (e) {}
  delete memCsv[r.id];
  records = records.filter(function (x) { return x !== r; });
}
// Write a record's CSV, removing the oldest other saved runs while storage is full (each one
// removed is added to dropped). True once written.
// (Once the runs removed have freed what it needs and it still fails, the space is taken by
// something else: stop removing runs.)
function storeCsv(rec, csv, dropped) {
  var need = csv.length - (rec.persisted ? rec.storedSize || rec.size || 0 : 0), freed = 0;
  for (var attempt = 0; attempt < 50; attempt++) {
    try {
      localStorage.setItem(STORE_PREFIX + rec.id, csv);
      rec.storedSize = csv.length;
      return true;
    } catch (e) {
      var o = freed < need ? oldestPersisted(rec) : null;
      if (!o) return false;
      freed += o.size || 0;
      removeRecord(o); dropped.push(o);
    }
  }
  return false;
}
// Write the index the same way (it grows with each record).
function saveIndexMakingRoom(keep, dropped) {
  for (var attempt = 0; attempt < 50; attempt++) {
    if (saveIndex()) return true;
    var o = oldestPersisted(keep);
    if (!o) return false;
    removeRecord(o); dropped.push(o);
  }
  return false;
}
function noteDropped(dropped) {
  if (!dropped.length) return;
  var msg = 'Storage full: removed ' + dropped.length + ' oldest saved run' + (dropped.length > 1 ? 's' : '') +
    ' (' + dropped.map(function (d) { return d.filename; }).join(', ') + ').';
  logLine(msg, 'sys');
  toast('Storage full: removed oldest saved run');
}
function storedTotal(except) {
  var t = 0;
  records.forEach(function (r) { if (r.persisted && r !== except) t += r.size || 0; });
  return t;
}

function addRecord(meta, csv) {
  // keep filenames unique when two records land in the same minute
  var base = meta.filename.replace(/\.csv$/, ''), name = meta.filename, n = 2;
  while (records.some(function (r) { return r.filename === name; })) name = base + '-' + (n++) + '.csv';
  meta.filename = name;
  meta.size = csv.length;
  meta.build = APP_BUILD;   // also in the saved list's index (older pages' records have none)
  meta.persisted = false;
  memCsv[meta.id] = csv;
  records.unshift(meta);
  var dropped = [];
  if (meta.size <= STORE_CAP) {
    while (storedTotal(meta) + meta.size > STORE_CAP) {
      var old = oldestPersisted(meta);
      if (!old) break;
      removeRecord(old); dropped.push(old);
    }
    meta.persisted = storeCsv(meta, csv, dropped);
  }
  if (meta.persisted && !saveIndexMakingRoom(meta, dropped)) {
    // index could not be written: undo so storage stays consistent
    try { localStorage.removeItem(STORE_PREFIX + meta.id); } catch (e) {}
    meta.persisted = false;
  }
  if (dropped.length || !meta.persisted) saveIndex();   // runs removed above must leave the stored index too
  noteDropped(dropped);
  if (!meta.persisted) {
    logLine('Could not keep ' + meta.filename + ' on this device. Export it before closing the page.', 'bad');
    toast('Not saved on this device. Export it now.');
  }
  renderSaved();
  return meta.id;
}

// ---- CSV helpers ----
function csvCell(v) {
  v = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function ascii(s) {
  return String(s).replace(/[–—]/g, '-').replace(/µ/g, 'u').replace(/[\r\n]+/g, ' ');
}
function z2(n) { return (n < 10 ? '0' : '') + n; }
function fileStamp(d) {
  return d.getFullYear() + '-' + z2(d.getMonth() + 1) + '-' + z2(d.getDate()) + '-' + z2(d.getHours()) + z2(d.getMinutes());
}
function newId(d) { return d.getTime().toString(36) + Math.floor(Math.random() * 1296).toString(36); }
function dist3(a, b) {
  if (!a || !b || !fin(a.x) || !fin(a.y) || !fin(a.z) || !fin(b.x) || !fin(b.y) || !fin(b.z)) return NaN;
  return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2) + Math.pow(a.z - b.z, 2));
}
function mmss(ms) {
  var s = Math.max(0, Math.round(ms / 1000));
  return Math.floor(s / 60) + ':' + z2(s % 60);
}

function saveCalRecord(source, info, pointsIn) {
  var d = new Date();
  var pts = pointsIn.slice().sort(function (a, b) { return a.point - b.point; });
  var downs = info.down ? info.down.slice() : null;   // [v3.2] null = firmware without a down pass
  var stored = source === 'stored';
  var result = stored ? 'stored' : info.partial ? 'incomplete (' + pts.length + ' of ' + TOTAL_POINTS + ' points)' : (info.ok ? 'saved' : 'rejected');
  var lines = [
    '# Keiser M3 Bridge calibration',
    '# record: calibration',
    '# source: ' + (stored ? 'stored (read back from the bridge with k)' : 'calibration run'),
    '# timestamp: ' + d.toISOString(),
    '# page_build: ' + APP_BUILD,   // which phone page saved it (pages before v3.3-2026-10-17 have no such line)
    '# result: ' + result,
    '# span_uT: ' + (fin(info.span) ? info.span.toFixed(1) : ''),
    '# minstep_uT: ' + (fin(info.minstep) ? info.minstep.toFixed(1) : ''),
    '# minstep_at_gear: ' + (fin(info.minAt) ? info.minAt : ''),
    '# message: ' + ascii(info.msg || ''),
    '# points: ' + pts.length + ' of ' + TOTAL_POINTS,
    (info.crank ? '# crank: ux=' + fmt(info.crank.ux, 3) + ', uy=' + fmt(info.crank.uy, 3) + ', uz=' + fmt(info.crank.uz, 3) +
      ', depth_uT=' + fmt(info.crank.depth, 1) + ', sign=' + (fin(info.crank.sign) ? info.crank.sign : '') : null),
    (info.edit ? '# edit: ' + ascii(info.edit) : null),
    '# labels: point 1 = lever all the way down (Bottom); points 2-24 = where the console first shows that gear; point 25 = lever all the way up (Top)',
    // [v3.3] how each point went (#11 / #12): hold-still tries (w) and go-backs (back), e.g. "u5 w=3; d12 back=1"
    (!stored ? '# point_stats: ' + (pointStatsText() || 'none') : null),
    // [v3.2] down points: same gear edge as the up point, approached from above
    (downs ? '# down_points: ' + downs.length + ' of ' + DOWN_POINTS + ' (down point N = coming down, where the console first shows gear N-1; empty when not measured)' : null),
    'point,label,x_uT,y_uT,z_uT,dist_prev_uT' + (downs ? ',down_x_uT,down_y_uT,down_z_uT' : '')
  ].filter(function (l) { return l !== null; });
  var downBy = {};
  if (downs) downs.forEach(function (q) { downBy[q.point] = q; });
  for (var i = 0; i < pts.length; i++) {
    var p = pts[i];
    var prev = i > 0 && pts[i - 1].point === p.point - 1 ? pts[i - 1] : null;
    var dd = dist3(p, prev), dn = downBy[p.point];
    var row = [p.point, pointLabel(p.point), fmt(p.x, 1), fmt(p.y, 1), fmt(p.z, 1), fin(dd) ? dd.toFixed(2) : ''];
    if (downs) row = row.concat(dn ? [fmt(dn.x, 1), fmt(dn.y, 1), fmt(dn.z, 1)] : ['', '', '']);
    lines.push(row.map(function (v) { return csvCell(v === '--' ? '' : v); }).join(','));
  }
  var title = stored ? 'Stored calibration' : info.partial ? 'Calibration incomplete' : (info.ok ? (info.edit ? 'Calibration edited' : 'Calibration saved') : 'Calibration rejected');
  var summary = info.partial
    ? 'incomplete (' + pts.length + ' of ' + TOTAL_POINTS + ' points) · ' + info.msg
    : 'Span ' + fmt(info.span, 1) + ' µT · smallest step ' + fmt(info.minstep, 1) + ' µT' +
    (fin(info.minAt) ? ' at gear ' + info.minAt : '') + ' · ' + pts.length + ' points' +
    (downs ? ' · down ' + downs.length + ' of ' + DOWN_POINTS : '') +
    (info.edit ? ' · ' + info.edit : '') +
    (!stored && !info.ok && info.msg ? ' · ' + info.msg : '');
  return addRecord({
    id: newId(d), type: 'cal', source: source, partial: !!info.partial, ts: d.toISOString(), title: title, summary: summary,
    filename: 'keiser-cal-' + fileStamp(d) + '.csv'
  }, lines.join('\n') + '\n');
}

// Add '#' comment lines to a saved record, just above its header row (e.g. the gear check).
// replace {line, summary}: first drop the comment lines starting with '# ' + line and the summary
// part starting with summary (an earlier run of the same thing).
function appendRecordComments(id, comments, summaryAdd, replace) {
  var rec = findRecord(id), csv = rec ? getCsv(id) : null;
  if (!rec || csv === null || csv === undefined) return false;
  var lines = csv.split('\n'), at = 0;
  if (replace) {
    lines = lines.filter(function (l) { return l.indexOf('# ' + replace.line) !== 0; });
    rec.summary = rec.summary.split(' · ').filter(function (part) { return part.indexOf(replace.summary) !== 0; }).join(' · ');
  }
  while (at < lines.length && lines[at].charAt(0) === '#') at++;
  lines.splice.apply(lines, [at, 0].concat(comments.map(function (c) { return '# ' + ascii(c); })));
  csv = lines.join('\n');
  memCsv[id] = csv;
  var oldSummary = rec.summary, oldSize = rec.size;
  if (summaryAdd) rec.summary += ' · ' + summaryAdd;
  if (rec.persisted) {
    // If even removing older runs doesn't make room, the stored copy (without these lines) stays
    // listed as it is stored, and the new lines are kept for this session only.
    var dropped = [];
    var ok = storeCsv(rec, csv, dropped);
    if (ok) rec.size = csv.length; else { rec.summary = oldSummary; rec.size = oldSize; }
    saveIndex();
    if (!ok) { rec.summary += summaryAdd ? ' · ' + summaryAdd : ''; rec.size = csv.length; }   // (this session shows them)
    noteDropped(dropped);
    if (!ok) {
      logLine('Could not add these lines to ' + rec.filename + ' on this device. Export it before closing the page.', 'bad');
      toast('Not saved on this device. Export it now.');
    }
  }
  renderSaved();
  return true;
}

function saveDiagRecord(dump) {
  var d = new Date();
  var n = dump.x.length;
  var markers = dump.markers.slice().sort(function (a, b) { return a.index - b.index || a.k - b.k; });
  var t = new Array(n), acc = 0;
  for (var i = 0; i < n; i++) { acc += i === 0 ? 0 : dump.dt[i]; t[i] = acc; }
  function labelFor(k) { return diag.labelByK[k] || ('marker ' + k); }
  var lines = [
    '# Keiser M3 Bridge diagnostic recording',
    '# record: diagnostic',
    '# timestamp: ' + d.toISOString(),
    '# page_build: ' + APP_BUILD,
    '# samples: ' + n,
    '# period_ms: ' + dump.period,
    '# duration_ms: ' + (n ? t[n - 1] : 0),
    '# checksum: ' + dump.checksum + ' (verified)',
    '# firmware: ' + (diag.gstop ? (diag.gstop.full ? 'G,full' : 'G,stop') + ' count=' + diag.gstop.count + ' duration_ms=' + diag.gstop.duration : 'no G,stop seen'),
    '# lean_step: ' + (diag.lean ? 'yes' : 'no') + (FAST > 1 ? '; fast mode (step times / ' + FAST + ')' : ''),
    '# units: x/y/z in uT (raw, 0.1 uT resolution); t_ms cumulative from dt; revs empty when no cadence pod',
    '# markers: k,index,t_ms,step'
  ];
  markers.forEach(function (m) {
    lines.push('# ' + m.k + ',' + m.index + ',' + (m.index < n ? t[m.index] : '') + ',' + csvCell(ascii(labelFor(m.k))));
  });
  lines.push('i,t_ms,step,x_uT,y_uT,z_uT,revs');
  var mi = 0, cur = '';
  for (var j = 0; j < n; j++) {
    while (mi < markers.length && markers[mi].index <= j) { cur = csvCell(ascii(labelFor(markers[mi].k))); mi++; }
    var r = dump.r[j];
    lines.push(j + ',' + t[j] + ',' + cur + ',' + (dump.x[j] / 10).toFixed(1) + ',' + (dump.y[j] / 10).toFixed(1) + ',' +
      (dump.z[j] / 10).toFixed(1) + ',' + (r === -1 ? '' : r));
  }
  var summary = n + ' samples · ' + mmss(n ? t[n - 1] : 0) + ' · ' + markers.length + (markers.length === 1 ? ' step marker' : ' step markers') + ' · checksum OK' +
    (diag.full ? ' · memory filled' : '');
  return addRecord({
    id: newId(d), type: 'diag', source: 'run', ts: d.toISOString(), title: 'Diagnostic run', summary: summary,
    filename: 'keiser-diag-' + fileStamp(d) + '.csv'
  }, lines.join('\n') + '\n');
}

// ---- export actions ----
// Share is shown when the browser can share a file, or at least text.
function canShare() {
  if (!navigator.share) return false;
  return true;
}

function recActionsHtml(id) {
  return '<div class="rec-acts">' +
    (canShare() ? '<button class="btn" type="button" data-rec-act="share" data-id="' + id + '">Share</button>' : '') +
    '<button class="btn" type="button" data-rec-act="download" data-id="' + id + '">Download</button>' +
    '<button class="btn" type="button" data-rec-act="copy" data-id="' + id + '">Copy</button>' +
    '<button class="btn danger" type="button" data-rec-act="delete" data-id="' + id + '">Delete</button>' +
    '</div>';
}

function doRecAction(act, id, btn) {
  var rec = findRecord(id);
  if (!rec) { toast('That record is gone'); renderSaved(); return; }
  if (act === 'delete') {
    twoTap(btn, 'Tap again', function () {
      removeRecord(rec); saveIndex(); renderSaved(); renderResult(); renderDiag();
      toast('Deleted');
    });
    return;
  }
  var csv = getCsv(id);
  if (csv === null || csv === undefined) { toast('Could not read the saved data'); return; }
  if (act === 'share') {
    var file = null;
    try { file = new File([csv], rec.filename, { type: 'text/csv' }); } catch (e) { file = null; }
    var p;
    try {
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) p = navigator.share({ files: [file], title: rec.filename });
      else if (navigator.share) p = navigator.share({ title: rec.filename, text: csv });
    } catch (e) { p = Promise.reject(e); }
    if (p && p.catch) p.catch(function (err) { if (!err || err.name !== 'AbortError') toast('Share failed'); });
    return;
  }
  if (act === 'download') {
    try {
      var url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      var a = document.createElement('a');
      a.href = url; a.download = rec.filename; a.style.display = 'none';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 15000);
    } catch (e) { toast('Download failed'); }
    return;
  }
  if (act === 'copy') {
    var fallback = function () { showCopySheet(csv, rec.filename); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(csv).then(function () { toast('Copied ' + rec.filename); }, fallback);
      } else fallback();
    } catch (e) { fallback(); }
  }
}

function showCopySheet(text, title) {
  $('copyTitle').textContent = title;
  var ta = $('copyText');
  ta.value = text;
  setHidden('copySheet', false);
  try { ta.focus(); ta.select(); ta.setSelectionRange(0, text.length); } catch (e) {}
}

// ---- point stats in saved files (#12): "u5 w=3; d12 back=1 w=2" ----
function pointStatsText() {
  var st = state.pointStats || {};
  return Object.keys(st).filter(function (k) { return st[k].w || st[k].back; }).sort(function (a, b) {
    return a.charAt(0) === b.charAt(0) ? +a.slice(1) - +b.slice(1) : a < b ? 1 : -1;   // up points first
  }).map(function (k) {
    return k + (st[k].w ? ' w=' + st[k].w : '') + (st[k].back ? ' back=' + st[k].back : '');
  }).join('; ');
}
function parsePointStats(text) {
  var st = {};
  String(text || '').split(';').forEach(function (part) {
    var m = /^\s*([ud])(\d+)((?:\s+\w+=\d+)*)\s*$/.exec(part);
    if (!m) return;
    var o = { w: 0, back: 0 };
    m[3].replace(/(\w+)=(\d+)/g, function (all, k, v) { if (k === 'w' || k === 'back') o[k] = +v; return all; });
    st[m[1] + m[2]] = o;
  });
  return st;
}
// The saved calibration of this phone with exactly these points (as the bridge sends them, to 0.1 uT):
// { stats, id } from the newest one that has a point_stats line (else the newest match, stats {}),
// or null. Readings that match mean it is the same calibration.
function savedPointStatsFor(points, down) {
  var key = function (q) { return q.point + ':' + fmt(q.x, 1) + ',' + fmt(q.y, 1) + ',' + fmt(q.z, 1); };
  var want = points.map(key).sort().join('|'), wantDown = (down || []).map(key).sort().join('|'), firstMatch = null;
  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    if (r.type !== 'cal' || r.partial) continue;
    var csv = getCsv(r.id);
    if (!csv) continue;
    var up = [], dn = [], stats = null, header = null;
    csv.split('\n').forEach(function (line) {
      var m = /^# point_stats: (.*)$/.exec(line);
      if (m) { stats = m[1]; return; }
      if (!line || line.charAt(0) === '#') return;
      var c = line.split(',');
      if (!header) { header = c; return; }
      var n = +c[0];
      if (c[2] !== '') up.push({ point: n, x: +c[2], y: +c[3], z: +c[4] });
      if (c.length >= 9 && c[6] !== '') dn.push({ point: n, x: +c[6], y: +c[7], z: +c[8] });
    });
    if (up.map(key).sort().join('|') !== want || dn.map(key).sort().join('|') !== wantDown) continue;
    if (!firstMatch) firstMatch = r.id;
    if (stats !== null) return { stats: parsePointStats(stats), id: r.id };
  }
  return firstMatch ? { stats: {}, id: firstMatch } : null;
}

// The saved calibration record the gear check adds its lines to (also after a reload, via the flow record).
function noteCalRecord(id, v33) {
  if (!id) return;
  state.calRecordId = id;
  if (v33) setFlowRecord({ recordId: id });
}
// A new calibration starts: nothing more goes into the last one's record.
function forgetCalRecord() {
  state.calRecordId = null;
  if (flowRecord()) setFlowRecord({ recordId: null });
}
function calRecordId() {
  // this session's calibration result decides (no record of its own: none, never an older one);
  // with no result: the saved file that matched the bridge's calibration when it was read back;
  // the remembered one only when nothing was read back (e.g. a reload at the checkpoint)
  var r = state.result, id = r && r.type === 'K' && r.ok ? r.recordId || null
    : state.calRecordId || (state.homeRead ? state.homeRecordId : (flowRecord() || {}).recordId) || null;
  return id && findRecord(id) ? id : null;
}

// Remember on this phone what is left of the last calibration (resume offers on the start screen).
var FLOW_KEY = 'm3bridge.flow';
function flowRecord() {
  try {
    var r = JSON.parse(localStorage.getItem(FLOW_KEY));
    return r && typeof r === 'object' && !Array.isArray(r) ? r : null;
  } catch (e) { return null; }
}
function setFlowRecord(patch) {
  var r = flowRecord() || {};
  for (var k in patch) r[k] = patch[k];
  r.at = new Date().toISOString();
  try { localStorage.setItem(FLOW_KEY, JSON.stringify(r)); } catch (e) {}
}

// Save the points of a calibration that ended without a K line (abort, disconnect,
// or no result). Saved at most once per point count, and only with at least 1 point.
function savePartialCal(reason) {
  state.calEnded = true;
  var n = state.points.length;
  if (!n || state.partialSaved === n) return null;
  state.partialSaved = n;
  try {
    var id = saveCalRecord('run', { ok: false, partial: true, msg: reason, down: state.v32 ? state.downPoints : null }, state.points);
    logLine('Saved the ' + n + ' captured point' + (n > 1 ? 's' : '') + ' as an incomplete calibration.', 'sys');
    return id;
  } catch (e) { console.warn('partial save failed', e); return null; }
}
