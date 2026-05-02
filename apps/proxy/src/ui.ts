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
(() => {
  const statusEl = document.getElementById('status');
  const countEl  = document.getElementById('count');
  const rowsEl   = document.getElementById('rows');
  const pauseBtn = document.getElementById('pause');
  const clearBtn = document.getElementById('clear');
  const clearTailBtn = document.getElementById('clearTail');
  let paused  = false;
  let entries = []; // newest first

  const statusClass = (s) => {
    if (s == null) return 'serr';
    if (s < 300) return 's2xx';
    if (s < 400) return 's3xx';
    if (s < 500) return 's4xx';
    return 's5xx';
  };
  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
  const fmtTime = (iso) => {
    try { return new Date(iso).toISOString().substring(11, 23); }
    catch { return iso; }
  };
  const bodyToHtml = (body) => {
    if (!body || body.kind === 'empty') return '<span class="muted">(empty)</span>';
    if (body.kind === 'binary') {
      return '<span class="muted">(binary, ' + body.bytes + ' bytes, ' +
             escapeHtml(body.contentType || 'unknown') + ')</span>' +
             '<pre>' + escapeHtml(body.preview) + '</pre>';
    }
    const note = body.truncated ? ' <span class="pill">truncated, ' + body.bytes + ' bytes total</span>' : '';
    return note + '<pre>' + escapeHtml(body.data) + '</pre>';
  };
  const headersHtml = (h) => {
    if (!h) return '';
    const rows = Object.entries(h)
      .map(([k, v]) => '<div class="k">' + escapeHtml(k) + '</div><div class="v">' + escapeHtml(v) + '</div>')
      .join('');
    return '<div class="kv">' + rows + '</div>';
  };
  const curlFor = (e) => {
    const parts = ['curl', '-X', e.method, JSON.stringify(e.target)];
    for (const [k, v] of Object.entries(e.request.headers ?? {})) {
      if (k.toLowerCase() === 'host') continue;
      parts.push('-H', JSON.stringify(k + ': ' + v));
    }
    const b = e.request.body;
    if (b && b.kind === 'text' && !b.truncated) {
      parts.push('--data-raw', JSON.stringify(b.data));
    }
    return parts.join(' ');
  };
  const detailHtml = (e) => {
    const parts = ['<div class="detail-inner">'];
    parts.push('<h3>request headers</h3>' + headersHtml(e.request.headers));
    parts.push('<h3>request body</h3>' + bodyToHtml(e.request.body));
    if (e.response) {
      parts.push('<h3>response headers</h3>' + headersHtml(e.response.headers));
      parts.push('<h3>response body</h3>' + bodyToHtml(e.response.body));
    }
    if (e.error) parts.push('<h3>error</h3><pre>' + escapeHtml(e.error) + '</pre>');
    parts.push('<h3>curl (approx)</h3><pre class="curl">' + escapeHtml(curlFor(e)) + '</pre>');
    parts.push('</div>');
    return parts.join('');
  };
  const rowHtml = (e) => {
    const status = e.response ? e.response.status : null;
    const statusText = status === null
      ? (e.error || 'error')
      : (status + ' ' + (e.response.statusText || ''));
    return '<tr class="row" data-id="' + escapeHtml(e.id) + '">' +
           '<td>' + fmtTime(e.startedAt) + '</td>' +
           '<td><span class="method">' + escapeHtml(e.method) + '</span></td>' +
           '<td class="target">' + escapeHtml(e.target) + '</td>' +
           '<td class="' + statusClass(status) + '">' + escapeHtml(statusText) + '</td>' +
           '<td>' + e.durationMs + 'ms</td>' +
           '</tr>' +
           '<tr class="detail" data-detail-for="' + escapeHtml(e.id) + '" hidden>' +
           '<td colspan="5">' + detailHtml(e) + '</td>' +
           '</tr>';
  };
  const render = () => {
    rowsEl.innerHTML = entries.map(rowHtml).join('');
    countEl.textContent = entries.length + ' entries';
    rowsEl.querySelectorAll('tr.row').forEach((row) => {
      row.addEventListener('click', () => {
        const id = row.getAttribute('data-id');
        const detail = rowsEl.querySelector('tr[data-detail-for="' + id + '"]');
        if (detail) {
          detail.hidden = !detail.hidden;
          row.classList.toggle('expanded', !detail.hidden);
        }
      });
    });
  };
  const setStatus = (connected) => {
    statusEl.className = 'status ' + (connected ? 'connected' : 'disconnected');
    statusEl.textContent = connected ? 'connected' : 'disconnected';
  };

  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.classList.toggle('active', paused);
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  });
  clearBtn.addEventListener('click', () => { entries = []; render(); });

  // The page itself was served behind PROXY_TAIL_SECRET; forward whatever
  // ?secret= query the user opened the page with onto the SSE / DELETE calls.
  // Resolve "tail" relative to the current page directory so the URL is
  // correct whether the app is mounted at "/" or behind a prefix like "/proxy".
  const tailUrl = () => {
    const dir = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';
    return dir + 'tail' + location.search;
  };

  clearTailBtn.addEventListener('click', async () => {
    clearTailBtn.disabled = true;
    try { await fetch(tailUrl(), { method: 'DELETE' }); }
    finally { clearTailBtn.disabled = false; }
  });

  const connect = () => {
    const es = new EventSource(tailUrl());
    es.addEventListener('snapshot', (ev) => {
      if (paused) return;
      entries = JSON.parse(ev.data).slice().reverse(); // newest first
      render();
    });
    es.addEventListener('entry', (ev) => {
      if (paused) return;
      entries.unshift(JSON.parse(ev.data));
      if (entries.length > 1000) entries.pop();
      render();
    });
    es.addEventListener('cleared', () => { entries = []; render(); });
    es.onopen  = () => setStatus(true);
    es.onerror = () => setStatus(false); // EventSource auto-reconnects
  };
  connect();
})();
</script>
</body>
</html>`;
