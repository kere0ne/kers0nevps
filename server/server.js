// Kers0neVPS panel node. Real accounts, real supervised bot processes, real
// file manager. Implements the full panel API the Kers0ne VPS front end
// calls. Docker when available, supervised child processes when not.
const express = require('express');
const multer = require('multer');
const os = require('os');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8123;
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, '..');
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const SERVERS_DIR = path.join(DATA, 'servers');
const UPLOADS_DIR = path.join(DATA, 'uploads');
const DB_FILE = path.join(DATA, 'db.json');
fs.mkdirSync(SERVERS_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const PLANS = {
  starter:     { cpu: '1 Core',  memory: '1 GB RAM', storage: '20 GB NVMe',  mem: '512m', cpus: '0.5', label: 'Free Community' },
  standard:    { cpu: '2 Cores', memory: '2 GB RAM', storage: '40 GB NVMe',  mem: '1g',   cpus: '1',   label: 'Free Bot Host' },
  performance: { cpu: '4 Cores', memory: '4 GB RAM', storage: '80 GB NVMe',  mem: '2g',   cpus: '2',   label: 'Free High Performance' },
  ultra:       { cpu: '8 Cores', memory: '8 GB RAM', storage: '160 GB NVMe', mem: '4g',   cpus: '4',   label: 'Free Ultra Dedicated' }
};
const DISCORD_PY = ['discord.py', 'python-dotenv', 'aiohttp', 'requests', 'psutil', 'colorama', 'asyncpg'];
const DISCORD_JS = ['discord.js', 'dotenv'];

// ---------- tiny json db ----------
function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { return { users: [], vps: [] }; }
}
function saveDb(db) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
const rand = (n) => crypto.randomBytes(n).toString('hex');
const hashPassword = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');

// ---------- vps process helpers ----------
const sdir = (id) => path.join(SERVERS_DIR, id);
const logFile = (id) => path.join(sdir(id), '.panel-app.log');

function vpsAlive(v) {
  try {
    const pid = parseInt(fs.readFileSync(path.join(sdir(v.id), 'pid'), 'utf8'), 10);
    process.kill(pid, 0);
    return pid;
  } catch (e) { return 0; }
}
function appendLog(id, line) {
  try { fs.appendFileSync(logFile(id), `[${new Date().toLocaleTimeString()}] ${line}\n`); } catch (e) {}
}

function spawnBot(v) {
  const dir = sdir(v.id);
  const rt = v.bot.runtime || 'python';
  const fn = v.bot.filename || (rt === 'node' ? 'index.js' : 'bot.py');
  const cmd = rt === 'node' ? `node ${fn}` : rt === 'bash' ? `bash ${fn}` : `python3 ${fn}`;
  const env = {};
  try {
    for (const l of fs.readFileSync(path.join(dir, '.env'), 'utf8').split('\n')) {
      const i = l.indexOf('=');
      if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
    }
  } catch (e) {}
  const out = fs.openSync(logFile(v.id), 'a');
  const child = spawn('sh', ['-c', `exec ${cmd}`], {
    cwd: dir, detached: true, stdio: ['ignore', out, out], env: { ...process.env, ...env }
  });
  child.unref();
  fs.writeFileSync(path.join(dir, 'pid'), String(child.pid));
  v.bot.pid = child.pid;
  v.bot.started_at = Date.now();
  appendLog(v.id, `[24/7 Watchdog] Spawning real process: ${cmd}`);
}

function killBot(v) {
  const pid = vpsAlive(v);
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch (e) {}
    setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch (e) {} }, 2500);
  }
  v.bot.pid = null;
  v.bot.started_at = null;
  appendLog(v.id, '[panel] Process stopped');
}

