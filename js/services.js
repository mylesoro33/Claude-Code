/*
 * Connected music services.
 *
 *   Apple Music   → MusicKit JS (handled in app.js; needs a developer token)
 *   Spotify       → official OAuth 2.0 with PKCE (no client secret; needs a client id)
 *   SoundCloud    → "Coming soon": SoundCloud isn't registering new API apps
 *   YouTube Music → "Coming soon": no public API for YouTube Music history
 *   Amazon Music  → "Coming soon": the Amazon Music Web API is invite-only
 *
 * Spotify tokens stay in this browser (localStorage); they're never sent to
 * Encore's server.
 */
(function () {
  const SP_KEY = 'encore.spotify';
  const SP_PENDING = 'encore.spotify.pending';
  const SCOPES = 'user-read-recently-played user-top-read';

  const LIST = [
    { key: 'apple', name: 'Apple Music', kind: 'musickit' },
    { key: 'spotify', name: 'Spotify', kind: 'oauth' },
    { key: 'soundcloud', name: 'SoundCloud', kind: 'soon', why: 'SoundCloud isn’t accepting new API apps right now.' },
    { key: 'youtube', name: 'YouTube Music', kind: 'soon', why: 'YouTube Music has no public API for listening history yet.' },
    { key: 'amazon', name: 'Amazon Music', kind: 'soon', why: 'Amazon Music’s API is invite-only for now.' },
  ];

  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const rand = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
  const redirectUri = () => location.origin + location.pathname;
  const read = (k, store = localStorage) => { try { return JSON.parse(store.getItem(k)); } catch (_) { return null; } };
  const write = (k, v, store = localStorage) => { try { v == null ? store.removeItem(k) : store.setItem(k, JSON.stringify(v)); } catch (_) { /* ignore */ } };

  const Spotify = {
    connected: () => !!read(SP_KEY),
    profile: () => (read(SP_KEY) || {}).name || '',
    /** Send the user to Spotify's consent screen. */
    async connect(clientId) {
      const verifier = rand(48);
      const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
      const state = rand(16);
      write(SP_PENDING, { verifier, state, clientId }, sessionStorage);
      const qs = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirectUri(), code_challenge_method: 'S256', code_challenge: challenge, state, scope: SCOPES });
      location.assign('https://accounts.spotify.com/authorize?' + qs);
    },
    /** Finish the OAuth round-trip if this page load is Spotify's redirect. Returns true if it connected. */
    async handleRedirect() {
      const params = new URLSearchParams(location.search);
      const code = params.get('code');
      const pending = read(SP_PENDING, sessionStorage);
      if (!pending || !params.get('state')) return false;
      const clean = () => { write(SP_PENDING, null, sessionStorage); history.replaceState(null, '', location.pathname + location.hash); };
      if (params.get('state') !== pending.state) { clean(); throw new Error('Spotify sign-in didn’t match. Try again.'); }
      if (params.get('error') || !code) { clean(); throw new Error(params.get('error') === 'access_denied' ? 'Spotify connection cancelled.' : 'Spotify sign-in failed.'); }
      const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), client_id: pending.clientId, code_verifier: pending.verifier }),
      });
      clean();
      if (!res.ok) throw new Error('Spotify sign-in failed.');
      const t = await res.json();
      const tok = { access: t.access_token, refresh: t.refresh_token, exp: Date.now() + (t.expires_in - 60) * 1000, clientId: pending.clientId, name: '' };
      write(SP_KEY, tok);
      try { const me = await Spotify.api('/v1/me'); tok.name = me.display_name || me.id || ''; write(SP_KEY, tok); } catch (_) { /* name is optional */ }
      return true;
    },
    async token() {
      const t = read(SP_KEY);
      if (!t) throw new Error('not connected');
      if (Date.now() < t.exp) return t.access;
      const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.clientId }),
      });
      if (!res.ok) { write(SP_KEY, null); throw new Error('Spotify connection expired. Connect again.'); }
      const n = await res.json();
      Object.assign(t, { access: n.access_token, refresh: n.refresh_token || t.refresh, exp: Date.now() + (n.expires_in - 60) * 1000 });
      write(SP_KEY, t);
      return t.access;
    },
    async api(path) {
      const res = await fetch('https://api.spotify.com' + path, { headers: { Authorization: 'Bearer ' + (await Spotify.token()) } });
      if (res.status === 401) { write(SP_KEY, null); throw new Error('Spotify connection expired. Connect again.'); }
      if (!res.ok) throw new Error('Spotify error ' + res.status);
      return res.json();
    },
    /** Recently played tracks as { title, artist } (deduplicated). */
    async recent() {
      const d = await Spotify.api('/v1/me/player/recently-played?limit=40');
      const seen = new Set();
      return (d.items || []).map((i) => i.track).filter((t) => t && !seen.has(t.id) && seen.add(t.id))
        .map((t) => ({ title: t.name, artist: (t.artists && t.artists[0] && t.artists[0].name) || '' }));
    },
    disconnect() { write(SP_KEY, null); },
  };

  window.Services = { LIST, Spotify };
})();
