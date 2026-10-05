// Kers0neVPS node API. Real accounts, real containers, real ports.
// Runs on any Linux VPS: uses Docker when available, falls back to
// supervised child processes when it is not. Serves the static site too,
// so the node URL is the full product.
//
// Install (Ubuntu/Debian):
//   curl -fsSL https://get.docker.com | sh        # optional but recommended
//   git clone https://github.com/kere0ne/kers0nevps /opt/kers0nevps
//   cd /opt/kers0nevps/server && npm install express multer
//   PUBLIC_HOST=your.node.ip node server.js       # or a domain behind HTTPS
//
// API: accounts at /api (email + scrypt), developer API at /v1 (personal
// access tokens created in the panel). All responses JSON, all fast.

const express = require('express');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const DATA = path.join(__dirname, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const DB = path.join(DATA, 'db.json');
fs.mkdirSync(UPLOADS, { recursive: true });

const PLANS = {
  mini:  { mem: '512m', cpus: '0.5', label: 'Mini - 512 MB' },
  basic: { mem: '1g',   cpus: '1',   label: 'Basic - 1 GB' },
  pro:   { mem: '2g',   cpus: '2',   label: 'Pro - 2 GB' }
};
const IMAGES = { node: 'node:20-alpine', python: 'python:3.12-slim', static: 'nginx:alpine' };
const ENTRY = { node: 'node index.js', python: 'python main.py', static: 'nginx -g "daemon off;"' };
const PORT_MIN = 20000, PORT_MAX = 29999;
const PUBLIC_HOST = process.env.PUBLIC_HOST || '';

// ---------- tiny JSON db ----------
function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB, 'utf8')); }
  catch (e) { return { users: [], sessions: [], tokens: [], servers: [] }; }
}
function saveDb(db) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(DB, JSON.stringify(db, null, 2));
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hashPassword = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const rand = (n) => crypto.randomBytes(n).toString('hex');

// ---------- runner: docker or proc ----------
let RUNNER = 'proc';
function detectRunner() {
  return new Promise((resolve) => {
    execFile('docker', ['info', '--format', 'ok'], (err) => {
      RUNNER = err ? 'proc' : 'docker';
      console.log(`[node] runner: ${RUNNER}`);
      resolve();
    });
  });
}
const cname = (id) => `kers0nevps-${id}`;
const vdir = (id) => path.join(DATA, 'servers', id);
const logf = (id) => path.join(vdir(id), 'app.log');

function dock(args) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout.trim());
    });
  });
}

// one call returns every container status; keeps list responses quick
async function dockerStatuses() {
  try {
    const out = await dock(['ps', '-a', '--filter', 'name=kers0nevps-', '--format', '{{.Names}}|{{.State}}']);
    const map = {};
    for (const line of out.split('\n')) {
      const [n, s] = line.split('|');
      if (n) map[n] = s;
    }
    return map;
  } catch (e) { return {}; }
}

async function startServer(id, meta) {
  const dir = vdir(id);
  if (RUNNER === 'docker') {
    const limits = PLANS[meta.plan] || PLANS.mini;
    const args = ['run', '-d', '--name', cname(id),
      '--restart', 'unless-stopped',
      '--memory', limits.mem, '--cpus', limits.cpus,
      '-w', '/bot',
      '-v', `${dir}:/bot`,
      '--env-file', path.join(dir, '.env')];
    if (meta.publicPort) args.push('-p', `${meta.publicPort}:8080`);
    args.push(IMAGES[meta.runtime] || IMAGES.node, 'sh', '-c', ENTRY[meta.runtime] || ENTRY.node);
    await dock(['rm', '-f', cname(id)]).catch(() => {});
    await dock(args);
    return;
  }
  // proc runner: supervised child process, logs to app.log
  const entry = ENTRY[meta.runtime] || ENTRY.node;
  const env = {};
  try {
    for (const line of fs.readFileSync(path.join(dir, '.env'), 'utf8').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
    }
  } catch (e) {}
  env.PORT = String(meta.publicPort || 8080);
  const out = fs.openSync(logf(id), 'a');
  const child = spawn('sh', ['-c', `exec ${entry}`], {
    cwd: dir, detached: true, stdio: ['ignore', out, out], env: { ...process.env, ...env }
  });
  child.unref();
  fs.writeFileSync(path.join(dir, 'pid'), String(child.pid));
}

