// Background service worker: owns all Anthropic API calls, the cluster state,
// the toolbar badge, and session stats. Content scripts talk to it via messages.
// The clustering logic itself (prompt, schema, parsing, state updates) lives in
// cluster-core.js so tools/harness.mjs can run it offline.

importScripts("shared.js", "cluster-core.js");

const API_URL = "https://api.anthropic.com/v1/messages";
const STATE_KEY = "clusterState"; // chrome.storage.session — survives SW restarts, cleared when browser closes
const TWEET_MEMO_MAX = 6000; // tweet -> assignment + text memo (dedupes re-encounters, backs cluster drill-down); ~3MB of the 10MB session quota
const CONSOLIDATE_EVERY = 3; // batches between merge-only consolidation passes
const CONSOLIDATE_MIN_CLUSTERS = 8;

// One-time migration (2026-09-26): clustering was tuned on Sonnet 5; Haiku
// misfiles posts and merges unrelated beats. Move existing installs over once.
chrome.runtime.onInstalled.addListener(migrateConfig);
chrome.runtime.onStartup.addListener(migrateConfig);
async function migrateConfig() {
  const config = await ceGetConfig();
  if (config.tunedClusterModel) return;
  config.model = "claude-sonnet-5";
  config.tunedClusterModel = true;
  await ceSaveConfig(config);
}

// ---------------------------------------------------------------------------
// Messaging

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ error: String(e && e.message ? e.message : e) }));
  return true; // async response
});

async function handleMessage(msg) {
  switch (msg.type) {
    case "GET_CONFIG":
      return { config: await ceGetConfig() };
    case "CLUSTER_BATCH":
      return enqueueBatch(msg.tweets);
    case "GET_CLUSTERS":
      return getClusterView();
    case "GET_CLUSTER_POSTS":
      return { posts: CE_CORE.clusterPosts(await getState(), String(msg.cluster)) };
    case "RESET_CLUSTERS":
      await chrome.storage.session.remove(STATE_KEY);
      return { ok: true };
    case "OPEN_OPTIONS":
      chrome.runtime.openOptionsPage();
      return { ok: true };
    case "GET_TUNING":
      return getTuning();
    case "SET_TUNING":
      return setTuning(msg);
    case "RELOAD_EXTENSION":
      setTimeout(() => chrome.runtime.reload(), 200);
      return { ok: true };
    case "TEST_KEY":
      return testKey(msg.apiKey, msg.model);
    case "SELECTOR_HEALTH":
      return reportHealth(msg.ok);
    case "REPAIR_PROPOSE":
      return proposeSelectors(msg.html, msg.previous, msg.feedback);
    case "SAVE_SELECTORS":
      return saveSelectors(msg.selectors);
    case "GET_STATUS":
      return getStatus();
    case "RESET_STATS":
      await chrome.storage.local.set({ stats: { classified: 0, hidden: 0, apiCalls: 0, since: Date.now() } });
      return { ok: true };
    default:
      return { error: "unknown message type: " + msg.type };
  }
}

// Tuning knobs exposed to the dev bridge / options page. Never the API key.
async function getTuning() {
  const config = await ceGetConfig();
  return {
    model: config.model,
    clusterPrompt: config.clusterPrompt || "",
    defaultClusterPrompt: CE_CORE.DEFAULT_CLUSTER_GUIDANCE,
    devBridge: config.devBridge !== false
  };
}

async function setTuning(msg) {
  const config = await ceGetConfig();
  if (typeof msg.model === "string" && msg.model.trim()) config.model = msg.model.trim();
  if (typeof msg.clusterPrompt === "string") config.clusterPrompt = msg.clusterPrompt;
  await ceSaveConfig(config);
  return getTuning();
}

// ---------------------------------------------------------------------------
// Clustering
//
// Batches are processed strictly one at a time so each call sees the clusters
// the previous one created (otherwise two in-flight batches would both invent
// "Opus 5.5 launch reactions" and we'd get duplicates).

let chain = Promise.resolve();

