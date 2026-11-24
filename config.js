/*
 * Encore client config — fill these in when you host without the Node server
 * (for example on GitHub Pages). With the server, set the environment variables
 * instead (see README) and leave these empty.
 *
 * All three values are designed to be public (they ship to every browser):
 *  - musickitDeveloperToken: a MusicKit developer token (JWT). Generate one with
 *      APPLE_TEAM_ID=… APPLE_KEY_ID=… APPLE_PRIVATE_KEY_PATH=… node scripts/musickit-token.js
 *    and restrict its origin in the Apple Developer portal. Tokens last up to 6 months.
 *  - spotifyClientId: from developer.spotify.com/dashboard. Add this site's URL as a Redirect URI.
 *  - lastfmApiKey: from last.fm/api/account/create. Powers the "Most Streamed" charts.
 */
window.ENCORE_CONFIG = {
  musickitDeveloperToken: '',
  spotifyClientId: '',
  lastfmApiKey: '',
};
