// BotNest panel. Demo mode (localStorage) or live mode against a panel API.
// On GitHub Pages, set the panel API URL in the login form; it is stored in
// this browser under the key bn_api_base.

const $ = (id) => document.getElementById(id);
const API_BASE = (localStorage.getItem('bn_api_base') || '').replace(/\/+$/, '');const API = {
  async call(path, opts = {}) {
    const token = sessionStorage.getItem('bn_token');
    const res = await fetch(API_BASE + '/api' + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) }
    });
    if (res.status === 401) { logout(); throw new Error('unauthorized'); }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'request failed');
    return res.json();
  }
};

let realMode = false;
let servers = [];
let openId = null;
let logTimer = null;

function demoLoad() {
  try { servers = JSON.parse(localStorage.getItem('bn_servers') || 'null'); } catch (e) { servers = null; }
  if (!servers) {
    servers = [
      { id: 'srv_demo1', name: 'luacrypt-bot', runtime: 'python', plan: 'roost', status: 'online', logs: [], env: {} },
      { id: 'srv_demo2', name: 'cypher-spectre', runtime: 'node', plan: 'nest', status: 'online', logs: [], env: {} }
    ];
    demoSave();
  }
}
function demoSave() { localStorage.setItem('bn_servers', JSON.stringify(servers)); }

const DEMO_LOGS = {
  python: ['[gateway] shard 0 connected', '[gateway] ready as your-bot#1234', '[commands] 20 commands registered', '[db] connection pool ready'],
  node: ['[gateway] websocket opened', '[gateway] ready, logged in as your-bot#1234', '[commands] slash commands synced', '[heartbeat] ok']
};

function demoLog(server) {
  const pool = DEMO_LOGS[server.runtime] || DEMO_LOGS.node;
  const line = new Date().toLocaleTimeString() + ' ' + pool[Math.floor(Math.random() * pool.length)];
  server.logs.push(line);
  if (server.logs.length > 300) server.logs.shift();
  if (openId === server.id) renderConsole(server);
}

function logout() {
  sessionStorage.removeItem('bn_token');
  clearInterval(logTimer);
  location.reload();
}

function renderList() {
  const list = $('server-list');
  list.innerHTML = '';
  for (const s of servers) {
    const row = document.createElement('div');
    row.className = 'server-row';
    row.innerHTML = `<span class="dot ${s.status}"></span><span class="name"></span><span class="meta">${s.runtime} · ${s.plan}</span>`;
    row.querySelector('.name').textContent = s.name;
    row.onclick = () => openDetail(s.id);
    list.appendChild(row);
  }
}

function renderConsole(s) {
  const c = $('console');
  c.textContent = (s.logs || []).join('\n') || 'no output yet';
  c.scrollTop = c.scrollHeight;
}

function renderDetail() {
  const s = servers.find(x => x.id === openId);
  if (!s) return;
  $('detail-name').textContent = s.name;
  $('detail-status').innerHTML = `<span class="dot ${s.status}"></span>${s.status}`;
  $('detail-status').className = 'status ' + s.status;
  $('detail-entry').textContent = s.runtime === 'python' ? 'python main.py' : 'node index.js';
  const envList = $('env-list');
  envList.innerHTML = '';
  for (const [k] of Object.entries(s.env || {})) {
    const row = document.createElement('div');
    row.className = 'env-row';
    row.innerHTML = `<span></span><span>hidden</span>`;
    row.querySelector('span').textContent = k;
    envList.appendChild(row);
  }
  renderConsole(s);
  $('start-btn').disabled = s.status === 'online';
  $('stop-btn').disabled = s.status === 'offline';
}

function openDetail(id) {
  openId = id;
  $('server-detail').hidden = false;
  $('server-list').style.display = 'none';
  $('new-server-btn').style.display = 'none';
  renderDetail();
  clearInterval(logTimer);
  const s = servers.find(x => x.id === id);
  if (realMode) {
    logTimer = setInterval(async () => {
      try {
        const d = await API.call(`/servers/${id}/logs`);
        s.logs = d.logs;
        renderConsole(s);
      } catch (e) {}
    }, 3000);
  } else {
    logTimer = setInterval(() => { if (s.status === 'online') demoLog(s); }, 2500);
  }
}

function closeDetail() {
  openId = null;
  clearInterval(logTimer);
  $('server-detail').hidden = true;
  $('server-list').style.display = '';
  $('new-server-btn').style.display = '';
}

