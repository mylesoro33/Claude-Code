/*
 * Encrypts service tokens at rest (AES-256-GCM) with TOKEN_ENCRYPTION_KEY.
 * Without a key a random one is generated per process: tokens then survive
 * only until restart, and the server logs a warning.
 */
'use strict';
const crypto = require('node:crypto');

function createBox(hexKey, log = console.warn) {
  let key = hexKey && /^[0-9a-f]{64}$/i.test(hexKey) ? Buffer.from(hexKey, 'hex') : null;
  if (!key) {
    if (hexKey) log('TOKEN_ENCRYPTION_KEY must be 64 hex characters; using a temporary key.');
    else log('TOKEN_ENCRYPTION_KEY is not set; connected services will need reconnecting after a restart.');
    key = crypto.randomBytes(32);
  }
  return {
    seal(obj) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
      return [iv, c.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
    },
    open(sealed) {
      try {
        const [iv, tag, data] = sealed.split('.').map((s) => Buffer.from(s, 'base64url'));
        const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
        d.setAuthTag(tag);
        return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString('utf8'));
      } catch { return null; }
    },
  };
}

module.exports = { createBox };
