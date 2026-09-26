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

## Slop vs. not slop: one rule, learned from your tags

There are no category buckets. Every incoming post gets one binary call: **slop or not**. Slop is never clustered; it is swept into a collapsed sidebar on the right. Non-slop posts go into topic clusters in the middle.

What decides slop is a single natural-language **rule**, shown in the band under the header. Before you've tagged anything it's a seed rule (platitudes, rage bait, drama, engagement farming). Every post you can see has a tag button: **slop** on posts inside clusters, **not slop** on posts in the slop sidebar. Tagging a post moves it immediately (a clustered post drops out of its cluster into the slop sidebar; a rescued post is clustered and also listed in the **Kept** sidebar on the left), and then a model reads *all* your tagged posts and rewrites the rule you seem to be applying. The classifier only ever sees the rule, never the examples — so the rule is the thing to read, argue with, and watch evolve. Tags and the rule persist across sessions; clusters are per session.

Rule rewrites run on the same model as clustering by default (`claude-opus-5` is a good upgrade for this one call, set separately in options). They're coalesced while one is in flight, so rapid tagging costs one call, not ten.

## Clustering model and tuning

Every cluster is a **beat**: a subject that keeps coming up, named the way a newsroom names a beat ("AI coding agents and developer workflows", "Nor'easter flooding", "Landlords, HOAs, and housing rules"). Formats and tones ("viral clips", "hot takes", "personal anecdotes") are explicitly forbidden as clusters. Each batch call can assign posts, rename beats to honestly cover a new angle, merge same-subject beats, or create new ones; every third batch a merge-only **consolidation pass** looks at the whole beat list and folds duplicates created in different batches.

A real "For you" feed has a handful of shared conversations and a long tail of one-offs, so the overlay shows beats with 2+ posts as cards and one-post beats as a compact chip list underneath; a chip becomes a card the moment its second post lands.

**Posting:** the **Post** button in the header (or the `n` key) opens X's own composer. It's X's normal compose modal, an SPA route (`/compose/post`), so drafts, media, polls, and scheduling all work as usual; while it's open the overlay steps aside and the timeline underneath is blurred, and keys and wheel pass through to the composer. Closing it brings the cluster view back.

**Interaction:** click a card to expand it and read the posts inside (author, text, category, and an "open on X" link that opens the post in a new tab); click again to collapse. Clicking a one-off chip promotes it to an expanded card. Posts are served from the worker's session memo, so a cluster can be opened long after X unmounted the tweets. When you scroll to the bottom to pull more posts, the list returns to the top once the last batch has landed.

The default model is `claude-sonnet-5`. Tuned side-by-side on a saved corpus, Haiku 4.5 misfiled posts (it writes category ids into the cluster field, cites clusters by slug) and its consolidation invented umbrellas like "Disputes, agreements, and stakeholder conflicts". Cost on Sonnet is roughly $1.3 per 1,000 posts including consolidation.

The prompt/schema/state logic is in `cluster-core.js` (shared by the worker and the offline harness), and the clustering guidance is overridable from the options page. To iterate without the extension:

```
echo 'ANTHROPIC_API_KEY=sk-ant-...' > ~/.clear-eyes.env   # read only by the harness
node tools/harness.mjs --model claude-sonnet-5 --consolidate 3 --seed 1        # built-in prompt
node tools/harness.mjs --guidance tools/prompts/v3-beats.txt --seed 2 --quiet  # a prompt variant
node tools/summarize.mjs                                                        # metrics across saved runs
```

The harness replays `tools/corpus/*.json` through the exact worker path (serialized batches of 20, each seeing the previous batch's clusters), prints every cluster with its members, and saves runs to `~/.clear-eyes-runs/`. Harvest a fresh corpus by collecting `article[data-testid="tweet"]` text/ids from a scrolled timeline.

## Install

1. `git clone` this repo (or download it).
2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
3. Click the extension icon → **Options** → paste your Anthropic API key ([console.anthropic.com](https://console.anthropic.com)) → **Test key** → **Save**.
4. Open [x.com/home](https://x.com/home) and scroll.

Tip: create a dedicated API key with a monthly spend limit for this.

## Configuration

Everything is in the options page:

- **Model** — `claude-sonnet-5` by default for the slop + clustering call. A separate model can be set for rule rewrites.
- **Slop rule** — read-only view of the current rule, with buttons to force a rewrite or forget all tags.
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