async function act(action) {
  const s = servers.find(x => x.id === openId);
  if (realMode) {
    try { await API.call(`/servers/${openId}/${action}`, { method: 'POST', body: JSON.stringify({}) }); } catch (e) { alert(e.message); return; }
    const d = await API.call('/servers').catch(() => null);
    if (d) servers = d.servers;
    renderDetail();
  } else {
    if (action === 'delete') {
      servers = servers.filter(x => x.id !== openId);
      demoSave(); closeDetail(); renderList(); return;
    }
    if (action === 'restart') { s.logs.push(new Date().toLocaleTimeString() + ' restarting container...'); s.status = 'online'; }
    else s.status = action === 'start' ? 'online' : 'offline';
    s.logs.push(new Date().toLocaleTimeString() + ` container ${action}ed`);
    demoSave(); renderDetail();
  }
}

async function boot() {
  // detect the real panel API
  try {
    const h = await fetch(API_BASE + '/api/health');
    if (h.ok) { const d = await h.json(); realMode = !!d.panel; }
  } catch (e) {}
  $('mode-pill').textContent = realMode ? 'live node' : 'demo mode';

  const token = sessionStorage.getItem('bn_token');
  if (token) {
    $('login-view').hidden = true;
    $('app-view').hidden = false;
    $('user-pill').textContent = sessionStorage.getItem('bn_email') || '';
    $('logout-btn').hidden = false;
    if (realMode) {
      const d = await API.call('/servers').catch(() => ({ servers: [] }));
      servers = d.servers;
    } else {
      demoLoad();
    }
    renderList();
  }
}

$('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const base = $('login-api-base').value.trim();
  if (base) localStorage.setItem('bn_api_base', base.replace(/\/+$/, ''));
  const email = $('login-email').value;
  sessionStorage.setItem('bn_token', 'demo');
  sessionStorage.setItem('bn_email', email);
  boot();
});
$('logout-btn').addEventListener('click', logout);
$('new-server-btn').addEventListener('click', () => { $('modal').hidden = false; });
$('modal-cancel').addEventListener('click', () => { $('modal').hidden = true; });
$('new-server-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = { name: $('ns-name').value.trim(), runtime: $('ns-runtime').value, plan: $('ns-plan').value };
  if (realMode) {
    try { await API.call('/servers', { method: 'POST', body: JSON.stringify(payload) }); } catch (err) { alert(err.message); return; }
  } else {
    servers.push({ id: 'srv_' + Date.now(), status: 'offline', logs: [], env: {}, ...payload });
    demoSave();
  }
  $('modal').hidden = true;
  $('ns-name').value = '';
  await boot(); renderList();
});
$('close-detail').addEventListener('click', closeDetail);
$('start-btn').addEventListener('click', () => act('start'));
$('stop-btn').addEventListener('click', () => act('stop'));
$('restart-btn').addEventListener('click', () => act('restart'));
$('delete-btn').addEventListener('click', () => { if (confirm('Delete this server and its files?')) act('delete'); });
$('env-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const k = $('env-key').value.trim(), v = $('env-value').value;
  if (!k || !v) return;
  const s = servers.find(x => x.id === openId);
  if (realMode) {
    try { await API.call(`/servers/${openId}/env`, { method: 'POST', body: JSON.stringify({ key: k, value: v }) }); } catch (err) { alert(err.message); return; }
  } else {
    s.env = s.env || {}; s.env[k] = 'saved';
    demoSave();
  }
  $('env-key').value = ''; $('env-value').value = '';
  renderDetail();
});
$('upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = $('upload-file').files[0];
  if (!f) return;
  if (realMode) {
    const token = sessionStorage.getItem('bn_token');
    const fd = new FormData();
    fd.append('file', f);
    try {
      const res = await fetch(`/api/servers/${openId}/upload`, { method: 'POST', headers: token ? { Authorization: 'Bearer ' + token } : {}, body: fd });
      if (!res.ok) throw new Error('upload failed');
      $('console').textContent += '\n[panel] ' + f.name + ' uploaded and extracted';
    } catch (err) { alert(err.message); return; }
  } else {
    $('console').textContent += '\n[panel] ' + f.name + ' received (demo mode, stored locally)';
    $('console').scrollTop = 1e9;
  }
  $('upload-file').value = '';
});

boot();
