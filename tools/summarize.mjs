#!/usr/bin/env node
// Print one line per saved harness run: metrics, cluster sizes, invalid refs.
//   node tools/summarize.mjs [substring-filter]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = path.join(os.homedir(), ".clear-eyes-runs");
const filter = process.argv[2] || "";
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f.includes(filter)).sort();
for (const f of files) {
  const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  const m = r.metrics;
  const sizes = r.clusters.map((c) => c.count).sort((a, b) => b - a);
  const bad = (r.batchLogs || []).flatMap((l) => l.invalidRefs || []);
  const cost = r.usage && r.usage.calls ? "" : "";
  console.log(`${r.name.padEnd(22)} clusters=${String(m.clusters).padStart(2)} singles=${String(m.singletons).padStart(2)} top5=${m.postsInTop5} largest=${String(m.largest).padStart(2)} merges=${m.merges} renames=${m.renames} unassigned=${m.unassigned ?? m.unsorted}${bad.length ? " refs=" + JSON.stringify(bad) : ""}${cost}`);
  console.log(`${"".padEnd(22)} sizes=${sizes.join(",")}`);
}
