'use strict';
// Node side of `ccr` and shell.sh (no python3 needed). Subcommands:
//   port                       print the dashboard port from accounts.json
//   ls                         read /api/state JSON on stdin, print the usage table
//   pick <notIds> <env 0|1>    read /api/state JSON on stdin, print the best account (exit 2 if none)
//   resolve <id|N>             print "<id>\t<dir>\t<isDefault 1|0>\t<label>" for a configured account
//   add <name>                 append an account to accounts.json, print its config dir
//   label                      print the label of the account this shell uses (for window titles)
//   reregister <dir>           append every account dir in <dir> (~/.claude-accounts) that accounts.json lacks
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./lib');

const [cmd, ...args] = process.argv.slice(2);
const die = (msg, code = 1) => { process.stderr.write(msg + '\n'); process.exit(code); };
const readStdin = () => { try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; } };
const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const RESERVED = new Set(['ls', 'list', 'web', 'open', 'pick', 'add', 'run', 'help', 'ui', 'login', 'mcp']);
const shq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";

function cfgOrDie() {
  try { return L.loadConfig(); } catch (e) { return die('ccr: ' + e.message); }
}

// Usable local accounts in the dashboard's own order (server.js view(): last-resort accounts after the
// rest, then Fable headroom first, then the earliest full reset), so `ccr` agrees with "use next".
function candidates(v, not) {
  return (v.accounts || [])
    .filter(a => !a.remote && a.configDir && a.ok !== false && (a.drainTier ?? 0) < 2 && !not.has(a.id)
      && a.headroom != null && !a.locked && a.eff5 < 100 && (a.eff7 ?? 0) < 100);
}

