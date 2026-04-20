# Contributing

Thanks for helping with Hermes Relay.

## Development Flow

1. Load the extension from [extension](</Users/mespoy/Desktop/Thegolemv4 fully working  /hermes-relay/extension>).
2. Make changes in the unpacked extension files.
3. Reload Hermes Relay in `chrome://extensions`.
4. Run:

```bash
npm run check
```

## Project Shape

- `extension/background.js`: Hermes API calls, storage, context menus, watchlist state
- `extension/popup/`: fast actions and connection UI
- `extension/sidepanel/`: persistent workspace for page-aware flows
- `extension/content/chat.js`: context injection into supported chat UIs

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
