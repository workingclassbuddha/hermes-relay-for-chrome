# Privacy

Hermes Relay for Chrome is designed as a local-first browser companion for Hermes Agent.

## Data Flow

- Hermes Relay runs as a Chrome extension.
- Page context is collected only when you use an extension action, run a workflow, create a snapshot, or enable a page watcher.
- Hermes Relay sends browser context to the local Hermes Agent API server configured in the extension.
- The default local API URL is `http://127.0.0.1:8642`.
- This project does not include a hosted backend service.

## Browser Context

Depending on the action, Hermes Relay may collect:

- page title and URL
- hostname and page metadata
- selected text
- visible headings and readable page text
- limited link, form, table, and focused-element metadata
- page notes, snapshots, tracked-page state, recent actions, and handoff context stored in Chrome local storage

Hermes Relay does not silently inspect every page in the background. Watchers only run for pages you explicitly track and watch.

## Redaction

Hermes Relay redacts common sensitive values before sending page context to Hermes. This includes credential-like tokens, API keys, card-like numbers, SSN-like values, and editable focused-field contents.

Redaction is a safety layer, not a guarantee. Review the page and output before saving, sharing, or inserting context into another assistant.

## API Keys

The local Hermes API key is stored in Chrome local extension storage. The `npm run setup:local` helper can write an ignored local development config at `extension/local-dev-config.json`; that file is excluded from the packaged extension zip.

Do not commit local API keys, `.env` files, or generated local config.

## Third-Party Sites

Hermes Relay can insert a saved context bundle into supported chat inputs on:

- Claude
- ChatGPT
- Gemini
- custom AI hosts you explicitly allow

Inserted text becomes part of the destination site's normal input flow. Review the inserted context before submitting it.

## No Sale of Data

This project does not sell browser data, user data, or page context. Any data handling by Hermes Agent or third-party assistant sites is governed by those tools and services.
