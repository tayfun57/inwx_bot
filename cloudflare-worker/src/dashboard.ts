/**
 * Self-contained dashboard page served by the Worker at `/`.
 *
 * Everything (markup, styling, client logic) is inline so there is no build
 * step and no external assets to fetch. The client talks to the same-origin
 * `/api/*` endpoints. A per-request CSP nonce (see index.ts) is applied to the
 * inline <style> and <script> so we can keep a strict Content-Security-Policy.
 *
 * The client script deliberately avoids template literals / escape sequences
 * so it can live safely inside this TypeScript template string.
 */
export function dashboardPage(nonce: string): string {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>INWX Bot Dashboard</title>
<link rel="icon" href="data:," />
<style nonce="${nonce}">
*{box-sizing:border-box}
:root{--bg:#f1f5f9;--fg:#0f172a;--muted:#64748b;--card:#fff;--border:#e2e8f0;--primary:#2563eb;--primary-fg:#fff;--err:#dc2626;--chip:#f1f5f9}
@media (prefers-color-scheme:dark){:root{--bg:#0b1220;--fg:#e2e8f0;--muted:#94a3b8;--card:#0f172a;--border:#1e293b;--chip:#1e293b}}
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg);line-height:1.5}
header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 20px;border-bottom:1px solid var(--border);background:var(--card)}
header h1{font-size:17px;margin:0}
.meta{display:flex;align-items:center;gap:10px}
main{max-width:980px;margin:0 auto;padding:20px;display:flex;flex-direction:column;gap:18px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.card h2{font-size:15px;margin:0}
.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.row{display:flex;gap:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px}
.tile{background:var(--chip);border:1px solid var(--border);border-radius:10px;padding:10px 12px}
.tile .k{font-size:12px;color:var(--muted)}
.tile .v{font-size:18px;font-weight:600;margin-top:2px}
.btn{font:inherit;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--fg);cursor:pointer}
.btn:hover{border-color:var(--muted)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn-primary{background:var(--primary);color:var(--primary-fg);border-color:var(--primary)}
.btn-ghost{background:transparent}
input,textarea,select{font:inherit;width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--fg)}
textarea{resize:vertical}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
thead th{cursor:pointer;user-select:none}
.filter-input{max-width:260px}
.table-wrap{overflow-x:auto}
.muted{color:var(--muted);font-size:13px}
.error{color:var(--err);font-size:13px}
.warn{color:#b45309;font-weight:600}
.danger{color:var(--err);font-weight:600}
.badge{display:inline-block;padding:3px 8px;border-radius:999px;font-size:12px;font-weight:600}
.badge-skipped{background:var(--chip);color:var(--muted)}
.badge-would_purchase{background:#dbeafe;color:#1e40af}
.badge-purchased{background:#dcfce7;color:#166534}
.badge-purchase_failed{background:#fee2e2;color:#991b1b}
.badge-error{background:#fef3c7;color:#92400e}
.badge-dry{background:#fef3c7;color:#92400e}
.badge-live{background:#dcfce7;color:#166534}
footer{max-width:980px;margin:0 auto;padding:8px 20px 28px;color:var(--muted);font-size:12px}
.mt{margin-top:10px}
.srow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid var(--border)}
.srow input[type=checkbox]{width:auto}
.srow input[type=number],.srow input[type=text]{max-width:220px}
[hidden]{display:none !important}
</style>
</head>
<body>
<header>
  <h1>INWX Bot Dashboard</h1>
  <div class="meta">
    <span id="mode" class="badge" hidden></span>
    <button id="logout" class="btn btn-ghost" hidden>Abmelden</button>
  </div>
</header>
<main>
  <section id="login" class="card" hidden>
    <h2>Anmelden</h2>
    <p class="muted">Bitte den Admin-Token eingeben (entspricht dem Secret <code>ADMIN_TOKEN</code>).</p>
    <div class="row">
      <input id="token" type="password" placeholder="Admin-Token" autocomplete="off" />
      <button id="connect" class="btn btn-primary">Verbinden</button>
    </div>
    <p id="login-error" class="error" hidden></p>
  </section>

  <div id="app" hidden>
    <section class="card">
      <div class="card-head">
        <h2>Status</h2>
        <div class="actions">
          <button id="refresh" class="btn">Aktualisieren</button>
          <button id="run" class="btn btn-primary">Jetzt prüfen</button>
        </div>
      </div>
      <div id="status-grid" class="grid"></div>
      <p id="run-msg" class="muted" hidden></p>
      <p id="last-error" class="error" hidden></p>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>Domain-Liste</h2>
        <span id="domain-count" class="muted"></span>
      </div>
      <p class="muted">Modus <b>auto</b> registriert verfügbare Domains automatisch (sofern nicht im Probelauf); <b>watch</b> meldet nur. Max-Preis verhindert teure Auto-Käufe.</p>
      <div class="table-wrap">
        <table id="domains-table">
          <thead><tr><th>Domain</th><th>Modus</th><th>Max-Preis</th><th>Tags</th><th>Notiz</th><th></th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="actions mt">
        <button id="add-domain" class="btn">+ Zeile</button>
        <button id="save-domains" class="btn btn-primary">Speichern</button>
        <span id="domains-msg" class="muted" hidden></span>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>Ergebnisse</h2>
        <div class="actions">
          <input id="results-filter" class="filter-input" type="text" placeholder="filtern…" />
          <button id="download" class="btn">CSV herunterladen</button>
        </div>
      </div>
      <div class="table-wrap">
        <table id="results">
          <thead><tr><th>Domain</th><th>Verfügbar</th><th>Status</th><th>Detail</th><th>Code</th><th>Preis</th><th></th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <p id="results-empty" class="muted" hidden>Noch keine Ergebnisse. Starte eine Prüfung.</p>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>WHOIS / Domain-Status</h2>
        <div class="actions">
          <input id="whois-filter" class="filter-input" type="text" placeholder="filtern…" />
          <span id="whois-time" class="muted"></span>
          <button id="whois-refresh" class="btn">WHOIS aktualisieren</button>
        </div>
      </div>
      <div class="table-wrap">
        <table id="whois">
          <thead><tr><th>Domain</th><th>Status</th><th>Registriert</th><th>Läuft ab</th><th>Zuletzt geändert</th><th>Registrar</th><th>Quelle</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <p id="whois-empty" class="muted" hidden>Noch keine WHOIS-Daten. Klicke „WHOIS aktualisieren".</p>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>Verlauf</h2>
        <span class="muted">letzte Läufe</span>
      </div>
      <div class="table-wrap">
        <table id="history">
          <thead><tr><th>Zeitpunkt</th><th>Geprüft</th><th>verfügbar</th><th>gekauft</th><th>fehlgeschlagen</th><th>Fehler</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <p id="history-empty" class="muted" hidden>Noch kein Verlauf.</p>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>Schnell-Check</h2>
        <span class="muted">prüft ohne zur Liste hinzuzufügen</span>
      </div>
      <div class="row">
        <input id="check-input" type="text" placeholder="domain.de  –  oder Keyword" />
        <input id="check-tlds" type="text" placeholder="TLDs für Keyword: de, com" />
        <button id="check-btn" class="btn btn-primary">Prüfen</button>
      </div>
      <div class="table-wrap mt">
        <table id="check-results">
          <thead><tr><th>Domain</th><th>Verfügbar</th><th>Preis / Info</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <p id="check-empty" class="muted" hidden>Domain – oder Keyword + TLDs – eingeben und „Prüfen".</p>
    </section>

    <section class="card">
      <div class="card-head"><h2>Einstellungen</h2><span id="settings-msg" class="muted" hidden></span></div>
      <div class="settings-form">
        <label class="srow"><span>Probelauf (DRY_RUN) – kauft nichts</span><input id="set-dryrun" type="checkbox" /></label>
        <label class="srow"><span>API-Delay (ms)</span><input id="set-delay" type="number" min="0" /></label>
        <label class="srow"><span>Ablauf-Schwellen (Tage, kommagetrennt)</span><input id="set-thresholds" type="text" placeholder="30,14,7,1" /></label>
        <label class="srow"><span>Verlängerungsmodus (renewalMode)</span>
          <select id="set-renewal">
            <option value="AUTORENEW">AUTORENEW</option>
            <option value="AUTODELETE">AUTODELETE</option>
            <option value="AUTOEXPIRE">AUTOEXPIRE</option>
          </select>
        </label>
        <label class="srow"><span>Registrierungsdauer (period, optional)</span><input id="set-period" type="text" placeholder="z. B. 1Y" /></label>
        <label class="srow"><span>Transfer-Sperre (transferLock)</span><input id="set-lock" type="checkbox" /></label>
      </div>
      <div class="actions mt">
        <button id="save-settings" class="btn btn-primary">Einstellungen speichern</button>
        <button id="reset-settings" class="btn">Auf Standard zurücksetzen</button>
        <button id="export-btn" class="btn">Backup herunterladen</button>
      </div>
      <p class="muted mt">Hinweis: Gespeicherte Werte überschreiben <code>wrangler.toml</code> dauerhaft – auch über Deploys hinweg – bis du auf Standard zurücksetzt.</p>
    </section>

    <section class="card">
      <div class="card-head"><h2>Audit-Log</h2><span class="muted">letzte Aktionen</span></div>
      <div class="table-wrap">
        <table id="audit">
          <thead><tr><th>Zeitpunkt</th><th>Aktion</th><th>Detail</th><th>IP</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <p id="audit-empty" class="muted" hidden>Noch keine Aktionen.</p>
    </section>
  </div>
</main>
<footer>INWX Bot &middot; Cron-gesteuerter Domain-Check auf Cloudflare Workers</footer>

<script nonce="${nonce}">
(function () {
  var TOKEN_KEY = 'inwx_admin_token';
  function el(id) { return document.getElementById(id); }
  function getToken() { return sessionStorage.getItem(TOKEN_KEY) || ''; }
  function setToken(t) { if (t) { sessionStorage.setItem(TOKEN_KEY, t); } else { sessionStorage.removeItem(TOKEN_KEY); } }
  function clearNode(node) { while (node.firstChild) { node.removeChild(node.firstChild); } }
  function show(node, on) { node.hidden = !on; }
  function fmtTime(iso) { if (!iso) { return 'noch kein Lauf'; } var d = new Date(iso); return isNaN(d.getTime()) ? iso : d.toLocaleString(); }
  function fmtDate(v) { if (!v) { return '–'; } var d = new Date(v); return isNaN(d.getTime()) ? String(v).slice(0, 10) : d.toLocaleDateString(); }
  function daysUntil(v) { if (!v) { return null; } var d = new Date(v); if (isNaN(d.getTime())) { return null; } return Math.floor((d.getTime() - Date.now()) / 86400000); }

  function api(path, opts) {
    opts = opts || {};
    var headers = {};
    var k;
    if (opts.headers) { for (k in opts.headers) { headers[k] = opts.headers[k]; } }
    var t = getToken();
    if (t) { headers['authorization'] = 'Bearer ' + t; }
    opts.headers = headers;
    return fetch(path, opts);
  }

  var ACTION_LABELS = { skipped: 'übersprungen', would_purchase: 'verfügbar', purchased: 'gekauft', purchase_failed: 'Kauf fehlgeschlagen', error: 'Fehler' };

  function badge(action) {
    var span = document.createElement('span');
    span.className = 'badge badge-' + action;
    span.textContent = ACTION_LABELS[action] || action;
    return span;
  }

  function tile(key, value) {
    var d = document.createElement('div'); d.className = 'tile';
    var kk = document.createElement('div'); kk.className = 'k'; kk.textContent = key;
    var vv = document.createElement('div'); vv.className = 'v'; vv.textContent = value;
    d.appendChild(kk); d.appendChild(vv);
    return d;
  }

  var lastTimestamp = null;

  function renderStatus(record) {
    var grid = el('status-grid'); clearNode(grid);
    var statuses = (record && record.statuses) || [];
    var counts = {};
    var i;
    for (i = 0; i < statuses.length; i++) { var a = statuses[i].action; counts[a] = (counts[a] || 0) + 1; }
    grid.appendChild(tile('Letzter Lauf', record ? fmtTime(record.timestamp) : 'noch kein Lauf'));
    grid.appendChild(tile('Geprüft', String(statuses.length)));
    grid.appendChild(tile('verfügbar', String(counts['would_purchase'] || 0)));
    grid.appendChild(tile('gekauft', String(counts['purchased'] || 0)));
    grid.appendChild(tile('fehlgeschlagen', String(counts['purchase_failed'] || 0)));
    grid.appendChild(tile('übersprungen', String(counts['skipped'] || 0)));
    grid.appendChild(tile('Fehler', String(counts['error'] || 0)));
    var le = el('last-error');
    if (record && record.error) { le.textContent = 'Fehler beim letzten Lauf: ' + record.error; show(le, true); }
    else { show(le, false); }
  }

  function renderResults(record) {
    var tbody = el('results').querySelector('tbody'); clearNode(tbody);
    var statuses = (record && record.statuses) || [];
    show(el('results-empty'), statuses.length === 0);
    var i;
    for (i = 0; i < statuses.length; i++) {
      var s = statuses[i];
      var tr = document.createElement('tr');
      var c1 = document.createElement('td'); c1.textContent = s.domain; tr.appendChild(c1);
      var c2 = document.createElement('td'); c2.textContent = s.available === true ? 'ja' : (s.available === false ? 'nein' : '–'); tr.appendChild(c2);
      var c3 = document.createElement('td'); c3.appendChild(badge(s.action)); tr.appendChild(c3);
      var c4 = document.createElement('td'); c4.textContent = s.detail || ''; tr.appendChild(c4);
      var c5 = document.createElement('td'); c5.textContent = (s.api_code === null || s.api_code === undefined) ? '' : String(s.api_code); tr.appendChild(c5);
      var c6 = document.createElement('td'); c6.textContent = (s.price === null || s.price === undefined) ? '' : String(s.price); tr.appendChild(c6);
      var c7 = document.createElement('td');
      if (s.action === 'would_purchase') {
        var bb = document.createElement('button'); bb.className = 'btn'; bb.textContent = 'Kaufen';
        (function (dom, price, button, row) {
          button.addEventListener('click', function () { buyDomain(dom, price, button, row); });
        })(s.domain, s.price, bb, tr);
        c7.appendChild(bb);
      }
      tr.appendChild(c7);
      tbody.appendChild(tr);
    }
    applyFilter(el('results-filter'), el('results'));
  }

  function buyDomain(domain, price, button, row) {
    var priceText = (price === null || price === undefined) ? '' : ' für ' + price;
    if (!window.confirm('Domain kostenpflichtig registrieren: ' + domain + priceText + ' ?')) { return; }
    button.disabled = true; button.textContent = 'Kaufe…';
    api('/api/buy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: domain }) })
      .then(function (r) { if (r.status === 401) { throw { auth: true }; } return r.json(); })
      .then(function (res) {
        if (res.ok) {
          // Reflect the purchase immediately, then refresh the live data.
          var statusCell = row.children[2]; clearNode(statusCell); statusCell.appendChild(badge('purchased'));
          button.parentNode.removeChild(button);
          window.alert('Registriert: ' + domain);
        } else {
          window.alert('Nicht gekauft: ' + (res.detail || res.error || 'Fehler'));
          button.disabled = false; button.textContent = 'Kaufen';
        }
        loadResults(); loadHistory(); loadAudit();
      })
      .catch(function (e) { window.alert((e && e.auth) ? 'Nicht autorisiert.' : 'Fehler beim Kauf.'); button.disabled = false; button.textContent = 'Kaufen'; });
  }

  function setMode(dryRun) {
    var m = el('mode');
    if (dryRun) { m.textContent = 'Probelauf — kauft nicht'; m.className = 'badge badge-dry'; }
    else { m.textContent = 'Live — kauft Domains'; m.className = 'badge badge-live'; }
    show(m, true);
  }

  function showApp(on) { show(el('app'), on); show(el('login'), !on); show(el('logout'), on); }

  function loadPublicStatus() {
    return fetch('/api/status').then(function (r) { return r.json(); }).then(function (j) {
      setMode(!!(j && j.dryRun));
      if (j && j.authConfigured === false) {
        var le = el('login-error');
        le.textContent = 'Auf dem Server ist kein ADMIN_TOKEN gesetzt. Bitte mit "wrangler secret put ADMIN_TOKEN" konfigurieren.';
        show(le, true);
        el('connect').disabled = true;
      }
    }).catch(function () {});
  }

  function loadResults() {
    return api('/api/results.json').then(function (r) {
      if (r.status === 401) { throw { auth: true }; }
      return r.json();
    }).then(function (rec) {
      lastTimestamp = (rec && rec.timestamp) ? rec.timestamp : null;
      renderStatus(rec); renderResults(rec);
    });
  }

  function makeInput(type, value, placeholder, cls) {
    var inp = document.createElement('input');
    inp.type = type;
    if (value !== undefined && value !== null) { inp.value = value; }
    if (placeholder) { inp.placeholder = placeholder; }
    if (cls) { inp.className = cls; }
    return inp;
  }

  function makeModeSelect(value) {
    var sel = document.createElement('select'); sel.className = 'd-mode';
    var modes = [['auto', 'auto (kauft)'], ['watch', 'watch (beobachtet)']];
    var i;
    for (i = 0; i < modes.length; i++) {
      var o = document.createElement('option'); o.value = modes[i][0]; o.textContent = modes[i][1];
      if (modes[i][0] === value) { o.selected = true; }
      sel.appendChild(o);
    }
    return sel;
  }

  function addDomainRow(cfg) {
    cfg = cfg || {};
    var tr = document.createElement('tr');
    var c1 = document.createElement('td'); c1.appendChild(makeInput('text', cfg.domain || '', 'example.de', 'd-domain')); tr.appendChild(c1);
    var c2 = document.createElement('td'); c2.appendChild(makeModeSelect(cfg.mode === 'watch' ? 'watch' : 'auto')); tr.appendChild(c2);
    var c3 = document.createElement('td');
    var price = makeInput('number', (cfg.maxPrice !== undefined && cfg.maxPrice !== null) ? cfg.maxPrice : '', '', 'd-price');
    price.min = '0'; price.step = '0.01'; c3.appendChild(price); tr.appendChild(c3);
    var c4 = document.createElement('td'); c4.appendChild(makeInput('text', (cfg.tags || []).join(', '), 'tag1, tag2', 'd-tags')); tr.appendChild(c4);
    var c5 = document.createElement('td'); c5.appendChild(makeInput('text', cfg.notes || '', 'Notiz', 'd-notes')); tr.appendChild(c5);
    var c6 = document.createElement('td');
    var rm = document.createElement('button'); rm.className = 'btn'; rm.textContent = '✕';
    rm.addEventListener('click', function () { tr.parentNode.removeChild(tr); });
    c6.appendChild(rm); tr.appendChild(c6);
    el('domains-table').querySelector('tbody').appendChild(tr);
  }

  function renderDomains(list) {
    var tbody = el('domains-table').querySelector('tbody'); clearNode(tbody);
    list = list || [];
    var i;
    for (i = 0; i < list.length; i++) { addDomainRow(list[i]); }
    el('domain-count').textContent = list.length + ' Domains';
  }

  function collectDomains() {
    var rows = el('domains-table').querySelectorAll('tbody tr');
    var out = [];
    var i;
    for (i = 0; i < rows.length; i++) {
      var row = rows[i];
      var domain = row.querySelector('.d-domain').value.trim();
      if (!domain) { continue; }
      var cfg = { domain: domain, mode: row.querySelector('.d-mode').value === 'watch' ? 'watch' : 'auto' };
      var priceVal = row.querySelector('.d-price').value.trim();
      if (priceVal !== '') { var p = Number(priceVal); if (!isNaN(p)) { cfg.maxPrice = p; } }
      var tagsVal = row.querySelector('.d-tags').value.trim();
      if (tagsVal !== '') { cfg.tags = tagsVal.split(',').map(function (t) { return t.trim(); }).filter(Boolean); }
      var notesVal = row.querySelector('.d-notes').value.trim();
      if (notesVal !== '') { cfg.notes = notesVal; }
      out.push(cfg);
    }
    return out;
  }

  function loadDomains() {
    return api('/api/domains').then(function (r) {
      if (r.status === 401) { throw { auth: true }; }
      return r.json();
    }).then(function (j) { renderDomains((j && j.domains) || []); });
  }

  function renderWhois(rec) {
    var tbody = el('whois').querySelector('tbody'); clearNode(tbody);
    var list = (rec && rec.domains) || [];
    show(el('whois-empty'), list.length === 0);
    if (rec && rec.timestamp) { el('whois-time').textContent = 'Stand: ' + fmtTime(rec.timestamp); }
    var i;
    for (i = 0; i < list.length; i++) {
      var w = list[i];
      var tr = document.createElement('tr');
      var cDomain = document.createElement('td'); cDomain.textContent = w.domain; tr.appendChild(cDomain);
      var cStatus = document.createElement('td');
      if (w.available === true) {
        var b = document.createElement('span'); b.className = 'badge badge-would_purchase'; b.textContent = 'verfügbar'; cStatus.appendChild(b);
      } else if (w.error) {
        cStatus.textContent = w.error; cStatus.className = 'muted';
      } else {
        cStatus.textContent = (w.status && w.status.length) ? w.status.join(', ') : 'registriert';
      }
      tr.appendChild(cStatus);
      var cReg = document.createElement('td'); cReg.textContent = fmtDate(w.registered); tr.appendChild(cReg);
      var cExp = document.createElement('td'); cExp.textContent = fmtDate(w.expires);
      var du = daysUntil(w.expires);
      if (du !== null && du < 0) { cExp.className = 'danger'; }
      else if (du !== null && du <= 30) { cExp.className = 'warn'; }
      tr.appendChild(cExp);
      var cUpd = document.createElement('td'); cUpd.textContent = fmtDate(w.updated); tr.appendChild(cUpd);
      var cRar = document.createElement('td'); cRar.textContent = w.registrar || '–'; tr.appendChild(cRar);
      var cSrc = document.createElement('td'); cSrc.textContent = w.source || '–'; cSrc.className = 'muted'; tr.appendChild(cSrc);
      tbody.appendChild(tr);
    }
    applyFilter(el('whois-filter'), el('whois'));
  }

  function loadWhois() {
    return api('/api/whois').then(function (r) {
      if (r.status === 401) { throw { auth: true }; }
      return r.json();
    }).then(function (rec) { renderWhois(rec); });
  }

  function addCell(tr, text, cls) {
    var td = document.createElement('td');
    td.textContent = text;
    if (cls) { td.className = cls; }
    tr.appendChild(td);
  }

  function renderHistory(list) {
    var tbody = el('history').querySelector('tbody'); clearNode(tbody);
    list = list || [];
    show(el('history-empty'), list.length === 0);
    var i;
    for (i = 0; i < list.length; i++) {
      var h = list[i];
      var counts = h.counts || {};
      var tr = document.createElement('tr');
      addCell(tr, fmtTime(h.timestamp));
      addCell(tr, String(h.total || 0));
      addCell(tr, String(counts['would_purchase'] || 0));
      addCell(tr, String(counts['purchased'] || 0));
      addCell(tr, String(counts['purchase_failed'] || 0));
      addCell(tr, h.error ? h.error : String(counts['error'] || 0), h.error ? 'error' : '');
      tbody.appendChild(tr);
    }
  }

  function loadHistory() {
    return api('/api/history').then(function (r) {
      if (r.status === 401) { throw { auth: true }; }
      return r.json();
    }).then(function (list) { renderHistory(list); });
  }

  function renderCheckResults(list) {
    var tbody = el('check-results').querySelector('tbody'); clearNode(tbody);
    list = list || [];
    show(el('check-empty'), list.length === 0);
    var i;
    for (i = 0; i < list.length; i++) {
      var r = list[i];
      var tr = document.createElement('tr');
      addCell(tr, r.domain);
      addCell(tr, r.error ? '–' : (r.available ? 'ja' : 'nein'), r.error ? 'muted' : '');
      addCell(tr, (r.price !== undefined && r.price !== null) ? String(r.price) : (r.error || '–'), r.error ? 'muted' : '');
      tbody.appendChild(tr);
    }
  }

  function loadSettings() {
    return api('/api/settings').then(function (r) {
      if (r.status === 401) { throw { auth: true }; }
      return r.json();
    }).then(function (j) {
      var s = (j && j.effective) || {};
      el('set-dryrun').checked = !!s.dryRun;
      el('set-delay').value = (s.apiDelayMs !== undefined && s.apiDelayMs !== null) ? s.apiDelayMs : '';
      el('set-thresholds').value = (s.expiryAlertDays || []).join(',');
      el('set-renewal').value = s.renewalMode || 'AUTORENEW';
      el('set-period').value = s.period || '';
      el('set-lock').checked = s.transferLock !== false;
    });
  }

  function renderAudit(list) {
    var tbody = el('audit').querySelector('tbody'); clearNode(tbody);
    list = list || [];
    show(el('audit-empty'), list.length === 0);
    var i;
    for (i = 0; i < list.length; i++) {
      var a = list[i];
      var tr = document.createElement('tr');
      addCell(tr, fmtTime(a.timestamp));
      addCell(tr, a.action || '');
      addCell(tr, a.detail || '');
      addCell(tr, a.ip || '–');
      tbody.appendChild(tr);
    }
  }

  function loadAudit() {
    return api('/api/audit').then(function (r) {
      if (r.status === 401) { throw { auth: true }; }
      return r.json();
    }).then(function (list) { renderAudit(list); });
  }

  function loadAuthed() {
    return Promise.all([loadDomains(), loadResults(), loadWhois(), loadHistory(), loadSettings(), loadAudit()]).then(function () {
      showApp(true);
    }).catch(function (e) {
      if (e && e.auth) {
        setToken(''); showApp(false);
        var le = el('login-error'); le.textContent = 'Token ungültig oder nicht autorisiert.'; show(le, true);
      }
    });
  }

  function pollUntilDone(before, attempt) {
    if (attempt > 30) { el('run-msg').textContent = 'Prüfung läuft noch im Hintergrund — bitte später aktualisieren.'; el('run').disabled = false; return; }
    setTimeout(function () {
      api('/api/results.json').then(function (r) { return r.json(); }).then(function (rec) {
        var ts = (rec && rec.timestamp) ? rec.timestamp : null;
        if (ts && ts !== before) {
          lastTimestamp = ts; renderStatus(rec); renderResults(rec); loadHistory();
          el('run-msg').textContent = 'Prüfung abgeschlossen.';
          el('run').disabled = false;
        } else {
          pollUntilDone(before, attempt + 1);
        }
      }).catch(function () { pollUntilDone(before, attempt + 1); });
    }, 2000);
  }

  el('connect').addEventListener('click', function () {
    var t = el('token').value.trim();
    if (!t) { return; }
    setToken(t); show(el('login-error'), false); loadAuthed();
  });
  el('token').addEventListener('keydown', function (e) { if (e.key === 'Enter') { el('connect').click(); } });
  el('logout').addEventListener('click', function () { setToken(''); showApp(false); });
  el('refresh').addEventListener('click', function () { loadResults(); loadHistory(); });

  el('add-domain').addEventListener('click', function () { addDomainRow({ mode: 'auto' }); });

  el('save-domains').addEventListener('click', function () {
    var btn = this; btn.disabled = true;
    var msg = el('domains-msg'); show(msg, true); msg.textContent = 'Speichere…';
    api('/api/domains', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(collectDomains()) })
      .then(function (r) { if (r.status === 401) { throw { auth: true }; } return r.json(); })
      .then(function (j) { msg.textContent = 'Gespeichert: ' + j.count + ' Domains'; el('domain-count').textContent = j.count + ' Domains'; })
      .catch(function (e) { msg.textContent = (e && e.auth) ? 'Nicht autorisiert.' : 'Fehler beim Speichern.'; })
      .then(function () { btn.disabled = false; });
  });

  el('run').addEventListener('click', function () {
    var btn = this; btn.disabled = true;
    var msg = el('run-msg'); show(msg, true); msg.textContent = 'Prüfung gestartet…';
    var before = lastTimestamp;
    api('/api/run?async=true', { method: 'POST' })
      .then(function (r) { if (r.status === 401) { throw { auth: true }; } return r.json(); })
      .then(function () { pollUntilDone(before, 0); })
      .catch(function (e) { msg.textContent = (e && e.auth) ? 'Nicht autorisiert.' : 'Konnte Prüfung nicht starten.'; btn.disabled = false; });
  });

  el('download').addEventListener('click', function () {
    api('/api/results.csv').then(function (r) { if (r.status === 401) { throw { auth: true }; } return r.text(); }).then(function (text) {
      var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'inwx-results.csv';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }).catch(function () {});
  });

  function pollWhois(before, attempt) {
    if (attempt > 60) { el('whois-time').textContent = 'WHOIS-Abfrage läuft noch — bitte später aktualisieren.'; el('whois-refresh').disabled = false; return; }
    setTimeout(function () {
      api('/api/whois').then(function (r) { return r.json(); }).then(function (rec) {
        var ts = (rec && rec.timestamp) ? rec.timestamp : null;
        if (ts && ts !== before) {
          renderWhois(rec); el('whois-refresh').disabled = false;
        } else {
          pollWhois(before, attempt + 1);
        }
      }).catch(function () { pollWhois(before, attempt + 1); });
    }, 2500);
  }

  el('whois-refresh').addEventListener('click', function () {
    var btn = this; btn.disabled = true;
    var before = null;
    api('/api/whois').then(function (r) { return r.json(); }).then(function (rec) { before = (rec && rec.timestamp) ? rec.timestamp : null; })
      .then(function () { return api('/api/whois/refresh?async=true', { method: 'POST' }); })
      .then(function (r) { if (r.status === 401) { throw { auth: true }; } return r.json(); })
      .then(function () { el('whois-time').textContent = 'WHOIS-Abfrage läuft…'; pollWhois(before, 0); })
      .catch(function (e) { el('whois-time').textContent = (e && e.auth) ? 'Nicht autorisiert.' : 'Fehler beim Start.'; btn.disabled = false; });
  });

  el('check-btn').addEventListener('click', function () {
    var input = el('check-input').value.trim();
    var tldsRaw = el('check-tlds').value.trim();
    if (!input) { return; }
    var body = tldsRaw
      ? { keyword: input, tlds: tldsRaw.split(',').map(function (t) { return t.trim(); }).filter(Boolean) }
      : { domain: input };
    var btn = this; btn.disabled = true; btn.textContent = 'Prüfe…';
    api('/api/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { if (r.status === 401) { throw { auth: true }; } return r.json(); })
      .then(function (j) { renderCheckResults((j && j.results) || []); if (j && j.ok === false && j.error) { window.alert(j.error); } })
      .catch(function (e) { window.alert((e && e.auth) ? 'Nicht autorisiert.' : 'Fehler beim Check.'); })
      .then(function () { btn.disabled = false; btn.textContent = 'Prüfen'; });
  });

  el('save-settings').addEventListener('click', function () {
    var dryRun = el('set-dryrun').checked;
    if (!dryRun && !window.confirm('DRY_RUN ausschalten? Der Bot registriert dann verfügbare auto-Domains WIRKLICH (kostenpflichtig).')) { return; }
    var override = { dryRun: dryRun };
    var delay = el('set-delay').value.trim();
    if (delay !== '') { var d = Number(delay); if (!isNaN(d)) { override.apiDelayMs = d; } }
    var th = el('set-thresholds').value.trim();
    if (th !== '') { override.expiryAlertDays = th.split(',').map(function (x) { return Number(x.trim()); }).filter(function (n) { return !isNaN(n); }); }
    override.renewalMode = el('set-renewal').value;
    override.period = el('set-period').value.trim();
    override.transferLock = el('set-lock').checked;
    var btn = this; btn.disabled = true;
    var msg = el('settings-msg'); show(msg, true); msg.textContent = 'Speichere…';
    api('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(override) })
      .then(function (r) { if (r.status === 401) { throw { auth: true }; } return r.json(); })
      .then(function () { msg.textContent = 'Gespeichert.'; loadPublicStatus(); loadAudit(); })
      .catch(function (e) { msg.textContent = (e && e.auth) ? 'Nicht autorisiert.' : 'Fehler.'; })
      .then(function () { btn.disabled = false; });
  });

  el('reset-settings').addEventListener('click', function () {
    if (!window.confirm('Alle Overrides löschen und auf die wrangler.toml-Standardwerte zurücksetzen?')) { return; }
    var btn = this; btn.disabled = true;
    var msg = el('settings-msg'); show(msg, true); msg.textContent = 'Setze zurück…';
    api('/api/settings', { method: 'DELETE' })
      .then(function (r) { if (r.status === 401) { throw { auth: true }; } return r.json(); })
      .then(function () { msg.textContent = 'Zurückgesetzt.'; loadSettings(); loadPublicStatus(); loadAudit(); })
      .catch(function (e) { msg.textContent = (e && e.auth) ? 'Nicht autorisiert.' : 'Fehler.'; })
      .then(function () { btn.disabled = false; });
  });

  el('export-btn').addEventListener('click', function () {
    api('/api/export').then(function (r) { if (r.status === 401) { throw { auth: true }; } return r.text(); }).then(function (text) {
      var blob = new Blob([text], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a'); a.href = url; a.download = 'inwx-bot-backup.json';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }).catch(function (e) { window.alert((e && e.auth) ? 'Nicht autorisiert.' : 'Fehler beim Export.'); });
  });

  // Client-side comfort: live row filtering + click-to-sort on read-only tables.
  function applyFilter(input, table) {
    if (!input || !table) { return; }
    var q = (input.value || '').trim().toLowerCase();
    var rows = table.querySelectorAll('tbody tr');
    for (var i = 0; i < rows.length; i++) {
      rows[i].hidden = q !== '' && rows[i].textContent.toLowerCase().indexOf(q) === -1;
    }
  }
  function attachFilter(input, table) {
    if (!input || !table) { return; }
    input.addEventListener('input', function () { applyFilter(input, table); });
  }
  function makeSortable(table) {
    if (!table) { return; }
    var ths = table.querySelectorAll('thead th');
    for (var i = 0; i < ths.length; i++) {
      (function (idx, th) {
        th.addEventListener('click', function () {
          var tbody = table.querySelector('tbody');
          var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));
          var asc = th.getAttribute('data-asc') !== 'true';
          rows.sort(function (a, b) {
            var x = a.children[idx] ? a.children[idx].textContent : '';
            var y = b.children[idx] ? b.children[idx].textContent : '';
            var nx = parseFloat(x), ny = parseFloat(y);
            if (!isNaN(nx) && !isNaN(ny)) { return asc ? nx - ny : ny - nx; }
            return asc ? x.localeCompare(y) : y.localeCompare(x);
          });
          for (var r = 0; r < rows.length; r++) { tbody.appendChild(rows[r]); }
          th.setAttribute('data-asc', asc ? 'true' : 'false');
        });
      })(i, ths[i]);
    }
  }
  makeSortable(el('results')); makeSortable(el('whois')); makeSortable(el('history'));
  attachFilter(el('results-filter'), el('results'));
  attachFilter(el('whois-filter'), el('whois'));

  loadPublicStatus();
  if (getToken()) { loadAuthed(); } else { showApp(false); }
})();
</script>
</body>
</html>`;
}
