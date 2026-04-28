# GitHub Release Checklist

This checklist prepares Hermes Relay for a public GitHub launch. It is not a Chrome Web Store submission checklist.

## Release Target

- Version: `v0.1.0` unless that tag already exists; otherwise use `v0.1.1`.
- Audience: Hermes Agent maintainers, early Hermes users, and contributors.
- Artifact: packaged Chrome extension zip at `dist/hermes-relay-chrome.zip`.

## Preflight

1. Confirm the branch is the intended release branch.
2. Review `README.md`, `PRIVACY.md`, `SECURITY.md`, `SUPPORT.md`, and `CHANGELOG.md`.
3. Confirm no local secrets are tracked:

```bash
git status --short
git diff --check
```

4. Run the full project check:

```bash
npm run check
```

Expected result: manifest parse, JavaScript syntax check, unit tests, and fixture e2e all pass.

## Package

Build the zip:

```bash
npm run package:chrome
```

Expected output:

```text
dist/hermes-relay-chrome.zip
```

The package should include extension source files, generated PNG icons, manifest, popup, side panel, content script, and background modules. It should exclude:

- `extension/local-dev-config.json`
- `.DS_Store`
- local secrets
- development-only duplicate extension folders

Inspect the zip:

```bash
unzip -l dist/hermes-relay-chrome.zip | sed -n '1,120p'
```

## Manual Smoke Test

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Load unpacked from `extension/`.
4. Confirm the popup opens.
5. Confirm the side panel opens.
6. Confirm setup state renders with local Hermes server status.
7. Open a normal `https` page and confirm page context can be read.
8. Run **Build Context**.
9. Open a supported or allowed chat-like page and confirm **Insert Latest** inserts the saved bundle.
10. Reload the extension and confirm notes, tracked pages, snapshots, and recent output persist.

## Known Limitations To Include In Release Notes

- Requires a local Hermes Agent API server.
- Chat insertion can break when assistant sites change their input DOM.
- Live-session and approval APIs are early integration surfaces.
- Redaction is best-effort and should not be treated as a full data-loss-prevention system.
- Chrome internal pages cannot be inspected.

## GitHub Release Draft

Title:

```text
Hermes Relay for Chrome v0.1.0
```

Body:

```markdown
Hermes Relay for Chrome is a local-first browser companion for Hermes Agent. It gives Hermes browser page context, revisit continuity, and AI handoff through a Chrome MV3 extension.

Highlights:
- page-aware Hermes workflows from the popup and side panel
- notes, snapshots, tracked pages, direct page threads, and recent output
- context bundles for Claude, ChatGPT, Gemini, and user-approved custom AI hosts
- local Hermes API setup helper
- redaction for common sensitive values before browser context is sent to Hermes
- packaged extension zip for source-based installation

Install:
1. Download `hermes-relay-chrome.zip`.
2. Unzip it locally.
3. Open `chrome://extensions`.
4. Enable Developer mode.
5. Load the unzipped extension folder.

Before using it, enable the local Hermes Agent API server and run `npm run setup:local` from the repository if installing from source.

Known limitations:
- Requires a local Hermes Agent API server.
- Chat input insertion depends on destination site DOMs.
- Live-session browser tooling is early and may evolve with Hermes Agent.
- Redaction is best-effort.
```

## Final Verification

- `npm run check` passes.
- `npm run package:chrome` completes.
- Zip inspection confirms no local config or secrets.
- README install path works for a fresh reader.
- GitHub issue and PR templates are present.
