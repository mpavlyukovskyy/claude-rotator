'use strict';
// Regression: a status-line record from ANOTHER login must never be shown on this account's card.
// Captured case: login A's own poll said 5-hour 100% used (resets 01:20Z), 7-day 46% (resets 29 Sep 15:00Z);
// A's live file carried login B's windows (5-hour 1%, resets 01:30Z; 7-day 65%, resets 24 Sep 00:00Z) and the
// card showed "5-hour 99% left". Run: node test/live-identity.test.js [path/to/lib.js]
const path = require('path');
const L = require(path.resolve(process.argv[2] || path.join(__dirname, '..', 'app', 'lib.js')));
const now = Date.parse('2026-09-22T22:51:56Z');
const aPoll = { fiveHour: { pct: 100, resetsAt: '2026-09-23T01:20:00.424212+00:00' }, sevenDay: { pct: 46, resetsAt: '2026-09-29T15:00:00.424235+00:00' } };
const bPoll = { fiveHour: { pct: 1, resetsAt: '2026-09-23T01:29:59.632566+00:00' }, sevenDay: { pct: 66, resetsAt: '2026-09-23T23:59:59.632604+00:00' } };
const cPoll = { fiveHour: { pct: 0, resetsAt: '2026-09-23T01:09:59.845180+00:00' }, sevenDay: { pct: 65, resetsAt: '2026-09-24T00:59:59.845201+00:00' } };
const foreign = { at: '2026-09-22T22:51:56.341Z', h5: 1, r5: '2026-09-23T01:30:00.000Z', d7: 65, r7: '2026-09-24T00:00:00.000Z' };
let fails = 0;
function t(name, got, want) {
  const pass = got.ok === want;
  if (!pass) fails++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${got.reason ? ' (' + got.reason + ')' : ''}`);
}
t('B live record on A card is rejected', L.liveBelongsTo(foreign, aPoll, now), false);
t('B live record on its own card is accepted', L.liveBelongsTo(foreign, bPoll, now), true);
t('7-day resets 1h apart (C vs B) still rejected', L.liveBelongsTo(foreign, cPoll, now), false);
t('own record, usage moved on inside the window, accepted',
  L.liveBelongsTo({ h5: 100, r5: '2026-09-23T01:20:00Z', d7: 47, r7: '2026-09-29T15:00:00Z' }, aPoll, now), true);
t('same windows but used % went backwards, rejected',
  L.liveBelongsTo({ h5: 2, r5: '2026-09-23T01:20:00Z', d7: 47, r7: '2026-09-29T15:00:00Z' }, aPoll, now), false);
t('weekly window rolled since the poll: next week\'s reset accepted',
  L.liveBelongsTo({ h5: 3, r5: '2026-09-30T20:00:00Z', d7: 1, r7: '2026-10-06T15:00:00Z' }, aPoll, Date.parse('2026-09-30T16:00:00Z')), true);
t('no poll to verify against, rejected', L.liveBelongsTo(foreign, null, now), false);
t('nothing comparable, rejected', L.liveBelongsTo({ h5: 1, r5: null, d7: null, r7: null }, aPoll, now), false);
console.log(fails ? `LIVE-IDENTITY: ${fails} FAILED` : 'LIVE-IDENTITY: ALL PASS');
process.exit(fails ? 1 : 0);