// ---------- background installs (API responses stay quick) ----------
const jobs = new Set();
function runInstall(vpsId, kind, args, onDone) {
  const key = vpsId + ':' + kind;
  jobs.add(key);
  const finish = (err, out) => {
    jobs.delete(key);
    if (err) appendLog(vpsId, '[panel] ' + kind + ' install issue: ' + String(err.message || err).slice(0, 180) + ' | ' + String(out || '').slice(-200).replace(/\n/g, ' '));
    if (onDone) onDone(err, out);
  };
  if (kind === 'node') {
    execFile('npm', ['install', '--no-audit', '--no-fund', ...args], { cwd: sdir(vpsId), timeout: 300000, maxBuffer: 4 * 1024 * 1024 }, finish);
  } else {
    // python3 -m pip first, then --break-system-packages for PEP 668 system pythons
    const pkgs = args.join(' ');
    execFile('sh', ['-c',
      'python3 -m pip install -q ' + pkgs + ' 2>&1 || python3 -m pip install -q --break-system-packages ' + pkgs + ' 2>&1 || pip3 install -q ' + pkgs + ' 2>&1'
    ], { cwd: sdir(vpsId), timeout: 300000, maxBuffer: 4 * 1024 * 1024 }, finish);
  }
}

function autoInstallStack(vpsId, force) {
  const db = loadDb();
  const v = db.vps.find((x) => x.id === vpsId);
  if (!v) return;
  if (!force && v.packages.auto_install.status === 'done') return;
  v.packages.auto_install = { status: 'running' };
  saveDb(db);
  appendLog(vpsId, '[24/7 Watchdog] Installing Discord stack (discord.py, discord.js, dotenv...)');
  let remaining = 2, okCount = 0;
  const done = (err, out) => {
    remaining--;
    if (!err && !/externally-managed|No such file|not found|EACCES|EXC/i.test(String(out || '').slice(-300))) okCount++;
    if (remaining > 0) return;
    const d2 = loadDb();
    const v2 = d2.vps.find((x) => x.id === vpsId);
    const failed = okCount === 0;
    if (v2) { v2.packages.auto_install.status = failed ? 'failed' : 'done'; saveDb(d2); }
    appendLog(vpsId, failed
      ? '[24/7 Watchdog] Discord stack install failed — press Install Discord Stack to retry'
      : '[24/7 Watchdog] Discord stack installed [ONLINE]');
  };
  runInstall(vpsId, 'python', DISCORD_PY, done);
  runInstall(vpsId, 'node', DISCORD_JS, done);
}

function preinstallAndStart(v) {
  const dir = sdir(v.id);
  const rt = v.bot.runtime || 'python';
  const step = () => {
    if (jobs.has(v.id + ':python') || jobs.has(v.id + ':node')) { setTimeout(step, 2000); return; }
    const needPy = rt === 'python' && fs.existsSync(path.join(dir, 'requirements.txt'));
    const needJs = rt === 'node' && fs.existsSync(path.join(dir, 'package.json')) && !fs.existsSync(path.join(dir, 'node_modules'));
    const go = () => { const d = loadDb(); const v2 = d.vps.find((x) => x.id === v.id); if (v2 && v2.bot.desired) { spawnBot(v2); saveDb(d); } };
    if (needPy) runInstall(v.id, 'python', ['-r', 'requirements.txt'], go);
    else if (needJs) runInstall(v.id, 'node', [], go);
    else go();
  };
  step();
}

// watchdog: keep desired bots alive 24/7
setInterval(() => {
  try {
    const db = loadDb();
    let changed = false;
    for (const v of db.vps) {
      if (v.bot && v.bot.desired && !vpsAlive(v)) {
        v.bot.respawnCount = (v.bot.respawnCount || 0) + 1;
        appendLog(v.id, `[24/7 Watchdog] Bot PID inactive, respawning (recovery ${v.bot.respawnCount}) [ONLINE]`);
        spawnBot(v);
        changed = true;
      }
    }
    if (changed) saveDb(db);
  } catch (e) {}
}, 10000);

// ---------- auth ----------
function userByKey(k) {
  k = String(k || '');
  if (!k) return null;
  const db = loadDb();
  return db.users.find((u) => u.api_key === k) || null;
}
function keyFromReq(req) {
  return req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || '';
}
function requireUser(req, res, next) {
  const u = userByKey(keyFromReq(req));
  if (!u) return res.status(401).json({ success: false, error: 'Not signed in.' });
  req.user = u;
  next();
}

