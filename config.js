/*
 * Encore client config, only for hosting without the Node server (for example
 * GitHub Pages). With the server, use .env instead (see SETUP.md) and leave this empty.
 *
 *  - lastfmApiKey: from last.fm/api/account/create. Turns on the Most Streamed tab
 *    (Last.fm play counts) when there's no server. It ships to every browser.
 */
window.ENCORE_CONFIG = {
  lastfmApiKey: '',
};
