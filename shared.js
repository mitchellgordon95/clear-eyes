// Shared config defaults + helpers. Loaded by options/popup pages via <script>,
// and by background.js via importScripts(). Content scripts get config over messaging.
//
// Categories are the per-post quality taxonomy. Every post still gets exactly
// one; cluster cards show the breakdown, and clusters that are mostly "hide"
// categories are dimmed as noise.

const CE_DEFAULT_CATEGORIES = [
  {
    id: "signal",
    label: "Intellectual value",
    description:
      "Substantive ideas, research, technical insight, well-reasoned argument, or expert commentary. The reader learns something or sees a real position from someone in the field.",
    action: "keep"
  },
  {
    id: "growth",
    label: "Personal growth",
    description:
      "Genuinely useful, specific advice on skills, health, craft, or career — concrete and experience-based, not hustle-culture platitudes.",
    action: "keep"
  },
  {
    id: "news",
    label: "News / announcements",
    description: "Factual news, releases, papers, or event announcements.",
    action: "keep"
  },
  {
    id: "slop",
    label: "Slop / engagement bait",
    description:
      "Low-effort attention farming: generic motivational platitudes, recycled listicle threads ('10 tools that will change your life'), AI-generated filler, reply-bait polls, 'repost if you agree', hustle-bro content, vague hype with nothing behind it.",
    action: "hide"
  },
  {
    id: "ragebait",
    label: "Rage bait",
    description:
      "Content engineered to provoke outrage: inflammatory framing, strawmen, culture-war provocations, decontextualized screenshots posted to farm angry quote-tweets.",
    action: "hide"
  },
  {
    id: "drama",
    label: "Drama",
    description:
      "Interpersonal feuds, dunks, pile-ons, subtweeting, community infighting, 'main character of the day' discourse.",
    action: "hide"
  }
];

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
  model: "claude-sonnet-5", // clustering quality on Haiku 4.5 was clearly worse (misfiled posts, umbrella merges); see tools/harness.mjs
  homeOnly: true, // only take over the Home timeline (/home); other pages show X as-is
  hideAds: true, // skip promoted tweets (detected locally, never sent to the API)
  repairModel: "claude-opus-5", // latest Opus alias; used only for selector self-repair
  clusterPrompt: "", // override for the clustering guidance section of the system prompt ("" = built-in default)
  devBridge: true, // let page scripts on x.com send whitelisted commands (reset, set prompt/model, reload) — used for automated tuning
  selectors: CE_DEFAULT_SELECTORS,
  categories: CE_DEFAULT_CATEGORIES
};

async function ceGetConfig() {
  const stored = await chrome.storage.local.get("config");
  const cfg = Object.assign({}, CE_DEFAULT_CONFIG, stored.config || {});
  if (!Array.isArray(cfg.categories) || cfg.categories.length === 0) {
    cfg.categories = CE_DEFAULT_CATEGORIES;
  }
  cfg.selectors = Object.assign({}, CE_DEFAULT_SELECTORS, cfg.selectors || {});
  return cfg;
}

async function ceSaveConfig(cfg) {
  await chrome.storage.local.set({ config: cfg });
}
