# Tennis Court Tracker

A mobile-first static web app that checks tennis court availability at Presidio, Golden Gate Park, and Menlo Park courts, filtered by the user's preferred days/times.

## Run & Operate

- Dev: `npx serve . -p 5000` (static file server, no build step)
- Daily data fetch: `node fetch.js` (Node.js 20+, no dependencies)
- GitHub Pages compatible — deploy `index.html`, `app.js`, `data.json`

## Stack

- Vanilla HTML + CSS + JavaScript (no framework, no build tool)
- Node.js script (`fetch.js`) for server-side data fetching
- GitHub Actions for daily scheduled runs

## Where things live

- `index.html` — app shell and all CSS
- `app.js` — data loading, rendering logic
- `fetch.js` — server-side fetch script (Node.js, no CORS issues)
- `data.json` — cached court availability, updated by GitHub Actions daily
- `.github/workflows/fetch-courts.yml` — cron at 21:00 UTC (2pm PDT)

## Architecture decisions

- **Two-tier data strategy**: `app.js` reads `data.json` first (< 25h old → use cache); falls back to live browser fetch via CORS proxy
- **GitHub Actions solves CORS + Menlo**: server-side Node.js has no CORS issues and can maintain sessions for perfectmind's CSRF flow
- **Presidio (rec.us)**: GET, works via allorigins.win proxy in browser
- **GGP (courtreserve)**: POST, blocked in browser (no free proxy); covered by GitHub Actions cache
- **Menlo (perfectmind)**: requires session cookie + CSRF token; only works in `fetch.js` (server-side); browser shows error + manual link
- **All 8 days viewable**: all day pills are clickable; non-preferred days show a broad 7am–10pm window

## Product

- Shows next 8 days as tappable pills (all clickable, no greying)
- Auto-selects first scheduled court day on load
- Preferred windows: Presidio/GGP = Tue/Thu after 5pm, Sat/Sun after 10am; Menlo = Wed/Thu 5–7pm
- Non-preferred days use a broad 7am–10pm window to show anything available
- Slots grouped by time, tagged by court name and color-coded
- "Data fetched at X" banner when showing cached results
- Graceful error handling with direct booking links

## User preferences

- Keep it simple, no unnecessary packages
- Hosted on GitHub Pages (static only)
- All 8 days should be viewable
- Daily check at 2pm (via GitHub Actions cron)

## Gotchas

- GGP evening slots were showing on wrong date: fixed by parsing local time from `Id` field ("Hard05/08/2026 17:00:00") instead of UTC timestamp
- corsproxy.io blocked outside localhost (403); now only used as last-resort fallback — GitHub Actions is primary
- perfectmind CONFIRMED broken from browser: must run via `fetch.js`
- GitHub Actions needs `permissions: contents: write` to push data.json back to repo

## Pointers

- GitHub Actions workflow: `.github/workflows/fetch-courts.yml`
- rec.us API: `GET /v1/locations/{id}/schedule?startDate=YYYY-MM-DD` → `{dates: {"YYYYMMDD": [{courtNumber, schedule: {"HH:MM, HH:MM": {referenceType}}}]}}`
- courtreserve API: `POST /Online/Reservations/ReadConsolidated/12465` → `{Data: [{Id:"Hard05/08/2026 14:00:00", AvailableCourts: N}]}`
- perfectmind: GET facility page for cookie+token, then POST FacilityAvailability with session
