# Clear Eyes

A Chrome extension that runs every tweet on your X.com Home timeline through Claude **before you see it**. Tweets classified as slop, rage bait, or drama collapse into a one-line placeholder (with a "show anyway" button). Everything with actual intellectual or personal value passes through untouched.

Bring your own Anthropic API key. No server, no build step, no middleman.

## How it works

1. A content script watches the timeline DOM. The instant a tweet enters the page it gets **veiled** (blurred) so nothing dopamine-shaped flashes at you.
2. Tweets are batched (up to 20 per ~400ms) and sent to the background service worker, which makes **one** Claude API call per batch using [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) — the model must return a valid JSON verdict for every tweet, one category each.
3. Keep-verdicts unveil the tweet; hide-verdicts collapse it to a labeled placeholder.
4. Verdicts are cached by tweet ID (in-memory + `storage.session`), so scrolling back up or re-encountering a tweet costs zero API calls.
5. **Fail open, always.** No API key, API error, rate limit, model refusal, X.com markup change — in every failure case tweets simply appear unfiltered. The extension can never eat your feed.

## Install

1. `git clone` this repo (or download it).
2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
3. Click the extension icon → **Options** → paste your Anthropic API key ([console.anthropic.com](https://console.anthropic.com)) → **Test key** → **Save**.
4. Open [x.com/home](https://x.com/home) and scroll.

Tip: create a dedicated API key with a monthly spend limit for this.

## Configuration

Everything is in the options page:

- **Model** — defaults to `claude-haiku-4-5` (fastest/cheapest, plenty for this). Swap in `claude-sonnet-5` if you want sharper judgment.
- **Categories** — fully editable. Each category is `{id, label, description, keep|hide}` and the descriptions *are* the prompt. Defaults:
  - keep: intellectual value, personal growth, news/announcements, benign/personal
  - hide: slop/engagement bait, rage bait, drama
- **Home only** (default on) — filter just `/home`; profiles, search, and threads stay untouched.
- **Media-only tweets** (default: pass through) — tweets with no text aren't classified.
- **Category pills** (default on) — every classified tweet gets a small pill in its header row showing the verdict ("Intellectual value", "no text", "not classified", …), so you can audit the classifier at a glance. Turn it off once you trust it.
- **Hide ads** (default on) — promoted tweets are detected straight from the DOM ("Ad"/"Promoted" marker, English UI) and collapsed instantly, no API call spent.

The classifier is instructed: *when uncertain between keep and hide, keep* — hiding good content is worse than letting mediocre content through.

## Cost

With `claude-haiku-4-5` ($1 / $5 per MTok): a batch of 20 tweets is roughly 1.5–2.5K input tokens and ~300 output tokens, so about **$0.3–0.5 per 1,000 tweets classified**. A heavy month of scrolling is on the order of a dollar or two.

## "What if X changes their markup?"

Instead of an hourly cloud job (which can't see your logged-in feed anyway), the extension self-monitors: if the Home timeline clearly rendered content but the tweet selector matched nothing for ~12 seconds, the toolbar badge shows **!** and the popup explains that selectors are stale. Filtering fails open in the meantime — you just see the normal unfiltered feed, never a broken one. Selectors live at the top of `content.js` (`article[data-testid="tweet"]`, `[data-testid="tweetText"]`, etc.).

## Prior art

Checked before building (July 2026): [Promptable Twitter Feed](https://github.com/jam3scampbell/Promptable-Twitter-Feed) (closest, but dormant and built on an old BlueRaven fork), [AI Twitter Filter](https://ai-twitter-filter.vercel.app/) (maintained, but Claude only via OpenRouter and filters after render), plus various "AI-slop detectors" that only flag AI-generated text rather than judging value. None combined direct-Anthropic-key + configurable category taxonomy + pre-render gating, hence this.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest |
| `content.js` / `content.css` | DOM observation, veiling, verdict application, selector health check |
| `background.js` | Anthropic API calls, batching endpoint, verdict cache, badge, stats |
| `shared.js` | Default config + storage helpers |
| `options.html/js` | API key, model, category editor |
| `popup.html/js` | On/off toggle, stats, health warning |
