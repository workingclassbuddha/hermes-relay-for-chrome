# Changelog

All notable changes to Hermes Relay for Chrome are documented here.

## v0.1.0 - Initial Public Launch

- Added a Chrome MV3 extension for local Hermes Agent browser context.
- Added popup quick actions for setup, page workflows, handoff, and insertion.
- Added side panel workspace for page continuity, notes, snapshots, direct page-aware conversation, tracked pages, and recent output.
- Added context extraction for page metadata, selection, readable text, headings, links, forms, tables, and focused-element metadata.
- Added redaction for common credential-like and sensitive values before page context is sent to Hermes.
- Added local Hermes API health checks, authenticated preflight, response calls, and live-session integration.
- Added context insertion support for Claude, ChatGPT, Gemini, and user-approved custom AI hosts.
- Added packaging script for `dist/hermes-relay-chrome.zip`.
- Added unit and fixture e2e checks through `npm run check`.

## Known Limitations

- Hermes Relay requires a local Hermes Agent API server.
- Chat input insertion depends on provider page structure and may need updates when providers change their DOM.
- Live-session and approval flows are early integration surfaces and may evolve with Hermes Agent.
- Page redaction reduces risk but cannot guarantee that every sensitive value is removed.