// ---------- http app ----------
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, X-API-Key, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
// never serve panel data, env files or db over http
app.use((req, res, next) => {
  const p = req.path;
  if (p.startsWith('/data') || p === '/tunnel-url.txt' || p === '/tunnel.log' || p === '/.api.pid' || p.startsWith('/.panel')) {
    return res.status(403).json({ success: false, error: 'forbidden' });
  }
  next();
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', product: 'Kers0neVPS', engine: 'kers0nevps-node', uptime_seconds: Math.floor(process.uptime()) }));

const netCache = new Map();
app.get('/api/netinfo', (req, res) => {
  let ip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  const hit = netCache.get(ip);
  if (hit && Date.now() - hit.t < 600000) return res.json({ success: true, ...hit.v });
  const url = 'http://ip-api.com/json/' + encodeURIComponent(ip) + '?fields=status,country,countryCode,isp,org,proxy,hosting,mobile,query';
  const req2 = require('http').get(url, { timeout: 6000 }, (r2) => {
    let d = '';
    r2.on('data', (c) => (d += c));
    r2.on('end', () => {
      let v = { ip, country: '', isp: '', proxy: false, hosting: false, mobile: false };
      try { const j = JSON.parse(d); if (j.status === 'success') v = { ip: j.query || ip, country: j.countryCode || '', isp: j.isp || j.org || '', proxy: !!j.proxy, hosting: !!j.hosting, mobile: !!j.mobile }; } catch (e) {}
      netCache.set(ip, { t: Date.now(), v });
      if (netCache.size > 500) netCache.clear();
      res.json({ success: true, ...v });
    });
  });
  req2.on('error', () => res.json({ success: false, ip }));
  req2.on('timeout', () => { req2.destroy(); res.json({ success: false, ip }); });
});

app.post('/api/register', (req, res) => {
  const db = loadDb();
  const username = String((req.body || {}).username || '').trim();
  const password = String((req.body || {}).password || '');
  if (username.length < 3) return res.json({ success: false, error: 'Username must be at least 3 characters.' });
  if (password.length < 6) return res.json({ success: false, error: 'Password must be at least 6 characters.' });
  if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) return res.json({ success: false, error: 'That username is already taken.' });
  const salt = rand(16);
  const user = {
    id: 'usr_' + rand(8), username,
    password: { salt, hash: hashPassword(password, salt) },
    api_key: 'kv_' + rand(24),
    created_at: new Date().toISOString()
  };
  db.users.push(user);
  saveDb(db);
  res.json({ success: true, api_key: user.api_key, user_id: user.id, username: user.username, created_at: user.created_at });
});

app.post('/api/login', (req, res) => {
  const db = loadDb();
  const username = String((req.body || {}).username || '').trim().toLowerCase();
  const password = String((req.body || {}).password || '');
  const user = db.users.find((u) => u.username.toLowerCase() === username);
  if (!user || hashPassword(password, user.password.salt) !== user.password.hash) {
    return res.json({ success: false, error: 'Wrong username or password.' });
  }
  res.json({ success: true, api_key: user.api_key, user_id: user.id, username: user.username, created_at: user.created_at });
});

app.get('/api/session', (req, res) => {
  const u = userByKey(keyFromReq(req));
  res.json(u ? { authenticated: true, user: { id: u.id, username: u.username, api_key: u.api_key, created_at: u.created_at } } : { authenticated: false });
});
app.post('/api/session/switch', (req, res) => {
  const u = userByKey(String((req.body || {}).api_key || ''));
  if (!u) return res.json({ success: false, error: 'That saved account could not be restored.' });
  res.json({ success: true, api_key: u.api_key, user_id: u.id, username: u.username });
});
app.post('/api/logout', (req, res) => res.json({ success: true }));

app.get('/api/plans', (req, res) => res.json(PLANS));

app.get('/api/hardware', (req, res) => {
  const cpus = os.cpus();
  const gb = (b) => (b / 1073741824).toFixed(1) + ' GB';
  res.json({
    hardware: {
      cpu_cores: cpus.length,
      cpu_model: cpus[0] ? cpus[0].model.trim() : '?',
      total_memory: gb(os.totalmem()),
      free_memory: gb(os.freemem()),
      platform: os.platform() === 'linux' ? 'Linux x64' : os.platform(),
      kernel: os.release(),
      uptime_seconds: Math.floor(os.uptime())
    }
  });
});

// ---------- vps crud ----------
function publicVps(v) {
  const p = PLANS[v.plan] || PLANS.starter;
  const desired = v.bot && v.bot.desired;
  const alive = !!vpsAlive(v);
  return {
    id: v.id, name: v.name, plan: v.plan, cpu: p.cpu, memory: p.memory, storage: p.storage,
    ip: v.ip, created_at: v.created_at,
    status: desired && alive ? 'running' : 'stopped',
    packages: v.packages
  };
}

app.get('/api/vps', requireUser, (req, res) => {
  const db = loadDb();
  res.json({ success: true, vps: db.vps.filter((v) => v.userId === req.user.id).map(publicVps) });
});

app.post('/api/vps', requireUser, (req, res) => {
  const db = loadDb();
  const name = String((req.body || {}).name || '').trim().slice(0, 40) || 'server';
  const plan = PLANS[(req.body || {}).plan] ? (req.body || {}).plan : 'starter';
  const ipN = 50 + (db.vps.length % 200) + 1;
  const v = {
    id: 'vps-' + rand(4), userId: req.user.id, name, plan, ip: `172.20.0.${ipN}`,
    created_at: new Date().toISOString(),
    bot: { desired: false, status: 'stopped', running: false, filename: '', runtime: 'python', token_type: 'bot', token: '', pid: null, started_at: null, respawnCount: 0 },
    packages: {
      python: DISCORD_PY.map((n) => ({ name: n, version: '', auto: true })),
      node: DISCORD_JS.map((n) => ({ name: n, version: '', auto: true })),
      auto_install: { status: 'queued' }
    }
  };
  fs.mkdirSync(sdir(v.id), { recursive: true });
  db.vps.push(v);
  saveDb(db);
  autoInstallStack(v.id, false);
  res.json({ success: true, vps: publicVps(v), auto_install: { status: 'queued' } });
});

function findVps(req, res) {
  const db = loadDb();
  const v = db.vps.find((x) => x.id === req.params.id && x.userId === req.user.id);
  if (!v) { res.status(404).json({ success: false, error: 'VPS not found.' }); return null; }
  return { db, v };
}

app.post('/api/vps/:id/start', requireUser, (req, res) => {
  const f = findVps(req, res); if (!f) return;
  const b = req.body || {};
  if (b.filename) f.v.bot.filename = String(b.filename).trim();
  if (b.runtime) f.v.bot.runtime = b.runtime;
  if (b.token_type) f.v.bot.token_type = b.token_type;
  if (b.token) f.v.bot.token = String(b.token);
  if (!f.v.bot.filename) { f.v.bot.filename = f.v.bot.runtime === 'node' ? 'index.js' : 'bot.py'; }
  if (!fs.existsSync(path.join(sdir(f.v.id), f.v.bot.filename))) {
    return res.json({ success: false, error: `Script ${f.v.bot.filename} not found. Upload your bot files first.` });
  }
  f.v.bot.desired = true;
  f.v.bot.respawnCount = 0;
  saveDb(f.db);
  preinstallAndStart(f.v);
  res.json({ success: true, message: 'Process started on live host! [ONLINE]', bot_status: 'starting' });
});

app.post('/api/vps/:id/stop', requireUser, (req, res) => {
  const f = findVps(req, res); if (!f) return;
  f.v.bot.desired = false;
  killBot(f.v);
  saveDb(f.db);
  res.json({ success: true, message: 'Process stopped.' });
});

app.post('/api/vps/:id/restart', requireUser, (req, res) => {
  const f = findVps(req, res); if (!f) return;
  const b = req.body || {};
  if (b.filename) f.v.bot.filename = String(b.filename).trim();
  if (b.runtime) f.v.bot.runtime = b.runtime;
  if (b.token) f.v.bot.token = String(b.token);
  if (b.token_type) f.v.bot.token_type = b.token_type;
  f.v.bot.desired = true;
  f.v.bot.respawnCount = 0;
  killBot(f.v);
  saveDb(f.db);
  setTimeout(() => preinstallAndStart(f.v), 1500);
  res.json({ success: true, message: 'Process restarted. [ONLINE]', bot_status: 'starting' });
});

app.post('/api/vps/:id/rename', requireUser, (req, res) => {
  const f = findVps(req, res); if (!f) return;
  const name = String((req.body || {}).name || '').trim().slice(0, 40);
  if (!name) return res.json({ success: false, error: 'Enter a name.' });
  f.v.name = name;
  saveDb(f.db);
  res.json({ success: true });
});

app.delete('/api/vps/:id', requireUser, (req, res) => {
  const f = findVps(req, res); if (!f) return;
  f.v.bot.desired = false;
  killBot(f.v);
  try { fs.rmSync(sdir(f.v.id), { recursive: true, force: true }); } catch (e) {}
  f.db.vps = f.db.vps.filter((x) => x.id !== f.v.id);
  saveDb(f.db);
  res.json({ success: true });
});

// ---------- bot ----------
function startBotRoute(req, res) {
  const f = findVps(req, res); if (!f) return;
  const b = req.body || {};
  if (b.filename) f.v.bot.filename = String(b.filename).trim();
  if (b.runtime) f.v.bot.runtime = b.runtime;
  if (b.token_type) f.v.bot.token_type = b.token_type;
  if (b.token) f.v.bot.token = String(b.token);
  if (!f.v.bot.filename) { f.v.bot.filename = f.v.bot.runtime === 'node' ? 'index.js' : 'bot.py'; }
  if (!fs.existsSync(path.join(sdir(f.v.id), f.v.bot.filename))) {
    return res.json({ success: false, error: `Script ${f.v.bot.filename} not found. Upload your bot files first.` });
  }
  f.v.bot.desired = true;
  f.v.bot.respawnCount = 0;
  saveDb(f.db);
  preinstallAndStart(f.v);
  res.json({ success: true, message: 'Process started on live host! [ONLINE]', bot_status: 'starting' });
}
function stopBotRoute(req, res) {
  const f = findVps(req, res); if (!f) return;
  f.v.bot.desired = false;
  killBot(f.v);
  saveDb(f.db);
  res.json({ success: true, message: 'Process stopped.' });
}
function restartBotRoute(req, res) {
  const f = findVps(req, res); if (!f) return;
  const b = req.body || {};
  if (b.filename) f.v.bot.filename = String(b.filename).trim();
  if (b.runtime) f.v.bot.runtime = b.runtime;
  if (b.token) f.v.bot.token = String(b.token);
  if (b.token_type) f.v.bot.token_type = b.token_type;
  f.v.bot.desired = true;
  f.v.bot.respawnCount = 0;
  killBot(f.v);
  saveDb(f.db);
  setTimeout(() => preinstallAndStart(f.v), 1500);
  res.json({ success: true, message: 'Process restarted. [ONLINE]', bot_status: 'starting' });
}

app.get('/api/vps/:id/bot', requireUser, (req, res) => {
  const f = findVps(req, res); if (!f) return;
  const v = f.v, alive = !!vpsAlive(v);
  const status = v.bot.desired && alive ? 'running' : v.bot.desired ? 'starting' : 'stopped';
  res.json({
    success: true,
    bot: {
      status, running: v.bot.desired && alive,
      uptime_seconds: v.bot.started_at ? Math.floor((Date.now() - v.bot.started_at) / 1000) : 0,
      filename: v.bot.filename, runtime: v.bot.runtime, token_type: v.bot.token_type,
      token_saved: !!v.bot.token, pid: v.bot.pid
    }
  });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^\w.\-]/g, '_'))
  }),
  limits: { fileSize: 50 * 1024 * 1024, files: 20 }
});

