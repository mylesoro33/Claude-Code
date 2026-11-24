# Encore — rate every song, head to head

Encore is a music rating app built like a record collection. You never type a number:

1. **Your first song is a 10.** It goes straight to the top of your collection.
2. **Every song after that is placed head to head.** Encore asks *"Is this better or worse than [song]?"*
   and narrows down to an exact rank in a few questions (a binary search: about 7 questions for 100 songs).
3. **Scores re-spread every time you add one.** A song's score comes from its rank:
   `score = 10 × (N − rank + 1) / N`. Your #1 is always a 10, and the order never contradicts the scores.

Search, artwork and 30-second previews come from the **iTunes Search API**, which needs no key and no sign-in.
Encore doesn't connect to any music service.

## Tabs
- **Home**: search songs, artists, or albums; your top records; what's trending.
- **Charts**: this week's rankings for *All genres* plus 12 genres (Pop, Rap/Hip-Hop, R&B, Country, Rock, EDM, Latin,
  Alternative, Indie, Jazz, Gospel, K-Pop). Rows show rank, artwork, title, artist, weeks on chart and peak.
- **Most Streamed**: the all-time most-streamed songs for the same genres, with the stream count on every row.
  Both chart tabs share the genre selector, every row has **Rate** and **Add to list**, and every song belongs to one
  genre (its primary artist's), so genre charts never repeat each other. Each chart names its source and when it
  was last updated.
- **Lists**: *My Ratings* (songs, plus artist and album averages; drag to re-rank) and *My Lists*:
  your own lists like "Best Rap Song" or "Gym Songs". You can name them, add songs (from search, your ratings
  or any chart), remove songs, re-order them, and make each one public or private.
- **Recommendations**: songs you'd probably rate highly, found by **collaborative filtering**: listeners whose
  ratings agree with yours, and what they rate highly that you haven't rated. Every card says why ("Because you
  rated Golden Hour a 10", "12 people with similar taste rated this 9+"). The picks **update the moment you rate**
  (with a short highlight on what changed), **Refresh** pulls a new batch, and songs you've rated never appear.
  New users get their genres' charts until they've rated 3 songs.
- **Profile**: sign up with email, a unique username (changeable later, still unique) and a password; a profile
  photo you crop and zoom with a live preview before saving (or the default record avatar), shown next to your name
  on your profile, ratings and lists; bio, rating count, Top 10, lists, people search, public/private profile,
  import, and a shareable Top 10 image.

## Run it
Requires Node 22.13+ and no `npm install` (it uses Node's built-in SQLite).

```sh
npm start            # http://localhost:3000
```

Everything works with no keys. Optional chart sources go in `.env` (copy `.env.example`);
**[SETUP.md](SETUP.md)** explains each one. Nothing is hardcoded.

Accounts are stored in `data/encore.db` (set `DATABASE_PATH` to move it, and `COOKIE_SECURE=1` behind HTTPS).
Host it anywhere that runs Node with a persistent disk (Render with a disk, Fly.io, Railway, a VPS).

### GitHub Pages (free, no server)
`.github/workflows/pages.yml` publishes the app to GitHub Pages on every push to `main`
(turn it on once: **Settings → Pages → Source: GitHub Actions**). Pages only hosts files, so there you get
guest mode: ratings, lists, charts and previews work and are saved in the browser. Accounts, profiles,
syncing and collaborative-filtering recommendations need the Node server. To turn on Most Streamed there,
put a Last.fm key in `config.js`.

## Chart sources and keys
Details and limits: **[SETUP.md](SETUP.md)**.

| What | Env var | Without it |
| --- | --- | --- |
| Charts tab: Apple Music genre charts | none | Always on |
| Charts tab: Billboard (Hot 100, Billboard 200, genre charts) | `BILLBOARD_PROVIDER`, `BILLBOARD_API_KEY`, `BILLBOARD_API_HOST` | Apple Music genre charts |
| Most Streamed: Spotify all-time stream counts (Kworb) | `KWORB_ENABLED=1` (default on) | Last.fm play counts |
| Most Streamed fill-in + one-genre-per-song tags (Last.fm) | `LASTFM_API_KEY` | Kworb alone; genres from Apple's artist genre |

## Code map
| File | What it does |
| --- | --- |
| `ranking.js` | Rating engine: first-song 10, better/worse placement, score re-spread, drag-to-move, migration of old data |
| `recommend.js` | Collaborative filtering + rediscovery weighting + reasons (used by the server and the browser) |
| `genres.js` | The chart genres: Apple, Deezer and Billboard ids, Last.fm tags, and the primary-genre rules |
| `server.js` | Accounts, sync, profiles, charts API, recommendations, catalog and artwork proxy |
| `lib/env.js` | Loads `.env` |
| `charts/index.js` + `charts/sources/*.js` | Server chart data layer: one module per source, genre dedupe, daily/weekly cache, weeks and peak |
| `js/charts.js` | Client side of the charts (server API, or Deezer + Last.fm on GitHub Pages) |
| `js/audio.js` / `js/gestures.js` / `js/motion.js` | Crossfading previews; swipe, drag and pull-to-refresh; motion helpers |
| `js/sharecard.js` / `js/palette.js` / `js/icons.js` | Top 10 share image; ⌘K command palette (keyboard only); icons |
| `app.js` | Screens and state |

Design: warm near-black, cream type and one burnt-orange accent; covers are record sleeves with the vinyl
peeking out, scores are price stickers, and the now-playing bar is a turntable whose tonearm tracks the song.
Fonts are **Fraunces** (display) and **Archivo** (text), stored in `fonts/` under the SIL Open Font License.

## Tests
```sh
npm test                          # rating engine, recommendations, server, charts
node tests/e2e.js [shotsDir]      # every screen in Chromium at 390px and 1280px (every outside API faked); saves screenshots
node tests/static-e2e.js          # the GitHub Pages build with no server
```
