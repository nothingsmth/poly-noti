# Poly Noti

Desktop notifications for [Polymarket](https://polymarket.com) trader activity. Watch any wallet by address — no wallet connection required.

A Chrome/Edge (Manifest V3) browser extension that polls Polymarket's public APIs and raises a desktop notification when a watched trader's positions change.

## Features

- Watch any Polymarket trader by wallet address
- Track multiple wallets at once
- Desktop notifications on trader activity
- No login or wallet connection required (read-only, public data)

## Install (unpacked, for development)

1. Clone this repo.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the project folder.
5. Click the Poly Noti toolbar icon and add a wallet address to watch.

## How it works

The extension has no backend. A background service worker (`src/background.js`)
periodically polls Polymarket's public REST APIs:

- `https://data-api.polymarket.com` — trader positions / activity
- `https://gamma-api.polymarket.com` — market metadata

Watched wallets and settings are stored locally via `chrome.storage`. Polling is
scheduled with `chrome.alarms`, and alerts are delivered through
`chrome.notifications`.

## Project structure

```
manifest.json        Extension manifest (MV3)
icons/               Toolbar / notification icons
src/
  background.js      Service worker: polling, diffing, notifications
  popup/             Toolbar popup UI (add/remove wallets, settings)
  lib/               API client, storage, formatting, market helpers
```

## Permissions

`storage`, `alarms`, `notifications`, plus host access to
`data-api.polymarket.com` and `gamma-api.polymarket.com`.

## Status

Early development (v0.6.7). Notifications are based on public on-chain / API
data, so partial limit-order fills (e.g. 10 of 100) may not be individually
distinguishable.

## Disclaimer

Unofficial project, not affiliated with or endorsed by Polymarket. Uses public
API endpoints only. Nothing here is financial advice.

## License

[MIT](LICENSE)