switch (cmd) {
  case 'port': {
    let port = 7788;
    try { port = JSON.parse(fs.readFileSync(L.CONFIG_PATH, 'utf8')).port || 7788; } catch (_) {}
    console.log(port);
    break;
  }
  case 'ls': {
    const v = JSON.parse(readStdin() || '{}');
    const pad = (x, n) => String(x ?? '').padEnd(n);
    const best = candidates(v, new Set())[0];
    console.log(pad('ACCOUNT', 16) + pad('EMAIL', 34) + pad('5h left', 9) + pad('7d left', 9) + pad('MODEL CAPS', 26) + 'NOTE');
    for (const a of v.accounts || []) {
      const l5 = a.eff5 == null ? '-' : Math.round(100 - a.eff5) + '%', l7 = a.eff7 == null ? '-' : Math.round(100 - a.eff7) + '%';
      const mc = Object.entries(a.models || {}).map(([k, m]) => m.name + ' ' + (a.effModels?.[k] == null ? '-' : Math.round(100 - a.effModels[k]) + '% left')).join(', ');
      const note = [best && a.id === best.id ? '<- use next' : '', a.activeSession ? 'active' : '', a.stale ? 'stale' : '',
        a.needsLogin ? 'NOT LOGGED IN' : '', a.locked ? 'LOCKED' : '', a.ok === false && !a.needsLogin && a.error ? 'ERROR: ' + String(a.error).slice(0, 60) : ''].filter(Boolean).join(' ');
      console.log(pad(a.id === a.label || !a.label ? a.id : `${a.id} (${a.label})`, 16) + pad(a.email || '', 34) + pad(l5, 9) + pad(l7, 9) + pad(mc, 26) + note);
    }
    break;
  }
  case 'pick': {
    const v = JSON.parse(readStdin() || '{}');
    const not = new Set(String(args[0] || '').split(',').filter(Boolean));
    const c = candidates(v, not);
    if (!c.length) die('ccr pick: no account with headroom (run `ccr ls` to see why)', 2);
    const a = c[0];
    if (args[1] !== '1') { process.stdout.write(`${a.id}\t${a.configDir}\t${a.default ? 1 : 0}\n`); break; }
    const out = [`export CLAUDE_USAGE_ACCOUNT=${shq(a.id)}`, `export CLAUDE_PICK_ACCOUNT=${shq(a.id)}`,
      a.default ? 'unset CLAUDE_CONFIG_DIR' : `export CLAUDE_CONFIG_DIR=${shq(a.configDir)}`];
    const t = L.inferenceToken(a.id);
    out.push(t ? `export CLAUDE_CODE_OAUTH_TOKEN=${shq(t)}` : 'unset CLAUDE_CODE_OAUTH_TOKEN');
    process.stdout.write(out.join('\n') + '\n');
    break;
  }
  case 'resolve': {
    const cfg = cfgOrDie();
    const p = String(args[0] || '');
    const a = /^[0-9]+$/.test(p) ? cfg.accounts[Number(p) - 1] : cfg.accounts.find(x => x.id === p);
    if (!a) die(`ccr: unknown account "${p}" (configured: ${cfg.accounts.map(x => x.id).join(', ') || 'none'}). Add one with: ccr add <name>`);
    // Name it after the LOGIN in that dir, like the dashboard does; fall back to the configured label.
    const label = L.labelFor(L.readIdentity(a).email, cfg, a.label || a.id);
    console.log([a.id, a.configDir, a.default ? 1 : 0, label].join('\t'));
    break;
  }
  case 'add': {
    const name = String(args[0] || '');
    // A name must not read as a ccr subcommand or as an account number (`ccr 2` means the 2nd account).
    if (!NAME_RE.test(name)) die('ccr add: name must be 1-32 chars of a-z, 0-9, _ or -, starting with a letter');
    if (RESERVED.has(name)) die(`ccr add: "${name}" is a ccr command; pick another name`);
    if (fs.existsSync(L.CONFIG_PATH) === false) die(`ccr add: no accounts file at ${L.CONFIG_PATH}. Run install.sh first.`);
    const raw = JSON.parse(fs.readFileSync(L.CONFIG_PATH, 'utf8'));
    raw.accounts = raw.accounts || [];
    if (raw.accounts.some(a => a.id === name)) die(`ccr add: account "${name}" already exists`);
    const configDir = `~/.claude-accounts/${name}`;
    raw.accounts.push({ id: name, label: name, configDir });
    fs.writeFileSync(L.CONFIG_PATH + '.tmp', JSON.stringify(raw, null, 2) + '\n');
    fs.renameSync(L.CONFIG_PATH + '.tmp', L.CONFIG_PATH);
    console.log(path.join(os.homedir(), '.claude-accounts', name));
    break;
  }
  case 'label': {
    // Which account does THIS shell use? CLAUDE_PICK_ACCOUNT, else CLAUDE_CONFIG_DIR, else the default.
    let cfg; try { cfg = L.loadConfig(); } catch (_) { break; }
    const pick = process.env.CLAUDE_PICK_ACCOUNT, d = process.env.CLAUDE_CONFIG_DIR;
    const real = p => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };
    let a = pick ? cfg.accounts.find(x => x.id === pick) : null;
    if (!a && pick) { console.log(pick); break; }
    if (!a && d) a = cfg.accounts.find(x => real(x.configDir) === real(d));
    if (!a) a = cfg.accounts.find(x => x.default);
    if (a) console.log(L.labelFor(L.readIdentity(a).email, cfg, a.label || a.id));
    break;
  }
  case 'reregister': {
    // After an uninstall that kept ~/.claude-accounts, a reinstall gets those accounts back. Existing entries,
    // their order and their flags (lastResort, label, ...) stay as they are; new dirs go at the end.
    const dir = String(args[0] || path.join(os.homedir(), '.claude-accounts'));
    const raw = JSON.parse(fs.readFileSync(L.CONFIG_PATH, 'utf8'));
    raw.accounts = raw.accounts || [];
    const real = p => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };
    const known = new Set(raw.accounts.map(a => real(String(a.configDir || '').replace(/^~/, os.homedir()))));
    let names = []; try { names = fs.readdirSync(dir).sort(); } catch (_) {}
    const added = [];
    for (const n of names) {
      const full = path.join(dir, n);
      let why = '';
      let isDir = false; try { isDir = fs.statSync(full).isDirectory(); } catch (_) {}
      if (!isDir) why = 'not a directory';
      else if (!NAME_RE.test(n)) why = 'name must be 1-32 chars of a-z, 0-9, _ or -, starting with a letter';
      else if (RESERVED.has(n)) why = 'name is a ccr command';
      else if (known.has(real(full))) continue; // already configured
      else if (raw.accounts.some(a => a.id === n)) why = `id "${n}" is already used by another config dir`;
      if (why) { console.log(`skipped ${full}: ${why}`); continue; }
      raw.accounts.push({ id: n, label: n, configDir: `~/.claude-accounts/${n}` });
      added.push(n);
    }
    if (added.length) {
      fs.writeFileSync(L.CONFIG_PATH + '.tmp', JSON.stringify(raw, null, 2) + '\n');
      fs.renameSync(L.CONFIG_PATH + '.tmp', L.CONFIG_PATH);
      console.log('re-registered from ' + dir.replace(os.homedir(), '~') + ': ' + added.join(', '));
    }
    break;
  }
  default:
    die(`ccr-helper: unknown command ${cmd}`);
}
