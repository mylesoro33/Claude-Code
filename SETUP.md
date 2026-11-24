# Encore setup checklist

Everything Encore needs from you: keys, secrets, redirect URIs and the developer-portal steps for each
service. Copy `.env.example` to `.env`, fill in what you have, and restart (`npm start`). Anything you leave
empty switches off cleanly: the app says what's missing instead of failing.

`.env` is git-ignored. Never commit it. On Render, add the same names under **Environment**.

---

## 0. Basics (needed for any connection)

| Variable | What it is | How to get it |
| --- | --- | --- |
| `APP_URL` | Your public address, no trailing slash, e.g. `https://encore-xyz.onrender.com` | Your Render/Fly URL. Every redirect URI below is built from it. Use `http://localhost:3000` locally. |
| `TOKEN_ENCRYPTION_KEY` | 64 hex characters. Encrypts the service tokens Encore stores | Run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `COOKIE_SECURE` | `1` when served over HTTPS | Set to `1` on Render |
| `DATABASE_PATH` | Where accounts, tokens and the chart cache live | Default `./data/encore.db`. On Render, point it at a persistent disk. |

---

## 1. Apple Music (MusicKit JS + server-signed developer token)

| Variable | Value |
| --- | --- |
| `APPLE_TEAM_ID` | 10-character Team ID (developer.apple.com → Membership) |
| `APPLE_KEY_ID` | 10-character Key ID of your MusicKit key |
| `APPLE_PRIVATE_KEY_PATH` | Path to the downloaded `AuthKey_XXXXXXXXXX.p8` (or paste it into `APPLE_PRIVATE_KEY`) |

Steps:
1. Join the **Apple Developer Program** ($99/year).
2. **Certificates, Identifiers & Profiles → Identifiers → +** → *Media IDs* → register one (e.g. `media.com.yourname.encore`) with **MusicKit** enabled.
3. **Keys → +** → tick **Media Services (MusicKit, ShazamKit…)** → *Configure* → pick the Media ID → *Continue* → *Register* → **Download the .p8** (you only get one chance) and note the **Key ID**.
4. No redirect URI: Apple Music sign-in is a MusicKit pop-up, not a redirect.

