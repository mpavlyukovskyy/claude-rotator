'use strict';
// Setup UI in a real Chromium (Playwright). Expects a dashboard from test/ui-harness.sh (fake providers,
// fake gateway key) at $UI_URL. Run through test/ui-browser.sh, which starts that dashboard.
//   UI_URL=http://127.0.0.1:18350 OUT=<screenshot dir> GW_KEY=<the fake gateway key> node test/ui-browser.js
// Off macOS the server never offers "Open login in Terminal", so the test patches /api/setup to say
// canOpenTerminal and answers the open-login call itself: the button's wiring is checked here, the
// route itself in ui.test.sh.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL0 = process.env.UI_URL || 'http://127.0.0.1:18350';
const OUT = process.env.OUT || path.join(__dirname, 'ui-shots');
const GW_KEY = process.env.GW_KEY || '';
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`); };

async function setupPage(context, errors) {
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', r => errors.push('requestfailed: ' + r.url()));
  await page.route('**/api/setup', async route => {
    const r = await route.fetch(); const j = await r.json(); j.canOpenTerminal = true;
    await route.fulfill({ response: r, json: j });
  });
  let opened = [];
  await page.route('**/api/accounts/*/open-login', async route => {
    opened.push({ url: route.request().url(), token: route.request().headers()['x-rotator-ui-token'] || '' });
    await route.fulfill({ status: 200, json: { ok: true } });
  });
  page.opened = opened;
  return page;
}
const noHScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

(async () => {
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: URL0 });
  const page = await setupPage(context, errors);
  const clip = () => page.evaluate(() => navigator.clipboard.readText());

  // 1. usage view loads, Setup opens
  await page.goto(URL0 + '/', { waitUntil: 'networkidle' });
  check('usage view shows by default', await page.isVisible('#view-usage') && !(await page.isVisible('#view-setup')));
  const token = await page.getAttribute('meta[name="rotator-ui-token"]', 'content');
  check('page carries a 64-hex setup token', /^[0-9a-f]{64}$/.test(token || ''));
  await page.screenshot({ path: path.join(OUT, 'usage-desktop.png'), fullPage: true });
  await page.click('#tab-setup');
  await page.waitForSelector('#su-check li:nth-child(6)');
  check('Setup tab shows the setup view', await page.isVisible('#view-setup') && !(await page.isVisible('#view-usage')));
  check('URL hash is #setup', new URL(page.url()).hash === '#setup');
  check('checklist has 6 items', (await page.locator('#su-check li').count()) === 6);
  check('Claude Code item reads the fake version', (await page.textContent('#su-check li:nth-child(1)')).includes('9.9.9'));
  await page.waitForSelector('[data-provider="fireworks"]');
  await page.waitForTimeout(600); // let the reveal animation finish before the screenshot
  await page.screenshot({ path: path.join(OUT, 'setup-desktop-start.png'), fullPage: true });

  // 2. accounts: a bad name is caught in the page, a good one makes a slot and shows its login command
  await page.fill('#add-name', 'Bad Name');
  await page.click('#add-btn');
  check('bad name shows a reason', (await page.textContent('#add-hint')).includes('lowercase'), await page.textContent('#add-hint'));
  await page.fill('#add-name', 'ui');
  await page.click('#add-btn');
  check('reserved name shows a reason', (await page.textContent('#add-hint')).includes('ccr command'));
  await page.fill('#add-name', 'work');
  await page.click('#add-btn');
  await page.waitForSelector('#add-callout');
  check('callout shows the login command', (await page.textContent('#add-callout')).includes('ccr login work'));
  await page.waitForSelector('[data-account="work"]');
  check('new slot is listed as not logged in', (await page.textContent('[data-account="work"]')).includes('not logged in'));
  const s1 = await page.evaluate(() => fetch('/api/setup').then(r => r.json()));
  check('server has the new account', s1.accounts.some(a => a.id === 'work'));
  await page.click('#add-callout [data-open-login="work"]');
  await page.waitForFunction(() => document.querySelector('#add-callout [data-open-login="work"]').textContent.includes('Opened'));
  check('Open login in Terminal calls the route with the token', page.opened.length === 1 && page.opened[0].url.endsWith('/api/accounts/work/open-login') && page.opened[0].token === token);

  // 3. provider keys: save, test (good and bad), remove
  const prov = n => `[data-provider="${n}"]`;
  await page.fill(`${prov('fireworks')} input[type=password]`, 'good-browser-key-1234');
  await page.click(`${prov('fireworks')} button[type=submit]`);
  await page.waitForFunction(() => document.querySelector('[data-provider="fireworks"] .badge').textContent.includes('1234'));
  check('saved key shows only the masked hint', (await page.textContent(prov('fireworks'))).includes('…1234') && !(await page.content()).includes('good-browser-key-1234'));
  await page.click(`${prov('fireworks')} [data-test]`);
  await page.waitForFunction(() => /Works|Failed/.test(document.querySelector('[data-provider="fireworks"] .res').textContent));
  check('Test on a good key says it works', (await page.textContent(`${prov('fireworks')} .res`)).includes('Works'), await page.textContent(`${prov('fireworks')} .res`));
  await page.fill(`${prov('openrouter')} input[type=password]`, 'bad-key-12345678');
  await page.click(`${prov('openrouter')} button[type=submit]`);
  await page.waitForFunction(() => !document.querySelector('[data-provider="openrouter"] [data-test]').disabled);
  await page.click(`${prov('openrouter')} [data-test]`);
  await page.waitForFunction(() => /Works|Failed/.test(document.querySelector('[data-provider="openrouter"] .res').textContent));
  check('Test on a bad key shows the error', (await page.textContent(`${prov('openrouter')} .res`)).includes('invalid API key'));

  // 4. fallback off and on again (on by default), and reorder
  check('fallback starts on (the providers default)', await page.isChecked('#fb-toggle'));
  await page.click('label.switch');
  await page.waitForFunction(() => !document.querySelector('#fb-toggle').checked && !document.querySelector('#fb-toggle').disabled);
  const p0 = await page.evaluate(() => fetch('/api/providers').then(r => r.json()));
  check('switching it off is saved on the server', p0.fallback.enabled === false);
  await page.click('label.switch');
  await page.waitForFunction(() => document.querySelector('#fb-toggle').checked && !document.querySelector('#fb-toggle').disabled);
  const p1 = await page.evaluate(() => fetch('/api/providers').then(r => r.json()));
  check('switching it back on is saved on the server', p1.fallback.enabled === true);
  const before = await page.$$eval('#fb-order [data-order]', els => els.map(e => e.dataset.order));
  await page.click(`#fb-order [data-move="${before[0]}"][data-dir="1"]`);
  await page.waitForFunction(b => document.querySelector('#fb-order [data-order]').dataset.order !== b, before[0]);
  const after = await page.$$eval('#fb-order [data-order]', els => els.map(e => e.dataset.order));
  check('moving a provider down swaps the order', after[0] === before[1] && after[1] === before[0], after.join(','));
  const p2 = await page.evaluate(() => fetch('/api/providers').then(r => r.json()));
  check('new order saved on the server', p2.fallback.order.join() === after.join());
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'setup-desktop-done.png'), fullPage: true });

  // 5. every copy button puts its own text on the clipboard; the gateway key comes from the guarded route
  const copies = await page.$$('#view-setup [data-copy]');
  let copyOk = 0;
  for (const b of copies) {
    const want = await b.getAttribute('data-copy');
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await b.click();
    const got = await clip();
    if (got === want) copyOk++; else console.log('  copy mismatch:', want, '->', got);
  }
  check(`every copy button copies its text (${copyOk}/${copies.length})`, copies.length >= 4 && copyOk === copies.length);
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.click('#gw-key');
  await page.waitForFunction(() => document.querySelector('#gw-key').textContent.includes('copied') || document.querySelector('#gw-key').textContent.includes('failed'));
  const gk = await clip();
  check('Copy gateway key puts the key on the clipboard', !!GW_KEY && gk === GW_KEY);
  check('the gateway key is never in the page', !(await page.content()).includes(GW_KEY));

  // 6. remove a key through the in-page confirm
  await page.click(`${prov('fireworks')} [data-remove]`);
  await page.waitForSelector('#dlg:not([hidden])');
  check('Remove asks first', (await page.textContent('#dlg-msg')).includes('Remove the Fireworks key'));
  await page.click('#dlg-ok');
  await page.waitForFunction(() => document.querySelector('[data-provider="fireworks"] .badge').textContent.includes('no key'));
  check('removed key shows no key', true);
  check('desktop has no horizontal scroll', await noHScroll(page));

  // 7. phone width
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const pp = await setupPage(phone, errors);
  await pp.goto(URL0 + '/#setup', { waitUntil: 'networkidle' });
  await pp.waitForSelector('[data-provider="fireworks"]');
  await pp.waitForTimeout(600);
  check('phone opens straight into Setup from #setup', await pp.isVisible('#view-setup'));
  check('phone has no horizontal scroll', await noHScroll(pp));
  await pp.screenshot({ path: path.join(OUT, 'setup-phone.png'), fullPage: true });
  await pp.goto(URL0 + '/', { waitUntil: 'networkidle' });
  await pp.screenshot({ path: path.join(OUT, 'usage-phone.png'), fullPage: true });

  check('no console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  await browser.close();
  const failed = results.filter(r => !r.ok).length;
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  console.log(failed ? `UI-BROWSER: ${failed} FAILED` : `UI-BROWSER: ALL PASS (${results.length})`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('UI-BROWSER: runner error', e); process.exit(1); });