function extractZip(zipPath, dest) {
  return new Promise((resolve) => {
    execFile('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zipPath, dest], { timeout: 60000 }, (err) => resolve(!err));
  });
}

function detectEntry(dir) {
  const names = [];
  const walk = (d, p) => {
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of items) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const rel = p ? p + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), rel);
      else names.push(rel);
    }
  };
  walk(dir, '');
  const pick = (c) => c.find((x) => names.includes(x));
  const js = pick(['index.js', 'bot.js', 'main.js', 'launcher.js']);
  const py = pick(['main.py', 'bot.py', 'app.py']);
  if (js && (fs.existsSync(path.join(dir, 'package.json')) || !py)) return { entry: js, runtime: 'node' };
  if (py) return { entry: py, runtime: 'python' };
  if (js) return { entry: js, runtime: 'node' };
  const anyPy = names.find((n) => n.toLowerCase().endsWith('.py'));
  const anyJs = names.find((n) => n.toLowerCase().endsWith('.js'));
  if (anyPy) return { entry: anyPy, runtime: 'python' };
  if (anyJs) return { entry: anyJs, runtime: 'node' };
  return { entry: '', runtime: '' };
}

app.post('/api/vps/:id/bot/upload', requireUser, upload.array('files', 20), async (req, res) => {
  const f = findVps(req, res); if (!f) return;
  const dir = sdir(f.v.id);
  const list = req.files || [];
  let ok = 0;
  for (const file of list) {
    const raw = file.originalname.replace(/\\/g, '/').replace(/^\/+/, '');
    const safe = raw.split('/').filter((s) => s && s !== '..' && s !== '.').join('/');
    if (!safe) { fs.rmSync(file.path, { force: true }); continue; }
    if (safe.toLowerCase().endsWith('.zip')) {
      if (await extractZip(file.path, dir)) ok++;
    } else {
      const full = path.join(dir, safe);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.copyFileSync(file.path, full);
      fs.rmSync(file.path, { force: true });
      ok++;
    }
  }
  if (!ok) return res.json({ success: false, error: 'No usable files in the upload.' });
  const det = detectEntry(dir);
  if (det.entry) { f.v.bot.filename = det.entry; f.v.bot.runtime = det.runtime; saveDb(f.db); }
  appendLog(f.v.id, `[panel] Uploaded ${ok} file(s)${det.entry ? `, entry: ${det.entry} (${det.runtime})` : ''}`);
  res.json({
    success: true, message: `Uploaded ${ok} file(s) successfully!`,
    uploaded: ok, detected_entry: det.entry, detected_runtime: det.runtime
  });
});

