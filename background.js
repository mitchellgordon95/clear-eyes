// Background service worker: owns all Anthropic API calls, the cluster state,
// the user's slop labels and derived rule, the toolbar badge, and session
// stats. Content scripts talk to it via messages. The clustering/slop logic
// itself (prompts, schemas, parsing, state updates) lives in cluster-core.js
// so tools/harness.mjs can run it offline.

importScripts("shared.js", "cluster-core.js");

const API_URL = "https://api.anthropic.com/v1/messages";
const STATE_KEY = "clusterState"; // chrome.storage.session — survives SW restarts, cleared when browser closes
const LABELS_KEY = "labels"; // chrome.storage.local — the user's slop/ok tags, persist across sessions
const RULE_KEY = "slopRule"; // chrome.storage.local — {text, derivedAt, nSlop, nOk}
const TWEET_MEMO_MAX = 6000; // tweet -> assignment + text memo; ~3MB of the 10MB session quota
const LABELS_MAX = 2000;
const CONSOLIDATE_EVERY = 3; // batches between merge-only consolidation passes
const CONSOLIDATE_MIN_CLUSTERS = 8;
const VIEW_SLOP_MAX = 200; // newest slop posts sent to the overlay

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
    case "GET_VIEW":
      return getView();
    case "GET_CLUSTER_POSTS":
      return { posts: CE_CORE.clusterPosts(await getState(), String(msg.cluster)) };
    case "SET_LABEL":
      return setLabel(msg);
    case "GET_RULE":
      return getRuleInfo();
    case "DERIVE_RULE":
      deriveRule();
      return { ok: true };
    case "RESET_CLUSTERS":
      await chrome.storage.session.remove(STATE_KEY);
      return { ok: true };
    case "RESET_LABELS":
      await chrome.storage.local.remove([LABELS_KEY, RULE_KEY]);
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
    ruleModel: config.ruleModel || "",
    clusterPrompt: config.clusterPrompt || "",
    defaultClusterPrompt: CE_CORE.DEFAULT_CLUSTER_GUIDANCE,
    devBridge: config.devBridge !== false
  };
}

async function setTuning(msg) {
  const config = await ceGetConfig();
  if (typeof msg.model === "string" && msg.model.trim()) config.model = msg.model.trim();
  if (typeof msg.ruleModel === "string") config.ruleModel = msg.ruleModel.trim();
  if (typeof msg.clusterPrompt === "string") config.clusterPrompt = msg.clusterPrompt;
  await ceSaveConfig(config);
  return getTuning();
}

// ---------------------------------------------------------------------------
// State / labels / rule storage

async function getState() {
  const stored = await chrome.storage.session.get(STATE_KEY);
  return CE_CORE.normalizeState(stored[STATE_KEY]);
}

async function saveState(state) {
  CE_CORE.pruneState(state, TWEET_MEMO_MAX);
  await chrome.storage.session.set({ [STATE_KEY]: state });
}

async function getLabels() {
  const stored = await chrome.storage.local.get(LABELS_KEY);
  return stored[LABELS_KEY] || {};
}

async function saveLabels(labels) {
  const ids = Object.keys(labels);
  if (ids.length > LABELS_MAX) {
    ids.sort((a, b) => (labels[a].at || 0) - (labels[b].at || 0));
    for (const id of ids.slice(0, ids.length - LABELS_MAX)) delete labels[id];
  }
  await chrome.storage.local.set({ [LABELS_KEY]: labels });
}

async function getRuleInfo() {
  const stored = await chrome.storage.local.get(RULE_KEY);
  const r = stored[RULE_KEY];
  return {
    rule: r && r.text ? r.text : CE_CORE.SEED_RULE,
    seed: !(r && r.text),
    derivedAt: r ? r.derivedAt || 0 : 0,
    nSlop: r ? r.nSlop || 0 : 0,
    nOk: r ? r.nOk || 0 : 0,
    updating: ruleInFlight,
    error: ruleError
  };
}

function labelCounts(labels) {
  let nSlop = 0, nOk = 0;
  for (const l of Object.values(labels)) if (l.label === "slop") nSlop++; else nOk++;
  return { nSlop, nOk };
}

async function getView() {
  const [config, state, labels, rule] = await Promise.all([ceGetConfig(), getState(), getLabels(), getRuleInfo()]);
  const kept = Object.entries(labels)
    .filter(([, l]) => l.label === "ok")
    .map(([id, l]) => ({ id, author: l.author || "", text: l.text || "", at: l.at || 0 }))
    .sort((a, b) => b.at - a.at);
  return {
    clusters: CE_CORE.clusterList(state),
    slop: CE_CORE.slopPosts(state).slice(0, VIEW_SLOP_MAX),
    kept,
    rule,
    labels: labelCounts(labels),
    hasKey: !!config.apiKey
  };
}

