# Chrome Release

## Before Packaging

1. Confirm Hermes Relay loads cleanly as an unpacked extension.
2. Run:

```bash
npm run check
```

3. Build the uploadable zip:

```bash
npm run package:chrome
```

## Output

The packaged upload is written to:

```text
dist/hermes-relay-chrome.zip
```

Generated icons are written to:

```text
extension/icons/
```

## First Release Checklist

- verify popup loads
- verify side panel opens
- verify Hermes connection succeeds locally
- verify context injection works on at least one supported provider
- verify the watchlist and snapshot flows work after extension reload
- confirm the zip installs in Chrome as expected
