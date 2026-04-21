# Contributing

Thanks for helping with Hermes Relay.

## Development Flow

1. Load the extension from `extension/`.
2. Make changes in the unpacked extension files.
3. Reload Hermes Relay in `chrome://extensions`.
4. Run:

```bash
npm run check
npm run setup:local
```

## Project Shape

- `extension/background.js`: message routing, bootstrap, and Chrome event wiring
- `extension/lib/background/`: Hermes client, storage, page context, workflows, handoff helpers
- `extension/lib/shared/`: shared constants and URL/util helpers
- `extension/popup/`: fast actions and connection UI
- `extension/sidepanel/`: persistent workspace for page-aware flows
- `extension/content/chat.js`: context injection into supported chat UIs
- `test/`: Node smoke tests for storage, handoff, Hermes client, and workflow helpers

## Guardrails

- Keep the extension local-first.
- Prefer the official Hermes API surface over repo-specific internals.
- Keep host permissions narrow.
- Treat browser actions as user-directed; avoid silent automation.
- Keep UI copy concise and operational.

## Good First Contributions

- Smarter provider-specific chat insertion
- Better empty and error states
- Watchlist review workflows
- Packaging and store-readiness work
