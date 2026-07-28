# Clear Eyes — Privacy Policy

*Last updated: July 27, 2026*

Clear Eyes is a browser extension that filters low-quality posts out of your X.com timeline using Anthropic's Claude API, authenticated with your own API key.

## What data the extension handles

**Post text ("website content").** The text and author handle of posts appearing in your X.com Home timeline are sent to Anthropic's API (`api.anthropic.com`) for classification. This happens only while the extension is enabled and you are viewing x.com or twitter.com. Anthropic's handling of that data is governed by [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy) and the API terms of your own Anthropic account.

**Your Anthropic API key ("authentication information").** You provide your own API key. It is stored in the extension's local storage on your machine and transmitted only to `api.anthropic.com` as part of API requests. It is never sent anywhere else.

**Settings and cache.** Your preferences (model choice, filter categories, toggles) and a short-lived cache of classification verdicts (post ID → category) are stored locally in extension storage. The verdict cache is cleared when your browser closes.

## What the developer collects

**Nothing.** There is no developer server. The extension makes network requests to exactly one host — `api.anthropic.com` — using your key, on your behalf. No analytics, no telemetry, no accounts, no tracking.

## What is never collected

- No personally identifiable information
- No browsing history or activity logging
- No direct messages (only public timeline posts are read)
- No data is sold or transferred to third parties, used for purposes unrelated to filtering your feed, or used for creditworthiness or lending purposes

## Data retention and deletion

All stored data lives in your browser's extension storage. Removing the extension (or clearing its storage) deletes everything. To revoke API access at any time, delete the key in your [Anthropic console](https://console.anthropic.com).

## Changes

Changes to this policy will be committed to this repository with the extension's source code, which is fully open at [github.com/mitchellgordon95/clear-eyes](https://github.com/mitchellgordon95/clear-eyes).

## Contact

Open an issue on the GitHub repository.
