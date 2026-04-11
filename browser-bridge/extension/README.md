# Needle Browser Bridge

This is the first-class Chrome extension package for Needle's controlled browser flow.

The extension source now lives here directly. `dist/background.js` is built from
`src/background.ts`, `src/cdp.ts`, and `src/protocol.ts`.

Build the unpacked extension bundle with:

```bash
npm run browser:bridge:build
```

Then load `browser-bridge/extension` via Chrome's `Load unpacked` flow.

The app runtime uses this directory by default. You can override it with
`FOLO_BROWSER_EXTENSION_DIR` when testing a custom unpacked extension bundle.
