// Kers0neVPS panel. Real accounts only: sign up or log in against the
// node API (server/server.js). No demo mode.

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'kv_token', EMAIL_KEY = 'kv_email', BASE_KEY = 'kv_api_base';

const apiBase = () => (localStorage.getItem(BASE_KEY) || '').replace(/\/+$/, '');

async function api(path, opts = {}) {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch(apiBase() + '/api' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { clearAuth(); showAuth(); throw new Error('session expired, log in again'); }
  if (!res.ok) throw new Error(data.error || 'request failed');
  return data;
}

let servers = [], openId = null, logTimer = null, listTimer = null;

function clearAuth() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(EMAIL_KEY); }

function showAuth() {
  $('auth-view').hidden = false;
  $('app-view').hidden = true;
  clearInterval(logTimer); clearInterval(listTimer);
  checkNode();
}

function showApp() {
  $('auth-view').hidden = true;
  $('app-view').hidden = false;
  $('side-email').textContent = localStorage.getItem(EMAIL_KEY) || '';
  switchView('servers');
  loadServers();
  listTimer = setInterval(() => { if (!openId) loadServers(true); }, 10000);
}

function switchView(v) {
  for (const el of document.querySelectorAll('.side-item')) el.classList.toggle('active', el.dataset.view === v);
  $('servers-view').hidden = v !== 'servers' || !!openId;
  $('server-detail').hidden = v !== 'servers' || !openId;
  $('account-view').hidden = v !== 'account';
  if (v === 'account') {
    $('account-email').textContent = localStorage.getItem(EMAIL_KEY) || '';
    $('api-base-2').value = apiBase();
  }
}

async function checkNode() {
  const pill = $('node-pill');
  if (!apiBase()) { pill.textContent = 'set your panel node below'; pill.className = 'pill'; return; }
  try {
    const r = await fetch(apiBase() + '/api/health');
    if (r.ok) { pill.textContent = 'node online'; pill.className = 'pill ok'; return; }
  } catch (e) {}
  pill.textContent = 'node unreachable'; pill.className = 'pill';
}

function renderServers() {
  const list = $('server-list');
  list.innerHTML = '';
  $('servers-empty').hidden = servers.length > 0;
  for (const s of servers) {
    const row = document.createElement('div');
    row.className = 'server-row';
    const meta = document.createElement('span'); meta.className = 'meta'; meta.textContent = `${s.runtime} · ${s.plan} · ${s.status}`;
    row.innerHTML = `<span class="dot ${s.status}"></span>`;
    const name = document.createElement('span'); name.className = 'name'; name.textContent = s.name;
    row.appendChild(name); row.appendChild(meta);
    row.onclick = () => openDetail(s.id);
    list.appendChild(row);
  }
}

async function loadServers(quiet) {
  try {
    const d = await api('/servers');
    servers = d.servers;
    if (!quiet) renderServers(); else { const keep = openId; renderServers(); if (keep) renderDetail(); }
  } catch (e) { if (!quiet) $('servers-empty').hidden = false, $('servers-empty').textContent = e.message; }
}

function renderDetail() {
  const s = servers.find(x => x.id === openId);
  if (!s) return;
  $('detail-name').textContent = s.name;
  $('detail-status').innerHTML = `<span class="dot ${s.status}"></span>${s.status}`;
  $('detail-status').className = 'status ' + s.status;
  $('detail-meta').textContent = `${s.runtime} runtime · ${s.plan} plan · created ${new Date(s.createdAt).toLocaleDateString()}`;
  $('detail-entry').textContent = s.runtime === 'python' ? 'python main.py' : 'node index.js';
  const envList = $('env-list');
  envList.innerHTML = '';
  for (const [k] of Object.entries(s.envKeys || {})) {
    const row = document.createElement('div');
    row.className = 'env-row';
    const a = document.createElement('span'); a.textContent = k;
    const b = document.createElement('span'); b.textContent = 'saved on node';
    row.appendChild(a); row.appendChild(b);
    envList.appendChild(row);
  }
  $('start-btn').disabled = s.status === 'online';
  $('stop-btn').disabled = s.status === 'offline';
}

async function openDetail(id) {
  openId = id;
  switchView('servers');
  renderDetail();
  clearInterval(logTimer);
  const pull = async () => {
    try {
      const d = await api(`/servers/${openId}/logs`);
      const c = $('console');
      c.textContent = d.logs.join('\n') || 'no output yet';
      c.scrollTop = c.scrollHeight;
    } catch (e) {}
  };
  pull();
  logTimer = setInterval(pull, 3000);
}

function closeDetail() { openId = null; clearInterval(logTimer); switchView('servers'); renderServers(); }