async function stopServer(id) {
  if (RUNNER === 'docker') { await dock(['rm', '-f', cname(id)]).catch(() => {}); return; }
  try {
    const pid = parseInt(fs.readFileSync(path.join(vdir(id), 'pid'), 'utf8'), 10);
    if (pid) process.kill(pid, 'SIGTERM');
    setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch (e) {} }, 3000);
  } catch (e) {}
}

function serverStatus(id) {
  if (RUNNER === 'docker') return null; // handled via dockerStatuses batch
  try {
    const pid = parseInt(fs.readFileSync(path.join(vdir(id), 'pid'), 'utf8'), 10);
    process.kill(pid, 0);
    return 'running';
  } catch (e) { return 'exited'; }
}

async function fetchLogs(id) {
  if (RUNNER === 'docker') {
    try {
      const out = await dock(['logs', '--tail', '200', cname(id)]);
      return out.split('\n').slice(-200);
    } catch (e) { return ['[panel] no logs yet, container not started']; }
  }
  try {
    const lines = fs.readFileSync(logf(id), 'utf8').split('\n');
    return lines.slice(-200);
  } catch (e) { return ['[panel] no logs yet, server not started']; }
}

async function assignPort(db, want) {
  if (!want) return null;
  const used = new Set(db.servers.map(s => s.publicPort).filter(Boolean));
  for (let i = 0; i < 200; i++) {
    const p = PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN));
    if (!used.has(p)) return p;
  }
  return null;
}

function recreateEnvFile(id, key, value) {
  fs.mkdirSync(vdir(id), { recursive: true });
  const file = path.join(vdir(id), '.env');
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l && !l.startsWith(key + '=')); } catch (e) {}
  lines.push(`${key}=${value}`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

// ---------- http app ----------
const app = express();
app.use(express.json({ limit: '1mb' }));

// GitHub Pages front end calls this node cross-origin; every route except
// /api/health requires a valid session or token
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// static site (the node serves the whole product at its own URL)
app.use(express.static(path.join(__dirname, '..'), { extensions: ['html'] }));

// ---------- auth ----------
function currentUser(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  const db = loadDb();
  const sess = db.sessions.find(s => s.token === h.slice(7));
  if (!sess) return null;
  return db.users.find(u => u.id === sess.userId) || null;
}
function requireUser(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  next();
}
function tokenUser(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer kv_')) return null;
  const db = loadDb();
  const t = db.tokens.find(x => x.hash === sha256(h.slice(7)));
  if (!t) return null;
  t.lastUsed = new Date().toISOString();
  saveDb(db);
  return db.users.find(u => u.id === t.userId) || null;
}
function requireToken(req, res, next) {
  const user = tokenUser(req);
  if (!user) return res.status(401).json({ error: 'invalid token' });
  req.user = user;
  next();
}

app.get('/api/health', (req, res) => res.json({ ok: true, panel: true, runner: RUNNER, uptime: process.uptime() }));

app.post('/api/signup', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'valid email required' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
  const db = loadDb();
  if (db.users.some(u => u.email === email.toLowerCase())) return res.status(409).json({ error: 'an account with that email already exists' });
  const salt = rand(16);
  const user = { id: 'u_' + rand(8), email: email.toLowerCase(), salt, passHash: hashPassword(password, salt), createdAt: new Date().toISOString() };
  db.users.push(user);
  const token = rand(32);
  db.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString() });
  saveDb(db);
  res.json({ token, user: { id: user.id, email: user.email, createdAt: user.createdAt } });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const db = loadDb();
  const user = db.users.find(u => u.email === (email || '').toLowerCase());
  let ok = false;
  if (user) {
    const a = Buffer.from(hashPassword(password || '', user.salt), 'hex');
    const b = Buffer.from(user.passHash, 'hex');
    ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  if (!ok) return res.status(401).json({ error: 'wrong email or password' });
  const token = rand(32);
  db.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString() });
  if (db.sessions.length > 500) db.sessions = db.sessions.slice(-200);
  saveDb(db);
  res.json({ token, user: { id: user.id, email: user.email, createdAt: user.createdAt } });
});

