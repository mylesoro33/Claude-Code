# Encore setup checklist

Encore has no music-service sign-ins. Song search, artwork and 30-second previews come from the
**iTunes Search API**, which needs no key and no login. The only keys are optional chart sources.

Copy `.env.example` to `.env`, fill in what you have, and restart (`npm start`). Anything you leave
empty switches off cleanly. `.env` is git-ignored; never commit it. On Render, add the same names under **Environment**.

---

## 1. Basics

| Variable | What it is |
| --- | --- |
| `COOKIE_SECURE` | `1` when served over HTTPS (set it on Render) |
| `DATABASE_PATH` | Where accounts and the chart cache live. Default `./data/encore.db`; on Render, point it at a persistent disk |
| `PORT` | Default 3000 |

---

## 2. Charts and Most Streamed

| Source | Variable | Status |
| --- | --- | --- |
| **Apple Music genre charts** (current, one feed per genre) | none | Live, no key |
| **Deezer genre charts** (current, one feed per genre) | none | Live, no key |
| **Kworb** (Spotify all-time total streams, real numbers) | `KWORB_ENABLED=1` (default on) | Live, no key. Kworb is an unofficial fan site that republishes Spotify numbers. Encore reads one page a week and caches it. Set `0` if you'd rather not use it. |
| **Last.fm top tracks by tag** (all-time play counts) | `LASTFM_API_KEY` | Live with a key |
| **Billboard** (Hot 100, Billboard 200, Hot Rap Songs, Hot Country Songs, Hot R&B/Hip-Hop Songs, Hot Rock & Alternative, Hot Dance/Electronic, Hot Latin Songs, Hot Gospel Songs…) | `BILLBOARD_PROVIDER`, `BILLBOARD_API_KEY`, `BILLBOARD_API_HOST` | **Needs a paid source** (options below) |

**Billboard options.** Billboard has no free public API, and Encore does **not** scrape billboard.com, because their terms forbid it.
1. **Licensed:** Billboard and Luminate (the company behind the charts) license chart data to businesses. Contact their data licensing team. This is the only fully official route, and it's paid.
2. **Third-party API:** RapidAPI lists several "Billboard API" providers with free or cheap tiers. They're unofficial resellers. Set `BILLBOARD_PROVIDER=rapidapi`, `BILLBOARD_API_KEY=<your RapidAPI key>`, `BILLBOARD_API_HOST=<the API's host, e.g. billboard-api2.p.rapidapi.com>`.
   Response formats differ between vendors. Encore's adapter (`charts/sources/billboard.js`) handles the common shape. If your vendor differs, it's one function to adjust.
3. **Neither:** the **Charts tab uses Apple Music's public genre charts** (no key, no login), labeled "Apple Music", so you still get real, live, genre-specific charts.

Refresh schedule: the Charts tab **daily**, Most Streamed **weekly**. Both are cached in the database, and every chart shows a "last updated" time.
**Weeks on chart / peak:** Billboard supplies these directly. For Apple and Deezer, Encore computes them from its own daily snapshots, so they count from the day your server started tracking.

---

## 3. Last.fm

| Variable | Value |
| --- | --- |
| `LASTFM_API_KEY` | last.fm/api/account/create → *API key* (the shared secret isn't needed) |

What it powers: genre tags that sort every song into exactly one genre (so genre charts never repeat each
other), and play counts on Most Streamed for genres Kworb barely covers. Without it, genres come from Apple's
artist genre and Most Streamed relies on Kworb alone.

---

## 4. GitHub Pages (no server)
Pages can't keep secrets, so only `lastfmApiKey` in `config.js` applies there (it turns on Most Streamed).
The Charts tab reads Deezer's public genre charts in the browser. Accounts, profiles, the chart cache,
Billboard and Kworb need the Node server.
