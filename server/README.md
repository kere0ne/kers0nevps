# BotNest panel API

This is the piece that makes the site real hosting. It runs on a VPS
(any 1 GB+ box, Ubuntu 22.04 or Debian 12) and manages one Docker
container per bot server.

## Install

```bash
curl -fsSL https://get.docker.com | sh
mkdir -p /opt/botnest && cd /opt/botnest
npm init -y && npm install express multer
# copy server.js here
openssl rand -hex 32   # this is your ADMIN_TOKEN
ADMIN_TOKEN=<that value> node server.js
```

Keep the whole tree private. Put it behind nginx with HTTPS, or a
Cloudflare Tunnel, so the API is never exposed on a raw port.

## How it works

- The static dashboard probes `/api/health`. When it answers
  `{"panel": true}`, the panel switches from demo mode to live mode and
  every server you create becomes a real Docker container on this node.
- Each server gets a volume at `data/servers/<id>/`. Upload a zip of
  your bot there; its entrypoint is `node index.js` or `python main.py`
  depending on the runtime you picked.
- Environment variables (bot tokens, database URLs) are stored in a
  `.env` file on the host, injected at runtime, and never sent back to
  the browser. This is deliberate: tokens stay server-side.
- Containers use `--restart unless-stopped`, so a crashed bot or a
  rebooted node brings itself back up.

## Run it as a service

```ini
# /etc/systemd/system/botnest.service
[Unit]
Description=BotNest panel API
After=docker.service
[Service]
Environment=ADMIN_TOKEN=<your token>
WorkingDirectory=/opt/botnest
ExecStart=/usr/bin/node server.js
Restart=always
[Install]
WantedBy=multi-user.target
```

`systemctl enable --now botnest`

## v1 limits

- One node. Multiple nodes need a scheduler in front of the registry.
- Zip uploads only; a git-pull deploy is the natural v2.
- No per-customer accounts: the single ADMIN_TOKEN is the panel login.
  Adding real signups means a user table and per-user server scoping.
