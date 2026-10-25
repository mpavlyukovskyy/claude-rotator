'use strict';
// Prepares the config dir of every non-default account (or only the ids given as arguments):
//   - creates the dir (mode 0700),
//   - symlinks the shared parts of ~/.claude into it, so skills, settings, memory and session history
//     follow you across accounts (`ccr --resume` works on any account),
//   - seeds .claude.json (onboarding state, prefs) from ~/.claude.json minus the account identity,
//     so /login is the only step left.
// Never touches an entry that already exists. Usage: node setup-dirs.js [id ...]
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const SHARE = ['CLAUDE.md', 'settings.json', 'skills', 'agents', 'commands', 'hooks', 'plugins', 'projects', 'keybindings.json', 'rules'];

function setupDir(acct) {
  const main = path.join(L.HOME, '.claude');
  const dir = acct.configDir;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const linked = [];
  for (const s of SHARE) {
    const from = path.join(main, s), to = path.join(dir, s);
    if (!fs.existsSync(from)) continue;
    try { fs.lstatSync(to); continue; } catch (_) {}
    fs.symlinkSync(from, to);
    linked.push(s);
  }
  const seed = path.join(dir, '.claude.json'), src = path.join(L.HOME, '.claude.json');
  let seeded = false;
  if (!fs.existsSync(seed) && fs.existsSync(src)) {
    try {
      const j = JSON.parse(fs.readFileSync(src, 'utf8'));
      delete j.oauthAccount; delete j.userID;
      fs.writeFileSync(seed, JSON.stringify(j, null, 2), { mode: 0o600 });
      seeded = true;
    } catch (e) { console.error(`could not seed ${seed}: ${e.message}`); }
  }
  console.log(`account dir ready: ${acct.id} -> ${dir}${linked.length ? ' (linked ' + linked.join(', ') + ')' : ''}${seeded ? ' (seeded .claude.json)' : ''}`);
}

if (require.main === module) {
  const cfg = L.loadConfig();
  const want = new Set(process.argv.slice(2));
  for (const a of cfg.accounts) {
    if (a.default) continue;
    if (want.size && !want.has(a.id)) continue;
    setupDir(a);
  }
}

module.exports = { setupDir, SHARE };
