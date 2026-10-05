# Kers0neVPS

Free, enhanced VPS hosting for Discord bots: a Droplets-style marketing
site, a real control panel with signup and login, and a node API that
provisions real containers on a VPS. No demo mode anywhere.

- `index.html` - landing page (features, free plans, API, FAQ)
- `dashboard.html` + `app.js` - control panel: signup first, servers,
  console, env vars, public ports, API tokens. No demo mode.
- `docs.html` - developer API reference (/v1, personal access tokens)
- `server/` - the node API. See server/README.md.
- `server/kers0nevps.service` - systemd unit for the node.

## The two surfaces

- GitHub Pages (this repo's Pages site) is the public front: landing,
  docs, and the panel. The panel talks to whichever node URL you set,
  stored per browser.
- The node (any VPS running `server/`) is the real thing: accounts,
  Docker containers (or supervised processes when Docker is absent),
  public ports, logs, and the /v1 developer API. The node also serves
  the whole site itself, so its URL is a complete panel on its own.

## Quick start (real hosting)

1. Rent or reuse a VPS (Ubuntu 22.04+), follow `server/README.md`.
2. Open the panel, paste the node URL in the Node URL field, sign up.
3. Create a server, upload a zip of your bot, set DISCORD_TOKEN as an
   env var, hit start. It runs 24/7 and restarts itself.

## Developer API

Full reference in docs.html. Create a token in the panel (API tokens),
then:

    curl -s https://your-node/v1/servers -H "Authorization: Bearer kv_..."

Create, start, stop, restart, delete, logs. Same API the panel uses.
