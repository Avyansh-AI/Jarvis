'use strict';
/** Tiny zero-dependency .env loader — real environment variables always win. */
const fs = require('fs');
const path = require('path');

module.exports = function loadEnv(file = path.join(__dirname, '..', '.env')) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (/^\s*(#|$)/.test(line)) continue;
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      if (process.env[m[1]] !== undefined) continue;
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env — fine */ }
};
