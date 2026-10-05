// Kers0neVPS node entry. Single supervised process:
// installs deps once, serves the API + site on 8080, keeps a public
// HTTPS tunnel up, and stands by cleanly if an instance already runs.
const { execSync, spawn } = require('child_process');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const PORT = 8123;
const LOCK = path.join(root, '.api.pid');
const TLOG = path.join(root, 'tunnel.log');
process.chdir(root);
process.env.STATIC_DIR = root;
process.env.PORT = String(PORT);

function pidAlive(p) { try { process.kill(p, 0); return true; } catch (e) { return false; } }

function probeHealth(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => {
      resolve(res.statusCode === 200); res.resume();
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
  });
}

function fetchText(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.headers.location) return resolve(fetchText(res.headers.location, timeoutMs));
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(d));
    });
    req.on('error', reject); req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function ensureCloudflared() {
  const bin = path.join(root, 'cloudflared');
  if (fs.existsSync(bin)) return bin;
  console.log('[launcher] downloading cloudflared...');
  execSync(`curl -sL -o "${bin}" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x "${bin}"`, { timeout: 180000 });
  return bin;
}

function ensureTunnel(bin) {
  try {
    const saved = fs.readFileSync(LOCK + '.tunnel', 'utf8');
    if (saved && pidAlive(parseInt(saved, 10))) {
      try { process.kill(parseInt(saved, 10), 'SIGTERM'); } catch (e) {}
    }
  } catch (e) {}
  try { fs.rmSync(LOCK + '.tunnel', { force: true }); } catch (e) {}
  try { fs.rmSync(TLOG, { force: true }); } catch (e) {}
  const out = fs.openSync(TLOG, 'a');
  const child = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate'], { stdio: ['ignore', out, out], detached: true });
  child.unref();
  fs.writeFileSync(LOCK + '.tunnel', String(child.pid));
  console.log('[launcher] tunnel starting, pid', child.pid);
}

(async () => {
  try {
    if (!fs.existsSync(path.join(root, 'node_modules', 'express'))) {
      console.log('[launcher] installing dependencies...');
      execSync('npm install --omit=dev --no-audit --no-fund', { stdio: 'inherit', timeout: 240000 });
    }
  } catch (e) { console.error('[launcher] npm install failed:', e.message); }

  if (await probeHealth()) {
    console.log('[launcher] node API already serving on :' + PORT + ', standing by');
  } else {
    console.log('[launcher] starting Kers0neVPS node API in-process');
    require('./server.js');
  }

  try {
    const bin = await ensureCloudflared();
    ensureTunnel(bin);
    // wait for the tunnel URL and report it
    let url = '';
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try { const t = fs.readFileSync(TLOG, 'utf8'); const m = t.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i); if (m) { url = m[0]; break; } } catch (e) {}
    }
    if (url) {
      fs.writeFileSync(path.join(root, 'tunnel-url.txt'), url + '\n');
      console.log('[launcher] PUBLIC URL: ' + url);
    } else {
      console.log('[launcher] tunnel URL not ready yet, check tunnel.log');
    }
    console.log('[launcher] node ready. health: ' + `http://127.0.0.1:${PORT}/api/health`);
  } catch (e) { console.error('[launcher] tunnel setup failed:', e.message); }

  setInterval(() => {}, 60000); // stay alive for the watchdog
})();
