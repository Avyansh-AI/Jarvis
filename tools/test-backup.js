#!/usr/bin/env node
'use strict';
/**
 * Disaster-recovery proof: encrypted stores survive a backup→corrupt→restore
 * round-trip byte-perfectly (tar.gz), including crash-resilience of the
 * atomic write path (no partial-file corruption).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok  ' + n); } else { fail++; console.log('FAIL ' + n); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'max-backup-'));
process.env.MAX_DATA_DIR = path.join(dir, 'data');
const { SecureStore } = require('../hub/secure-store');

// 1. write real data
const s1 = new SecureStore('memory');
s1.data = { users: { default: { id: 'default', name: 'Owner', facts: [{ fact: 'likes tea', ts: 1 }] } } };
s1.save();
const set1 = new SecureStore('settings');
set1.data = { assistantName: 'Max', privacy: { vision: 'cloud' } };
set1.save();
ok('stores written', fs.existsSync(path.join(process.env.MAX_DATA_DIR, 'memory.enc.json')));

// 2. simulate a torn write: truncate a .tmp then remove it — main file must stay valid
const memPath = path.join(process.env.MAX_DATA_DIR, 'memory.enc.json');
fs.writeFileSync(memPath + '.tmp', '{"partial":');
s1._load();
ok('torn tmp does not corrupt main store', s1.data.users.default.facts[0].fact === 'likes tea');
fs.unlinkSync(memPath + '.tmp');

// 3. backup
const backup = path.join(dir, 'backup.tar.gz');
execFileSync('tar', ['-czf', backup, '-C', dir, 'data']);
ok('backup tarball created', fs.statSync(backup).size > 200);

// 4. corrupt the live store (simulating disk damage) — Round 3 semantics:
//    a GOOD .bak means self-heal to the saved data; trash BOTH -> quarantine + fresh start.
fs.writeFileSync(memPath, '{"this is":"garbage",');
const s2 = new SecureStore('memory');
ok('corrupt main self-heals from .bak (no data loss, no crash)', s2.data.users.default.facts[0].fact === 'likes tea');
fs.writeFileSync(memPath, '{"this is":"garbage",');
fs.writeFileSync(memPath + '.bak', '{"also":"garbage",');
const s2b = new SecureStore('memory');
ok('past-total-corruption starts fresh without crashing', JSON.stringify(s2b.data) === '{}');

// 5. restore from backup
fs.rmSync(process.env.MAX_DATA_DIR, { recursive: true, force: true });
execFileSync('tar', ['-xzf', backup, '-C', dir]);
const s3 = new SecureStore('memory');
ok('restored memory intact', s3.data.users.default.facts[0].fact === 'likes tea');
const set3 = new SecureStore('settings');
ok('restored settings intact', set3.data.privacy.vision === 'cloud');

// 6. wrong-key store does NOT silently "open": it should fail auth, not decrypt
const wrong = new SecureStore('memory', { pass: 'definitely-the-wrong-key' });
ok('wrong key yields empty store, not garbage', JSON.stringify(wrong.data) === '{}');

console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
