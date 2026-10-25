'use strict';
// One-shot poll (fallback when the server is not running). Prints the same view shape as /api/state, minus history.
const L = require('./lib');
(async () => {
  const cfg = L.loadConfig();
  const now = Date.now();
  const accounts = [];
  for (const a of cfg.accounts) {
    const r = await L.pollAccount(a);
    const eff = w => (!w || w.pct == null) ? null : (w.resetsAt && new Date(w.resetsAt).getTime() <= now ? 0 : w.pct);
    r.eff5 = eff(r.fiveHour); r.eff7 = eff(r.sevenDay);
    r.locked = !!(r.fiveHour?.locked || r.sevenDay?.locked);
    r.effModels = Object.fromEntries(Object.entries(r.models || {}).map(([k, m]) => [k, eff(m)]));
    r.effWeekMax = Math.max(r.eff7 ?? 0, ...Object.values(r.effModels).filter(x => x != null));
    r.headroom = r.eff5 == null ? null : Math.min(100 - r.eff5, 100 - r.effWeekMax);
    accounts.push(r);
  }
  const c = accounts.filter(a => a.headroom != null && !a.locked && a.eff5 < 100 && a.effWeekMax < 100).sort((x, y) => (x.eff5 - y.eff5) || (x.effWeekMax - y.effWeekMax));
  process.stdout.write(JSON.stringify({ generatedAt: new Date(now).toISOString(), pollAgeSec: 0, recommended: c[0]?.id || null, accounts }));
})();
