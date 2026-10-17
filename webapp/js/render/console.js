// M3 Bridge phone page: Console screen: the log and the last-turn line.
// Classic script sharing the page's global scope; index.html loads the files in order (see its loader).
'use strict';

// ===================================================================
// Console log
// ===================================================================
function ts() {
  var d = new Date();
  function z(n) { return (n < 10 ? '0' : '') + n; }
  return z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds());
}
// Follow new lines unless the user has scrolled up to read history.
var logStick = true;
$('log').addEventListener('scroll', function () {
  var l = $('log');
  if (l.clientHeight > 0) logStick = l.scrollHeight - l.scrollTop - l.clientHeight < 40;
});
function logLine(text, kind) {
  var log = $('log');
  var div = document.createElement('div');
  div.className = 'ln' + (kind === 'raw' ? ' raw' : kind === 'rawbad' || kind === 'bad' ? ' bad' : kind === 'sent' ? ' sent' : kind === 'sys' ? ' sys' : '');
  var t = document.createElement('span'); t.className = 'ts'; t.textContent = ts();
  div.appendChild(t);
  div.appendChild(document.createTextNode(text));
  log.appendChild(div);
  while (log.childNodes.length > LOG_MAX) log.removeChild(log.firstChild);
  if (logStick) log.scrollTop = log.scrollHeight;
}

function renderTurnInfo() {
  var t = state.lastTurn, el = $('turnInfo');
  if (!t) { el.hidden = true; return; }
  el.hidden = false;
  var rpm = t.period > 0 ? 60000 / t.period : NaN;
  el.textContent = 'Last turn: ' + Math.round(t.period) + ' ms · ' + fmt(rpm, 1) + ' rpm' +
    (t.gear > 0 ? ' · gear ' + t.gear : '') + (fin(t.res) ? ' · res ' + fmt(t.res, 1) : '');
}
