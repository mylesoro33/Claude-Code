'use strict';
/*
 * OAuth broker for Spotify, YouTube (Google), SoundCloud and Amazon.
 *
 *  GET /auth/:service/start     → redirects to the provider's consent screen (state + PKCE)
 *  GET /auth/:service/callback  → exchanges the code (server-side, with the secret), stores
 *                                 the tokens encrypted, redirects back into the app
 *
 * Tokens are refreshed quietly whenever they're about to expire. If a refresh is
 * refused (the user revoked access), the connection is removed and callers get a
 * 401 with { reauth: true } so the app can offer "Reconnect".
 *
 * Apple Music isn't here: Apple's sign-in is MusicKit JS in the browser.
 */
const crypto = require('node:crypto');
const { makeCall } = require('./http');
const ADAPTERS = {
  spotify: require('./services/spotify'),
  youtube: require('./services/youtube'),
  soundcloud: require('./services/soundcloud'),
  amazon: require('./services/amazon'),
};

const PROVIDERS = {
  spotify: {
    name: 'Spotify', auth: 'https://accounts.spotify.com/authorize', token: 'https://accounts.spotify.com/api/token',
    scope: 'user-read-recently-played user-top-read user-library-read user-library-modify playlist-read-private playlist-modify-public playlist-modify-private',
    idEnv: 'SPOTIFY_CLIENT_ID', secretEnv: 'SPOTIFY_CLIENT_SECRET', secretOptional: true, basic: true,
  },
  youtube: {
    name: 'YouTube Music', auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/youtube', idEnv: 'GOOGLE_CLIENT_ID', secretEnv: 'GOOGLE_CLIENT_SECRET',
    extra: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  },
  soundcloud: {
    name: 'SoundCloud', auth: 'https://secure.soundcloud.com/authorize', token: 'https://secure.soundcloud.com/oauth/token',
    scope: '', idEnv: 'SOUNDCLOUD_CLIENT_ID', secretEnv: 'SOUNDCLOUD_CLIENT_SECRET', authScheme: 'OAuth',
  },
  amazon: {
    name: 'Amazon Music', auth: 'https://www.amazon.com/ap/oa', token: 'https://api.amazon.com/auth/o2/token',
    scope: 'profile', idEnv: 'AMAZON_CLIENT_ID', secretEnv: 'AMAZON_CLIENT_SECRET',
  },
};
const b64url = (b) => Buffer.from(b).toString('base64url');

