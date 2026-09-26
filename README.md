# Clear Eyes

A Chrome extension that **replaces your X.com Home timeline with a cluster view**. Every tweet X loads is sent to Claude, which groups it into a topic cluster and classifies its quality. You see cluster titles, one-line summaries, and counts — never a raw tweet. Scrolling pulls more posts from your timeline, and the counts grow.

Bring your own Anthropic API key. No server, no build step, no middleman.

## How it works

1. On `x.com/home` a content script covers the page with an opaque overlay. X's own app keeps running underneath — it is still the thing that fetches tweets — but nothing it renders is visible.
2. Every tweet X mounts into the DOM is ingested (id, author, text). Ads and media-only posts are skipped locally.
3. Tweets are batched (up to 20 per ~400ms) and sent to the background service worker, which makes **one** Claude call per batch using [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs). The model sees the existing clusters and must, for every post, pick an existing cluster or propose a new one (title + summary), plus assign one quality category.
4. Batches are processed strictly one at a time so each call sees the clusters the previous one created; otherwise two in-flight batches would both invent the same cluster.
5. The overlay renders the clusters sorted by size. Counts bump and cards reorder as new posts land. Clusters that are mostly "hide" categories (slop, rage bait, drama) are dimmed and tagged as noise.
6. **Scrolling the overlay scrolls X underneath.** Wheel and keyboard input is forwarded to the hidden page in sub-viewport steps so X's virtualized list mounts every cell (nothing gets skipped) and its infinite scroll keeps fetching. When X is busy loading, the pump waits.
7. Cluster state lives in `storage.session` (cleared when the browser closes) and each tweet is memoized by id, so re-encountering a tweet never double-counts or costs an API call. "Reset clusters" starts a fresh session.

## Install

1. `git clone` this repo (or download it).
2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
3. Click the extension icon → **Options** → paste your Anthropic API key ([console.anthropic.com](https://console.anthropic.com)) → **Test key** → **Save**.
4. Open [x.com/home](https://x.com/home) and scroll.

Tip: create a dedicated API key with a monthly spend limit for this.

## Configuration

Everything is in the options page:

- **Model** — defaults to `claude-haiku-4-5` (fastest/cheapest). `claude-sonnet-5` clusters more coherently at ~2–3x the cost.
- **Categories** — the per-post quality taxonomy, fully editable. Each is `{id, label, description, keep|hide}` and the descriptions *are* the prompt. Cluster cards show the breakdown per category. Defaults:
  - keep: intellectual value, personal growth, news/announcements
  - hide: slop/engagement bait, rage bait, drama
- **Enabled** — off means X looks normal again. Same toggle in the popup.
- **Home only** (default on) — take over just `/home`; profiles, search, and threads show X as-is.
- **Skip ads** (default on) — promoted tweets are detected straight from the DOM ("Ad"/"Promoted" marker, English UI) and never sent to the API.

## Cost

With `claude-haiku-4-5` ($1 / $5 per MTok): a batch of 20 tweets plus the cluster list is roughly 3–5K input tokens and ~600 output tokens, so about **$0.4–0.6 per 1,000 tweets**. A heavy month of scrolling is on the order of a couple of dollars.

## "What if X changes their markup?" — self-repair

The extension self-monitors: if the Home timeline clearly rendered content but the tweet selector matched nothing for ~12 seconds, the toolbar badge shows **!** and a banner appears on top of the overlay offering an **automatic repair**. If you accept, the extension:

1. Serializes a pruned sample of the timeline DOM (svg innards, styles, generated class names, image payloads, and long text stripped).
2. Sends it to the latest Claude Opus (`claude-opus-5`, your key) asking for replacement CSS selectors, with the old selectors and requirements spelled out.
3. **Verifies the candidates against the live DOM** — tweet selector must match ≥3 posts, status-ID extraction must work on ≥80% of a sample, text extraction on ≥50% — and feeds failures back to Opus for up to 3 attempts.
4. Only saves selectors that pass verification; they persist in extension storage and take effect immediately.

Nothing is sent anywhere without you clicking the button. Default selectors live in `shared.js`.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest |
| `content.js` / `content.css` | Overlay UI, DOM ingestion, scroll pump, selector health check + self-repair |
| `background.js` | Anthropic API calls, serialized cluster assignment, cluster state, badge, stats |
| `shared.js` | Default config + storage helpers |
| `options.html/js` | API key, model, category editor |
| `popup.html/js` | On/off toggle, stats, reset clusters, health warning |
