# JoyGo 樂遊

JoyGo 樂遊 is a private travel companion PWA for itinerary planning, maps, transit, flights, accommodation, booking documents, saved places and shared expenses.

## Production release

Current release: **v8.0.2**

This repository is the production app shell. Firebase remains the authoritative data source for active trips. Runtime Firebase project identifiers and existing Firestore / Storage paths are intentionally unchanged from the regression-passed v7.9.20.24 baseline.


## Production data boundary

- `trip.json` is a **neutral runtime bootstrap only**. It contains no real Trip and is never rendered as a production Trip.
- Visible production Trips originate from Firebase and may resume from the app’s existing permission-bound local cache; bundled repository JSON is never a production Trip source.
- `examples/demo-trip.example.json` is a fictional Portable Trip JSON template for manual reference or manual import. The app does not auto-load it and the Service Worker does not precache it.
- On production hosts, the historical `?data=...` bootstrap override is disabled. It remains available only on local development hosts (`localhost`, `127.0.0.1`, `file:`).

This keeps the GitHub repository useful as an app / JSON-format reference without publishing or silently rendering any real Trip data.

## Deployment

### GitHub Pages

Publish the `main` branch from the repository root. The app uses relative asset paths and is compatible with a GitHub Pages project path.

### Firebase

Do not redeploy Firebase merely for a normal app-shell release. Deploy Firebase only when `firestore.rules`, `storage.rules`, `firestore.indexes.json`, or `functions/` actually change.

## Release workflow

1. Upload all changed app files.
2. Upload `sw.js` last when updating an existing deployment.
3. Open the production PWA and allow the new Service Worker to activate.
4. Run a short real-device smoke test: launch / refresh, Trip switch, Day Bar, Map, Transit, Documents, Expenses, Backup and offline reopen.

## Product name

- Brand: **JoyGo 樂遊**
- English: **JoyGo**
- Chinese: **樂遊**

## Brand icon

- Primary app icon: refined gold `G + airplane` mark on a clean white full-bleed square.
- Runtime icon files remain under `assets/icon/`; source artwork has no pre-rounded corners.
- `icon-maskable-512.png` uses additional safe-area padding for launcher masking.
- Manifest / entry fallback background is white; Trip-specific appearance and backgrounds remain data-driven and unchanged.
