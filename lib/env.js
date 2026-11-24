/*
 * Tiny .env loader (no dependency). Reads KEY=VALUE lines from .env next to
 * server.js into process.env without overriding variables already set (so
 * Render's dashboard values win). Supports quotes and \n escapes.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function parse(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      const dq = v.startsWith('"');
      v = v.slice(1, -1);
      if (dq) v = v.replace(/\\n/g, '\n');
    } else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

function load(dir = path.join(__dirname, '..')) {
  const file = path.join(dir, '.env');
  if (!fs.existsSync(file)) return {};
  const vars = parse(fs.readFileSync(file, 'utf8'));
  for (const [k, v] of Object.entries(vars)) if (process.env[k] === undefined) process.env[k] = v;
  return vars;
}

module.exports = { parse, load };