function enqueueBatch(tweets) {
  const p = chain.then(() => clusterBatch(tweets));
  chain = p.catch(() => {});
  return p;
}

async function getState() {
  const stored = await chrome.storage.session.get(STATE_KEY);
  return CE_CORE.normalizeState(stored[STATE_KEY]);
}

async function saveState(state) {
  CE_CORE.pruneState(state, TWEET_MEMO_MAX);
  await chrome.storage.session.set({ [STATE_KEY]: state });
}

async function getClusterView() {
  const [config, state] = await Promise.all([ceGetConfig(), getState()]);
  return { clusters: CE_CORE.clusterList(state), categories: categoryActions(config) };
}

async function clusterBatch(tweets) {
  const config = await ceGetConfig();
  if (!config.enabled) return { assigned: {}, clusters: [], disabled: true };
  if (!config.apiKey) {
    await setBadge("key", "#b58900");
    return { error: "No API key configured. Open the Clear Eyes options page.", needsKey: true };
  }

  const state = await getState();
  const assigned = {};
  const toClassify = [];
  for (const t of tweets) {
    const memo = CE_CORE.lookupMemo(state, t.id);
    if (memo) assigned[t.id] = memo;
    else toClassify.push(t);
  }

  if (toClassify.length > 0) {
    let result;
    try {
      const text = await callClaude(CE_CORE.buildRequest(toClassify, state, config), config.apiKey);
      result = CE_CORE.parseResponse(text, toClassify, config);
    } catch (e) {
      const message = "Anthropic API error: " + (e && e.message ? e.message : e);
      await setBadge("err", "#dc322f");
      await chrome.storage.local.set({ lastError: { message, at: Date.now() } });
      return { error: message };
    }
    await setBadge("", "");
    await chrome.storage.local.remove("lastError");

    const applied = CE_CORE.applyResult(state, toClassify, result, Date.now());
    Object.assign(assigned, applied.assigned);
    let calls = 1;

    // Every few batches, a merge-only pass over the cluster list folds
    // same-subject beats that were created in different batches.
    state.batches = (state.batches || 0) + 1;
    if (state.batches % CONSOLIDATE_EVERY === 0 && Object.keys(state.clusters).length >= CONSOLIDATE_MIN_CLUSTERS) {
      try {
        const ctext = await callClaude(CE_CORE.buildConsolidateRequest(state, config), config.apiKey);
        CE_CORE.applyConsolidation(state, CE_CORE.parseConsolidateResponse(ctext), Date.now());
        calls++;
        for (const [id, a] of Object.entries(assigned)) {
          const cid = CE_CORE.resolveAlias(state, a.cluster);
          if (cid) assigned[id] = { cluster: cid, category: a.category };
        }
      } catch (e) {
        console.warn("[clear-eyes] consolidation failed:", e && e.message ? e.message : e);
      }
    }
    await saveState(state);
    await bumpStats(toClassify.length, countHidden(applied.assigned, config), calls);
  }

  return { assigned, clusters: CE_CORE.clusterList(state), categories: categoryActions(config) };
}

function categoryActions(config) {
  const out = {};
  for (const c of config.categories) out[c.id] = { label: c.label, action: c.action };
  return out;
}

function countHidden(assigned, config) {
  const actions = categoryActions(config);
  let n = 0;
  for (const v of Object.values(assigned)) {
    if (actions[v.category] && actions[v.category].action === "hide") n++;
  }
  return n;
}

// POST a prepared body; returns the text block of the response.
async function callClaude(body, apiKey) {
  const resp = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    let detail = resp.status + " " + resp.statusText;
    try {
      const err = await resp.json();
      if (err && err.error && err.error.message) detail = err.error.message;
    } catch (_) {}
    throw new Error(detail);
  }
  const data = await resp.json();
  if (data.stop_reason === "refusal") throw new Error("model refused the request");
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("no text block in response");
  return textBlock.text;
}

