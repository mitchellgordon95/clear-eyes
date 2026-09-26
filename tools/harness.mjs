#!/usr/bin/env node
// Offline tuning harness: runs the extension's clustering core (cluster-core.js)
// over a saved corpus exactly as the service worker would — serialized batches,
// each seeing the clusters the previous one produced — and prints the result.
//
//   node tools/harness.mjs [--corpus tools/corpus/home-2026-09-26.json]
//        [--model claude-haiku-4-5] [--guidance path-to-text-file]
//        [--batch 20] [--seed 1] [--limit N] [--name label] [--quiet]
//
// API key: ANTHROPIC_API_KEY, or a line `ANTHROPIC_API_KEY=...` in ~/.clear-eyes.env
// (that file is read only by this script and never committed).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// Load the extension's plain scripts without a bundler: shared.js defines
// top-level consts, cluster-core.js attaches to globalThis.
const sharedSrc = fs.readFileSync(path.join(root, "shared.js"), "utf8");
const { CE_DEFAULT_CATEGORIES } = new Function(sharedSrc + "\nreturn { CE_DEFAULT_CATEGORIES };")();
new Function(fs.readFileSync(path.join(root, "cluster-core.js"), "utf8"))();
const CORE = globalThis.CE_CORE;

const args = parseArgs(process.argv.slice(2));
const corpusPath = args.corpus || path.join(here, "corpus", "home-2026-09-26.json");
const model = args.model || "claude-haiku-4-5";
const batchSize = Number(args.batch || 20);
const seed = Number(args.seed || 1);
const limit = args.limit ? Number(args.limit) : Infinity;
const quiet = !!args.quiet;
const guidance = args.guidance ? fs.readFileSync(args.guidance, "utf8") : "";
const consolidateEvery = args.consolidate ? Number(args.consolidate) : 0; // run a merge-only pass every N batches (and at the end)
const name = args.name || `${model}${args.guidance ? "-" + path.basename(args.guidance, ".txt") : ""}-s${seed}`;

const apiKey = loadKey();
if (!apiKey) {
  console.error("No API key. Set ANTHROPIC_API_KEY or put ANTHROPIC_API_KEY=... in ~/.clear-eyes.env");
  process.exit(2);
}

const config = { model, categories: CE_DEFAULT_CATEGORIES, clusterPrompt: guidance };
let corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
corpus = shuffle(corpus, seed).slice(0, limit);

const state = CORE.newState();
const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0, ms: 0 };
const batchLogs = [];

