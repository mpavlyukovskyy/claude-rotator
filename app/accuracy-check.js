'use strict';
/*
 * Standing accuracy check for the dashboard. Optional: run it by hand, or from cron/launchd every 10 min.
 * Independent of server.js view(): it reads what the dashboard SERVES (/api/state) and compares every local
 * card against the raw poll log the poller appends straight from the usage endpoint (history.jsonl).
 * A card whose 5-hour or 7-day window does not line up with its own latest poll, or whose used % is below it
 * inside the same window, is showing someone else's numbers. Two consecutive failing runs alert; recovery
 * sends one note. Alerts go to stdout, and also to ALERT_WEBHOOK (JSON {"text": ...}) when that is set.
 *   node accuracy-check.js              normal run
 *   node accuracy-check.js --self-test  feeds a corrupted card through the checker and alerts, labelled SELF-TEST
 */
const fs = require('fs');
const path = require('path');
const L = require('./lib');

let cfgPort = 7788; try { cfgPort = L.loadConfig().port || 7788; } catch (_) {}
const DASH = process.env.CLAUDE_USAGE_DASH || `http://127.0.0.1:${cfgPort}/api/state`;
const HISTORY = path.join(L.STATE_DIR, 'history.jsonl');
const STATE = path.join(L.STATE_DIR, 'accuracy.json');
const TOL = 5 * 60 * 1000;
const WEEK = 7 * 24 * 3600 * 1000;
const SELF = process.argv.includes('--self-test');

function log(...a) { console.log(new Date().toISOString(), ...a); }

async function alert(text) {
  log('ALERT', text);
  const hook = process.env.ALERT_WEBHOOK;
  if (!hook) return true;
  const r = await fetch(hook, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }), signal: AbortSignal.timeout(10000),
  }).catch(e => ({ ok: false, statusText: e.message }));
  log('alert webhook', r.ok ? 'sent' : 'FAILED ' + r.statusText);
  return r.ok;
}

function latestPolls() {
  const last = {};
  let lines = [];
  try { lines = fs.readFileSync(HISTORY, 'utf8').trim().split('\n').slice(-500); } catch (_) {}
  for (const l of lines) { try { const j = JSON.parse(l); last[j.id] = j; } catch (_) {} }
  return last;
}

// Problems with one card vs its own poll. Empty = the card is telling the truth.
function checkCard(card, poll, now) {
  const bad = [];
  if (card.ok && card.identity && card.identity !== 'token') bad.push(`name unverified (${card.identityError || 'profile call failed'}): card may be labelled with the wrong login`);
  if (poll.e && card.email && poll.e.toLowerCase() !== card.email.toLowerCase()) bad.push(`card is labelled ${card.email} but its latest poll was ${poll.e}`);
  for (const [name, shown, pr, pp, period] of [
    ['5-hour', card.fiveHour, poll.r5, poll.h5, 0],
    ['7-day', card.sevenDay, poll.r7, poll.d7, WEEK],
  ]) {
    const s = shown && shown.resetsAt ? Date.parse(shown.resetsAt) : NaN;
    let p = pr ? Date.parse(pr) : NaN;
    if (!Number.isFinite(p)) continue;
    if (!Number.isFinite(s)) { bad.push(`${name}: card shows no reset, poll says ${pr}`); continue; }
    let rolled = false;
    if (p <= now - TOL) { if (!period) continue; while (p <= now - TOL) p += period; rolled = true; }
    if (Math.abs(s - p) > TOL) bad.push(`${name}: card resets ${new Date(s).toISOString()}, own poll ${new Date(p).toISOString()}`);
    else if (!rolled && shown.pct != null && pp != null && shown.pct < pp - 1) bad.push(`${name}: card ${shown.pct}% used, own poll ${pp}%`);
  }
  return bad;
}

async function main() {
  const now = Date.now();
  let state;
  try { const r = await fetch(DASH, { signal: AbortSignal.timeout(8000) }); state = await r.json(); }
  catch (e) { log('dashboard unreachable', e.message); return; } // liveness is /healthz's job; this checks truth
  const polls = latestPolls();
  let cards = (state.accounts || []).filter(a => !String(a.id).includes(':'));
  if (SELF) {
    // Replay a known failure: one login's card carrying another login's windows.
    cards = [{ id: 'main', label: 'SELF-TEST', fiveHour: { pct: 1, resetsAt: '2026-09-23T01:30:00Z' }, sevenDay: { pct: 65, resetsAt: '2026-09-24T00:00:00Z' } }];
    polls.main = { t: '2026-09-22T22:48:59Z', id: 'main', h5: 100, r5: '2026-09-23T01:20:00Z', d7: 46, r7: '2026-09-29T15:00:00Z' };
  }
  const problems = [];
  for (const c of cards) {
    const p = polls[c.id];
    if (!p) continue;
    if (!SELF && now - Date.parse(p.t) > 20 * 60 * 1000) continue; // stale poll = /healthz territory
    const bad = checkCard(c, p, SELF ? Date.parse('2026-09-22T22:52:00Z') : now);
    if (bad.length) problems.push(`${c.label || c.id} [${c.source || '?'}]: ${bad.join('; ')}`);
  }
  if (SELF) {
    const fired = problems.length > 0;
    log(fired ? 'SELF-TEST detected the corrupted card' : 'SELF-TEST FAILED: corrupted card passed');
    if (fired) await alert(`SELF-TEST (claude-usage accuracy check, ignore): ${problems.join(' | ')}`);
    process.exit(fired ? 0 : 1);
  }
  let st = { strikes: 0, alerted: false };
  try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) {}
  if (problems.length) {
    st.strikes++; st.last = problems;
    log(`INACCURATE (strike ${st.strikes}):`, problems.join(' | '));
    if (st.strikes >= 2 && !st.alerted) st.alerted = await alert(`Claude usage dashboard is showing WRONG numbers:\n${problems.join('\n')}\nSee lib.liveBelongsTo and server.js view()`);
  } else {
    if (st.alerted) await alert('Claude usage dashboard numbers match the polls again (recovered).');
    st = { strikes: 0, alerted: false };
    log(`ok: ${cards.length} local cards match their own polls`);
  }
  st.at = new Date().toISOString();
  fs.writeFileSync(STATE, JSON.stringify(st));
}

main().catch(e => { log('accuracy-check error', e.message); process.exit(1); });
