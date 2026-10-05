# Kers0neVPS node API

This makes the site real. It runs on a VPS (Ubuntu 22.04+ / Debian 12)
and provisions one isolated server per bot, scoped to the account that
created it. Uses Docker when available; otherwise falls back to
supervised child processes so it runs on any box with Node.

## What is real here

- Accounts: signup and login, scrypt-hashed passwords, bearer sessions,
  per-user isolation. Stored in data/db.json on the node.
- Servers: Docker containers with per-plan memory and CPU limits and
  --restart unless-stopped self-healing (proc runner: supervised
  processes with auto-restart-on-crash via exec loops; add the provided
  systemd unit to also survive node reboots).
- Public ports: create a server with exposePort and it gets its own
  public HTTP port and URL, mapped to the container's port 8080.
- Env vars: written to the server's .env on the host, injected at
  runtime, never returned by the API.
- Developer API: /v1 with personal access tokens (sha256-hashed).
- Speed: one docker ps call powers the whole server list; no per-server
  round trips.

## Install

```bash
curl -fsSL https://get.docker.com | sh        # optional, recommended
git clone https://github.com/kere0ne/kers0nevps /opt/kers0nevps
cd /opt/kers0nevps/server && npm install express@4 multer
PUBLIC_HOST=your.public.ip PORT=3000 node server.js
```

Open http://your.public.ip:3000 - the node serves the full site.
Put nginx with HTTPS or a Cloudflare Tunnel in front for TLS.

## Run it as a service

Copy kers0nevps.service to /etc/systemd/system/, then:

```bash
systemctl daemon-reload && systemctl enable --now kers0nevps
```

## Notes and limits

- One node per API instance. Multiple nodes need a scheduler above it.
- JSON file storage is fine for a handful of accounts; move to SQLite
  or Postgres before you have many. Back up data/db.json: it holds the
  account table.
- In proc mode, resource limits are not enforced (no cgroups without
  Docker); Docker mode enforces plan limits.
- The unzip binary must exist (apt install unzip).