app.post('/api/logout', requireUser, (req, res) => {
  const db = loadDb();
  const h = req.headers.authorization || '';
  db.sessions = db.sessions.filter(s => s.token !== h.slice(7));
  saveDb(db);
  res.json({ ok: true });
});

app.get('/api/me', requireUser, (req, res) => res.json({ user: { id: req.user.id, email: req.user.email, createdAt: req.user.createdAt } }));

// ---------- tokens (panel-managed) ----------
app.get('/api/tokens', requireUser, (req, res) => {
  const db = loadDb();
  res.json({ tokens: db.tokens.filter(t => t.userId === req.user.id).map(({ id, label, prefix, createdAt, lastUsed }) => ({ id, label, prefix, createdAt, lastUsed })) });
});
app.post('/api/tokens', requireUser, (req, res) => {
  const { label } = req.body || {};
  if (!label) return res.status(400).json({ error: 'label required' });
  const db = loadDb();
  const token = 'kv_' + rand(24);
  const t = { id: 'tk_' + rand(6), userId: req.user.id, label: label.slice(0, 40), prefix: token.slice(0, 8), hash: sha256(token), createdAt: new Date().toISOString() };
  db.tokens.push(t);
  saveDb(db);
  res.json({ token, id: t.id });
});
app.delete('/api/tokens/:id', requireUser, (req, res) => {
  const db = loadDb();
  db.tokens = db.tokens.filter(t => !(t.id === req.params.id && t.userId === req.user.id));
  saveDb(db);
  res.json({ ok: true });
});

// ---------- servers core (shared by /api and /v1) ----------
async function listServers(user, req) {
  const db = loadDb();
  const mine = db.servers.filter(s => s.userId === user.id);
  const statuses = RUNNER === 'docker' ? await dockerStatuses() : null;
  const out = [];
  for (const meta of mine) {
    let st = RUNNER === 'docker' ? (statuses[cname(meta.id)] || 'exited') : serverStatus(meta.id);
    const status = st === 'running' ? 'online' : (st === 'restarting' ? 'crashed' : 'offline');
    let envKeys = {};
    try {
      for (const line of fs.readFileSync(path.join(vdir(meta.id), '.env'), 'utf8').split('\n')) {
        if (line.includes('=')) envKeys[line.split('=')[0]] = true;
      }
    } catch (e) {}
    const host = PUBLIC_HOST || req.hostname || 'localhost';
    out.push({ ...meta, status, envKeys, publicUrl: meta.publicPort ? `http://${host}:${meta.publicPort}` : null });
  }
  return out;
}

async function createServer(user, body, req) {
  const { name, runtime = 'node', plan = 'mini', exposePort = false } = body || {};
  if (!name) return { error: 'name required' };
  if (!PLANS[plan]) return { error: 'unknown plan' };
  const db = loadDb();
  if (db.servers.filter(s => s.userId === user.id).length >= 20) return { error: 'server limit reached' };
  const id = 'srv' + rand(5);
  const dir = vdir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), '');
  const meta = { id, userId: user.id, name: name.slice(0, 60), runtime: IMAGES[runtime] ? runtime : 'node', plan, createdAt: new Date().toISOString() };
  meta.publicPort = await assignPort(db, exposePort);
  db.servers.push(meta);
  saveDb(db);
  if (RUNNER === 'docker') {
    const limits = PLANS[meta.plan];
    const args = ['create', '--name', cname(id), '--restart', 'unless-stopped',
      '--memory', limits.mem, '--cpus', limits.cpus, '-w', '/bot',
      '-v', `${dir}:/bot`, '--env-file', path.join(dir, '.env')];
    if (meta.publicPort) args.push('-p', `${meta.publicPort}:8080`);
    args.push(IMAGES[meta.runtime], 'sh', '-c', ENTRY[meta.runtime]);
    await dock(args).catch(() => {});
  }
  return { server: { ...meta, status: 'offline', publicUrl: meta.publicPort ? `http://${PUBLIC_HOST || req.hostname || 'localhost'}:${meta.publicPort}` : null } };
}

async function serverAction(user, id, type) {
  const db = loadDb();
  const meta = db.servers.find(s => s.id === id && s.userId === user.id);
  if (!meta) return { error: 'not found' };
  if (!['start', 'stop', 'restart'].includes(type)) return { error: 'unknown action' };
  if (type === 'stop') await stopServer(id);
  else await startServer(id, meta);
  return { action: type, ok: true };
}