async function testKey(apiKey, model) {
  try {
    const resp = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: model || "claude-haiku-4-5",
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }]
      })
    });
    if (!resp.ok) {
      let detail = resp.status + " " + resp.statusText;
      try {
        const err = await resp.json();
        if (err && err.error && err.error.message) detail = err.error.message;
      } catch (_) {}
      return { ok: false, error: detail };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// ---------------------------------------------------------------------------
// Selector self-repair: when X.com's markup changes, ask the latest Opus to
// derive new selectors from a pruned HTML sample of the timeline. The content
// script verifies candidates against the live DOM before they are saved.

const SELECTOR_KEYS = ["tweet", "tweetText", "userName", "cell", "caret", "statusLink"];

async function proposeSelectors(html, previous, feedback) {
  const config = await ceGetConfig();
  if (!config.apiKey) return { error: "No API key configured." };

  const schema = {
    type: "object",
    properties: Object.fromEntries(SELECTOR_KEYS.map((k) => [k, { type: "string" }])),
    required: SELECTOR_KEYS,
    additionalProperties: false
  };

  const system =
    "You repair CSS selectors for a browser extension that reads posts on X.com (Twitter). " +
    "The site's DOM changed and the current selectors no longer match. From the provided HTML sample of the timeline, derive working CSS selectors.\n\n" +
    "Required selectors:\n" +
    "- tweet: matches each post's container element, exactly one match per visible post\n" +
    "- tweetText: within a tweet container, the element holding the post's body text\n" +
    "- userName: within a tweet, an anchor linking to the author's profile (href like \"/handle\")\n" +
    "- cell: the list-cell ancestor that wraps each tweet; may be the tweet's parent\n" +
    "- caret: within a tweet, the 'more options' menu button in the post header\n" +
    "- statusLink: within a tweet, an anchor whose href contains \"/status/<numeric id>\"\n\n" +
    "Prefer stable attributes (data-testid, role, aria-label, href patterns) over generated class names, which change every deploy. " +
    "The sample has had svg contents, style/class attributes, and long text removed — do not rely on anything that was stripped.";

  const user =
    "Current selectors (no longer working):\n" +
    JSON.stringify(previous, null, 2) +
    (feedback ? "\n\nA previous repair attempt failed live-DOM verification with these results (matched counts): " + feedback : "") +
    "\n\nHTML sample of the timeline:\n" +
    html;

  try {
    const text = await callClaude(
      {
        model: config.repairModel || "claude-opus-5",
        max_tokens: 16000,
        system,
        messages: [{ role: "user", content: user }],
        output_config: { format: { type: "json_schema", schema } }
      },
      config.apiKey
    );
    return { selectors: JSON.parse(text) };
  } catch (e) {
    return { error: "Anthropic API error: " + (e && e.message ? e.message : e) };
  }
}

async function saveSelectors(selectors) {
  const config = await ceGetConfig();
  config.selectors = Object.assign({}, config.selectors, selectors);
  await ceSaveConfig(config);
  await reportHealth(true);
  await setBadge("", "");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Stats / health / badge

async function bumpStats(classified, hidden, apiCalls) {
  const stored = await chrome.storage.local.get("stats");
  const stats = stored.stats || { classified: 0, hidden: 0, apiCalls: 0, since: Date.now() };
  stats.classified += classified;
  stats.hidden += hidden;
  stats.apiCalls += apiCalls;
  await chrome.storage.local.set({ stats });
}

async function reportHealth(ok) {
  await chrome.storage.local.set({ selectorHealth: { ok, at: Date.now() } });
  if (!ok) await setBadge("!", "#dc322f");
  return { ok: true };
}

async function getStatus() {
  const [config, stored, state] = await Promise.all([
    ceGetConfig(),
    chrome.storage.local.get(["stats", "selectorHealth", "lastError"]),
    getState()
  ]);
  return {
    config,
    stats: stored.stats || { classified: 0, hidden: 0, apiCalls: 0, since: Date.now() },
    clusterCount: Object.keys(state.clusters).length,
    selectorHealth: stored.selectorHealth || { ok: true, at: 0 },
    lastError: stored.lastError || null
  };
}

async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text });
    if (color) await chrome.action.setBadgeBackgroundColor({ color });
  } catch (_) {}
}
