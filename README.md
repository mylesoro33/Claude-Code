# Encore — rate every song, head to head

Encore is a music rating app built like a record collection. You never type a number:

1. **Your first song is a 10.** It goes straight to the top of your collection.
2. **Every song after that is placed head to head.** Encore asks *"Is this better or worse than [song]?"*
   and narrows down to an exact rank in a few questions (a binary search: about 7 questions for 100 songs).
3. **Scores re-spread every time you add one.** A song's score comes from its rank:
   `score = 10 × (N − rank + 1) / N`. Your #1 is always a 10, and the order never contradicts the scores.

The catalog is **Apple Music's**: search, artwork and 30-second previews come from Apple's public catalog API.

## Tabs
- **Home**: search every song on Apple Music; your **recently played** songs from every connected service
  (and from *Find my account*), each one tap from "Rate this"; your top records; what's trending.
- **Charts**: *All genres* plus 12 genres (Pop, Rap/Hip-Hop, R&B, Country, Rock, EDM, Latin, Alternative, Indie, Jazz,
  Gospel, K-Pop), each with a **Current Chart** and **Most Streamed** built from real data. Every song belongs to one
  genre (its primary artist's tags), so genre charts never repeat each other. Rows show rank, artwork, title, artist,
  weeks on chart and peak (or the stream count on Most Streamed), plus **Rate** and **Add to list**. Each chart names
  its source and when it was last updated. No placeholder data.
- **Lists**: *My Ratings* (songs, plus artist and album averages; drag to re-rank) and *My Lists*:
  your own lists like "Best Rap Song" or "Gym Songs". You can name them, add songs (from search, your ratings
  or any chart), remove songs, re-order them, and make each one public or private.
- **Recommendations**: songs you've probably heard and would rate highly, found by **collaborative filtering**:
  listeners whose ratings agree with yours, and what they rate highly that you haven't rated yet. Picks lean
  toward rediscoveries (your listening history, songs many similar listeners rate 9+, your favourite artists and genres).
  Every card says why, for example "Because you rated Golden Hour a 10" or "12 people with similar taste rated this 9+".
  New users get the genre charts until they've rated 3 songs. The list refreshes every time you rate.
- **Profile**: sign up with email, a unique username (changeable later) and a password; a profile photo you crop
  yourself (or the default record avatar), bio, rating count, Top 10, lists, **Connect settings** for
  Apple Music, Spotify, YouTube Music, SoundCloud and Amazon Music, **Find my account** (rate songs from a public
  Last.fm, Spotify, YouTube or SoundCloud profile), people search, public/private profile, import, and a
  shareable Top 10 image.
- **❤ and Add to playlist** on any song: hearting saves it to your connected libraries (Apple Music library,
  Spotify Liked Songs, YouTube likes, SoundCloud likes); *Add to playlist* picks or creates a playlist on that service.

## Run it
Requires Node 22.13+ and no `npm install` (it uses Node's built-in SQLite).

```sh
npm start            # http://localhost:3000
```

Copy `.env.example` to `.env` and fill in what you have; **[SETUP.md](SETUP.md)** is the step-by-step checklist
for every key, secret and redirect URI. Nothing is hardcoded, and anything left blank shows a plain "Not set up" state.

Accounts are stored in `data/encore.db` (set `DATABASE_PATH` to move it, and `COOKIE_SECURE=1` behind HTTPS).
Host it anywhere that runs Node with a persistent disk (Render with a disk, Fly.io, Railway, a VPS).

### GitHub Pages (free, no server)
`.github/workflows/pages.yml` publishes the app to GitHub Pages on every push to `main`
(turn it on once: **Settings → Pages → Source: GitHub Actions**). Pages only hosts files, so there you get
guest mode: ratings, lists, charts and previews work and are saved in the browser. Accounts, profiles,
syncing and collaborative-filtering recommendations need the Node server. For integrations on Pages,
put public keys in `config.js` (see below).

## Plugging in real services
Full checklist with the developer-portal steps and each service's limits: **[SETUP.md](SETUP.md)**.

| What | Env vars | Without it |
| --- | --- | --- |
| Apple Music (MusicKit) | `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY_PATH` | Apple shows "Not set up" |
| Spotify (OAuth + PKCE) | `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | Spotify shows "Not set up" |
| YouTube Music (Google OAuth) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `YOUTUBE_API_KEY` | "Not set up" |
| SoundCloud | `SOUNDCLOUD_CLIENT_ID`, `SOUNDCLOUD_CLIENT_SECRET` | "Not set up" |
| Amazon Music (closed beta) | `AMAZON_CLIENT_ID`, `AMAZON_CLIENT_SECRET`, `AMAZON_MUSIC_API_KEY` | "Waiting for API access" |
| Find my account: Last.fm, genre tags, stream counts | `LASTFM_API_KEY` | Last.fm lookups off; genres from Apple only |
| Billboard charts | `BILLBOARD_PROVIDER`, `BILLBOARD_API_KEY`, `BILLBOARD_API_HOST` | Apple Music genre charts |
| Spotify stream counts (Kworb) | `KWORB_ENABLED=1` (default on) | Last.fm play counts |
| Token encryption | `TOKEN_ENCRYPTION_KEY` | A random key each restart (users reconnect) |

On **GitHub Pages** (no server) only `config.js` keys apply: `musickitDeveloperToken`, `spotifyClientId`
(PKCE in the browser) and `lastfmApiKey`. The Current Chart comes from Deezer's public chart there, and the
other services and *Find my account* need the server.

## Code map
| File | What it does |
| --- | --- |
| `ranking.js` | Rating engine: first-song 10, better/worse placement, score re-spread, drag-to-move, migration of old data |
| `recommend.js` | Collaborative filtering + rediscovery weighting + reasons (used by the server and the browser) |
| `genres.js` | The chart genres: Apple, Deezer and Billboard ids, Last.fm tags, and the primary-genre rules |
| `server.js` | Accounts, sync, profiles, connections API, charts API, recommendations, Apple developer tokens |
| `lib/oauth.js` | OAuth broker: state + PKCE, server-side code exchange, encrypted tokens, quiet refresh |
| `lib/services/*.js` | One module per service: recent plays, ❤, playlists, public-profile lookup |
| `charts/index.js` + `charts/sources/*.js` | Server chart data layer: one module per source, genre dedupe, daily/weekly cache, weeks and peak |
| `js/charts.js` | Client side of the charts (server API, or Deezer + Last.fm on GitHub Pages) |
| `js/services.js` | Spotify PKCE in the browser, for GitHub Pages only |
| `js/audio.js` / `js/gestures.js` / `js/motion.js` | Crossfading previews; swipe, drag and pull-to-refresh; motion helpers |
| `js/sharecard.js` / `js/palette.js` / `js/icons.js` | Top 10 share image; ⌘K command palette (keyboard only); icons |
| `app.js` | Screens and state |

Design: warm near-black, cream type and one burnt-orange accent; covers are record sleeves with the vinyl
peeking out, scores are price stickers, and the now-playing bar is a turntable whose tonearm tracks the song.
Fonts are **Fraunces** (display) and **Archivo** (text), stored in `fonts/` under the SIL Open Font License.

## Tests
```sh
npm test                          # rating engine, recommendations, server, service adapters, charts
node tests/e2e.js [shotsDir]      # every screen in Chromium at 390px and 1280px (every outside API faked); saves screenshots
node tests/static-e2e.js          # the GitHub Pages build with no server
```
