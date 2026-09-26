// Fake chrome.* for running content.js on a mock timeline page with no
// extension and no API: clusters are assigned round-robin so the overlay's
// card/one-off promotion and count bumps can be exercised deterministically.
// Prepend to content.js (see tools/ui-mock/README in gen.mjs header).
window.chrome = (() => {
  const S = { tweet: 'article[data-testid="tweet"]', tweetText: '[data-testid="tweetText"]', userName: '[data-testid="User-Name"] a[href^="/"]', cell: '[data-testid="cellInnerDiv"]', caret: '[data-testid="caret"]', statusLink: 'a[href*="/status/"]' };
  const categories = [
    { id: "signal", label: "Intellectual value", action: "keep" },
    { id: "news", label: "News", action: "keep" },
    { id: "slop", label: "Slop", action: "hide" },
    { id: "drama", label: "Drama", action: "hide" }
  ];
  const cfg = { enabled: true, apiKey: "fake", model: "fake", homeOnly: false, hideAds: true, devBridge: true, selectors: S, categories };
  const titles = ["Nor'easter flooding", "AI coding agents", "PhD exams and credentials", "Indie game development", "Landlords and HOAs", "Baseball highlights", "Mental health reflections", "US healthcare pricing", "Tailscale and home networking", "Celebrity anecdotes", "Startup equity", "Architecture trends"];
  const state = { clusters: {}, tweets: {}, n: 0, calls: 0 };
  const catActions = () => Object.fromEntries(categories.map((c) => [c.id, { label: c.label, action: c.action }]));
  const list = () => Object.values(state.clusters);
  function handle(msg) {
    switch (msg.type) {
      case "GET_CONFIG": return { config: cfg };
      case "GET_CLUSTERS": return { clusters: list(), categories: catActions() };
      case "RESET_CLUSTERS": state.clusters = {}; state.tweets = {}; state.n = 0; return { ok: true };
      case "GET_TUNING": return { model: cfg.model, clusterPrompt: "", devBridge: true };
      case "CLUSTER_BATCH": {
        state.calls++;
        const assigned = {}, now = Date.now();
        for (const t of msg.tweets) {
          if (state.tweets[t.id]) { assigned[t.id] = state.tweets[t.id]; continue; }
          // Zipf-ish: early cluster ids get more posts, so some beats grow while others stay one-offs.
          const k = Math.min(titles.length - 1, Math.floor(Math.pow(state.n % 40, 0.7)));
          const id = "c" + k;
          if (!state.clusters[id]) state.clusters[id] = { id, title: titles[k], summary: "Posts about " + titles[k].toLowerCase() + ".", count: 0, categories: {}, createdAt: now, updatedAt: now };
          const c = state.clusters[id];
          const cat = categories[state.n % categories.length].id;
          c.count++; c.categories[cat] = (c.categories[cat] || 0) + 1; c.updatedAt = now;
          assigned[t.id] = state.tweets[t.id] = { cluster: id, category: cat };
          state.n++;
        }
        return { assigned, clusters: list(), categories: catActions() };
      }
      default: return { ok: true };
    }
  }
  window.__mockState = state;
  return {
    runtime: { lastError: null, sendMessage(msg, cb) { const r = handle(msg); setTimeout(() => cb && cb(r), msg.type === "CLUSTER_BATCH" ? 400 : 0); } },
    storage: { onChanged: { addListener() {} } }
  };
})();
