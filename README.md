# Kers0ne VPS

Free Discord bot hosting with a real control panel: create servers, upload
your bot (files or zip), edit files in-browser, install packages, and watch
live logs. A 24/7 watchdog keeps bots online.

- Panel: https://kere0ne.github.io/kers0nevps/ (also served by the node itself)
- Repo: this one. `server/` is the panel node (Express, docker or supervised processes).
- Deploy a node: clone this repo on a Linux box, `cd server && npm install`,
  then `node launcher.js` (installs deps, serves API + site on :8123, opens a
  public HTTPS tunnel, prints PUBLIC URL).
- The GitHub Pages panel reaches the node through `config.js` (KV_NODE) or the
  Panel Node Address field in Account (saved per-browser).
- Discord tokens are stored only on the node (server-side .env per server) and
  are never returned by the API.
