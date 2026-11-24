# Encore — rate every song, head to head

Encore is a music rating app built like a record collection. You never type a number:

1. **Your first song is a 10.** It goes straight to the top of your collection.
2. **Every song after that is placed head to head.** Encore asks *"Is this better or worse than [song]?"*
   and narrows down to an exact rank in a few questions (a binary search: about 7 questions for 100 songs).
3. **Scores re-spread every time you add one.** A song's score comes from its rank:
   `score = 10 × (N − rank + 1) / N`. Your #1 is always a 10, and the order never contradicts the scores.

The catalog is **Apple Music's**: search, artwork and 30-second previews come from Apple's public catalog API.

## Tabs
- **Home**: search every song on Apple Music; your **recently played** songs from Apple Music (or Spotify),
  each one tap from "Rate this"; your top records; what's trending.
- **Charts**: 12 genres (Pop, Rap/Hip-Hop, R&B, Country, Rock, EDM, Latin, Alternative, Indie, Jazz, Gospel, K-Pop),
  each with a **Current Chart** and **Most Streamed**. Every row has **Rate** and **Add to list**.
  Each chart says where its data came from, and placeholder data is always labelled.
- **Lists**: *My Ratings* (songs, plus artist and album averages; drag to re-rank) and *My Lists*:
  your own lists like "Best Rap Song" or "Gym Songs". You can name them, add songs (from search, your ratings
  or any chart), remove songs, re-order them, and make each one public or private.
- **Recommendations**: songs you've probably heard and would rate highly, found by **collaborative filtering**:
  listeners whose ratings agree with yours, and what they rate highly that you haven't rated yet. Picks lean
  toward rediscoveries (your listening history, songs many similar listeners rate 9+, your favourite artists and genres).
  Every card says why, for example "Because you rated Golden Hour a 10" or "12 people with similar taste rated this 9+".
  New users get the genre charts until they've rated 3 songs. The list refreshes every time you rate.
- **Profile**: sign up with email, a unique username and a password; avatar, bio, rating count, Top 10, lists,
  connected services, people search, public/private profile, export/import, and a shareable Top 10 image.

## Run it
Requires Node 22.13+ and no `npm install` (it uses Node's built-in SQLite).

```sh
npm start            # http://localhost:3000
```

Accounts are stored in `data/encore.db` (set `DATABASE_PATH` to move it, and `COOKIE_SECURE=1` behind HTTPS).
Host it anywhere that runs Node with a persistent disk (Render with a disk, Fly.io, Railway, a VPS).

### GitHub Pages (free, no server)
`.github/workflows/pages.yml` publishes the app to GitHub Pages on every push to `main`
(turn it on once: **Settings → Pages → Source: GitHub Actions**). Pages only hosts files, so there you get
guest mode: ratings, lists, charts and previews work and are saved in the browser. Accounts, profiles,
syncing and collaborative-filtering recommendations need the Node server. For integrations on Pages,
put public keys in `config.js` (see below).

## Plugging in real services
| What | Server (env var) | GitHub Pages (`config.js`) | Without it |
| --- | --- | --- | --- |
| Apple Music sign-in + recently played | `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY_PATH` | `musickitDeveloperToken` (make one with `node scripts/musickit-token.js`) | "Connect Apple Music" explains it isn't set up |
| Spotify sign-in + recently played | `SPOTIFY_CLIENT_ID` | `spotifyClientId` | Spotify shows "Not set up" |
| Most Streamed charts (Last.fm) | `LASTFM_API_KEY` | `lastfmApiKey` | Labelled placeholder lists |
| Current Chart (Apple genre feeds) | built in | tried from the browser | Labelled placeholder lists |

- **Apple Music**: you need an Apple Developer Program membership. Create a *Media ID* and a key with
  *Media Services (MusicKit)*, then download the `.p8`. The server signs short-lived tokens, and the key never reaches the browser.
- **Spotify**: create an app at developer.spotify.com/dashboard and add your site URL (for example
  `https://your-app.onrender.com/`) as a Redirect URI. Sign-in uses OAuth with PKCE, so no client secret is needed,
  and tokens stay in the user's browser.
- **SoundCloud, YouTube Music, Amazon Music** show **Coming soon**. None of them currently offers a public API
  for listening history that a new app can use.
- **Charts data layer**: `js/charts.js` is the only place chart data comes from. To add a provider
  (Deezer, a paid chart API…), add an entry to its `providers` list.

## Code map
| File | What it does |
| --- | --- |
| `ranking.js` | Rating engine: first-song 10, better/worse placement, score re-spread, drag-to-move, migration of old data |
| `recommend.js` | Collaborative filtering + rediscovery weighting + reasons (used by the server and the browser) |
| `genres.js` | The 12 chart genres: Apple genre ids, Last.fm tags, labelled sample lists |
| `server.js` | Accounts, sync, profiles, charts proxy, recommendations, Apple developer tokens |
| `js/charts.js` | Charts data layer (Apple → Last.fm → labelled placeholder) |
| `js/services.js` | Connected services (Spotify OAuth PKCE; coming-soon states) |
| `js/audio.js` / `js/gestures.js` / `js/motion.js` | Crossfading previews; swipe, drag and pull-to-refresh; motion helpers |
| `js/sharecard.js` / `js/palette.js` / `js/icons.js` | Top 10 share image; ⌘K palette (desktop); icons |
| `app.js` | Screens and state |

Design: warm near-black, cream type and one burnt-orange accent; covers are record sleeves with the vinyl
peeking out, scores are price stickers, and the now-playing bar is a turntable whose tonearm tracks the song.
Fonts are **Fraunces** (display) and **Archivo** (text), stored in `fonts/` under the SIL Open Font License.

## Tests
```sh
npm test                          # rating engine, recommendations, server (accounts, lists, profiles, charts, CF)
node tests/e2e.js [shotsDir]      # every screen in Chromium at 390px and 1280px (Apple + MusicKit mocked); saves screenshots
node tests/static-e2e.js          # the GitHub Pages build with no server
```
