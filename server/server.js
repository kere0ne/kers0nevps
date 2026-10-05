// Kers0neVPS node API. Runs on a VPS with Docker and turns the static
// site into real hosting: real accounts, and one Docker container per
// server, scoped to the account that created it.
//
// Setup (Ubuntu 22.04+):
//   curl -fsSL https://get.docker.com | sh
//   npm init -y && npm install express multer
//   node server.js            # no secrets in env needed anymore
//   # put nginx or a Cloudflare Tunnel with HTTPS in front of it
//
// Auth: accounts live in data/db.json (scrypt-hashed passwords, bearer
// session tokens). The first account created is just an account; there
// is no shared admin token to leak.

const express = require('express');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const DATA = path.join(__dirname, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const DB = path.join(DATA, 'db.json');
fs.mkdirSync(UPLOADS, { recursive: true });

const app = express();
app.use(express.json({ limit: '1mb' }));

// the static front end lives on GitHub Pages and calls this API
// cross-origin; every route except /health requires a valid session token
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const PLANS = {
  starter: { mem: '512m', cpus: '0.5' },
  plus:    { mem: '1g',   cpus: '1'   },
  elite:   { mem: '3g',   cpus: '2'   }
};
const IMAGES = { node: 'node:20-alpine', python: 'python:3.12-slim' };
const ENTRY = { node: 'node index.js', python: 'python main.py' };

// ---------- tiny JSON database ----------
function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch (e) { return { users: [], sessions: [], servers: [] }; }
}
function saveDb(db) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(DB, JSON.stringify(db, null, 2));
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

const dock = (args) => new Promise((resolve, reject) => {
  execFile('docker', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) return reject(new Error(stderr || err.message));
    resolve(stdout.trim());
  });
});
const cname = (id) => `kers0nevps-${id}`;
const vdir = (id) => path.join(DATA, 'servers', id);

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

app.get('/api/health', (req, res) => res.json({ ok: true, panel: true }));

app.post('/api/signup', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'valid email required' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
  const db = loadDb();
  if (db.users.some(u => u.email === email.toLowerCase())) return res.status(409).json({ error: 'an account with that email already exists' });
  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: 'u_' + crypto.randomBytes(8).toString('hex'),
    email: email.toLowerCase(),
    salt,
    passHash: hashPassword(password, salt),
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString() });
  saveDb(db);
  res.json({ token, user: { id: user.id, email: user.email, createdAt: user.createdAt } });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const db = loadDb();
  const user = db.users.find(u => u.email === (email || '').toLowerCase());
  const ok = user && crypto.timingSafeEqual(Buffer.from(hashPassword(password || '', user.salt), 'hex'), Buffer.from(user.passHash, 'hex'));
  if (!ok) return res.status(401).json({ error: 'wrong email or password' });
  const token = crypto.randomBytes(32).toString('hex');
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

app.get('/api/me', requireUser, (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email, createdAt: req.user.createdAt } });
});

// ---------- servers (scoped to the signed-in account) ----------
app.get('/api/servers', requireUser, async (req, res) => {
  const db = loadDb();
  const mine = db.servers.filter(s => s.userId === req.user.id);
  const servers = [];
  for (const meta of mine) {
    let status = 'offline';
    try {
      const out = await dock(['inspect', '-f', '{{.State.Status}}', cname(meta.id)]);
      status = out === 'running' ? 'online' : (out === 'restarting' ? 'crashed' : 'offline');
    } catch (e) {}
    let envKeys = {};
    try {
      for (const line of fs.readFileSync(path.join(vdir(meta.id), '.env'), 'utf8').split('\n')) {
        if (line.includes('=')) envKeys[line.split('=')[0]] = true;
      }
    } catch (e) {}
    servers.push({ ...meta, status, envKeys });
  }
  res.json({ servers });
});

