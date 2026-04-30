export function renderUI(): string {
  return UI_HTML;
}

const UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Proxy Tail — toolbox</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
* { box-sizing: border-box; }
body { margin: 0; font-family: 'SF Mono','Fira Code','Cascadia Code',monospace;
       background:#0d1117; color:#c9d1d9; }
header { padding: 1rem 1.5rem; background:#161b22; border-bottom:1px solid #21262d;
         display:flex; align-items:center; gap:1rem; }
h1 { margin:0; font-size:1.1rem; color:#58a6ff; }
.status { padding: 0.25rem 0.5rem; border-radius:4px; font-size:0.8rem; }
.status.connected { background:#1f3a23; color:#3fb950; }
.status.disconnected { background:#3a1f1f; color:#f85149; }
.count { color:#8b949e; font-size:0.85rem; margin-left:auto; }
button { background:#21262d; color:#c9d1d9; border:1px solid #30363d;
         padding:0.3rem 0.7rem; border-radius:4px; cursor:pointer; font:inherit; font-size:0.85rem; }
button:hover { background:#30363d; }
button.active { background:#1f6feb; border-color:#1f6feb; color:#fff; }
table { width:100%; border-collapse:collapse; }
th, td { padding:0.4rem 0.75rem; text-align:left; border-bottom:1px solid #21262d;
         font-size:0.85rem; vertical-align:top; }
th { background:#161b22; color:#58a6ff; font-weight:500; position:sticky; top:0; }
tr.row:hover { background:#161b22; cursor:pointer; }
tr.row.expanded { background:#161b22; }
.s2xx { color:#3fb950; } .s3xx { color:#58a6ff; }
.s4xx { color:#d29922; } .s5xx { color:#f85149; } .serr { color:#f85149; }
.target { color:#c9d1d9; word-break:break-all; }
.detail td { padding:0; background:#0d1117; }
.detail-inner { padding:0.75rem 2rem; border-bottom:1px solid #21262d; }
.detail h3 { margin: 0.75rem 0 0.3rem; font-size:0.75rem; color:#8b949e;
             text-transform: uppercase; letter-spacing:0.05em; }
.detail pre { background:#0d1117; border:1px solid #21262d; padding:0.5rem;
              white-space:pre-wrap; word-break:break-all; font-size:0.8rem;
              max-height: 400px; overflow:auto; margin:0; }
.kv { display:grid; grid-template-columns: max-content 1fr; gap:0.2rem 1rem;
      font-size:0.8rem; }
.kv .k { color:#8b949e; }
.kv .v { word-break:break-all; }
.curl { font-size:0.8rem; }
.method { display:inline-block; min-width:3.5em; }
.muted { color:#8b949e; }
.pill { font-size:0.75rem; padding:0.1rem 0.4rem; border-radius:3px; background:#21262d; }
</style>
</head>
<body>
<header>
  <h1>toolbox / proxy tail</h1>
  <span class="status disconnected" id="status">connecting…</span>
  <button id="pause">Pause</button>
  <button id="clear">Clear view</button>
  <button id="clearTail" title="Clear server-side tail (affects all viewers)">Clear tail</button>
  <span class="count" id="count">0 entries</span>
</header>
<table>
  <thead>
    <tr><th>time</th><th>method</th><th>target</th><th>status</th><th>duration</th></tr>
  </thead>
  <tbody id="rows"></tbody>
</table>
<script>
(function () {
  var statusEl = document.getElementById('status');
  var countEl  = document.getElementById('count');
  var rowsEl   = document.getElementById('rows');
  var pauseBtn = document.getElementById('pause');
  var clearBtn = document.getElementById('clear');
  var clearTailBtn = document.getElementById('clearTail');
  var paused   = false;
  var entries  = []; // newest first

  function statusClass(s) {
    if (s == null) return 'serr';
    if (s < 300) return 's2xx';
    if (s < 400) return 's3xx';
    if (s < 500) return 's4xx';
    return 's5xx';
  }
  function escape(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function fmtTime(iso) {
    try { return new Date(iso).toISOString().substring(11, 23); }
    catch (_) { return iso; }
  }
  function bodyToHtml(body) {
    if (!body || body.kind === 'empty') return '<span class="muted">(empty)</span>';
    if (body.kind === 'binary') {
      return '<span class="muted">(binary, ' + body.bytes + ' bytes, ' +
             escape(body.contentType || 'unknown') + ')</span>' +
             '<pre>' + escape(body.preview) + '</pre>';
    }
    var note = body.truncated ? ' <span class="pill">truncated, ' + body.bytes + ' bytes total</span>' : '';
    return note + '<pre>' + escape(body.data) + '</pre>';
  }
  function headersHtml(h) {
    if (!h) return '';
    var rows = '';
    Object.keys(h).forEach(function (k) {
      rows += '<div class="k">' + escape(k) + '</div><div class="v">' + escape(h[k]) + '</div>';
    });
    return '<div class="kv">' + rows + '</div>';
  }
  function curlFor(e) {
    var parts = ['curl', '-X', e.method, JSON.stringify(e.target)];
    Object.keys(e.request.headers || {}).forEach(function (k) {
      if (k.toLowerCase() === 'host') return;
      parts.push('-H', JSON.stringify(k + ': ' + e.request.headers[k]));
    });
    var b = e.request.body;
    if (b && b.kind === 'text' && !b.truncated) {
      parts.push('--data-raw', JSON.stringify(b.data));
    }
    return parts.join(' ');
  }
  function detailHtml(e) {
    var parts = ['<div class="detail-inner">'];
    parts.push('<h3>request headers</h3>' + headersHtml(e.request.headers));
    parts.push('<h3>request body</h3>' + bodyToHtml(e.request.body));
    if (e.response) {
      parts.push('<h3>response headers</h3>' + headersHtml(e.response.headers));
      parts.push('<h3>response body</h3>' + bodyToHtml(e.response.body));
    }
    if (e.error) parts.push('<h3>error</h3><pre>' + escape(e.error) + '</pre>');
    parts.push('<h3>curl (approx)</h3><pre class="curl">' + escape(curlFor(e)) + '</pre>');
    parts.push('</div>');
    return parts.join('');
  }
  function rowHtml(e) {
    var status = e.response ? e.response.status : null;
    var statusText = status === null
      ? (e.error || 'error')
      : (status + ' ' + (e.response.statusText || ''));
    return '<tr class="row" data-id="' + escape(e.id) + '">' +
           '<td>' + fmtTime(e.startedAt) + '</td>' +
           '<td><span class="method">' + escape(e.method) + '</span></td>' +
           '<td class="target">' + escape(e.target) + '</td>' +
           '<td class="' + statusClass(status) + '">' + escape(statusText) + '</td>' +
           '<td>' + e.durationMs + 'ms</td>' +
           '</tr>' +
           '<tr class="detail" data-detail-for="' + escape(e.id) + '" hidden>' +
           '<td colspan="5">' + detailHtml(e) + '</td>' +
           '</tr>';
  }
  function render() {
    rowsEl.innerHTML = entries.map(rowHtml).join('');
    countEl.textContent = entries.length + ' entries';
    rowsEl.querySelectorAll('tr.row').forEach(function (row) {
      row.addEventListener('click', function () {
        var id = row.getAttribute('data-id');
        var detail = rowsEl.querySelector('tr[data-detail-for="' + id + '"]');
        if (detail) {
          detail.hidden = !detail.hidden;
          row.classList.toggle('expanded', !detail.hidden);
        }
      });
    });
  }
  function setStatus(connected) {
    statusEl.className = 'status ' + (connected ? 'connected' : 'disconnected');
    statusEl.textContent = connected ? 'connected' : 'disconnected';
  }

  pauseBtn.addEventListener('click', function () {
    paused = !paused;
    pauseBtn.classList.toggle('active', paused);
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  });
  clearBtn.addEventListener('click', function () { entries = []; render(); });
  clearTailBtn.addEventListener('click', function () {
    clearTailBtn.disabled = true;
    fetch('tail', { method: 'DELETE' })
      .catch(function () { /* server will broadcast cleared if it succeeded */ })
      .then(function () { clearTailBtn.disabled = false; });
  });

  function connect() {
    var es = new EventSource('tail');
    es.addEventListener('snapshot', function (ev) {
      if (paused) return;
      var snap = JSON.parse(ev.data);
      entries = snap.slice().reverse(); // newest first
      render();
    });
    es.addEventListener('entry', function (ev) {
      if (paused) return;
      entries.unshift(JSON.parse(ev.data));
      if (entries.length > 1000) entries.pop();
      render();
    });
    es.addEventListener('cleared', function () {
      entries = [];
      render();
    });
    es.onopen  = function () { setStatus(true); };
    es.onerror = function () { setStatus(false); /* EventSource auto-reconnects */ };
  }
  connect();
})();
</script>
</body>
</html>`;
