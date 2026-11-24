# Encore — rank your songs, Beli-style

Encore is a song-ranking app modeled on how Beli ranks restaurants. You never
type a score. You react to a song, then answer a few quick
**"Which do you like more?"** head-to-heads, and Encore slots it into the
right place in your personal list.

The song catalog is **Apple Music's**: search goes live through Apple's public
iTunes Search API, so you can rank any song on Apple Music. It comes with
artwork, 30-second previews and "Open in Apple Music" links.

## How ranking works
1. Tap **+** on any song and pick **I loved it / It was fine / Didn't like it**.
2. Encore runs a binary search through the songs in that group, asking you to
   pick between the new song and one you've already ranked. A list of N songs
   takes at most ~log2(N) questions (about 7 for 100 songs, 10 for 1,000).
   Hit "Too close to call" to place it right there.
   You can also **drag** a song in My List to move it, and its score updates.
3. Every song gets a 0–10 score from its position. Loved songs sit in the
   6.7–10 band, fine songs in 3.4–6.6, and songs you didn't like in 0–3.3.
   Scores adjust as your list grows.

## Features
- **Discover**: live top-songs chart, plus search across the whole Apple Music catalog (storefront picker)
- **My List**: switch between **Songs**, **Artists** and **Albums**. Artists and albums show the
  **average score** of the songs you've ranked from them, and update every time you rank another one.
  After each ranking you see the new artist and album averages. Tap an artist or album to see its songs.
- **Accounts**: sign up or sign in to sync your list across devices. Guest rankings move into a new
  account automatically. Profiles are public by default (toggle in Profile), so you can
  share `?u=username` links, find people by name, and see a "% taste match" on friends' lists.
- **Apple Music linking** (MusicKit): rank straight from your *Recently played* and *Library*,
  play full songs with a subscription instead of 30-second previews, and save your top 25 as an
  Apple Music playlist.
- **Cover art**: high-resolution Apple artwork everywhere, with a generated placeholder if any
  image fails to load. Missing art on older saved songs fills in automatically.
- **Later**: a want-to-listen list. Swipe a song right in Discover to save it.
- **Taste Profile**: your score distribution, top genres and average score by artist, plus a
  **shareable Top 10 image** (PNG, via the share sheet on phones).
- **Player**: tap any cover to hear the 30-second preview. Previews crossfade, and a mini player
  shows a live waveform. Swipe the mini player to skip, and the list keeps playing in order.
- **Installable app (PWA)**: add it to your home screen. It opens instantly and works offline,
  even while the free server is waking up.
- **Keyboard**: press `⌘K` / `Ctrl+K` for the command palette, `/` to search, `1`–`4` to switch tabs,
  `Space` to play or pause, `←` `→` to pick a side while ranking, and `?` to list all shortcuts.

## Design
"Liner notes after dark": a near-black stage lit by album art. Encore reads a dominant color
from each cover and uses it for glows, gradients and score rings, so the interface takes on the
color of whatever you're looking at. Display type is **Unbounded**, body text is **Manrope**.
Both are stored in `fonts/` under the SIL Open Font License.

- Design tokens (color, type, spacing, radii, shadows, motion) are defined once at the top of `styles.css`.
- Motion uses spring curves and only animates `transform` and `opacity`, apart from the score-ring
  stroke. Everything turns off for `prefers-reduced-motion`.
- The front-end code is split into small modules with no dependencies:

  | File | What it does |
  | --- | --- |
  | `ranking.js` | Ranking engine (binary insertion, scores, drag-to-move) |
  | `js/motion.js` | Springs, FLIP list animations, the cover-to-album-page transition, count-up rings, haptics |
  | `js/color.js` | Dominant color from album art (through the `/api/art` proxy) |
  | `js/audio.js` | Two-deck crossfading player and the live waveform |
  | `js/gestures.js` | Swipe rows, pull to refresh, drag to re-rank |
  | `js/sharecard.js` | The Top 10 share image |
  | `js/palette.js` | ⌘K command palette |
  | `js/icons.js` | Icon set |
  | `app.js` | Screens, state, sync, Apple Music |

## Run it
Requires Node 22.5+, with no `npm install` needed (it uses Node's built-in SQLite).

```sh
npm start            # http://localhost:3000
```

Accounts are stored in `data/encore.db` (set `DATABASE_PATH` to move it, and set `COOKIE_SECURE=1` behind HTTPS).
Deploy to any host that runs Node with a persistent disk (Render, Fly.io, Railway, a VPS).

The static files still work on their own (for example on GitHub Pages) in guest-only mode, without accounts or Apple Music linking.

### Turning on "Connect Apple Music"
Apple requires a MusicKit developer token, which needs an Apple Developer Program membership:

1. Go to developer.apple.com → Certificates, Identifiers & Profiles → **Identifiers** and create a
   *Media ID* with MusicKit enabled.
2. Go to **Keys**, create a key with *Media Services (MusicKit)*, and download the `.p8` file. Note the Key ID.
3. Start the server with:
   ```sh
   APPLE_TEAM_ID=ABCDE12345 APPLE_KEY_ID=XYZ987TUV1 APPLE_PRIVATE_KEY_PATH=./AuthKey_XYZ987TUV1.p8 npm start
   ```
The server signs short-lived tokens. Your private key never reaches the browser. Never commit the `.p8` file (it is in `.gitignore`).

## Tests
```sh
npm test            # ranking engine + server (accounts, sync, profiles, Apple token)
node tests/e2e.js [screenshotDir]   # every screen and gesture in Chromium at 390px and 1280px,
                                    # against a real server with Apple mocked; saves screenshots
```
