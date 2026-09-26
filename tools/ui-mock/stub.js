// Fake chrome.* for running content.js on a mock timeline page with no
// extension and no API: every 5th post is "slop", the rest are assigned to
// clusters round-robin (Zipf-ish) so the overlay's card/one-off promotion,
// count bumps, sidebars, and tagging can be exercised deterministically.
// Prepended to content.js by tools/ui-mock/gen.mjs.
window.chrome = (() => {
  const S = { tweet: 'article[data-testid="tweet"]', tweetText: '[data-testid="tweetText"]', userName: '[data-testid="User-Name"] a[href^="/"]', cell: '[data-testid="cellInnerDiv"]', caret: '[data-testid="caret"]', statusLink: 'a[href*="/status/"]' };
  const cfg = { enabled: true, apiKey: "fake", model: "fake", homeOnly: false, hideAds: true, devBridge: true, selectors: S };
  const titles = ["Nor'easter flooding", "AI coding agents", "PhD exams and credentials", "Indie game development", "Landlords and HOAs", "Baseball highlights", "Mental health reflections", "US healthcare pricing", "Tailscale and home networking", "Celebrity anecdotes", "Startup equity", "Architecture trends"];
  const state = { clusters: {}, tweets: {}, slop: [], labels: {}, n: 0, calls: 0, rule: { rule: "SEED: generic platitudes, rage bait, drama are slop.", seed: true, derivedAt: 0, nSlop: 0, nOk: 0, updating: false } };
  const list = () => Object.values(state.clusters);
  const post = (id) => Object.assign({ id }, state.tweets[id]);
  const view = () => ({
    clusters: list(),
    slop: state.slop.slice().reverse().map(post),
    kept: Object.entries(state.labels).filter(([, l]) => l.label === "ok").map(([id, l]) => ({ id, author: l.author, text: l.text, at: l.at })),
    rule: state.rule,
    labels: { nSlop: Object.values(state.labels).filter((l) => l.label === "slop").length, nOk: Object.values(state.labels).filter((l) => l.label === "ok").length },
    hasKey: true
  });
  function assign(t, forceOk) {
    const now = Date.now();
    if (!forceOk && state.n % 5 === 4) {
      state.tweets[t.id] = { slop: true, author: t.author, text: t.text, at: now, source: "auto" };
      state.slop.push(t.id);
      state.n++;
      return { slop: true };
    }
    const k = Math.min(titles.length - 1, Math.floor(Math.pow(state.n % 40, 0.7)));
    const id = "c" + k;
    if (!state.clusters[id]) state.clusters[id] = { id, title: titles[k], summary: "Posts about " + titles[k].toLowerCase() + ".", count: 0, createdAt: now, updatedAt: now };
    state.clusters[id].count++;
    state.clusters[id].updatedAt = now;
    state.tweets[t.id] = { cluster: id, author: t.author, text: t.text, at: now, source: forceOk ? "user" : "auto" };
    state.n++;
    return { cluster: id };
  }
  function handle(msg) {
    switch (msg.type) {
      case "GET_CONFIG": return { config: cfg };
      case "GET_VIEW": return view();
      case "GET_RULE": return state.rule;
      case "GET_TUNING": return { model: cfg.model, clusterPrompt: "", devBridge: true };
      case "RESET_CLUSTERS": state.clusters = {}; state.tweets = {}; state.slop = []; state.n = 0; return { ok: true };
      case "RESET_LABELS": state.labels = {}; return { ok: true };
      case "GET_CLUSTER_POSTS": return { posts: Object.entries(state.tweets).filter(([, m]) => m.cluster === msg.cluster).map(([id, m]) => Object.assign({ id }, m)).reverse() };
      case "SET_LABEL": {
        const m = state.tweets[msg.id] || {};
        state.labels[msg.id] = { label: msg.label, author: msg.author || m.author || "", text: msg.text || m.text || "", at: Date.now() };
        if (msg.label === "slop") {
          if (m.cluster && state.clusters[m.cluster]) { state.clusters[m.cluster].count--; if (state.clusters[m.cluster].count <= 0) delete state.clusters[m.cluster]; }
          state.tweets[msg.id] = { slop: true, author: msg.author || m.author, text: msg.text || m.text, at: Date.now(), source: "user" };
          if (!state.slop.includes(msg.id)) state.slop.push(msg.id);
        } else {
          const i = state.slop.indexOf(msg.id); if (i >= 0) state.slop.splice(i, 1);
          if (!m.cluster) assign({ id: msg.id, author: msg.author || m.author, text: msg.text || m.text }, true);
          else state.tweets[msg.id].source = "user";
        }
        const n = Object.keys(state.labels).length;
        state.rule = { rule: "DERIVED from " + n + " tags: the reader dislikes " + (n % 2 ? "engagement bait and vague hype" : "drama and platitudes") + "; keeps substantive posts.", seed: false, derivedAt: Date.now(), nSlop: view().labels.nSlop, nOk: view().labels.nOk, updating: false };
        return view();
      }
      case "CLUSTER_BATCH": {
        state.calls++;
        const assigned = {}, slopAdded = [];
        for (const t of msg.tweets) {
          if (state.tweets[t.id] && !t.confirmedOk) { const m = state.tweets[t.id]; assigned[t.id] = m.slop ? { slop: true } : { cluster: m.cluster }; continue; }
          const a = assign(t, !!t.confirmedOk);
          assigned[t.id] = a;
          if (a.slop) slopAdded.push(post(t.id));
        }
        return { assigned, clusters: list(), slopAdded };
      }
      default: return { ok: true };
    }
  }
  window.__mockState = state;
  return {
    runtime: { lastError: null, sendMessage(msg, cb) { const r = handle(msg); setTimeout(() => cb && cb(r), msg.type === "CLUSTER_BATCH" ? 400 : 30); } },
    storage: { onChanged: { addListener() {} } }
  };
})();
