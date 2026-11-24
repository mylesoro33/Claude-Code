'use strict';
/**
 * JSON-over-HTTP helper bound to a base URL and auth headers.
 * Errors carry .status and .data so callers can tell "expired token" from "not found".
 */
function makeCall(fetchImpl, base, getHeaders = async () => ({})) {
  return async function call(path, { method = 'GET', query, body, form, headers: extra } = {}) {
    const url = new URL(/^https?:/.test(path) ? path : base + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    const headers = { Accept: 'application/json', ...(await getHeaders()), ...(extra || {}) };
    let payload;
    if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    let res;
    try { res = await fetchImpl(url.toString(), { method, headers, body: payload }); }
    catch (e) { const err = new Error('Couldn’t reach ' + url.hostname); err.status = 502; throw err; }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const msg = (data && (data.error_description || (data.error && (data.error.message || data.error)) || data.message)) || `HTTP ${res.status}`;
      const err = new Error(typeof msg === 'string' ? msg : `HTTP ${res.status}`);
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  };
}
module.exports = { makeCall };