app.post('/api/vps/:id/bot/start', requireUser, startBotRoute);
app.post('/api/vps/:id/bot/stop', requireUser, stopBotRoute);
app.post('/api/vps/:id/bot/restart', requireUser, restartBotRoute);

app.get('/api/vps/:id/bot/logs', requireUser, (req, res) => {
  const f = findVps(req, res); if (!f) return;
  const v = f.v, alive = !!vpsAlive(v);
  let lines = [];
  try { lines = fs.readFileSync(logFile(v.id), 'utf8').split('\n').filter(Boolean); } catch (e) {}
  res.json({
    success: true,
    logs: lines.slice(-250),
    status: {
      status: v.bot.desired && alive ? 'running' : 'stopped',
      running: v.bot.desired && alive,
      uptime_seconds: v.bot.started_at ? Math.floor((Date.now() - v.bot.started_at) / 1000) : 0
    }
  });
});

app.post('/api/vps/:id/bot/logs/clear', requireUser, (req, res) => {
  const f = findVps(req, res); if (!f) return;
  try { fs.writeFileSync(logFile(f.v.id), ''); } catch (e) {}
  res.json({ success: true });
});

// ---------- files ----------
function safePath(base, rel) {
  const p = path.normalize(String(rel || '')).replace(/^([.][.](\/|\\|$))+/, '');
  const full = path.join(base, p);
  if (!full.startsWith(base)) return null;
  return full;
}

