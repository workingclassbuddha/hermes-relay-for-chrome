# Support

Use this checklist when Hermes Relay does not behave as expected.

## Install From Source

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `extension/` folder from this repository.
5. Reload the extension after local file changes.

## Local Hermes Setup

Hermes Relay expects a local Hermes Agent API server.

Add this to `~/.hermes/.env`:

```bash
API_SERVER_ENABLED=true
API_SERVER_KEY=change-me-local-dev
```

Start Hermes:

```bash
hermes gateway
```

Then run:

```bash
npm run setup:local
```

Reload the unpacked extension in Chrome.

## Common Checks

- Confirm Hermes responds at `http://127.0.0.1:8642/health`.
- Confirm the API key in the popup matches `~/.hermes/.env`.
- Use a normal `http` or `https` page; Chrome internal pages cannot be inspected.
- If handoff insertion fails, reload the destination chat tab and try again.
- If a custom AI site is not supported, use **Allow This AI Site** from the popup first.
- If a watcher does not run, confirm the page is tracked, watched, and currently open in Chrome.

## Filing Issues

Open a GitHub issue with:

- Chrome version
- Hermes Agent version or commit, if known
- Hermes Relay branch or release version
- whether the extension was loaded unpacked or from a zip
- the action you clicked
- expected behavior
- actual behavior
- relevant console errors with secrets removed
