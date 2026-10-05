// BotNest panel API. Runs on a VPS with Docker and turns the static
// site into real bot hosting: each "server" in the panel is a Docker
// container on this node.
//
// Setup (Ubuntu 22.04+):
//   curl -fsSL https://get.docker.com | sh
//   npm install express
//   ADMIN_TOKEN=<long-random-string> node server.js
//   # then put nginx or a Cloudflare Tunnel in front of it
//
// Auth: every /api route except /health needs "Authorization: Bearer $ADMIN_TOKEN".
// The dashboard auto-detects this API at /api/health and switches to live mode.

const express = require('express');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) { console.error('ADMIN_TOKEN env var required'); process.exit(1); }

const DATA = path.join(__dirname, 'data');
const UPLOADS = path.join(DATA, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

const app = express();
app.use(express.json());

// the static front end lives on GitHub Pages and calls this API cross-origin;
// every route is still gated by the ADMIN_TOKEN bearer check below
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// memory/cpu limits per plan
const PLANS = {
  nest:   { mem: '512m', cpus: '0.5' },
  roost:  { mem: '1g',   cpus: '1'   },
  aviary: { mem: '3g',   cpus: '2'   }
};
const IMAGES = {
  node:   'node:20-alpine',
  python: 'python:3.12-slim'
};
const ENTRY = { node: 'node index.js', python: 'python main.py' };

const dock = (args) => new Promise((resolve, reject) => {
  execFile('docker', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) return reject(new Error(stderr || err.message));
    resolve(stdout.trim());
  });
});
const cname = (id) => `botnest-${id}`;
const vdir = (id) => path.join(DATA, 'servers', id);

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  if (h !== 'Bearer ' + ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// registry file: { id: { name, runtime, plan, createdAt } }
const REG = path.join(DATA, 'registry.json');
function readReg() { try { return JSON.parse(fs.readFileSync(REG, 'utf8')); } catch (e) { return {}; } }
function writeReg(r) { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(REG, JSON.stringify(r, null, 2)); }

app.get('/api/health', (req, res) => res.json({ ok: true, panel: true }));

app.use('/api', auth);

// list servers with live container state
app.get('/api/servers', async (req, res) => {
  const reg = readReg();
  const servers = [];
  for (const [id, meta] of Object.entries(reg)) {
    let status = 'offline';
    try {
      const out = await dock(['inspect', '-f', '{{.State.Status}}', cname(id)]);
      status = out === 'running' ? 'online' : (out === 'restarting' ? 'crashed' : 'offline');
    } catch (e) { status = 'offline'; }
    servers.push({ id, ...meta, status });
  }
  res.json({ servers });
});

app.post('/api/servers', async (req, res) => {
  const { name, runtime = 'node', plan = 'nest' } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!PLANS[plan]) return res.status(400).json({ error: 'unknown plan' });
  const id = 'srv' + Math.random().toString(36).slice(2, 10);
  const dir = vdir(id);
  fs.mkdirSync(dir, { recursive: true });
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
    // container may exit immediately if the dir is empty; that is fine,
    // the user still needs to upload code and start it.
    await dock(['rm', '-f', cname(id)]).catch(() => {});
  }
  const reg = readReg();
  reg[id] = { name, runtime, plan, createdAt: new Date().toISOString() };
  writeReg(reg);
  res.json({ id });
});

app.post('/api/servers/:id/:action(start|stop|restart)', async (req, res) => {
  const { id, action } = req.params;
  if (!readReg()[id]) return res.status(404).json({ error: 'not found' });
  const cmd = { start: 'start', stop: 'stop', restart: 'restart' }[action];
  await dock([cmd, cname(id)]);
  res.json({ ok: true });
});

app.delete('/api/servers/:id', async (req, res) => {
  const { id } = req.params;
  const reg = readReg();
  if (!reg[id]) return res.status(404).json({ error: 'not found' });
  await dock(['rm', '-f', cname(id)]).catch(() => {});
  fs.rmSync(vdir(id), { recursive: true, force: true });
  delete reg[id];
  writeReg(reg);
  res.json({ ok: true });
});

// environment variables: appended to the container's .env, values never read back
app.post('/api/servers/:id/env', async (req, res) => {
  const { id } = req.params;
  const { key, value } = req.body || {};
  if (!key || typeof value !== 'string') return res.status(400).json({ error: 'key and value required' });
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return res.status(400).json({ error: 'invalid key' });
  const reg = readReg();
  if (!reg[id]) return res.status(404).json({ error: 'not found' });
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
app.post('/api/servers/:id/upload', auth, upload.single('file'), async (req, res) => {
  const { id } = req.params;
  if (!readReg()[id]) return res.status(404).json({ error: 'not found' });
  const dir = vdir(id);
  fs.mkdirSync(dir, { recursive: true });
  await new Promise((resolve, reject) => {
    const unzip = require('child_process').execFile('unzip', ['-o', req.file.path, '-d', dir], (err) => err ? reject(err) : resolve());
    unzip.on('error', reject);
  }).catch(e => { return res.status(500).json({ error: 'unzip failed: ' + e.message }); });
  fs.unlinkSync(req.file.path);
  res.json({ ok: true });
});

app.get('/api/servers/:id/logs', async (req, res) => {
  const { id } = req.params;
  if (!readReg()[id]) return res.status(404).json({ error: 'not found' });
  try {
    const out = await dock(['logs', '--tail', '200', cname(id)]);
    res.json({ logs: out.split('\n').slice(-200) });
  } catch (e) {
    res.json({ logs: ['[panel] no logs yet, container not started'] });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BotNest panel API on :${PORT}`));
