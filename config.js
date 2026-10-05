// Kers0neVPS front-end configuration.
// KV_NODE is the hosting node's public address. The GitHub Pages panel talks
// to it cross-origin; the node also serves this same site at its own URL.
window.KV_NODE = "https://analyses-arnold-resumes-plenty.trycloudflare.com";
// A node address saved by the user in Account always wins over this default.
try { const saved = localStorage.getItem('kv_node'); if (saved) window.KV_NODE = saved; } catch (e) {}
// When a page is served BY the node itself, same-origin calls are always right.
if (!location.hostname.endsWith('.github.io')) window.KV_NODE = "";
window.KV_DEFAULT_NODE = window.KV_NODE;
