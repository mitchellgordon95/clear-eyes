// Shared config defaults + helpers. Loaded by options/popup pages via <script>,
// and by background.js via importScripts(). Content scripts get config over messaging.
//
// Slop vs. not slop is decided by ONE rule, derived by a model from the posts
// the user tags (labels live in chrome.storage.local, see background.js).
// Non-slop posts are grouped into topic clusters ("beats").

// CSS selectors for X.com's DOM. These are what the self-repair flow rewrites
// when X changes their markup.
const CE_DEFAULT_SELECTORS = {
  tweet: 'article[data-testid="tweet"]',
  tweetText: '[data-testid="tweetText"]',
  userName: '[data-testid="User-Name"] a[href^="/"]',
  cell: '[data-testid="cellInnerDiv"]',
  caret: '[data-testid="caret"]',
  statusLink: 'a[href*="/status/"]'
};

const CE_DEFAULT_CONFIG = {
  enabled: true,
  apiKey: "",
  model: "claude-sonnet-5", // clustering + slop calls; Haiku 4.5 clustered noticeably worse (see tools/harness.mjs)
  ruleModel: "", // rule derivation from labels; "" = same as model
  homeOnly: true, // only take over the Home timeline (/home); other pages show X as-is
  hideAds: true, // skip promoted tweets (detected locally, never sent to the API)
  repairModel: "claude-opus-5", // latest Opus alias; used only for selector self-repair
  clusterPrompt: "", // override for the clustering guidance section of the system prompt ("" = built-in default)
  devBridge: true, // let page scripts on x.com send whitelisted commands (reset, set prompt/model, reload) — used for automated tuning
  selectors: CE_DEFAULT_SELECTORS
};

async function ceGetConfig() {
  const stored = await chrome.storage.local.get("config");
  const cfg = Object.assign({}, CE_DEFAULT_CONFIG, stored.config || {});
  delete cfg.categories; // pre-slop-rule taxonomy; no longer used
  cfg.selectors = Object.assign({}, CE_DEFAULT_SELECTORS, cfg.selectors || {});
  return cfg;
}

async function ceSaveConfig(cfg) {
  await chrome.storage.local.set({ config: cfg });
}
