// Content script: replaces X's Home timeline with a cluster view.
//
// X's own page keeps running underneath (it is what fetches tweets). We cover
// it with an opaque overlay, ingest every tweet X mounts into the DOM, ask the
// background worker to sort each batch (slop / not slop, then cluster), and
// render clusters in the middle, the user's "kept" posts on the left, and slop
// swept into a collapsed sidebar on the right. Scrolling the overlay drives
// X's infinite scroll so more tweets keep arriving and cluster counts grow.
//
// Tagging: every visible post has a slop / not-slop button. Tags are the
// training set for the slop rule, which the worker re-derives and which is
// shown in the band under the header.

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
  const CE_BUILD = "b6"; // bump when content.js changes; shown as data-build on the overlay root

  let config = null;
  let S = null; // active selectors (config.selectors; rewritten by self-repair)
  let queue = []; // [{id, author, text}]
  let queuedIds = new Set();
  let flushTimer = null;
  let everSawTweet = false;
  const seen = new Map(); // tweetId -> {cluster} | {slop:true} | "pending" | "failed" | "ad" | "notext"
  const retryCounts = new Map(); // tweetId -> failed attempts
  let parked = []; // tweets waiting for an API key
  let inFlight = 0; // tweets currently being classified
  const skipped = { ads: 0, noText: 0, failed: 0 };
  let ingestPaused = false;

  // View state (from the worker)
  let clusters = []; // [{id, title, summary, count, createdAt, updatedAt}]
  let slop = []; // [{id, author, text, at, source}] newest first
  let kept = []; // posts the user tagged not-slop, newest first
  let rule = { rule: "", seed: true, derivedAt: 0, nSlop: 0, nOk: 0, updating: false };
  let ui = null; // mounted overlay elements, or null

  init();

  async function init() {
    config = await getConfig();
    if (!config) return;
    S = config.selectors;

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.config) return;
      const hadKey = !!config.apiKey;
      config = Object.assign({}, config, changes.config.newValue || {});
      if (config.selectors) S = config.selectors;
      syncView();
      if (!hadKey && config.apiKey && parked.length > 0) {
        const p = parked;
        parked = [];
        for (const t of p) enqueue(t);
        flush();
      }
      render();
    });

    await refreshView();

    const observer = new MutationObserver(() => scheduleSweep());
    observer.observe(document.body, { childList: true, subtree: true });
    setInterval(sweep, SWEEP_INTERVAL_MS);
    syncView();
    sweep();

    setTimeout(healthCheck, HEALTH_CHECK_AFTER_MS);
    installDevBridge();
  }

  async function refreshView() {
    const v = await sendMessageAsync({ type: "GET_VIEW" });
    if (v && !v.error) applyView(v);
  }

  function applyView(v) {
    if (v.clusters) clusters = v.clusters;
    if (v.slop) slop = v.slop;
    if (v.kept) kept = v.kept;
    if (v.rule) rule = v.rule;
    render();
  }

  // -------------------------------------------------------------------------
  // Dev bridge: lets a page script (e.g. an automated tuning session driving
  // the browser) send a whitelisted set of commands to the worker via
  // window.postMessage. The API key never crosses this boundary. Off via the
  // "developer bridge" option.

  const BRIDGE_ALLOWED = new Set([
    "GET_TUNING", "SET_TUNING", "GET_VIEW", "GET_CLUSTER_POSTS", "GET_RULE", "SET_LABEL", "DERIVE_RULE",
    "RESET_CLUSTERS", "RESET_LABELS", "CLUSTER_BATCH", "RELOAD_EXTENSION", "GET_STATUS"
  ]);

  function installDevBridge() {
    window.addEventListener("message", async (e) => {
      if (e.source !== window || !e.data || e.data.type !== "ce-dev") return;
      if (config.devBridge === false) return;
      const { id, msg, local } = e.data;
      let resp;
      if (local === "pause") { ingestPaused = true; resp = { ok: true, paused: true }; }
      else if (local === "resume") { ingestPaused = false; resp = { ok: true, paused: false }; sweep(); }
      else if (local === "state") {
        resp = { paused: ingestPaused, seen: seen.size, inFlight, skipped, clusters, slop: slop.length, kept: kept.length, rule, queued: queue.length };
      } else if (local === "refresh") {
        await refreshView();
        resp = { ok: true };
      } else if (msg && BRIDGE_ALLOWED.has(msg.type)) {
        resp = await sendMessageAsync(msg);
        if ((msg.type === "RESET_CLUSTERS" || msg.type === "RESET_LABELS") && resp && resp.ok) {
          seen.clear(); retryCounts.clear();
          skipped.ads = skipped.noText = skipped.failed = 0;
          await refreshView();
        }
      } else {
        resp = { error: "not allowed" };
      }
      window.postMessage({ type: "ce-dev-resp", id, resp }, "*");
    });
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
    const p = location.pathname;
    // /compose/post is X's SPA route for the compose modal over the Home
    // timeline; the overlay stays up underneath it.
    if (config.homeOnly !== false && p !== "/home" && !p.startsWith("/compose/")) return false;
    return true;
  }

  // X's compose modal is open: let keys and wheel through to it.
  function composing() {
    return location.pathname.startsWith("/compose/");
  }

  function openCompose() {
    const a = document.querySelector('[data-testid="SideNav_NewTweet_Button"]');
    if (a) a.click(); // SPA route change; the modal renders above a blurred timeline
    else location.assign("/compose/post");
  }

  function sweep() {
    if (ui && !ui.root.isConnected) unmount(); // something removed our node; remount below
    syncView(); // X is an SPA: the path can change without a reload
    syncComposing();
    const articles = document.querySelectorAll(S.tweet);
    if (articles.length > 0) everSawTweet = true;
    if (!viewActive() || ingestPaused) return;

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
  // Batching + assignment

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
        const missing = []; // the model skipped these or cited a cluster that doesn't exist; retry
        for (const t of batch) {
          const a = resp.assigned && resp.assigned[t.id];
          if (a) {
            seen.set(t.id, a);
            retryCounts.delete(t.id);
          } else {
            missing.push(t);
          }
        }
        if (resp.clusters) clusters = resp.clusters;
        if (resp.slopAdded && resp.slopAdded.length) {
          const have = new Set(slop.map((p) => p.id));
          slop = resp.slopAdded.filter((p) => !have.has(p.id)).reverse().concat(slop);
        }
        const wasAtBottom = listAtBottom();
        render();
        if (missing.length) failBatch(missing);
        // The user scrolled to the bottom to pull more posts; once the last
        // in-flight batch lands, bring them back to the top where the biggest
        // (and just-updated) beats are.
        if (wasAtBottom && inFlight === 0 && queue.length === 0 && !pumpTimer && ui) {
          ui.list.scrollTo({ top: 0, behavior: "smooth" });
        }
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
  // Labels

  async function labelPost(post, label) {
    const resp = await sendMessageAsync({ type: "SET_LABEL", id: post.id, label, author: post.author, text: post.text });
    if (!resp || resp.error) {
      console.warn("[clear-eyes] label failed:", resp && resp.error);
      return;
    }
    seen.set(post.id, label === "slop" ? { slop: true } : { cluster: null });
    if (ui) ui.postsCache.clear();
    applyView(resp);
    pollRule();
  }

  // The worker re-derives the rule after every label; watch for the update.
  let rulePoll = null;
  function pollRule() {
    clearInterval(rulePoll);
    const since = rule.derivedAt || 0;
    let tries = 0;
    rulePoll = setInterval(async () => {
      tries++;
      const r = await sendMessageAsync({ type: "GET_RULE" });
      if (r && !r.error) {
        rule = r;
        renderRule();
        if ((r.derivedAt || 0) > since || (!r.updating && tries > 2) || r.error) {
          clearInterval(rulePoll);
          rulePoll = null;
        }
      }
      if (tries >= 30) {
        clearInterval(rulePoll);
        rulePoll = null;
      }
    }, 3000);
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
    root.dataset.build = CE_BUILD;

    // Header
    const top = el("header", "ce-top");
    const brand = el("div", "ce-brand", "Clear Eyes");
    const stats = el("div", "ce-stats");
    const leftToggle = el("button", "ce-btn ce-toggle", "Kept");
    leftToggle.addEventListener("click", () => { ui.leftOpen = !ui.leftOpen; render(); });
    const rightToggle = el("button", "ce-btn ce-toggle", "Slop");
    rightToggle.addEventListener("click", () => { ui.rightOpen = !ui.rightOpen; render(); });
    const post = el("button", "ce-btn ce-btn-primary", "Post");
    post.title = "Write a post (n)";
    post.addEventListener("click", openCompose);
    const reset = el("button", "ce-btn", "Reset clusters");
    reset.addEventListener("click", async () => {
      reset.disabled = true;
      await sendMessageAsync({ type: "RESET_CLUSTERS" });
      seen.clear();
      retryCounts.clear();
      skipped.ads = skipped.noText = skipped.failed = 0;
      await refreshView();
      sweep();
      reset.disabled = false;
    });
    top.append(brand, stats, leftToggle, rightToggle, post, reset);

    // Rule band
    const ruleBox = el("section", "ce-rule");
    const ruleHead = el("div", "ce-rule-head");
    const ruleText = el("div", "ce-rule-text");
    ruleBox.append(ruleHead, ruleText);

    const notice = el("div", "ce-notice");

    // Columns
    const columns = el("div", "ce-columns");
    const left = el("aside", "ce-side ce-side-left");
    const leftHead = el("div", "ce-side-head");
    const leftList = el("div", "ce-side-list");
    left.append(leftHead, leftList);
    const center = el("div", "ce-center");
    const list = el("main", "ce-list");
    const tail = el("section", "ce-tail");
    const tailHead = el("div", "ce-tail-head");
    const tailList = el("div", "ce-tail-list");
    tail.append(tailHead, tailList);
    const foot = el("footer", "ce-foot", "Scroll to pull more posts from your timeline");
    center.append(list, foot);
    const right = el("aside", "ce-side ce-side-right");
    const rightHead = el("div", "ce-side-head");
    const rightList = el("div", "ce-side-list");
    right.append(rightHead, rightList);
    columns.append(left, center, right);

    root.append(top, ruleBox, notice, columns);
    ui = {
      root, stats, leftToggle, rightToggle, ruleBox, ruleHead, ruleText, notice, list, tail, tailHead, tailList,
      left, leftHead, leftList, right, rightHead, rightList,
      cards: new Map(), expanded: new Set(), pinned: new Set(), postsCache: new Map(),
      leftOpen: window.innerWidth >= 1100, rightOpen: false // slop starts swept aside
    };
    placeRoot();
    document.documentElement.classList.add("ce-active");

    root.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", swallowKey, true);
    window.addEventListener("keypress", swallowKey, true);

    render();
  }

  function unmount() {
    if (!ui) return;
    ui.root.removeEventListener("wheel", onWheel);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("keyup", swallowKey, true);
    window.removeEventListener("keypress", swallowKey, true);
    ui.root.remove();
    document.documentElement.classList.remove("ce-active", "ce-composing");
    wasComposing = false;
    ui = null;
    stopPump();
  }

  // The overlay lives in <body> (never <html>: X makes it the scroller and
  // fixed children get offset by the scroll position; and never inside X's
  // #layers: it is React-managed and a foreign child there stops the compose
  // modal from rendering). X's modals therefore can't paint above the overlay,
  // so while the compose route is open the overlay hides itself and the
  // timeline underneath is blurred (see syncComposing).
  function placeRoot() {
    if (ui.root.parentElement !== document.body) document.body.appendChild(ui.root);
  }

  let wasComposing = false;
  function syncComposing() {
    const c = composing();
    if (c === wasComposing) return;
    wasComposing = c;
    document.documentElement.classList.toggle("ce-composing", c);
    if (ui) ui.root.style.display = c ? "none" : "";
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // -------------------------------------------------------------------------
  // Scroll pump: wheel/keys over the center column scroll the underlying X
  // page so it fetches and mounts more tweets. Steps are kept under a viewport
  // so X's virtualized list mounts every cell along the way.

  let pumpBudget = 0;
  let pumpTimer = null;
  let stallSince = 0;

  function onWheel(e) {
    if (composing()) return;
    // Sidebars and the rule band scroll themselves.
    if (e.target.closest(".ce-side, .ce-rule")) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * innerHeight : e.deltaY;
    requestScroll(dy);
  }

  function onKey(e) {
    if (!ui || composing()) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === "n") openCompose();
    else if (k === "ArrowDown" || k === "j") requestScroll(80);
    else if (k === "ArrowUp" || k === "k") requestScroll(-80);
    else if (k === "PageDown" || k === " ") requestScroll(innerHeight * 0.8);
    else if (k === "PageUp") requestScroll(-innerHeight * 0.8);
    else if (k === "End") requestScroll(innerHeight * 4);
    else if (k === "Home") ui.list.scrollTop = 0;
    // Swallow everything so X's global shortcuts (/, etc.) can't fire underneath.
    e.stopImmediatePropagation();
    if (k === " " || k === "PageDown" || k === "PageUp") e.preventDefault();
  }

  function swallowKey(e) {
    if (ui && !composing()) e.stopImmediatePropagation();
  }

  function listAtBottom() {
    if (!ui) return false;
    const list = ui.list;
    return list.scrollTop + list.clientHeight >= list.scrollHeight - 2;
  }

  function requestScroll(dy) {
    if (!ui) return;
    const list = ui.list;
    if (dy < 0) {
      list.scrollTop += dy;
      return;
    }
    if (!listAtBottom()) {
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
    renderRule();
    renderNotice();
    renderClusters();
    renderSides();
  }

  function renderStats() {
    if (!ui) return;
    const posts = clusters.reduce((a, c) => a + c.count, 0);
    const parts = [`${posts} posts`, `${clusters.length} clusters`, `${slop.length} slop`];
    if (inFlight > 0) parts.push(`${inFlight} sorting…`);
    const sk = [];
    if (skipped.ads) sk.push(`${skipped.ads} ads`);
    if (skipped.noText) sk.push(`${skipped.noText} media-only`);
    if (skipped.failed) sk.push(`${skipped.failed} failed`);
    if (sk.length) parts.push("skipped " + sk.join(", "));
    ui.stats.textContent = parts.join(" · ");
    ui.leftToggle.textContent = `Kept · ${kept.length}`;
    ui.leftToggle.classList.toggle("ce-on", !!ui.leftOpen);
    ui.rightToggle.textContent = `Slop · ${slop.length}`;
    ui.rightToggle.classList.toggle("ce-on", !!ui.rightOpen);
  }

  function renderRule() {
    if (!ui) return;
    const n = (rule.nSlop || 0) + (rule.nOk || 0);
    let head = rule.seed ? "Slop rule — seed (tag posts and it gets rewritten from your tags)" : `Slop rule — derived from your ${n} tag${n === 1 ? "" : "s"}`;
    if (rule.updating) head += " · updating…";
    if (rule.error) head += " · last update failed: " + rule.error;
    ui.ruleHead.textContent = head;
    ui.ruleText.textContent = rule.rule || "";
    ui.ruleBox.classList.toggle("ce-rule-updating", !!rule.updating);
  }

  function renderNotice() {
    const n = ui.notice;
    n.innerHTML = "";
    if (!config.apiKey) {
      n.append(el("span", null, "Add your Anthropic API key to start. "));
      const b = el("button", "ce-link", "Open options");
      b.addEventListener("click", () => sendMessageAsync({ type: "OPEN_OPTIONS" }));
      n.append(b);
      n.style.display = "";
    } else if (clusters.length === 0 && slop.length === 0 && inFlight === 0) {
      n.textContent = "Waiting for posts… scroll to pull from your timeline.";
      n.style.display = "";
    } else {
      n.style.display = "none";
    }
  }

  // Clusters with 2+ posts are cards. One-post clusters are the long tail of
  // any feed (most of it, early on); they sit in a compact list underneath and
  // get promoted to a card the moment a second post lands.
  function renderClusters() {
    const list = ui.list;
    const cards = ui.cards;
    const sorted = clusters.slice().sort((a, b) => b.count - a.count || a.createdAt - b.createdAt);
    const main = sorted.filter((c) => c.count >= 2 || ui.pinned.has(c.id));
    const tail = sorted.filter((c) => c.count < 2 && !ui.pinned.has(c.id));

    // FLIP: remember where each card was so reorders animate.
    const before = new Map();
    for (const [id, card] of cards) before.set(id, card.getBoundingClientRect().top);

    const live = new Set();
    for (const c of main) {
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

    // Tail section always last.
    ui.tailHead.textContent = tail.length
      ? `${tail.length} one-off${tail.length === 1 ? "" : "s"} — topics with a single post so far`
      : "";
    ui.tailList.innerHTML = "";
    for (const c of tail) {
      const item = el("button", "ce-tail-item", c.title);
      item.title = c.summary || "";
      // Clicking a one-off promotes it to an expanded card so its post can be read.
      item.addEventListener("click", () => {
        ui.pinned.add(c.id);
        ui.expanded.add(c.id);
        render();
        const card = ui.cards.get(c.id);
        if (card) card.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
      ui.tailList.append(item);
    }
    if (tail.length) list.appendChild(ui.tail);
    else ui.tail.remove();

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
    const posts = el("div", "ce-posts");
    body.append(title, summary, posts);
    card.append(count, body);
    card.addEventListener("click", (e) => {
      if (e.target.closest("a, button, .ce-posts")) return; // links and the post list handle themselves
      toggleExpanded(c.id);
    });
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
    renderPosts(card, c);
  }

  // -------------------------------------------------------------------------
  // Drill-down: an expanded card lists the posts inside the cluster, fetched
  // from the worker's memo (so it works after X unmounted them or after a
  // reload). Refetched whenever the cluster's count changes while open.

  function toggleExpanded(id) {
    if (ui.expanded.has(id)) {
      ui.expanded.delete(id);
      if (ui.pinned.has(id)) ui.pinned.delete(id); // a promoted one-off goes back to the chip list
    } else {
      ui.expanded.add(id);
    }
    render();
  }

  async function loadPosts(id, count) {
    const cached = ui.postsCache.get(id);
    if (cached && cached.count === count) return cached.posts;
    const resp = await sendMessageAsync({ type: "GET_CLUSTER_POSTS", cluster: id });
    const posts = (resp && resp.posts) || [];
    ui.postsCache.set(id, { count, posts });
    return posts;
  }

  async function renderPosts(card, c) {
    const box = card.querySelector(".ce-posts");
    if (!ui.expanded.has(c.id)) {
      box.innerHTML = "";
      delete box.dataset.count;
      card.classList.remove("ce-expanded");
      return;
    }
    card.classList.add("ce-expanded");
    if (box.dataset.count === String(c.count) && box.children.length) return;
    box.dataset.count = String(c.count);
    if (!box.children.length) box.append(el("div", "ce-post-loading", "Loading posts…"));
    const posts = await loadPosts(c.id, c.count);
    if (!ui || !ui.expanded.has(c.id)) return;
    box.innerHTML = "";
    if (posts.length === 0) {
      box.append(el("div", "ce-post-loading", "No stored posts for this cluster (they were clustered before this session started)."));
      return;
    }
    for (const p of posts) box.append(buildPostRow(p, "slop"));
  }

  // A post row: author, text, open-on-X, and the tag button ("slop" or "ok").
  function buildPostRow(p, action) {
    const row = el("article", "ce-post");
    row.dataset.id = p.id;
    const head = el("div", "ce-post-head");
    const who = el("a", "ce-post-author", p.author ? "@" + p.author : "post");
    who.href = p.author ? `https://x.com/${p.author}` : `https://x.com/i/web/status/${p.id}`;
    who.target = "_blank";
    who.rel = "noopener";
    const open = el("a", "ce-post-open", "open ↗");
    open.href = p.author ? `https://x.com/${p.author}/status/${p.id}` : `https://x.com/i/web/status/${p.id}`;
    open.target = "_blank";
    open.rel = "noopener";
    const tag = el("button", "ce-tag ce-tag-" + action, action === "slop" ? "slop" : "not slop");
    tag.title = action === "slop" ? "Tag as slop: sweeps it into the slop sidebar and teaches the rule" : "Tag as not slop: rescues it and teaches the rule";
    tag.addEventListener("click", async (e) => {
      e.stopPropagation();
      tag.disabled = true;
      row.classList.add("ce-post-leaving");
      await labelPost(p, action === "slop" ? "slop" : "ok");
    });
    if (p.source === "user") row.dataset.user = "1";
    head.append(who, open, tag);
    const text = el("div", "ce-post-text", p.text);
    row.append(head, text);
    return row;
  }

  function renderSides() {
    const L = ui.left, R = ui.right;
    L.classList.toggle("ce-collapsed", !ui.leftOpen);
    R.classList.toggle("ce-collapsed", !ui.rightOpen);
    ui.leftHead.textContent = ui.leftOpen ? `Kept · ${kept.length} — posts you tagged not slop` : `Kept · ${kept.length}`;
    ui.rightHead.textContent = ui.rightOpen ? `Slop · ${slop.length} — swept aside; tag anything worth keeping` : `Slop · ${slop.length}`;
    ui.leftHead.onclick = () => { ui.leftOpen = !ui.leftOpen; render(); };
    ui.rightHead.onclick = () => { ui.rightOpen = !ui.rightOpen; render(); };

    fillSide(ui.leftList, ui.leftOpen ? kept : [], "slop", "Nothing kept yet. Open a cluster and tag posts, or rescue something from the slop sidebar.");
    fillSide(ui.rightList, ui.rightOpen ? slop : [], "ok", "No slop yet.");
  }

  function fillSide(listEl, posts, action, emptyText) {
    // Rebuild only when the id sequence changed (keeps scroll position otherwise).
    const key = posts.map((p) => p.id).join(",");
    if (listEl.dataset.key === key && listEl.children.length) return;
    listEl.dataset.key = key;
    listEl.innerHTML = "";
    if (posts.length === 0) {
      if (listEl.parentElement && !listEl.parentElement.classList.contains("ce-collapsed")) listEl.append(el("div", "ce-post-loading", emptyText));
      return;
    }
    for (const p of posts) listEl.append(buildPostRow(p, action));
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
