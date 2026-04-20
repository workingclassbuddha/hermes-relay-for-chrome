# Hermes Relay Phase 1: Sidepanel-First UX Implementation Plan

> For Hermes: implement this in small verified steps. Prioritize speed, low friction, right-click usefulness, and revisit continuity.

Goal: Shift Hermes Relay from popup-heavy utility bundle toward a sidepanel-first browser interface with stronger page continuity and cleaner right-click flows.

Architecture: Keep the existing MV3 extension shape, but tighten the surface boundaries. Popup becomes a lightweight launcher/status view. Sidepanel becomes the canonical result/workspace surface. Background.js gains minimal state helpers for revisit continuity and UI routing, without a full refactor yet.

Tech Stack: Chrome Extension MV3, vanilla HTML/CSS/JS, chrome.storage.local, Hermes local API /v1/responses.

---

## Implementation scope for this pass

1. Simplify popup into a launcher/status surface.
2. Route popup actions toward the sidepanel instead of treating popup as a mini workspace.
3. Add revisit continuity cues for pages Hermes has seen before.
4. Improve context-menu actions so they land in sidepanel instead of spawning output tabs by default.
5. Preserve a small amount of sidepanel workspace state so Hermes feels more continuous.

## Files likely to modify

- Modify: extension/popup/popup.html
- Modify: extension/popup/popup.css
- Modify: extension/popup/popup.js
- Modify: extension/sidepanel/sidepanel.html
- Modify: extension/sidepanel/sidepanel.css
- Modify: extension/sidepanel/sidepanel.js
- Modify: extension/background.js
- Modify: README.md

## Acceptance criteria

- Popup feels like a quick launcher, not a cramped workspace.
- Popup can show whether current page has prior Hermes context.
- Main page actions can open/use the sidepanel as the canonical workspace.
- Context-menu actions prefer sidepanel routing over opening standalone result tabs.
- Sidepanel clearly shows whether a page is new or previously seen.
- Sidepanel restores draft-ish workspace state across reopen/refresh.
- npm run check passes.