app.post('/api/servers', requireUser, async (req, res) => {
  const { name, runtime = 'node', plan = 'starter' } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!PLANS[plan]) return res.status(400).json({ error: 'unknown plan' });
  const db = loadDb();
  if (db.servers.filter(s => s.userId === req.user.id).length >= 20) return res.status(400).json({ error: 'server limit reached' });
  const id = 'srv' + crypto.randomBytes(5).toString('hex');
  const dir = vdir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), '');
  const limits = PLANS[plan];
  try {
    await dock(['run', '-d', '--name', cname(id),
      '--restart', 'unless-stopped',
      '--memory', limits.mem, '--cpus', limits.cpus,
      '-w', '/bot',
      '-v', `${dir}:/bot`,
      '--env-file', path.join(dir, '.env'),
      IMAGES[runtime] || IMAGES.node,
      'sh', '-c', ENTRY[runtime] || ENTRY.node]);
  } catch (e) {
    await dock(['rm', '-f', cname(id)]).catch(() => {});
  }
  db.servers.push({ id, userId: req.user.id, name, runtime, plan, createdAt: new Date().toISOString() });
  saveDb(db);
  res.json({ id });
});

app.post('/api/servers/:id/:action(start|stop|restart)', requireUser, async (req, res) => {
  const db = loadDb();
  const meta = db.servers.find(s => s.id === req.params.id && s.userId === req.user.id);
  if (!meta) return res.status(404).json({ error: 'not found' });
  const cmd = { start: 'start', stop: 'stop', restart: 'restart' }[req.params.action];
  await dock([cmd, cname(meta.id)]);
  res.json({ ok: true });
});

app.delete('/api/servers/:id', requireUser, async (req, res) => {
  const db = loadDb();
  const meta = db.servers.find(s => s.id === req.params.id && s.userId === req.user.id);
  if (!meta) return res.status(404).json({ error: 'not found' });
  await dock(['rm', '-f', cname(meta.id)]).catch(() => {});
  fs.rmSync(vdir(meta.id), { recursive: true, force: true });
  db.servers = db.servers.filter(s => s.id !== meta.id);
  saveDb(db);
  res.json({ ok: true });
});

// environment variables: stored in the container's .env on the host,
// values are never read back through the API
app.post('/api/servers/:id/env', requireUser, async (req, res) => {
  const { id } = req.params;
  const { key, value } = req.body || {};
  if (!key || typeof value !== 'string') return res.status(400).json({ error: 'key and value required' });
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return res.status(400).json({ error: 'invalid key' });
  const db = loadDb();
  const meta = db.servers.find(s => s.id === id && s.userId === req.user.id);
  if (!meta) return res.status(404).json({ error: 'not found' });
  const file = path.join(vdir(id), '.env');
  fs.mkdirSync(vdir(id), { recursive: true });
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l && !l.startsWith(key + '=')); } catch (e) {}
  lines.push(`${key}=${value}`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  res.json({ ok: true });
});

// upload a zip of bot code, extracted into the container's volume
const upload = multer({ dest: UPLOADS, limits: { fileSize: 100 * 1024 * 1024 } });
app.post('/api/servers/:id/upload', requireUser, upload.single('file'), async (req, res) => {
  const db = loadDb();
  const meta = db.servers.find(s => s.id === req.params.id && s.userId === req.user.id);
  if (!meta) return res.status(404).json({ error: 'not found' });
  const dir = vdir(meta.id);
  fs.mkdirSync(dir, { recursive: true });
  try {
    await new Promise((resolve, reject) => {
      execFile('unzip', ['-o', req.file.path, '-d', dir], (err, so, se) => err ? reject(new Error(se || err.message)) : resolve());
    });
  } catch (e) { return res.status(500).json({ error: 'unzip failed: ' + e.message }); }
  fs.unlinkSync(req.file.path);
  res.json({ ok: true });
});

app.get('/api/servers/:id/logs', requireUser, async (req, res) => {
  const db = loadDb();
  const meta = db.servers.find(s => s.id === req.params.id && s.userId === req.user.id);
  if (!meta) return res.status(404).json({ error: 'not found' });
  try {
    const out = await dock(['logs', '--tail', '200', cname(meta.id)]);
    res.json({ logs: out.split('\n').slice(-200) });
  } catch (e) {
    res.json({ logs: ['[panel] no logs yet, container not started'] });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Kers0neVPS node API on :${PORT}`));