async function act(action) {
  const s = servers.find(x => x.id === openId);
  if (action === 'delete' && !confirm(`Delete ${s.name}? Container and files are removed permanently.`)) return;
  try {
    if (action === 'delete') await api(`/servers/${openId}`, { method: 'DELETE' });
    else await api(`/servers/${openId}/${action}`, { method: 'POST', body: '{}' });
  } catch (e) { alert(e.message); return; }
  if (action === 'delete') { closeDetail(); }
  await loadServers(true); renderDetail();
}

// auth tabs
$('tab-login').addEventListener('click', () => {
  $('tab-login').classList.add('active'); $('tab-signup').classList.remove('active');
  $('login-form').hidden = false; $('signup-form').hidden = true;
});
$('tab-signup').addEventListener('click', () => {
  $('tab-signup').classList.add('active'); $('tab-login').classList.remove('active');
  $('signup-form').hidden = false; $('login-form').hidden = true;
});
function authError(msg) { const e = $('auth-error'); e.textContent = msg; e.hidden = !msg; }

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault(); authError('');
  try {
    const d = await api('/login', { method: 'POST', body: JSON.stringify({ email: $('login-email').value.trim(), password: $('login-password').value }) });
    localStorage.setItem(TOKEN_KEY, d.token); localStorage.setItem(EMAIL_KEY, d.user.email);
    showApp();
  } catch (err) { authError(err.message); }
});
$('signup-form').addEventListener('submit', async (e) => {
  e.preventDefault(); authError('');
  if ($('signup-password').value !== $('signup-confirm').value) { authError('passwords do not match'); return; }
  try {
    const d = await api('/signup', { method: 'POST', body: JSON.stringify({ email: $('signup-email').value.trim(), password: $('signup-password').value }) });
    localStorage.setItem(TOKEN_KEY, d.token); localStorage.setItem(EMAIL_KEY, d.user.email);
    showApp();
  } catch (err) { authError(err.message); }
});
$('logout-btn').addEventListener('click', () => {
  api('/logout', { method: 'POST', body: '{}' }).catch(() => {});
  clearAuth(); showAuth();
});

// api base management
function saveBase(input) {
  const v = input.value.trim();
  if (v) localStorage.setItem(BASE_KEY, v.replace(/\/+$/, ''));
  checkNode();
}
$('api-save').addEventListener('click', () => saveBase($('api-base')));
$('api-save-2').addEventListener('click', () => saveBase($('api-base-2')));

// servers
$('new-server-btn').addEventListener('click', () => { $('modal').hidden = false; });
$('modal-cancel').addEventListener('click', () => { $('modal').hidden = true; });
$('new-server-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/servers', { method: 'POST', body: JSON.stringify({ name: $('ns-name').value.trim(), runtime: $('ns-runtime').value, plan: $('ns-plan').value }) });
    $('modal').hidden = true; $('ns-name').value = '';
    await loadServers();
  } catch (err) { alert(err.message); }
});
document.querySelectorAll('.side-item').forEach(el => el.addEventListener('click', () => switchView(el.dataset.view)));
$('close-detail').addEventListener('click', closeDetail);
$('start-btn').addEventListener('click', () => act('start'));
$('stop-btn').addEventListener('click', () => act('stop'));
$('restart-btn').addEventListener('click', () => act('restart'));
$('delete-btn').addEventListener('click', () => act('delete'));
$('env-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const k = $('env-key').value.trim(), v = $('env-value').value;
  if (!k || !v) return;
  try { await api(`/servers/${openId}/env`, { method: 'POST', body: JSON.stringify({ key: k, value: v }) }); }
  catch (err) { alert(err.message); return; }
  $('env-key').value = ''; $('env-value').value = '';
  const s = servers.find(x => x.id === openId);
  if (s) { s.envKeys = s.envKeys || {}; s.envKeys[k] = true; }
  renderDetail();
});
$('upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = $('upload-file').files[0];
  if (!f) return;
  const token = localStorage.getItem(TOKEN_KEY);
  const fd = new FormData();
  fd.append('file', f);
  try {
    const res = await fetch(apiBase() + `/api/servers/${openId}/upload`, { method: 'POST', headers: token ? { Authorization: 'Bearer ' + token } : {}, body: fd });
    if (!res.ok) throw new Error('upload failed');
    const c = $('console');
    c.textContent += `\n[panel] ${f.name} uploaded and extracted`;
    c.scrollTop = c.scrollHeight;
  } catch (err) { alert(err.message); return; }
  $('upload-file').value = '';
});

// boot
$('api-base').value = apiBase();
if (localStorage.getItem(TOKEN_KEY)) {
  api('/me').then((d) => { localStorage.setItem(EMAIL_KEY, d.user.email); showApp(); }).catch(() => showAuth());
} else {
  showAuth();
}