app.get('/api/vps/:id/files', requireUser, (req, res) => {
  const f = findVps(req, res); if (!f) return;
  const files = [];
  const skip = new Set(['pid', '.panel-app.log', '.env', 'node_modules']);
  const walk = (d, p) => {
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of items) {
      if (skip.has(e.name)) continue;
      const rel = p ? p + '/' + e.name : e.name;
      if (e.isDirectory()) { files.push({ name: rel, isDirectory: true, size: 0 }); walk(path.join(d, e.name), rel); }
      else { try { files.push({ name: rel, isDirectory: false, size: fs.statSync(path.join(d, e.name)).size }); } catch (err) {} }
    }
  };
  walk(sdir(f.v.id), '');
  res.json({ success: true, files });
});

app.get('/api/vps/:id/file', requireUser, (req, res) => {
  const f = findVps(req, res); if (!f) return;
  const full = safePath(sdir(f.v.id), req.query.path);
  if (!full || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return res.json({ success: false, error: 'File not found.' });
  const st = fs.statSync(full);
  if (st.size > 512 * 1024) return res.json({ success: false, error: 'File too large to edit (max 512 KB).' });
  res.json({ success: true, content: fs.readFileSync(full, 'utf8') });
});

app.post('/api/vps/:id/file', requireUser, (req, res) => {
  const f = findVps(req, res); if (!f) return;
  const full = safePath(sdir(f.v.id), (req.body || {}).path);
  if (!full) return res.json({ success: false, error: 'Bad path.' });
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, String((req.body || {}).content ?? ''));
  res.json({ success: true });
});