What works: sign-in, recently played, ❤ (adds the song to the user's library and marks it Loved), list playlists, create playlist, add to playlist.
**Limits:** the user needs an active Apple Music subscription for library and playlist changes. Apple's API can add to playlists but can't remove from them or rename them.

---

## 2. Spotify (OAuth Authorization Code + PKCE)

| Variable | Value |
| --- | --- |
| `SPOTIFY_CLIENT_ID` | From your app's dashboard page |
| `SPOTIFY_CLIENT_SECRET` | Same page (*View client secret*). Used for "Find my account" lookups and server-side token refresh |

Redirect URI to register: **`{APP_URL}/auth/spotify/callback`** (also add `http://127.0.0.1:3000/auth/spotify/callback` for local testing; Spotify no longer accepts `localhost`).

Scopes Encore asks for: `user-read-recently-played user-top-read user-library-read user-library-modify playlist-read-private playlist-modify-public playlist-modify-private`

Steps:
1. developer.spotify.com/dashboard → **Create app** → tick **Web API**.
2. Add the redirect URI(s) above → *Save*.
3. **Settings → User Management**: add the Spotify email of every person who will use Encore (see limits).

**Limits (real ones):**
- A new Spotify app runs in **development mode: only the users you add by email can connect (maximum 25)**. Spotify now grants "extended quota" only to organizations with large audiences (around 250k monthly users), so treat Encore's Spotify connection as invite-only.
- Spotify's API does **not** expose stream counts, and charts.spotify.com has no API. Stream counts come from Kworb (§7).

---

## 3. YouTube Music (Google OAuth + YouTube Data API v3)

YouTube Music has **no official API**. Encore connects through Google sign-in and the YouTube Data API.
YouTube Music likes and playlists are the same as your YouTube ones, so they carry across.

| Variable | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID` | OAuth client ID (*Web application*) |
| `GOOGLE_CLIENT_SECRET` | Its secret |
| `YOUTUBE_API_KEY` | An API key restricted to *YouTube Data API v3* (for "Find my account" lookups of public playlists) |

Redirect URI to register: **`{APP_URL}/auth/youtube/callback`**

Scope Encore asks for: `https://www.googleapis.com/auth/youtube` (read likes and playlists, like videos, create and edit playlists)

Steps:
1. console.cloud.google.com → create a project → **APIs & Services → Library** → enable **YouTube Data API v3**.
2. **OAuth consent screen** → *External* → fill in the app name and support email → add the `…/auth/youtube` scope → add yourself (and testers) under **Test users**.
3. **Credentials → Create credentials → OAuth client ID → Web application** → add the redirect URI above.
4. **Credentials → Create credentials → API key** → restrict it to *YouTube Data API v3*.

**Limits (real ones):**
- **No listening history.** Google removed watch history from the API in 2016. Encore uses your **Liked videos** as your "recently played" source instead.
- **Daily quota of 10,000 units.** A ❤ costs about 150 units (a search plus a like) and "Add to playlist" about 150, so roughly 60 favorites a day across *all* users, unless you request more quota from Google.
- Until Google verifies the app (a review with a privacy policy), only your **Test users (max 100)** can connect, and they'll see an "unverified app" screen.
- Songs are matched to YouTube videos by search, so a ❤ occasionally lands on a live or lyric version.

---

## 4. SoundCloud (OAuth 2.1 + PKCE)

| Variable | Value |
| --- | --- |
| `SOUNDCLOUD_CLIENT_ID` | From your registered app |
| `SOUNDCLOUD_CLIENT_SECRET` | Same place |

Redirect URI to register: **`{APP_URL}/auth/soundcloud/callback`**

Steps:
1. Apply for API access at **soundcloud.com/you/apps** (SoundCloud reviews every new app, and registrations have been paused at times. If the form is closed, their help center links to the current request form).
2. Once approved, set the redirect URI above on the app.

**Limits (real ones):**
- **No listening history** in the public API. Encore uses your **Likes** as the "recent" source.
- ❤ likes the SoundCloud track found by searching for it, and "Add to playlist" uses your SoundCloud playlists.
- Many major-label songs aren't on SoundCloud at all, so the ❤ is skipped with a clear message when no match is found.

---

## 5. Amazon Music (Login with Amazon + Amazon Music Web API)

| Variable | Value |
| --- | --- |
| `AMAZON_CLIENT_ID` | Login with Amazon *security profile* client ID |
| `AMAZON_CLIENT_SECRET` | Its secret |
| `AMAZON_MUSIC_API_KEY` | The `x-api-key` Amazon issues when they approve your Amazon Music API access |

Redirect URI to register (security profile → *Web Settings* → **Allowed Return URLs**): **`{APP_URL}/auth/amazon/callback`**. Add `{APP_URL}` under *Allowed Origins*.

Steps:
1. **Request access** to the Amazon Music Web API (developer.amazon.com → Amazon Music → *Web API*; it's a **closed beta** and Amazon approves each app).
2. developer.amazon.com → **Login with Amazon** → create a **security profile** → copy the client ID and secret.
3. Add the return URL and origin above.

**Limits (real ones):**
- Without Amazon's approval there is **no way** to read or write a user's Amazon Music library. Encore's Connect button runs the real Login with Amazon flow, and then says it's waiting for API access if `AMAZON_MUSIC_API_KEY` is missing.
- The Amazon Music endpoints are written from Amazon's beta documentation and **couldn't be tested without access**. Expect small fixes once you have a key.

---

## 6. Last.fm (Find my account + Most Streamed play counts + genre tags)

| Variable | Value |
| --- | --- |
| `LASTFM_API_KEY` | last.fm/api/account/create → *API key* (the shared secret isn't needed) |

No redirect URI. What it powers: **Find my account** by Last.fm username (recent and top tracks), genre tags for
sorting songs into exactly one genre, and play counts on Most Streamed when Kworb doesn't have a song.

---

## 7. Charts

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
3. **Neither:** Encore's **Current Chart uses Apple Music's genre charts**, labeled "Apple Music", so you still get real, live, genre-specific charts.

Refresh schedule: current charts **daily**, Most Streamed **weekly**. Both are cached in the database, and every chart shows a "last updated" time.
**Weeks on chart / peak:** Billboard supplies these directly. For Apple and Deezer, Encore computes them from its own daily snapshots, so they count from the day your server started tracking.

---

## 8. GitHub Pages (no server)
Pages can't keep secrets, so only browser-safe values work there, in `config.js`: `musickitDeveloperToken`
(from `node scripts/musickit-token.js`), `spotifyClientId` (Spotify PKCE needs no secret) and `lastfmApiKey`.
Google, SoundCloud and Amazon sign-ins, the chart cache, Billboard and Kworb all need the Node server.
