// Content script: veils tweets the moment they enter the DOM, batches them,
// asks the background worker for verdicts, then reveals or collapses each one.
// Fails open: any error (no key, API failure, weird DOM) reveals the tweet.

(() => {
  const BATCH_MAX = 20;
  const BATCH_DEBOUNCE_MS = 400;
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 4000;
  const SWEEP_INTERVAL_MS = 1500;
  const HEALTH_CHECK_AFTER_MS = 12000;

  let config = null;
  let S = null; // active selectors (config.selectors; rewritten by self-repair)
  let queue = []; // [{id, author, text, articles: [el]}]
  let queuedIds = new Set();
  let flushTimer = null;
  let everSawTweet = false;
  const verdictCache = new Map(); // id -> category (page-lifetime memo)
  const retryCounts = new Map(); // id -> failed classification attempts
  let categoryInfo = {}; // id -> {label, action}

  init();

  async function init() {
    config = await getConfig();
    if (!config) return;
    S = config.selectors;
    buildLocalCategoryInfo();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.config) {
        config = Object.assign({}, config, changes.config.newValue || {});
        if (config.selectors) S = config.selectors;
        buildLocalCategoryInfo();
        if (!config.enabled) revealEverything();
        if (config.showLabels === false) {
          for (const article of document.querySelectorAll(S.tweet)) clearLabel(article);
        }
      }
    });

    const observer = new MutationObserver(() => scheduleSweep());
    observer.observe(document.body, { childList: true, subtree: true });
    setInterval(sweep, SWEEP_INTERVAL_MS);
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

  // -------------------------------------------------------------------------
  // Scanning

  let sweepScheduled = false;
  function scheduleSweep() {
    if (sweepScheduled) return;
    sweepScheduled = true;
    requestAnimationFrame(() => {
      sweepScheduled = false;
      sweep();
    });
  }

  function filteringActive() {
    if (!config || !config.enabled) return false;
    if (config.homeOnly && location.pathname !== "/home") return false;
    return true;
  }

  function sweep() {
    const articles = document.querySelectorAll(S.tweet);
    if (articles.length > 0) everSawTweet = true;
    if (!filteringActive()) return;

    for (const article of articles) {
      const id = extractTweetId(article);
      if (!id) {
        // Promoted tweets sometimes lack a status link; still catch them.
        if (config.hideAds !== false && !article.dataset.ceAdChecked) {
          article.dataset.ceAdChecked = "1";
          if (isAd(article)) hideTweet(article, null, "ad", "Ad");
        }
        continue;
      }

      // X virtualizes the timeline and can recycle DOM nodes: if the node's
      // recorded id no longer matches its content, reset and reprocess.
      if (article.dataset.ceId && article.dataset.ceId !== id) {
        resetArticle(article);
      }
      if (article.dataset.ceId === id) {
        ensurePill(article); // re-add if a React re-render dropped it
        continue;
      }

      article.dataset.ceId = id;
      processTweet(article, id);
    }
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
      if (span.closest(S.tweetText)) continue; // tweet body, not the marker
      return true;
    }
    return false;
  }

  function processTweet(article, id) {
    // Ads: detected from the DOM, hidden instantly, never sent to the API.
    if (config.hideAds !== false && isAd(article)) {
      hideTweet(article, id, "ad", "Ad");
      return;
    }

    // Known verdict (scrolled past before) — apply instantly, no veil flash.
    if (verdictCache.has(id)) {
      applyVerdict(article, id, verdictCache.get(id));
      return;
    }

    const text = extractText(article);
    if (!text) {
      if ((config.noTextAction || "hide") === "hide") {
        hideTweet(article, id, "notext", "no text");
      } else {
        markKept(article);
        setLabel(article, "no text", "skip");
      }
      return;
    }

    veil(article);

    if (!queuedIds.has(id)) {
      queuedIds.add(id);
      queue.push({ id, author: extractAuthor(article), text: text.slice(0, 2000) });
    }
    if (queue.length >= BATCH_MAX) flush();
    else {
      clearTimeout(flushTimer);
      flushTimer = setTimeout(flush, BATCH_DEBOUNCE_MS);
    }
  }

  // -------------------------------------------------------------------------
  // Batching + verdicts

  function flush() {
    clearTimeout(flushTimer);
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    queuedIds = new Set();

    let responded = false;
    try {
      chrome.runtime.sendMessage({ type: "CLASSIFY_BATCH", tweets: batch }, (resp) => {
        responded = true;
        if (chrome.runtime.lastError || !resp || resp.error) {
          if (resp && resp.error) console.warn("[clear-eyes]", resp.error);
          failBatch(batch);
          return;
        }
        if (resp.disabled) {
          for (const t of batch) for (const a of findArticles(t.id)) unveil(a);
          return;
        }
        if (resp.categories) categoryInfo = Object.assign(categoryInfo, resp.categories);
        for (const t of batch) {
          const category = resp.verdicts[t.id];
          if (category) {
            verdictCache.set(t.id, category);
            retryCounts.delete(t.id);
          }
          applyVerdictById(t.id, category);
        }
      });
    } catch (_) {
      failBatch(batch);
    }
    // Safety valve: if the worker never answers, treat as a failed attempt.
    setTimeout(() => {
      if (!responded) failBatch(batch);
    }, 20000);
  }

  // A batch failed to classify: unveil immediately (fail open), retry quietly
  // in the background, and only mark tweets "not classified" once retries
  // are exhausted.
  function failBatch(batch) {
    const toRetry = [];
    for (const t of batch) {
      if (verdictCache.has(t.id)) continue; // a retry already succeeded
      const attempts = (retryCounts.get(t.id) || 0) + 1;
      retryCounts.set(t.id, attempts);
      for (const article of findArticles(t.id)) unveil(article);
      if (attempts < MAX_ATTEMPTS) {
        toRetry.push(t);
      } else {
        for (const article of findArticles(t.id)) {
          setLabel(article, "not classified", "error");
        }
      }
    }
    if (toRetry.length > 0) {
      setTimeout(() => {
        for (const t of toRetry) {
          if (verdictCache.has(t.id) || queuedIds.has(t.id)) continue;
          queuedIds.add(t.id);
          queue.push(t);
        }
        if (queue.length > 0) flush();
      }, RETRY_DELAY_MS * (retryCounts.get(toRetry[0].id) || 1));
    }
  }

  function findArticles(id) {
    return document.querySelectorAll(`${S.tweet}[data-ce-id="${id}"]`);
  }

  function applyVerdictById(id, category) {
    for (const article of findArticles(id)) applyVerdict(article, id, category);
  }

  function applyVerdict(article, id, category) {
    const info = categoryInfo[category];
    if (!category || !info) {
      markKept(article);
      setLabel(article, "not classified", "error");
      return;
    }
    if (info.action !== "hide") {
      markKept(article);
      setLabel(article, info.label || category, "keep");
      return;
    }
    hideTweet(article, id, category, info.label);
  }

  // -------------------------------------------------------------------------
  // DOM manipulation

  function setLabel(article, text, kind) {
    if (config.showLabels === false) return;
    article.dataset.ceLabel = text;
    article.dataset.ceKind = kind;
    insertPill(article);
  }

  function insertPill(article) {
    const old = article.querySelector(".ce-pill");
    if (old) old.remove();
    delete article.dataset.cePillFallback;

    // Anchor next to the tweet's top-right controls (Grok button + "..." menu):
    // insert just before the caret button so the pill sits beside them.
    const caret = article.querySelector(S.caret);
    if (!caret || !caret.parentNode) {
      article.dataset.cePillFallback = "1"; // CSS pseudo-element fallback
      return;
    }
    const pill = document.createElement("span");
    pill.className = "ce-pill";
    pill.dataset.kind = article.dataset.ceKind || "keep";
    pill.textContent = article.dataset.ceLabel || "";
    caret.parentNode.insertBefore(pill, caret);
  }

  // X's React re-renders can silently drop our injected pill; re-add it.
  function ensurePill(article) {
    if (config.showLabels === false) return;
    if (!article.dataset.ceLabel || article.dataset.cePillFallback) return;
    if (!article.querySelector(".ce-pill")) insertPill(article);
  }

  function clearLabel(article) {
    delete article.dataset.ceLabel;
    delete article.dataset.ceKind;
    delete article.dataset.cePillFallback;
    const pill = article.querySelector(".ce-pill");
    if (pill) pill.remove();
  }

  function veil(article) {
    article.classList.add("ce-veiled");
  }

  function unveil(article) {
    article.classList.remove("ce-veiled");
  }

  function markKept(article) {
    unveil(article);
    article.classList.remove("ce-hidden");
    removeBar(article);
  }

  function hideTweet(article, id, category, label) {
    unveil(article);
    article.classList.add("ce-hidden");

    const cell = article.closest(S.cell) || article.parentElement;
    if (!cell) return;
    // Always rebuild the bar: X recycles DOM nodes, and a leftover bar from a
    // previous tweet would carry a stale label and a dead click handler.
    const stale = cell.querySelector(":scope > .ce-bar");
    if (stale) stale.remove();

    const bar = document.createElement("div");
    bar.className = "ce-bar";
    const tag = document.createElement("span");
    tag.className = "ce-bar-label";
    tag.textContent = "Filtered · " + (label || category);
    const btn = document.createElement("button");
    btn.className = "ce-bar-show";
    btn.textContent = "show anyway";
    btn.addEventListener("click", () => {
      article.classList.remove("ce-hidden");
      article.dataset.ceRevealed = "1";
      bar.remove();
    });
    bar.append(tag, btn);
    cell.prepend(bar);
  }

  function removeBar(article) {
    const cell = article.closest(S.cell) || article.parentElement;
    if (!cell) return;
    const bar = cell.querySelector(":scope > .ce-bar");
    if (bar) bar.remove();
  }

  function resetArticle(article) {
    delete article.dataset.ceId;
    delete article.dataset.ceRevealed;
    delete article.dataset.ceAdChecked;
    clearLabel(article);
    article.classList.remove("ce-veiled", "ce-hidden");
    removeBar(article);
  }

  function revealEverything() {
    for (const article of document.querySelectorAll(S.tweet)) {
      article.classList.remove("ce-veiled", "ce-hidden");
      clearLabel(article);
      removeBar(article);
    }
    for (const bar of document.querySelectorAll(".ce-bar")) bar.remove();
  }

  // -------------------------------------------------------------------------
  // Selector health: if we're on a timeline page that clearly rendered content
  // but our tweet selector never matched, X probably changed their markup.

  function healthCheck() {
    const onTimeline = location.pathname === "/home";
    if (!onTimeline) return;
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
        statusEl.textContent = "Repaired and verified (" + result.summary + "). Filtering resumed.";
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
      "Couldn't find working selectors after " + REPAIR_MAX_ATTEMPTS + " attempts. Filtering stays off (feed shows unfiltered).";
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

  // Serialize the timeline's DOM, pruned to what selector-derivation needs:
  // structure + stable attributes. Drops svg innards, styles, generated class
  // names, image payloads, and truncates text.
  function captureDomSample() {
    const root =
      document.querySelector('[data-testid="primaryColumn"]') ||
      document.querySelector("main") ||
      document.body;
    const clone = root.cloneNode(true);
    for (const el of clone.querySelectorAll("svg, script, style, link, noscript, video")) el.remove();
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
        const el = t.querySelector(c.tweetText);
        if (el && el.innerText.trim()) text++;
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
    // ids are essential (cache keys); text on most (media tweets have none);
    // caret/cell degrade gracefully, so they inform but don't gate.
    const pass = id >= n * 0.8 && text >= n * 0.5;
    return { pass, summary };
  }
})();
