'use strict';
// Claude Code statusLine command. Reads the session JSON on stdin, records live
// rate-limit numbers for the dashboard, prints a one-line status.
const fs = require('fs');
const path = require('path');
const L = require('./lib');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  let j = {}; try { j = JSON.parse(input); } catch (_) {}
  let cfg; try { cfg = L.loadConfig(); } catch (_) { cfg = { accounts: [] }; }
  const dir = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : null;
  let acct = cfg.accounts.find(a => dir ? a.configDir === dir : a.default) || { id: 'unknown', label: dir ? path.basename(dir) : 'Main' };
  // `ccr pick --env` and `ccr run` set CLAUDE_PICK_ACCOUNT for the account whose token the session runs on.
  // Attribute live usage to THAT account whenever it is set. Do NOT gate this on CLAUDE_CODE_OAUTH_TOKEN:
  // Claude Code strips that variable from the statusline's environment, so a token-gated check never fires.
  if (process.env.CLAUDE_PICK_ACCOUNT) {
    // Ids are matched as-is: no id is an alias for another (an alias goes wrong the moment a dir is re-logged).
    const pid = process.env.CLAUDE_PICK_ACCOUNT;
    acct = cfg.accounts.find(a => a.id === pid) || { id: null, label: pid };
  }
  if (acct.configDir) acct = { ...acct, label: L.labelFor(L.readIdentity(acct).email, cfg, acct.label) };
  const rl = j.rate_limits || {};
  const toIso = s => (s == null ? null : new Date(Number(s) * 1000).toISOString());
  const h5 = rl.five_hour?.used_percentage, d7 = rl.seven_day?.used_percentage;
  // The env guess above is only a guess: a session keeps the login it started with after its dir is re-logged.
  // The session's own reset times identify the account, so match them against the polled accounts and trust
  // the match over the guess. No match = write nothing (the dashboard would reject it anyway) and say so.
  const rec = { h5, r5: toIso(rl.five_hour?.resets_at), d7, r7: toIso(rl.seven_day?.resets_at) };
  let verified = false;
  if (h5 != null || d7 != null) {
    let st = null; try { st = JSON.parse(fs.readFileSync(path.join(L.STATE_DIR, 'state.json'), 'utf8')); } catch (_) {}
    if (st) {
      const refOf = a => a.ok ? a : a.lastGood;
      const local = (st.accounts || []).find(a => refOf(a) && L.liveBelongsTo(rec, refOf(a)).ok);
      const remote = !local && [].concat(...(st.remotes || []).map(r => r.accounts || [])).find(a => a.ok && L.liveBelongsTo(rec, a).ok);
      const hit = local || remote;
      if (hit) { acct = { id: local ? hit.id : null, label: L.labelFor(hit.email, cfg, hit.label) }; verified = true; }
      else acct = { id: null, label: `${acct.label}?` };
    }
  }
  if (acct.id && verified && (h5 != null || d7 != null)) {
    try {
      fs.mkdirSync(L.LIVE_DIR, { recursive: true });
      fs.writeFileSync(path.join(L.LIVE_DIR, acct.id + '.json'), JSON.stringify({ at: new Date().toISOString(), ...rec }));
    } catch (_) {}
  }
  const bar = p => { if (p == null) return '-'; const n = Math.round(Math.min(100, Math.max(0, p)) / 20); return '█'.repeat(n) + '░'.repeat(5 - n) + ' ' + Math.round(p) + '%'; };
  const model = j.model?.display_name ? ` · ${j.model.display_name}` : '';
  const ctx = j.context_window?.used_percentage != null ? ` · ctx ${Math.round(j.context_window.used_percentage)}%` : '';
  process.stdout.write(`[${acct.label}] 5h ${bar(h5)} · 7d ${bar(d7)}${model}${ctx}`);
});
