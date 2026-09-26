// Content script: replaces X's Home timeline with a cluster view.
//
// X's own page keeps running underneath (it is what fetches tweets). We cover
// it with an opaque overlay, ingest every tweet X mounts into the DOM, ask the
// background worker to cluster + classify each batch, and render only the
// clusters. Raw tweets are never displayed. Scrolling the overlay drives X's
// infinite scroll so more tweets keep arriving and cluster counts grow.

(() => {
  const BATCH_MAX = 20;
  const BATCH_DEBOUNCE_MS = 400;
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 4000;
  const SWEEP_INTERVAL_MS = 1500;
  const HEALTH_CHECK_AFTER_MS = 12000;
  const PUMP_TICK_MS = 120; // how often the underlying page is nudged
  const PUMP_STALL_MS = 5000; // give up on a scroll request if X stops loading
  const WHEEL_GAIN = 3; // px of underlying scroll per px of wheel delta

  let config = null;
  let S = null; // active selectors (config.selectors; rewritten by self-repair)
  let queue = []; // [{id, author, text}]
  let queuedIds = new Set();
  let flushTimer = null;
  let everSawTweet = false;
  const seen = new Map(); // tweetId -> {cluster, category} | "pending" | "failed" | "ad" | "notext"
  const retryCounts = new Map(); // tweetId -> failed attempts
  let parked = []; // tweets waiting for an API key
  let inFlight = 0; // tweets currently being classified
  const skipped = { ads: 0, noText: 0, failed: 0 };
  let clusters = []; // [{id, title, summary, count, categories, createdAt, updatedAt}]
  let categoryInfo = {}; // id -> {label, action}
  let ui = null; // mounted overlay elements, or null

  init();

  async function init() {
    config = await getConfig();
    if (!config) return;
    S = config.selectors;
    buildLocalCategoryInfo();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.config) return;
      const hadKey = !!config.apiKey;
      config = Object.assign({}, config, changes.config.newValue || {});
      if (config.selectors) S = config.selectors;
      buildLocalCategoryInfo();
      syncView();
      if (!hadKey && config.apiKey && parked.length > 0) {
        const p = parked;
        parked = [];
        for (const t of p) enqueue(t);
        flush();
      }
      render();
    });

    const resp = await sendMessageAsync({ type: "GET_CLUSTERS" });
    if (resp && resp.clusters) {
      clusters = resp.clusters;
      if (resp.categories) categoryInfo = Object.assign(categoryInfo, resp.categories);
    }

    const observer = new MutationObserver(() => scheduleSweep());
    observer.observe(document.body, { childList: true, subtree: true });
    setInterval(sweep, SWEEP_INTERVAL_MS);
    syncView();
    sweep();

    setTimeout(healthCheck, HEALTH_CHECK_AFTER_MS);
  }

  function buildLocalCategoryInfo() {
    categoryInfo = {};
    for (const c of config.categories || []) {
      categoryInfo[c.id] = { label: c.label, action: c.action };
    }
  }

  function getConfig() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "GET_CONFIG" }, (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.config) resolve(null);
          else resolve(resp.config);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  function sendMessageAsync(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
          else resolve(resp);
        });
      } catch (e) {
        resolve({ error: String(e) });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Scanning X's DOM (underneath the overlay)

  let sweepScheduled = false;
  function scheduleSweep() {
    if (sweepScheduled) return;
    sweepScheduled = true;
    requestAnimationFrame(() => {
      sweepScheduled = false;
      sweep();
    });
  }

  function viewActive() {
    if (!config || !config.enabled) return false;
    if (config.homeOnly !== false && location.pathname !== "/home") return false;
    return true;
  }

  function sweep() {
    syncView(); // X is an SPA: the path can change without a reload
    const articles = document.querySelectorAll(S.tweet);
    if (articles.length > 0) everSawTweet = true;
    if (!viewActive()) return;

    let changed = false;
    for (const article of articles) {
      const id = extractTweetId(article);
      if (!id) continue;
      if (seen.has(id)) continue;

      if (config.hideAds !== false && isAd(article)) {
        seen.set(id, "ad");
        skipped.ads++;
        changed = true;
        continue;
      }
      const text = extractText(article);
      if (!text) {
        seen.set(id, "notext");
        skipped.noText++;
        changed = true;
        continue;
      }
      seen.set(id, "pending");
      enqueue({ id, author: extractAuthor(article), text: text.slice(0, 2000) });
      changed = true;
    }
    if (queue.length >= BATCH_MAX) flush();
    else if (queue.length > 0) {
      clearTimeout(flushTimer);
      flushTimer = setTimeout(flush, BATCH_DEBOUNCE_MS);
    }
    if (changed) renderStats();
  }

  function enqueue(t) {
    if (queuedIds.has(t.id)) return;
    queuedIds.add(t.id);
    queue.push(t);
  }

  function extractTweetId(article) {
    const link = article.querySelector(S.statusLink);
    if (!link) return null;
    const m = link.getAttribute("href").match(/status\/(\d+)/);
    return m ? m[1] : null;
  }

  function extractText(article) {
    const el = article.querySelector(S.tweetText);
    return el ? el.innerText.trim() : "";
  }

  function extractAuthor(article) {
    const link = article.querySelector(S.userName);
    if (!link) return "";
    return link.getAttribute("href").replace(/^\//, "").split("/")[0];
  }

  // Promoted-tweet detection: X wraps ads in placementTracking and/or shows a
  // bare "Ad" / "Promoted" span in the header. Locale-dependent (English).
  function isAd(article) {
    if (article.closest('[data-testid="placementTracking"]') ||
        article.querySelector('[data-testid="placementTracking"]')) {
      return true;
    }
    for (const span of article.querySelectorAll("span")) {
      if (span.children.length > 0) continue;
      const t = span.textContent.trim();
      if (t !== "Ad" && t !== "Promoted") continue;
      if (span.closest(S.tweetText)) continue;
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Batching + cluster assignment

  function flush() {
    clearTimeout(flushTimer);
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    queuedIds = new Set();
    inFlight += batch.length;
    renderStats();

    let responded = false;
    const done = () => {
      if (responded) return false;
      responded = true;
      inFlight -= batch.length;
      renderStats();
      return true;
    };

    try {
      chrome.runtime.sendMessage({ type: "CLUSTER_BATCH", tweets: batch }, (resp) => {
        if (!done()) return;
        if (chrome.runtime.lastError || !resp || resp.error) {
          if (resp && resp.needsKey) {
            parked.push(...batch);
            render();
            return;
          }
          if (resp && resp.error) console.warn("[clear-eyes]", resp.error);
          failBatch(batch);
          return;
        }
        if (resp.disabled) return;
        if (resp.categories) categoryInfo = Object.assign(categoryInfo, resp.categories);
        for (const t of batch) {
          const a = resp.assigned && resp.assigned[t.id];
          if (a) {
            seen.set(t.id, a);
            retryCounts.delete(t.id);
          } else {
            seen.set(t.id, "failed");
            skipped.failed++;
          }
        }
        if (resp.clusters) clusters = resp.clusters;
        render();
      });
    } catch (_) {
      if (done()) failBatch(batch);
    }
    // Safety valve: if the worker never answers, treat as a failed attempt.
    setTimeout(() => {
      if (done()) failBatch(batch);
    }, 30000);
  }

  function failBatch(batch) {
    const toRetry = [];
    for (const t of batch) {
      const cur = seen.get(t.id);
      if (cur && typeof cur === "object") continue; // a retry already succeeded
      const attempts = (retryCounts.get(t.id) || 0) + 1;
      retryCounts.set(t.id, attempts);
      if (attempts < MAX_ATTEMPTS) toRetry.push(t);
      else {
        seen.set(t.id, "failed");
        skipped.failed++;
      }
    }
    renderStats();
    if (toRetry.length > 0) {
      setTimeout(() => {
        for (const t of toRetry) {
          if (seen.get(t.id) === "pending") enqueue(t);
        }
        if (queue.length > 0) flush();
      }, RETRY_DELAY_MS * (retryCounts.get(toRetry[0].id) || 1));
    }
  }

  // -------------------------------------------------------------------------
  // Overlay lifecycle

  function syncView() {
    const want = viewActive();
    if (want && !ui) mount();
    else if (!want && ui) unmount();
  }

  function mount() {
    const root = el("div", "ce-root");
    root.id = "ce-root";

    const top = el("header", "ce-top");
    const brand = el("div", "ce-brand", "Clear Eyes");
    const stats = el("div", "ce-stats");
    const reset = el("button", "ce-btn", "Reset clusters");
    reset.addEventListener("click", async () => {
      reset.disabled = true;
      await sendMessageAsync({ type: "RESET_CLUSTERS" });
      clusters = [];
      seen.clear();
      retryCounts.clear();
      skipped.ads = skipped.noText = skipped.failed = 0;
      render();
      sweep();
      reset.disabled = false;
    });
    top.append(brand, stats, reset);

    const notice = el("div", "ce-notice");
    const list = el("main", "ce-list");
    const foot = el("footer", "ce-foot", "Scroll to pull more posts from your timeline");

    root.append(top, notice, list, foot);
    // Must live in <body>: X makes <html> the scroller, and a fixed element
    // attached directly to <html> gets offset by the scroll position.
    document.body.appendChild(root);
    document.documentElement.classList.add("ce-active");

    root.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", swallowKey, true);
    window.addEventListener("keypress", swallowKey, true);

    ui = { root, stats, notice, list, cards: new Map() };
    render();
  }

  function unmount() {
    if (!ui) return;
    ui.root.removeEventListener("wheel", onWheel);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("keyup", swallowKey, true);
    window.removeEventListener("keypress", swallowKey, true);
    ui.root.remove();
    document.documentElement.classList.remove("ce-active");
    ui = null;
    stopPump();
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // -------------------------------------------------------------------------
  // Scroll pump: wheel/keys on the overlay scroll the underlying X page so it
  // fetches and mounts more tweets. Steps are kept under a viewport so X's
  // virtualized list mounts every cell along the way (nothing gets skipped).

  let pumpBudget = 0;
  let pumpTimer = null;
  let stallSince = 0;

  function onWheel(e) {
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * innerHeight : e.deltaY;
    requestScroll(dy);
  }

  function onKey(e) {
    if (!ui) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === "ArrowDown" || k === "j") requestScroll(80);
    else if (k === "ArrowUp" || k === "k") requestScroll(-80);
    else if (k === "PageDown" || k === " ") requestScroll(innerHeight * 0.8);
    else if (k === "PageUp") requestScroll(-innerHeight * 0.8);
    else if (k === "End") requestScroll(innerHeight * 4);
    else if (k === "Home") ui.list.scrollTop = 0;
    // Swallow everything so X's global shortcuts (n, /, etc.) can't fire underneath.
    e.stopImmediatePropagation();
    if (k === " " || k === "PageDown" || k === "PageUp") e.preventDefault();
  }

  function swallowKey(e) {
    if (ui) e.stopImmediatePropagation();
  }

  function requestScroll(dy) {
    if (!ui) return;
    const list = ui.list;
    if (dy < 0) {
      list.scrollTop += dy;
      return;
    }
    const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 2;
    if (!atBottom) {
      list.scrollTop += dy;
      return;
    }
    pumpBudget = Math.min(pumpBudget + dy * WHEEL_GAIN, innerHeight * 8);
    if (!pumpTimer) {
      stallSince = 0;
      pumpTimer = setInterval(pumpTick, PUMP_TICK_MS);
      ui.root.classList.add("ce-pumping");
    }
  }

  function pumpTick() {
    if (!ui || pumpBudget <= 0) return stopPump();
    const doc = document.documentElement;
    const atDocBottom = window.scrollY + innerHeight >= doc.scrollHeight - 4;
    if (atDocBottom) {
      // X is (hopefully) fetching the next page. Wait for the document to grow.
      if (!stallSince) stallSince = Date.now();
      else if (Date.now() - stallSince > PUMP_STALL_MS) return stopPump();
      return;
    }
    stallSince = 0;
    const step = Math.min(pumpBudget, innerHeight * 0.7);
    window.scrollBy(0, step);
    pumpBudget -= step;
  }

  function stopPump() {
    clearInterval(pumpTimer);
    pumpTimer = null;
    pumpBudget = 0;
    if (ui) ui.root.classList.remove("ce-pumping");
  }

  // -------------------------------------------------------------------------
  // Rendering

  function render() {
    if (!ui) return;
    renderStats();
    renderNotice();
    renderClusters();
  }

  function renderStats() {
    if (!ui) return;
    let assigned = 0;
    for (const v of seen.values()) if (typeof v === "object") assigned++;
    const parts = [`${assigned} posts`, `${clusters.length} clusters`];
    if (inFlight > 0) parts.push(`${inFlight} classifying…`);
    const sk = [];
    if (skipped.ads) sk.push(`${skipped.ads} ads`);
    if (skipped.noText) sk.push(`${skipped.noText} media-only`);
    if (skipped.failed) sk.push(`${skipped.failed} failed`);
    if (sk.length) parts.push("skipped " + sk.join(", "));
    ui.stats.textContent = parts.join(" · ");
  }

  function renderNotice() {
    const n = ui.notice;
    n.innerHTML = "";
    if (!config.apiKey) {
      n.append(el("span", null, "Add your Anthropic API key to start clustering. "));
      const b = el("button", "ce-link", "Open options");
      b.addEventListener("click", () => sendMessageAsync({ type: "OPEN_OPTIONS" }));
      n.append(b);
      n.style.display = "";
    } else if (clusters.length === 0 && inFlight === 0) {
      n.textContent = "Waiting for posts… scroll to pull from your timeline.";
      n.style.display = "";
    } else {
      n.style.display = "none";
    }
  }

  function renderClusters() {
    const list = ui.list;
    const cards = ui.cards;
    const sorted = clusters.slice().sort((a, b) => b.count - a.count || a.createdAt - b.createdAt);

    // FLIP: remember where each card was so reorders animate.
    const before = new Map();
    for (const [id, card] of cards) before.set(id, card.getBoundingClientRect().top);

    const live = new Set();
    for (const c of sorted) {
      live.add(c.id);
      let card = cards.get(c.id);
      if (!card) {
        card = buildCard(c);
        cards.set(c.id, card);
        card.classList.add("ce-new");
      } else {
        updateCard(card, c);
      }
      list.appendChild(card); // appending in sorted order reorders in place
    }
    for (const [id, card] of cards) {
      if (!live.has(id)) {
        card.remove();
        cards.delete(id);
      }
    }

    for (const [id, card] of cards) {
      const prev = before.get(id);
      if (prev == null) continue;
      const delta = prev - card.getBoundingClientRect().top;
      if (!delta) continue;
      card.style.transition = "none";
      card.style.transform = `translateY(${delta}px)`;
      requestAnimationFrame(() => {
        card.style.transition = "";
        card.style.transform = "";
      });
    }
  }

  function buildCard(c) {
    const card = el("article", "ce-card");
    card.dataset.id = c.id;
    const count = el("div", "ce-count");
    const body = el("div", "ce-body");
    const title = el("h2", "ce-title");
    const summary = el("p", "ce-summary");
    const cats = el("div", "ce-cats");
    const tag = el("span", "ce-noise-tag", "mostly noise");
    body.append(title, summary, cats);
    card.append(count, body, tag);
    updateCard(card, c, true);
    return card;
  }

  function updateCard(card, c, initial) {
    const countEl = card.querySelector(".ce-count");
    const prev = Number(countEl.textContent) || 0;
    if (!initial && c.count !== prev) {
      countEl.dataset.delta = c.count > prev ? "+" + (c.count - prev) : "";
      card.classList.remove("ce-bump");
      void card.offsetWidth; // restart animation
      card.classList.add("ce-bump");
    }
    countEl.textContent = String(c.count);
    card.querySelector(".ce-title").textContent = c.title;
    card.querySelector(".ce-summary").textContent = c.summary;

    const cats = card.querySelector(".ce-cats");
    cats.innerHTML = "";
    let hidden = 0;
    const entries = Object.entries(c.categories || {}).sort((a, b) => b[1] - a[1]);
    for (const [id, n] of entries) {
      const info = categoryInfo[id] || { label: id, action: "keep" };
      if (info.action === "hide") hidden += n;
      const chip = el("span", "ce-cat", `${info.label} ${n}`);
      chip.dataset.action = info.action;
      cats.append(chip);
    }
    card.dataset.noise = c.count > 0 && hidden / c.count > 0.5 ? "1" : "";
  }

  // -------------------------------------------------------------------------
  // Selector health: if we're on a timeline page that clearly rendered content
  // but our tweet selector never matched, X probably changed their markup.

  function healthCheck() {
    if (location.pathname !== "/home") return;
    const column = document.querySelector('[data-testid="primaryColumn"], main');
    const pageHasContent = column && column.querySelectorAll("div").length > 50;
    const ok = everSawTweet || !pageHasContent;
    try {
      chrome.runtime.sendMessage({ type: "SELECTOR_HEALTH", ok });
    } catch (_) {}
    if (!ok && config.apiKey !== "") showRepairBanner();
  }

  // -------------------------------------------------------------------------
  // Self-repair: X changed their markup → ask the user, then have Opus derive
  // new selectors from a pruned HTML sample and verify them against the live
  // DOM before saving. Never applies anything that doesn't verify.

  const REPAIR_MAX_ATTEMPTS = 3;

  function showRepairBanner() {
    if (document.querySelector(".ce-repair")) return;
    const box = document.createElement("div");
    box.className = "ce-repair";

    const msg = document.createElement("div");
    msg.className = "ce-repair-msg";
    msg.textContent =
      "Clear Eyes can't find tweets — X may have changed their page structure. " +
      "Try an automatic repair? (Sends a snippet of this page's HTML to Claude using your API key.)";

    const row = document.createElement("div");
    row.className = "ce-repair-row";
    const fix = document.createElement("button");
    fix.className = "ce-repair-btn ce-repair-primary";
    fix.textContent = "Attempt auto-repair";
    const dismiss = document.createElement("button");
    dismiss.className = "ce-repair-btn";
    dismiss.textContent = "Not now";
    row.append(fix, dismiss);

    const status = document.createElement("div");
    status.className = "ce-repair-status";

    box.append(msg, row, status);
    document.body.appendChild(box);

    dismiss.addEventListener("click", () => box.remove());
    fix.addEventListener("click", async () => {
      fix.disabled = true;
      dismiss.disabled = true;
      await runRepair(status);
      dismiss.disabled = false;
      dismiss.textContent = "Close";
    });
  }

  async function runRepair(statusEl) {
    let feedback = "";
    for (let attempt = 1; attempt <= REPAIR_MAX_ATTEMPTS; attempt++) {
      statusEl.textContent = `Asking Claude Opus to analyze the page (attempt ${attempt}/${REPAIR_MAX_ATTEMPTS})…`;
      const resp = await sendMessageAsync({
        type: "REPAIR_PROPOSE",
        html: captureDomSample(),
        previous: S,
        feedback
      });
      if (!resp || resp.error) {
        statusEl.textContent = "Repair failed: " + (resp && resp.error ? resp.error : "no response");
        return;
      }
      const result = verifySelectors(resp.selectors);
      if (result.pass) {
        await sendMessageAsync({ type: "SAVE_SELECTORS", selectors: resp.selectors });
        S = Object.assign({}, S, resp.selectors);
        everSawTweet = true;
        statusEl.textContent = "Repaired and verified (" + result.summary + "). Clustering resumed.";
        sweep();
        setTimeout(() => {
          const box = document.querySelector(".ce-repair");
          if (box) box.remove();
        }, 6000);
        return;
      }
      feedback = result.summary;
      statusEl.textContent = `Proposed selectors failed verification (${result.summary}); retrying…`;
    }
    statusEl.textContent =
      "Couldn't find working selectors after " + REPAIR_MAX_ATTEMPTS + " attempts. Nothing can be clustered until this is fixed.";
  }

  // Serialize the timeline's DOM, pruned to what selector-derivation needs:
  // structure + stable attributes. Drops svg innards, styles, generated class
  // names, image payloads, and truncates text.
  function captureDomSample() {
    const root =
      document.querySelector('[data-testid="primaryColumn"]') ||
      document.querySelector("main") ||
      document.body;
    const clone = root.cloneNode(true);
    for (const e of clone.querySelectorAll("svg, script, style, link, noscript, video, #ce-root")) e.remove();
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent.length > 60) node.textContent = node.textContent.slice(0, 60) + "…";
      } else {
        node.removeAttribute("style");
        node.removeAttribute("class");
        if (node.tagName === "IMG") {
          node.removeAttribute("src");
          node.removeAttribute("srcset");
        }
      }
    }
    return clone.outerHTML.slice(0, 250000);
  }

  // Hard, live-DOM acceptance test for candidate selectors.
  function verifySelectors(c) {
    if (!c || typeof c !== "object") return { pass: false, summary: "no selectors returned" };
    let tweets;
    try {
      tweets = Array.from(document.querySelectorAll(c.tweet));
    } catch (_) {
      return { pass: false, summary: "tweet selector is not valid CSS" };
    }
    if (tweets.length < 3) {
      return { pass: false, summary: `tweet matched only ${tweets.length} elements (need >= 3)` };
    }
    const sample = tweets.slice(0, 12);
    let text = 0, id = 0, caret = 0, cell = 0;
    for (const t of sample) {
      try {
        const e = t.querySelector(c.tweetText);
        if (e && e.innerText.trim()) text++;
      } catch (_) {}
      try {
        const l = t.querySelector(c.statusLink);
        if (l && /status\/\d+/.test(l.getAttribute("href") || "")) id++;
      } catch (_) {}
      try {
        if (t.querySelector(c.caret)) caret++;
      } catch (_) {}
      try {
        if (t.closest(c.cell)) cell++;
      } catch (_) {}
    }
    const n = sample.length;
    const summary = `tweets:${tweets.length}, text:${text}/${n}, statusId:${id}/${n}, caret:${caret}/${n}, cell:${cell}/${n}`;
    const pass = id >= n * 0.8 && text >= n * 0.5;
    return { pass, summary };
  }
})();
