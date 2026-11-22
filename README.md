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
   Hit "Too tough" to place it right there.
3. Every song gets a 0–10 score from its position. Loved songs sit in the
   6.7–10 band, fine songs in 3.4–6.6, and songs you didn't like in 0–3.3.
   Scores adjust as your list grows.

## Features
- **Discover**: live top-songs chart, plus search across the whole Apple Music catalog (storefront picker)
- **My List**: your full ranked list with scores, filter by text or by group
- **Later**: a want-to-listen bookmark list
- **Profile**: stats, top artists and genres, export/import JSON, reset
- Tap any artwork to play the 30-second preview
- Installable as a PWA. Data is stored locally in the browser.

## Run it
It's a static site with no build step:

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

Or deploy the folder to any static host (GitHub Pages, Netlify, Vercel).

## Tests
```sh
node --test tests/ranking.test.js   # ranking engine
node tests/e2e.js                   # UI flow in Chromium, Apple API mocked (needs playwright)
```
