# Security

Hermes Relay is a local-first Chrome extension that connects browser context to a local Hermes Agent API server.

## Reporting Issues

Please report security issues privately to the repository owner before opening a public issue. If no private channel is available, open a GitHub issue with minimal detail and ask for a private follow-up path.

Do not include secrets, API keys, private page content, or reproduced sensitive data in public reports.

## Security Model

- Hermes Relay assumes the local Hermes API server is trusted by the user.
- The default server is `http://127.0.0.1:8642`.
- Authenticated requests use the local API key configured by the user.
- Browser context is sent only through user-directed actions or explicit page watchers.
- Browser actions requested by live Hermes sessions require extension-side approval before execution.

## Permission Rationale

- `storage`: saves local configuration, notes, snapshots, tracked pages, recent actions, live events, and workspace state.
- `activeTab` and `scripting`: inspect the active page when the user runs an action.
- `tabs`: find the active tab and route handoff insertion to supported chat tabs.
- `contextMenus`: expose user-directed page and selection actions.
- `sidePanel`: provide the main Hermes Relay workspace.
- `alarms`: support explicit watched-page checks.
- local host permissions: connect to the local Hermes Agent API server.
- supported assistant host permissions: insert saved context into Claude, ChatGPT, and Gemini.
- optional host permissions: allow user-approved custom AI hosts.

## Review Notes

The extension does not load remote JavaScript. Extension logic is packaged in the submitted source. Hermes API responses are treated as data and displayed or inserted through extension-controlled flows.
