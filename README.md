# Kers0neVPS

A Discord bot hosting platform: landing page + control panel + a node
API that provisions real Docker containers on a VPS. Accounts are real:
signup, login, per-user servers.

- `index.html` - landing page (features, network, pricing, FAQ)
- `dashboard.html` + `app.js` - control panel. Signup first, then
  servers, console, env vars, uploads. No demo mode.
- `server/` - the node API. See server/README.md for setup.
- `botnest.service` - systemd unit for the API.

## Front end (GitHub Pages)

Pushed to this repo, served from the main branch root at
`https://kere0ne.github.io/kers0nevps/`. In the panel, set the "Panel
node" URL once to the HTTPS address of the machine running `server/`;
it is stored in the browser and every request goes there.

## Making hosting real

1. Rent a VPS, install Docker + Node, copy `server/` up, follow
   `server/README.md`.
2. Open the panel, set the panel node URL, sign up, create a server.
3. Upload a zip of your bot, set its `DISCORD_TOKEN` as an env var,
   hit start. The container runs 24/7 and restarts itself.