function createBroker({ db, env, fetch, box, log = () => {} }) {
  db.exec(`CREATE TABLE IF NOT EXISTS service_tokens (
    owner TEXT NOT NULL, service TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner, service))`);
  const q = {
    get: db.prepare('SELECT data FROM service_tokens WHERE owner = ? AND service = ?'),
    all: db.prepare('SELECT service, data FROM service_tokens WHERE owner = ?'),
    put: db.prepare(`INSERT INTO service_tokens (owner, service, data, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(owner, service) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`),
    del: db.prepare('DELETE FROM service_tokens WHERE owner = ? AND service = ?'),
    move: db.prepare('UPDATE OR IGNORE service_tokens SET owner = ? WHERE owner = ?'),
    purge: db.prepare('DELETE FROM service_tokens WHERE owner = ?'),
  };
  const pending = new Map(); // state → { owner, service, verifier, at }
  const appUrl = () => String(env.APP_URL || '').replace(/\/+$/, '');
  const redirectUri = (svc) => `${appUrl()}/auth/${svc}/callback`;

  function missing(svc) {
    const p = PROVIDERS[svc];
    const need = [p.idEnv, ...(p.secretOptional ? [] : [p.secretEnv])].filter((k) => !env[k]);
    if (!env.APP_URL) need.push('APP_URL');
    return need;
  }
  const configured = (svc) => !!PROVIDERS[svc] && !missing(svc).length;

  function read(owner, svc) {
    const row = q.get.get(owner, svc);
    return row ? box.open(row.data) : null;
  }
  function write(owner, svc, data) { q.put.run(owner, svc, box.seal(data), Date.now()); }

  function start(svc, owner) {
    const p = PROVIDERS[svc];
    if (!configured(svc)) throw Object.assign(new Error(`${p.name} isn’t set up on this server yet.`), { status: 501, missing: missing(svc) });
    for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60e3) pending.delete(k);
    const state = b64url(crypto.randomBytes(18));
    const verifier = b64url(crypto.randomBytes(48));
    pending.set(state, { owner, service: svc, verifier, at: Date.now() });
    const qs = new URLSearchParams({
      client_id: env[p.idEnv], response_type: 'code', redirect_uri: redirectUri(svc), state,
      code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
      ...(p.scope ? { scope: p.scope } : {}), ...(p.extra || {}),
    });
    return `${p.auth}?${qs}`;
  }

  async function tokenRequest(svc, form) {
    const p = PROVIDERS[svc];
    const headers = {};
    const body = { ...form, client_id: env[p.idEnv] };
    if (env[p.secretEnv]) {
      if (p.basic) headers.Authorization = 'Basic ' + Buffer.from(`${env[p.idEnv]}:${env[p.secretEnv]}`).toString('base64');
      else body.client_secret = env[p.secretEnv];
    }
    return makeCall(fetch, '')(p.token, { method: 'POST', form: body, headers });
  }

  /** Finish the round-trip. Returns { owner, service, account }. */
  async function callback(svc, query) {
    const st = pending.get(query.state || '');
    if (!st || st.service !== svc) throw Object.assign(new Error('That sign-in link expired. Try connecting again.'), { status: 400 });
    pending.delete(query.state);
    if (query.error || !query.code) throw Object.assign(new Error(query.error === 'access_denied' ? 'Connection cancelled.' : `${PROVIDERS[svc].name} sign-in failed.`), { status: 400 });
    const t = await tokenRequest(svc, { grant_type: 'authorization_code', code: query.code, redirect_uri: redirectUri(svc), code_verifier: st.verifier });
    const data = { access: t.access_token, refresh: t.refresh_token || null, exp: Date.now() + ((t.expires_in || 3600) - 60) * 1000, account: '', connectedAt: Date.now() };
    write(st.owner, svc, data);
    try { data.account = await adapter(st.owner, svc).account(); write(st.owner, svc, data); } catch (e) { log(`${svc} account name: ${e.message}`); }
    return { owner: st.owner, service: svc, account: data.account };
  }

  /** A valid access token, refreshed quietly when needed. */
  async function access(owner, svc) {
    const data = read(owner, svc);
    if (!data) throw Object.assign(new Error(`Connect ${PROVIDERS[svc].name} first.`), { status: 401, reauth: true });
    if (Date.now() < data.exp) return data.access;
    if (!data.refresh) { q.del.run(owner, svc); throw Object.assign(new Error(`${PROVIDERS[svc].name} needs you to reconnect.`), { status: 401, reauth: true }); }
    try {
      const t = await tokenRequest(svc, { grant_type: 'refresh_token', refresh_token: data.refresh });
      Object.assign(data, { access: t.access_token, refresh: t.refresh_token || data.refresh, exp: Date.now() + ((t.expires_in || 3600) - 60) * 1000 });
      write(owner, svc, data);
      return data.access;
    } catch (e) {
      if (e.status === 400 || e.status === 401) { q.del.run(owner, svc); throw Object.assign(new Error(`${PROVIDERS[svc].name} access was revoked. Reconnect to keep syncing.`), { status: 401, reauth: true }); }
      throw e;
    }
  }

  /** The service adapter, with calls that carry a fresh token and retry once on 401. */
  function adapter(owner, svc) {
    const mod = ADAPTERS[svc];
    const scheme = PROVIDERS[svc].authScheme || 'Bearer';
    const raw = makeCall(fetch, mod.base, async () => ({ Authorization: `${scheme} ${await access(owner, svc)}` }));
    const call = async (path, opts) => {
      try { return await raw(path, opts); }
      catch (e) {
        if (e.status !== 401) throw e;
        const data = read(owner, svc);
        if (data) { data.exp = 0; write(owner, svc, data); } // force a refresh, then retry once
        return raw(path, opts);
      }
    };
    return mod.api({ call, env, fetch });
  }

  function list(owner) {
    const have = Object.fromEntries(q.all.all(owner).map((r) => [r.service, box.open(r.data)]));
    return Object.keys(PROVIDERS).map((svc) => ({
      service: svc, name: PROVIDERS[svc].name, configured: configured(svc), missing: missing(svc),
      connected: !!have[svc], account: (have[svc] && have[svc].account) || '',
      waiting: svc === 'amazon' && !!have[svc] && !env.AMAZON_MUSIC_API_KEY,
    }));
  }

  return {
    PROVIDERS, configured, missing, start, callback, access, adapter, list, redirectUri,
    disconnect: (owner, svc) => q.del.run(owner, svc),
    /** Move a guest device's connections to the account that just signed in. */
    adopt: (from, to) => { q.move.run(to, from); q.purge.run(from); },
    _write: write,
  };
}

module.exports = { createBroker, PROVIDERS, ADAPTERS };