for (let i = 0; i < corpus.length; i += batchSize) {
  const batch = corpus.slice(i, i + batchSize);
  const body = CORE.buildRequest(batch, state, config);
  const t0 = Date.now();
  const data = await callApi(body);
  usage.ms += Date.now() - t0;
  usage.calls++;
  usage.input += data.usage.input_tokens || 0;
  usage.cacheRead += data.usage.cache_read_input_tokens || 0;
  usage.cacheWrite += data.usage.cache_creation_input_tokens || 0;
  usage.output += data.usage.output_tokens || 0;
  const text = (data.content || []).find((b) => b.type === "text")?.text;
  if (!text) throw new Error("no text block; stop_reason=" + data.stop_reason);
  let result;
  try {
    result = CORE.parseResponse(text, batch, config);
  } catch (e) {
    throw new Error(`${e.message} (stop_reason=${data.stop_reason}, output_tokens=${data.usage.output_tokens}, tail=${JSON.stringify(text.slice(-120))})`);
  }
  const { log } = CORE.applyResult(state, batch, result, Date.now());
  batchLogs.push(log);
  if (!quiet) {
    const n = Object.keys(state.clusters).length;
    console.log(`batch ${batchLogs.length}: +${log.created.length} new, ${log.merges.length} merges, ${log.renames.length} renames, ${log.unsorted} unassigned${log.unsorted ? " (refs: " + log.invalidRefs.join(",") + ")" : ""} → ${n} clusters`);
    for (const m of log.merges) console.log(`   merge ${m.from.join("+")} → ${m.into}: ${m.title}`);
    for (const r of log.renames) console.log(`   rename ${r.id}: "${r.from}" → "${r.to}"`);
  }
  const isLast = i + batchSize >= corpus.length;
  if (consolidateEvery && (batchLogs.length % consolidateEvery === 0 || isLast)) {
    const cbody = CORE.buildConsolidateRequest(state, config);
    const t1 = Date.now();
    const cdata = await callApi(cbody);
    usage.ms += Date.now() - t1;
    usage.calls++;
    usage.input += cdata.usage.input_tokens || 0;
    usage.output += cdata.usage.output_tokens || 0;
    const ctext = (cdata.content || []).find((b) => b.type === "text")?.text || "{}";
    const merges = CORE.parseConsolidateResponse(ctext);
    const applied = CORE.applyConsolidation(state, merges, Date.now());
    batchLogs.push({ consolidate: true, merges: applied, renames: [], created: [], unsorted: 0, invalidRefs: [] });
    if (!quiet) {
      console.log(`consolidate: ${applied.length} merges → ${Object.keys(state.clusters).length} clusters`);
      for (const m of applied) console.log(`   merge ${m.from.join("+")} → ${m.into}: ${m.title}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Report

const clusters = CORE.clusterList(state).sort((a, b) => b.count - a.count || a.createdAt - b.createdAt);
const sizes = clusters.map((c) => c.count);
const total = sizes.reduce((a, b) => a + b, 0);
const singletons = sizes.filter((n) => n === 1).length;
const metrics = {
  posts: total,
  clusters: clusters.length,
  singletons,
  singletonShare: +(singletons / clusters.length).toFixed(2),
  postsInTop5: +(sizes.slice(0, 5).reduce((a, b) => a + b, 0) / total).toFixed(2),
  largest: sizes[0] || 0,
  avgSize: +(total / clusters.length).toFixed(2),
  merges: batchLogs.reduce((a, l) => a + l.merges.length, 0),
  renames: batchLogs.reduce((a, l) => a + l.renames.length, 0),
  unassigned: batchLogs.reduce((a, l) => a + l.unsorted, 0)
};
const cost = estimateCost(model, usage);

console.log(`\n=== ${name} ===`);
console.log(JSON.stringify(metrics));
console.log(`calls ${usage.calls}, ${(usage.ms / usage.calls / 1000).toFixed(1)}s/call, in ${usage.input + usage.cacheRead + usage.cacheWrite} (cache ${usage.cacheRead}), out ${usage.output}${cost != null ? `, ≈$${cost.toFixed(3)}` : ""}`);
console.log("");
const byCluster = new Map();
for (const t of corpus) {
  const a = state.tweets[t.id];
  if (!a) continue;
  const cid = CORE.resolveAlias(state, a.cluster);
  if (!byCluster.has(cid)) byCluster.set(cid, []);
  byCluster.get(cid).push({ text: t.text.replace(/\s+/g, " ").slice(0, 90), cat: a.category });
}
for (const c of clusters) {
  const cats = Object.entries(c.categories).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" ");
  console.log(`[${String(c.count).padStart(2)}] ${c.title}  (${cats})`);
  console.log(`     ${c.summary}`);
  if (!quiet) for (const m of byCluster.get(c.id) || []) console.log(`       · ${m.cat.padEnd(8)} ${m.text}`);
}

const outDir = path.join(os.homedir(), ".clear-eyes-runs");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${name}-${Date.now()}.json`);
fs.writeFileSync(outPath, JSON.stringify({ name, model, guidance, seed, batchSize, metrics, usage, clusters, tweets: state.tweets, batchLogs }, null, 2));
console.log(`\nsaved ${outPath}`);

// ---------------------------------------------------------------------------

async function callApi(body) {
  for (let attempt = 1; ; attempt++) {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body)
    });
    if (resp.ok) return resp.json();
    const detail = await resp.text();
    if ((resp.status === 429 || resp.status >= 500) && attempt < 4) {
      const wait = 2000 * attempt;
      console.error(`API ${resp.status}, retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new Error(`API ${resp.status}: ${detail.slice(0, 300)}`);
  }
}

function loadKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const env = fs.readFileSync(path.join(os.homedir(), ".clear-eyes.env"), "utf8");
    const m = env.match(/^\s*(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*["']?([^"'\s]+)/m);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}

// $/MTok (input, output, cache read, cache write) — current first-party rates.
function estimateCost(model, u) {
  const rates = {
    "claude-haiku-4-5": [1, 5, 0.1, 1.25],
    "claude-sonnet-5": [2, 10, 0.2, 2.5],
    "claude-opus-5": [5, 25, 0.5, 6.25]
  };
  const r = Object.entries(rates).find(([k]) => model.startsWith(k))?.[1];
  if (!r) return null;
  return (u.input * r[0] + u.output * r[1] + u.cacheRead * r[2] + u.cacheWrite * r[3]) / 1e6;
}

function shuffle(arr, seed) {
  const a = arr.slice();
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    out[k] = v;
  }
  return out;
}
