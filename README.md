# Hermes Relay

Hermes Relay is a standalone Chrome extension for [Hermes Agent](https://hermes-agent.nousresearch.com/). It gives Hermes a browser-native control layer for capture, memory, watchlists, and context handoff without tying the experience to a single project repo.

## What It Does

- ask Hermes about the page you are on
- summarize, extract tasks, draft replies, and build next-step plans
- save durable facts, preferences, and workflows into Hermes memory
- build compact context bundles for Claude, ChatGPT, and Gemini
- inject those bundles into supported chat inputs
- track important pages over time with notes, pins, and snapshots
- compare the current page against the last saved snapshot

## Current Feature Set

### Popup

- simple local Hermes connection flow
- quick page actions
- recent runs
- watchlist preview for tracked pages

### Workspace Side Panel

- current-page context view
- page notes
- page snapshots and snapshot comparison
- workflow runner
- memory actions
- tracked-page watchlist with search and pinning

### Browser Integration

- context menus for selection and page actions
- keyboard shortcuts for capture and context workflows
- chat insertion on:
  - `claude.ai`
  - `chatgpt.com`
  - `chat.openai.com`
  - `gemini.google.com`

## Hermes Setup

Hermes Relay expects the official Hermes API server to be running locally.

Add these to `~/.hermes/.env`:

```bash
API_SERVER_ENABLED=true
API_SERVER_KEY=change-me-local-dev
```

Then start Hermes:

```bash
hermes gateway
```

Default local API:

```text
http://127.0.0.1:8642
```

Official references:

- [Hermes Agent docs](https://hermes-agent.nousresearch.com/docs/)
- [API Server docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/)
- [Memory docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/)

## Load The Extension

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click **Load unpacked**
4. Select `hermes-relay/extension`

## Validate The Project

From `hermes-relay/`:

```bash
npm run check
```

That validates:

- `extension/manifest.json`
- `extension/background.js`
- `extension/content/chat.js`
- `extension/popup/popup.js`
- `extension/sidepanel/sidepanel.js`

## Package For Chrome

Build an uploadable Chrome zip from `hermes-relay/`:

```bash
npm run package:chrome
```

That will:

- generate release icons in `extension/icons/`
- create `dist/hermes-relay-chrome.zip`

## Keyboard Shortcuts

- `Alt+Shift+H`: capture current page
- `Alt+Shift+C`: build Hermes context
- `Alt+Shift+I`: inject latest Hermes context

## Project Layout

```text
hermes-relay/
  .gitignore
  CONTRIBUTING.md
  LICENSE
  README.md
  package.json
  extension/
    manifest.json
    background.js
    content/
      chat.js
    popup/
      popup.html
      popup.css
      popup.js
    sidepanel/
      sidepanel.html
      sidepanel.css
      sidepanel.js
```

## Near-Term Roadmap

- smarter provider-specific injection behavior
- better Hermes memory receipts and recall flows
- richer watchlist review actions
- packaging, icons, and store-readiness
