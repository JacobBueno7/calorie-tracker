# Calorie Tracker

A personal calorie tracker for iPhone, built as an installable web app (PWA). No App Store needed. Your data stays on the phone.

## Features
- **Exact grams → calories.** Type any amount (100 g strawberries, 500 g ground turkey, 500 g cooked rice) and calories + protein/carbs/fat are calculated from per-100 g values.
- **Breakfast, lunch, dinner, snacks**, daily goal ring, macro bars, 14-day history.
- **Food sources:** ~200 built-in USDA foods (instant, offline), USDA FoodData Central online search (generic + branded/packaged), Open Food Facts.
- **Packaged food:** scan the barcode with the camera, or enter the Nutrition Facts label (per serving or per 100 g). Saved to *My Foods*.
- **AI meal photo scan:** take a picture and Claude identifies each food, estimates grams and calories for the whole meal. Edit the grams before adding.
- Quick add, edit/delete entries, export/import backups, dark mode, works offline.

## Install on iPhone
1. Open the app URL in **Safari**.
2. Tap **Share** → **Add to Home Screen**.
3. Open it from the home screen icon.
4. For AI photo scanning: **Settings** → paste an Anthropic API key (from console.anthropic.com).
5. Optional: add a free USDA API key (fdc.nal.usda.gov/api-key-signup) for unlimited online search.

## Develop
```
npm install
node build.mjs      # outputs dist/
```
Pushing to `main` deploys to GitHub Pages via `.github/workflows/deploy.yml`.
