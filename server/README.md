# Kers0neVPS node API

This is the piece that makes the site real. It runs on a VPS (any
1 GB+ box, Ubuntu 22.04 or Debian 12) and manages one Docker container
per server, scoped to the account that created it.

## What is real here

- Accounts: signup and login with email and scrypt-hashed passwords,
  bearer session tokens, per-user server isolation. Stored in
  `data/db.json` on the node.
- Servers: real Docker containers with per-plan memory and CPU limits
  and `--restart unless-stopped` self-healing.
- Env vars: bot tokens are written to the container's `.env` on the
  host and injected at runtime. Values are never returned by the API.
- Logs: streamed from the container via docker logs.

## Install

```bash
curl -fsSL https://get.docker.com | sh
mkdir -p /opt/kers0nevps && cd /opt/kers0nevps
npm init -y && npm install express multer
# copy server.js here
node server.js
```

Put it behind nginx with HTTPS or a Cloudflare Tunnel so the API is
never exposed on a raw port. The GitHub Pages front end talks to it
cross-origin; CORS is already handled.

## Run it as a service

See `botnest.service` in this folder (rename to kers0nevps.service):

```ini
[Unit]
Description=Kers0neVPS node API
After=docker.service network.target
[Service]
WorkingDirectory=/opt/kers0nevps
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
```

`systemctl enable --now kers0nevps`

## v1 limits

- One node per API instance. Multiple nodes need a scheduler above it.
- Zip uploads only; git-pull deploys are the natural v2.
- JSON file storage is fine for a handful of accounts; move to SQLite
  or Postgres before you have many.
- Back up `data/db.json`: it holds the account table.