async function deleteServer(user, id) {
  const db = loadDb();
  const meta = db.servers.find(s => s.id === id && s.userId === user.id);
  if (!meta) return { error: 'not found' };
  await stopServer(id);
  fs.rmSync(vdir(id), { recursive: true, force: true });
  db.servers = db.servers.filter(s => s.id !== id);
  saveDb(db);
  return { ok: true };
}

function ownServer(user, id) {
  const db = loadDb();
  return db.servers.find(s => s.id === id && s.userId === user.id) || null;
}

// ---------- panel routes (/api) ----------
app.get('/api/servers', requireUser, async (req, res) => res.json({ servers: await listServers(req.user, req) }));
app.post('/api/servers', requireUser, async (req, res) => {
  const r = await createServer(req.user, req.body, req);
  if (r.error) return res.status(400).json(r);
  res.json(r);
});
app.post('/api/servers/:id/:action', requireUser, async (req, res) => {
  const r = await serverAction(req.user, req.params.id, req.params.action);
  if (r.error) return res.status(400).json(r);
  res.json(r);
});
app.delete('/api/servers/:id', requireUser, async (req, res) => {
  const r = await deleteServer(req.user, req.params.id);
  if (r.error) return res.status(404).json(r);
  res.json(r);
});
app.post('/api/servers/:id/env', requireUser, (req, res) => {
  const { key, value } = req.body || {};
  if (!key || typeof value !== 'string') return res.status(400).json({ error: 'key and value required' });
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return res.status(400).json({ error: 'invalid key' });
  if (!ownServer(req.user, req.params.id)) return res.status(404).json({ error: 'not found' });
  recreateEnvFile(req.params.id, key, value);
  res.json({ ok: true });
});
const upload = multer({ dest: UPLOADS, limits: { fileSize: 100 * 1024 * 1024 } });
app.post('/api/servers/:id/upload', requireUser, upload.single('file'), async (req, res) => {
  if (!ownServer(req.user, req.params.id)) return res.status(404).json({ error: 'not found' });
  const dir = vdir(req.params.id);
  fs.mkdirSync(dir, { recursive: true });
  try {
    await new Promise((resolve, reject) => {
      execFile('unzip', ['-o', req.file.path, '-d', dir], (err, so, se) => err ? reject(new Error(se || err.message)) : resolve());
    });
  } catch (e) { fs.unlinkSync(req.file.path); return res.status(500).json({ error: 'unzip failed: ' + e.message }); }
  fs.unlinkSync(req.file.path);
  res.json({ ok: true });
});
app.get('/api/servers/:id/logs', requireUser, async (req, res) => {
  if (!ownServer(req.user, req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json({ logs: await fetchLogs(req.params.id) });
});

// ---------- developer API (/v1, personal access tokens) ----------
app.get('/v1/account', requireToken, (req, res) => res.json({ account: { id: req.user.id, email: req.user.email, createdAt: req.user.createdAt } }));
app.get('/v1/servers', requireToken, async (req, res) => res.json({ servers: await listServers(req.user, req) }));
app.post('/v1/servers', requireToken, async (req, res) => {
  const r = await createServer(req.user, req.body, req);
  if (r.error) return res.status(400).json(r);
  res.status(201).json(r);
});
app.get('/v1/servers/:id', requireToken, async (req, res) => {
  const all = await listServers(req.user, req);
  const s = all.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json({ server: s });
});
app.post('/v1/servers/:id/actions', requireToken, async (req, res) => {
  const r = await serverAction(req.user, req.params.id, (req.body || {}).type);
  if (r.error) return res.status(400).json(r);
  res.json(r);
});
app.delete('/v1/servers/:id', requireToken, async (req, res) => {
  const r = await deleteServer(req.user, req.params.id);
  if (r.error) return res.status(404).json(r);
  res.json(r);
});
app.get('/v1/servers/:id/logs', requireToken, async (req, res) => {
  if (!ownServer(req.user, req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json({ logs: await fetchLogs(req.params.id) });
});

const PORT = process.env.PORT || 3000;
detectRunner().then(() => app.listen(PORT, () => console.log(`Kers0neVPS node API on :${PORT}`)));
