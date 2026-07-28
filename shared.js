// Shared config defaults + helpers. Loaded by options/popup pages via <script>,
// and by background.js via importScripts(). Content scripts get config over messaging.

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
    description:
      "Factual news, releases, papers, event announcements, or first-hand reporting.",
    action: "keep"
  },
  {
    id: "neutral",
    label: "Benign / personal",
    description:
      "Ordinary personal updates, honest questions, humor or art without engagement-bait mechanics. Harmless filler that isn't optimized to farm attention.",
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

const CE_DEFAULT_CONFIG = {
  enabled: true,
  apiKey: "",
  model: "claude-haiku-4-5",
  homeOnly: true, // only filter the Home timeline (/home); profiles, search, threads untouched
  skipNoText: true, // pure media tweets (no text) pass through unclassified
  showLabels: true, // show the category pill on kept tweets
  categories: CE_DEFAULT_CATEGORIES
};

async function ceGetConfig() {
  const stored = await chrome.storage.local.get("config");
  const cfg = Object.assign({}, CE_DEFAULT_CONFIG, stored.config || {});
  if (!Array.isArray(cfg.categories) || cfg.categories.length === 0) {
    cfg.categories = CE_DEFAULT_CATEGORIES;
  }
  return cfg;
}

async function ceSaveConfig(cfg) {
  await chrome.storage.local.set({ config: cfg });
}