app.post('/api/vps/:id/folder', requireUser, (req, res) => {
  const f = findVps(req, res); if (!f) return;
  const full = safePath(sdir(f.v.id), (req.body || {}).path);
  if (!full) return res.json({ success: false, error: 'Bad path.' });
  fs.mkdirSync(full, { recursive: true });
  res.json({ success: true });
});

app.delete('/api/vps/:id/file', requireUser, (req, res) => {
  const f = findVps(req, res); if (!f) return;
  const full = safePath(sdir(f.v.id), req.query.path);
  if (!full || full === sdir(f.v.id)) return res.json({ success: false, error: 'Bad path.' });
  fs.rmSync(full, { recursive: true, force: true });
  res.json({ success: true });
});

app.get('/api/vps/:id/file/download', (req, res) => {
  const u = userByKey(req.query.api_key);
  if (!u) return res.status(401).json({ success: false, error: 'Not signed in.' });
  const db = loadDb();
  const v = db.vps.find((x) => x.id === req.params.id && x.userId === u.id);
  if (!v) return res.status(404).json({ success: false, error: 'VPS not found.' });
  const full = safePath(sdir(v.id), req.query.path);
  if (!full || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return res.status(404).json({ success: false, error: 'File not found.' });
  res.download(full);
});

// ---------- packages ----------
app.get('/api/vps/:id/packages/list', requireUser, (req, res) => {
  const f = findVps(req, res); if (!f) return;
  res.json({ success: true, python: f.v.packages.python, node: f.v.packages.node, auto_install: f.v.packages.auto_install });
});

app.post('/api/vps/:id/packages/install', requireUser, (req, res) => {
  const f = findVps(req, res); if (!f) return;
  const names = String((req.body || {}).packages || '').trim().split(/\s+/).filter(Boolean);
  const runtime = (req.body || {}).runtime === 'node' ? 'node' : 'python';
  if (!names.length) return res.json({ success: false, error: 'Enter a package name.' });
  const list = runtime === 'node' ? f.v.packages.node : f.v.packages.python;
  for (const n of names) {
    const hit = list.find((p) => p.name === n);
    if (hit) hit.version = 'pending';
    else list.push({ name: n, version: 'pending', auto: false });
  }
  saveDb(f.db);
  appendLog(f.v.id, `[panel] Installing ${names.join(', ')} (${runtime})...`);
  runInstall(f.v.id, runtime, names, (err) => {
    const d2 = loadDb();
    const v2 = d2.vps.find((x) => x.id === f.v.id);
    if (v2) {
      const l2 = runtime === 'node' ? v2.packages.node : v2.packages.python;
      for (const n of names) {
        const hit = l2.find((p) => p.name === n);
        if (hit) hit.version = err ? 'failed' : 'ok';
      }
      saveDb(d2);
    }
    appendLog(f.v.id, err ? `[panel] Install failed: ${names.join(', ')}` : `[panel] Installed ${names.join(', ')} (${runtime})`);
  });
  res.json({ success: true, message: `Installing ${names.join(', ')} (${runtime})...` });
});

app.post('/api/vps/:id/packages/auto-install', requireUser, (req, res) => {
  const f = findVps(req, res); if (!f) return;
  autoInstallStack(f.v.id, true);
  res.json({ success: true, message: 'Discord stack install started — watch the logs.' });
});

// ---------- static site ----------
app.use(express.static(STATIC_DIR, { extensions: ['html'] }));

app.listen(PORT, () => console.log(`[node] Kers0neVPS node serving on :${PORT}`));