// ---------------------------------------------------------------------------
// Labels → state update, and (re)derive the rule

async function setLabel(msg) {
  const id = String(msg.id || "");
  const label = msg.label === "slop" ? "slop" : "ok";
  if (!id) return { error: "missing id" };

  const [state, labels] = await Promise.all([getState(), getLabels()]);
  const prev = state.tweets[id] || {};
  const meta = { author: msg.author || prev.author || "", text: msg.text || prev.text || "" };
  labels[id] = { label, author: meta.author.slice(0, 40), text: meta.text.slice(0, 600), at: Date.now() };
  await saveLabels(labels);

  const { needsCluster } = CE_CORE.setLabel(state, id, label, meta, Date.now());
  await saveState(state);

  if (needsCluster) {
    // Rescued from slop: cluster it now, flagged so the model can't re-slop it.
    await enqueueBatch([{ id, author: meta.author, text: meta.text, confirmedOk: true }]);
  }
  deriveRule(); // fire and forget; coalesced
  return getView();
}

let ruleInFlight = false;
let ruleDirty = false;
let ruleError = null;

async function deriveRule() {
  if (ruleInFlight) {
    ruleDirty = true;
    return;
  }
  ruleInFlight = true;
  try {
    do {
      ruleDirty = false;
      const [config, labels, current] = await Promise.all([ceGetConfig(), getLabels(), getRuleInfo()]);
      if (!config.apiKey || Object.keys(labels).length === 0) break;
      const text = await callClaude(CE_CORE.buildRuleRequest(labels, config, current.rule), config.apiKey);
      const rule = CE_CORE.parseRuleResponse(text);
      const counts = labelCounts(labels);
      await chrome.storage.local.set({ [RULE_KEY]: { text: rule, derivedAt: Date.now(), nSlop: counts.nSlop, nOk: counts.nOk } });
      await bumpStats(0, 0, 1);
      ruleError = null;
    } while (ruleDirty);
  } catch (e) {
    ruleError = String(e && e.message ? e.message : e);
    console.warn("[clear-eyes] rule derivation failed:", ruleError);
  } finally {
    ruleInFlight = false;
  }
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
    const memo = t.confirmedOk ? null : CE_CORE.lookupMemo(state, t.id);
    if (memo) assigned[t.id] = memo;
    else toClassify.push(t);
  }

  let slopAdded = [];
  if (toClassify.length > 0) {
    let result;
    try {
      const rule = (await getRuleInfo()).rule;
      const text = await callClaude(CE_CORE.buildRequest(toClassify, state, config, rule), config.apiKey);
      result = CE_CORE.parseResponse(text, toClassify);
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
    slopAdded = toClassify
      .filter((t) => applied.assigned[t.id] && applied.assigned[t.id].slop)
      .map((t) => ({ id: t.id, author: t.author || "", text: String(t.text || "").slice(0, 500), at: Date.now(), source: "auto" }));
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
          if (!a.cluster) continue;
          const cid = CE_CORE.resolveAlias(state, a.cluster);
          if (cid) assigned[id] = { cluster: cid };
        }
      } catch (e) {
        console.warn("[clear-eyes] consolidation failed:", e && e.message ? e.message : e);
      }
    }
    await saveState(state);
    await bumpStats(toClassify.length, applied.log.slop, calls);
  }

  return { assigned, clusters: CE_CORE.clusterList(state), slopAdded };
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
        model: model || "claude-sonnet-5",
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
  stats.hidden += hidden; // slop count
  stats.apiCalls += apiCalls;
  await chrome.storage.local.set({ stats });
}

async function reportHealth(ok) {
  await chrome.storage.local.set({ selectorHealth: { ok, at: Date.now() } });
  if (!ok) await setBadge("!", "#dc322f");
  return { ok: true };
}

async function getStatus() {
  const [config, stored, state, labels] = await Promise.all([
    ceGetConfig(),
    chrome.storage.local.get(["stats", "selectorHealth", "lastError"]),
    getState(),
    getLabels()
  ]);
  return {
    config,
    stats: stored.stats || { classified: 0, hidden: 0, apiCalls: 0, since: Date.now() },
    clusterCount: Object.keys(state.clusters).length,
    slopCount: state.slop.length,
    labels: labelCounts(labels),
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
