#!/usr/bin/env node
// Generate a mock X.com Home timeline page from a corpus so content.js can be
// exercised in any browser without the extension or X.
//
//   node tools/ui-mock/gen.mjs <out-dir> [corpus.json]
//
// Writes <out-dir>/home.html (X-like DOM: primaryColumn > cellInnerDiv >
// article[data-testid=tweet] with tweetText / User-Name / status link, plus a
// scroll-driven loader that mounts 10 more posts each time you reach the
// bottom) and <out-dir>/ui-harness.js (stub.js + content.js). Then in a
// browser: open home.html, add content.css as a style tag and ui-harness.js
// as a script tag, and scroll.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: gen.mjs <out-dir> [corpus.json]");
  process.exit(2);
}
const corpusPath = process.argv[3] || path.join(root, "tools", "corpus", "home-2026-09-26.json");
const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
fs.mkdirSync(outDir, { recursive: true });

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Home / X (mock)</title>
<style>
  body { margin: 0; background: #000; color: #e7e9ea; font-family: -apple-system, sans-serif; }
  [data-testid="primaryColumn"] { width: 600px; margin: 0 auto; }
  [data-testid="cellInnerDiv"] { border-bottom: 1px solid #2f3336; }
  [data-testid="cellInnerDiv"] > article { padding: 12px 16px; min-height: 120px; } /* scoped: the overlay's cards are <article> too */
  .name { font-weight: 700; margin-bottom: 6px; }
  .name a { color: inherit; text-decoration: none; }
  [data-testid="tweetText"] { white-space: pre-wrap; font-size: 15px; line-height: 1.4; }
  .meta a { color: #71767b; font-size: 12px; }
  #ce-mock-loading { padding: 20px; color: #71767b; text-align: center; }
</style></head>
<body>
<main><div data-testid="primaryColumn"><div id="timeline"></div><div id="ce-mock-loading"></div></div></main>
<script>
const POSTS = ${JSON.stringify(corpus.map((t, i) => ({ id: t.id, author: t.author || "user" + (i % 17), text: t.text })))};
let mounted = 0;
const timeline = document.getElementById("timeline");
function mount(n) {
  for (let i = 0; i < n && mounted < POSTS.length; i++, mounted++) {
    const p = POSTS[mounted];
    const cell = document.createElement("div");
    cell.setAttribute("data-testid", "cellInnerDiv");
    cell.innerHTML = '<article data-testid="tweet" role="article">' +
      '<div class="name" data-testid="User-Name"><a href="/' + p.author + '">' + p.author + '</a></div>' +
      '<div data-testid="tweetText"></div>' +
      '<div class="meta"><a href="/' + p.author + '/status/' + p.id + '">status</a> <button data-testid="caret">…</button></div>' +
      '</article>';
    cell.querySelector('[data-testid="tweetText"]').textContent = p.text;
    timeline.appendChild(cell);
  }
  document.getElementById("ce-mock-loading").textContent = mounted < POSTS.length ? "" : "You're all caught up";
}
mount(20);
let loading = false;
window.addEventListener("scroll", () => {
  if (loading || mounted >= POSTS.length) return;
  if (window.scrollY + innerHeight >= document.documentElement.scrollHeight - 400) {
    loading = true;
    document.getElementById("ce-mock-loading").textContent = "Loading…";
    setTimeout(() => { mount(10); loading = false; }, 600);
  }
});
window.__mockMounted = () => mounted;
</script>
</body></html>
`;
fs.writeFileSync(path.join(outDir, "home.html"), html);
const harness = fs.readFileSync(path.join(here, "stub.js"), "utf8") + "\n" + fs.readFileSync(path.join(root, "content.js"), "utf8");
fs.writeFileSync(path.join(outDir, "ui-harness.js"), harness);
fs.copyFileSync(path.join(root, "content.css"), path.join(outDir, "content.css"));
console.log(`wrote ${path.join(outDir, "home.html")} (${corpus.length} posts), ui-harness.js, content.css`);
