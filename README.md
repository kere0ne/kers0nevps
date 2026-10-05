# BotNest

A Discord bot hosting site: marketing page + control panel + a real
provisioning API you can run on any VPS with Docker.

- `index.html` - landing page (features, pricing, FAQ)
- `dashboard.html` + `app.js` - control panel. Runs in demo mode with no
  backend (state in localStorage) and auto-switches to live mode when
  the panel API answers `/api/health`.
- `server/` - the panel API. See server/README.md for setup.
- `botnest.service` - systemd unit for the API.

## Quick start (demo)

Open dashboard.html in a browser. Any email logs you in. Servers are
simulated so you can see the full flow.

## Hosting the front end on GitHub Pages

Push this repo to GitHub and enable Pages from the main branch root:
Settings > Pages, or `gh api repos/<owner>/<repo>/pages -f
'source[branch]=main' -f 'source[path]=/'`. The site lands at
`https://<owner>.github.io/<repo>/`.

GitHub Pages is static only, so the panel runs in demo mode until you
fill in the Panel API URL on the login screen (point it at the VPS
running server/). The URL is saved in the browser; the API already
allows the cross-origin calls.

## Quick start (real hosting)

1. Rent a VPS (any provider), install Docker + Node, copy `server/` up.
2. Follow `server/README.md` to start the API behind HTTPS.
3. Upload `index.html`, `dashboard.html`, `styles.css`, `app.js` to the
   same host (or Cloudflare Pages pointing at the API domain).
4. Open the dashboard: the pill in the nav flips from "demo mode" to
   "live node". Create a server, upload your bot zip, set the
   DISCORD_TOKEN env var, hit start.

Rename note: "BotNest" is a working name. Search-and-replace it in
index.html, dashboard.html and app.js to rebrand.
