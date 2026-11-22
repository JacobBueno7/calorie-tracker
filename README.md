# Calorie Tracker

A personal calorie tracker for iPhone, built as an installable web app (PWA). No App Store needed. Your data stays on the phone.

## Features
- **Exact grams → calories.** Type any amount (100 g strawberries, 500 g ground turkey, 500 g cooked rice) and calories + protein/carbs/fat are calculated from per-100 g values.
- **Breakfast, lunch, dinner, snacks**, daily goal ring, macro bars, 14-day history.
- **Food sources:** ~200 built-in USDA foods (instant, offline), USDA FoodData Central online search (generic + branded/packaged), Open Food Facts.
- **Packaged food:** scan the barcode with the camera, or enter the Nutrition Facts label (per serving or per 100 g). Saved to *My Foods*.
- **AI meal photo scan:** take a picture and Claude identifies each food, estimates grams and calories for the whole meal. Edit the grams before adding.
- **History & trends** (7 days / 30 / 90 / 1 year / all time): average calories per day vs goal and vs the previous period, days logged, days at or under goal, logging streaks, average protein and how often you hit it, highest/lowest day, a daily (or weekly/monthly) calories chart with a 7-day average, macro split, calories by meal and by weekday, top calorie sources, and a day-by-day table.
- **Body weight:** log weigh-ins (lb or kg), see a 7-day trend line, change and rate per week, and an **estimated maintenance calories** figure computed from your logged intake and weight trend (after ~2 weeks of data).
- Smoothie builder, quick add, edit/delete entries, export/import backups, light & dark mode, works offline.

## Where your data lives
Everything stays **on your iPhone**, inside the Home Screen app's own website storage. Nothing is sent to a server, GitHub, or iCloud.
- The food log is in **IndexedDB** (one record per day). Safari lets a site use a large share of free disk space for it, so years of history fit easily (~1–3 KB per day of logging).
- Settings, My Foods, recent foods and weigh-ins are in `localStorage` (small).
- **Settings → Storage & backups** shows how much is used, the growth per day, and how many years of room are left at your pace.
- Deleting the Home Screen icon deletes its data, and data in a Safari tab is separate from the Home Screen app. Use **Export backup** now and then (save it to Files / iCloud Drive) and **Import backup** to restore or move data.

## Install on iPhone
1. Open the app URL in **Safari**.
2. Tap **Share** → **Add to Home Screen**.
3. Open it from the home screen icon.
4. For AI photo scanning: **Settings** → paste an Anthropic API key (from console.anthropic.com).
5. Optional: add a free USDA API key (fdc.nal.usda.gov/api-key-signup) for unlimited online search.

## API key security
The app calls Anthropic directly from your phone, so your key has to be stored on the phone. Protections:
- **Stored only on the device**, in its own slot: never in the code, the repo, backups/exports, or imports.
- **Never displayed again** after saving (Settings shows only `sk-ant-…1234`), with Replace/Remove buttons.
- **Sent only to `https://api.anthropic.com`** (hard-coded endpoint, HTTPS).
- **Content Security Policy** (`public/index.html`): only the app's own script can run, and the page can only
  connect to Anthropic, USDA and Open Food Facts. Even injected code could not send the key elsewhere.
- No third-party scripts, analytics or CDNs; all user/API data is HTML-escaped; the app refuses to run inside a frame.
- Dependencies are locked (`package-lock.json`, `npm ci`) and GitHub Actions are pinned to commit SHAs.

Limit the damage if a key ever leaks anyway:
- Use a **dedicated key** for this app, in its own Console **workspace with a monthly spend limit**.
- If you suspect a leak, delete the key in the Anthropic Console (instant) and create a new one.
- Use the app from the Home Screen icon (its storage is separate from Safari's).

## Develop
```
npm install
node build.mjs      # outputs dist/
```
Pushing to `main` deploys to GitHub Pages via `.github/workflows/deploy.yml`.
