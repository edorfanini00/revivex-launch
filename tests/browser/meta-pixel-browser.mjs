// Meta pixel browser QA against the owned LOCAL harness (SYNTHETIC Stripe stand-in).
// Meta is never contacted: connect.facebook.net/en_US/fbevents.js is answered with a stub
// that records every fbq call, and any other request to a Meta host is counted and
// aborted. Runs under the real vercel.json headers, so a CSP gap shows as a console error.
//
//   node tests/browser/meta-pixel-browser.mjs [--out <dir>]
import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outIdx = process.argv.indexOf('--out');
const OUT = path.resolve(outIdx > -1 ? process.argv[outIdx + 1] : path.join(ROOT, '.tmp/pixel-browser'));
fs.mkdirSync(OUT, { recursive: true });
const TEST_PIXEL = '123456789012345';

// Two builds of the real site: one with the placeholder id, one with a test pixel id.
const BUILD_OFF = path.join(ROOT, '.tmp/pixel-build-off');
const BUILD_ON = path.join(ROOT, '.tmp/pixel-build-on');
for (const [b, id] of [[BUILD_OFF, 'REVIVEX_PIXEL_ID_PLACEHOLDER'], [BUILD_ON, TEST_PIXEL]]) {
  fs.rmSync(b, { recursive: true, force: true });
  execFileSync('node', ['scripts/build.mjs', '--out', b], { cwd: ROOT, stdio: 'inherit' });
  const idFile = path.join(b, 'public/meta-pixel-id.js');
  const src = fs.readFileSync(idFile, 'utf8');
  if (!/export const META_PIXEL_ID = '[^']*';/.test(src)) throw new Error('pixel id constant not found');
  fs.writeFileSync(idFile, src.replace(/export const META_PIXEL_ID = '[^']*';/, `export const META_PIXEL_ID = '${id}';`));
}

const results = [];
function check(ok, label, detail = '') {
  results.push({ ok: !!ok, label, detail: String(detail).slice(0, 600) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail && !ok ? ` :: ${detail}` : ''}`);
}
function startHarness(port, root) {
  return new Promise((resolve, reject) => {
    const p = spawn('node', ['tests/harness/local-harness.mjs', '--mode', 'synthetic', '--port', String(port), '--root', path.join(root, 'public')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
    p.stdout.on('data', d => { if (String(d).includes('harness ')) resolve(p); });
    p.on('exit', c => reject(new Error(`harness exited ${c}`)));
    setTimeout(() => reject(new Error('harness start timeout')), 8000);
  });
}

// Stands in for fbevents.js: drains the loader queue and records every later call.
const STUB = `(function () {
  var f = window.fbq; if (!f) return;
  function rec(a) { try { window.__fbqRecord(JSON.parse(JSON.stringify(Array.prototype.slice.call(a)))); } catch (e) {} }
  f.callMethod = function () { rec(arguments); };
  var q = f.queue || []; f.queue = [];
  for (var i = 0; i < q.length; i++) rec(q[i]);
})();`;

async function newContext(browser, { gpc = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const calls = [];
  const metaHits = { fbevents: 0, other: [] };
  await ctx.exposeBinding('__fbqRecord', ({ page }, args) => { calls.push({ path: new URL(page.url()).pathname, args }); });
  if (gpc) await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true }));
  // Playwright tries the most recently registered matching route first: general rules first.
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|checkout\.stripe\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|connect\.facebook\.net|www\.facebook\.com)/, r => r.abort());
  await ctx.route(/^https?:\/\/([a-z0-9-]+\.)*(facebook\.(com|net)|fbcdn\.net)\//, r => { metaHits.other.push(r.request().url()); return r.abort(); });
  await ctx.route('https://connect.facebook.net/en_US/fbevents.js', r => { metaHits.fbevents++; return r.fulfill({ status: 200, contentType: 'text/javascript', body: STUB }); });
  await ctx.route('https://checkout.stripe.com/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>SYNTHETIC</title><h1>SYNTHETIC CHECKOUT PAGE (local test, not Stripe)</h1>' }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  return { ctx, page, calls, metaHits, errors };
}
const tracks = calls => calls.filter(c => c.args[0] === 'track').map(c => `${c.path} ${c.args[1]}`);
const settle = page => page.waitForTimeout(300);
const DEPOSIT = { content_name: 'Revivex machine preorder deposit', value: 100, currency: 'USD' };

async function reserveToStripe(page, base) {
  await page.goto(`${base}/#reserve`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.getElementById('reserveBtn').disabled, null, { timeout: 5000 });
  if (!(await page.locator('#termsInput').isChecked())) await page.locator('#termsInput').check();
  await Promise.all([page.waitForURL(/checkout\.stripe\.com/), page.locator('#reserveBtn').click()]);
  return page.url().split('/').pop();
}
async function receipt(page, base, id) {
  await page.goto(`${base}/reservation.html?session_id=${id}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.getElementById('receipt').dataset.state !== 'loading');
  await settle(page);
  return page.locator('#receipt').getAttribute('data-state');
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const harnesses = [];
try {
  const ON = 4395, OFF = 4396;
  harnesses.push(await startHarness(ON, BUILD_ON), await startHarness(OFF, BUILD_OFF));
  const S = `http://127.0.0.1:${ON}`;
  const api = async (p, method = 'GET') => (await fetch(S + p, { method })).json();

  // ---- Pixel on: home -> Preorder -> synthetic paid receipt ----
  {
    const { ctx, page, calls, metaHits, errors } = await newContext(browser);
    await page.goto(`${S}/`, { waitUntil: 'networkidle' });
    await settle(page);
    check(JSON.stringify(calls.map(c => c.args)) === JSON.stringify([['set', 'autoConfig', false, TEST_PIXEL], ['init', TEST_PIXEL], ['track', 'PageView'], ['track', 'ViewContent', DEPOSIT]]), 'home: autoConfig off, init, PageView, ViewContent (value 100 USD)', JSON.stringify(calls));

    // Submit without consent: no checkout, no InitiateCheckout.
    await page.locator('#reserve').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => !document.getElementById('reserveBtn').disabled, null, { timeout: 5000 });
    await page.locator('#reserveBtn').click();
    await settle(page);
    check(!tracks(calls).some(t => t.endsWith('InitiateCheckout')), 'no InitiateCheckout when consent is not ticked');

    await page.locator('#termsInput').check();
    await Promise.all([page.waitForURL(/checkout\.stripe\.com/), page.locator('#reserveBtn').click()]);
    const sessionId = page.url().split('/').pop();
    const ic = calls.filter(c => c.args[1] === 'InitiateCheckout');
    await page.goBack({ waitUntil: 'networkidle' });
    const token = await page.evaluate(() => JSON.parse(sessionStorage.getItem('revivex.depositOperation')).token);
    const opId = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()).id;
    check(ic.length === 1 && ic[0].path === '/' && JSON.stringify(ic[0].args) === JSON.stringify(['track', 'InitiateCheckout', DEPOSIT, { eventID: opId }]), 'InitiateCheckout fired once on the home page before the Stripe redirect, event id = operation id', JSON.stringify(ic));

    const before = calls.length;
    check(await receipt(page, S, sessionId) === 'not_completed', 'unpaid receipt is not_completed');
    check(!calls.slice(before).some(c => c.args[1] === 'Purchase'), 'no Purchase for an unpaid receipt');
    check(!calls.slice(before).some(c => c.args[1] === 'ViewContent'), 'no ViewContent on the receipt page');

    await api(`/__synthetic/pay?session_id=${sessionId}`, 'POST');
    const paidFrom = calls.length;
    check(await receipt(page, S, sessionId) === 'confirmed', 'paid receipt confirmed by the server');
    const paidCalls = calls.slice(paidFrom).filter(c => c.args[0] === 'track');
    check(JSON.stringify(paidCalls.map(c => c.args)) === JSON.stringify([['track', 'PageView'], ['track', 'Purchase', DEPOSIT, { eventID: `deposit_${sessionId}` }]]), 'receipt: PageView then Purchase (100 USD, event id deposit_<session id>)', JSON.stringify(paidCalls));

    const reloadFrom = calls.length;
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.getElementById('receipt').dataset.state === 'confirmed');
    await settle(page);
    check(!calls.slice(reloadFrom).some(c => c.args[1] === 'Purchase'), 'reload of the paid receipt: no second Purchase (localStorage guard)');

    await page.goto(`${S}/privacy.html`, { waitUntil: 'networkidle' });
    await settle(page);
    check(tracks(calls).at(-1) === '/privacy.html PageView', 'privacy page: PageView');

    check(metaHits.fbevents >= 1, 'fbevents.js requested from connect.facebook.net (allowed by CSP)');
    check(metaHits.other.length === 0, 'no other Meta request', metaHits.other.join(' '));
    check(errors.filter(e => !/Failed to load resource/.test(e)).length === 0, 'no console errors (incl. CSP violations)', errors.join(' | '));
    console.log('sequence:', tracks(calls).join(' -> '));
    fs.writeFileSync(path.join(OUT, 'pixel-on-sequence.json'), JSON.stringify(calls, null, 2));
    await ctx.close();
  }

  // ---- Global Privacy Control: nothing loaded, nothing sent, checkout still works ----
  {
    const { ctx, page, calls, metaHits, errors } = await newContext(browser, { gpc: true });
    await page.goto(`${S}/`, { waitUntil: 'networkidle' });
    const id = await reserveToStripe(page, S);
    await api(`/__synthetic/pay?session_id=${id}`, 'POST');
    check(await receipt(page, S, id) === 'confirmed', 'GPC: checkout and receipt still work');
    check(calls.length === 0 && metaHits.fbevents === 0 && metaHits.other.length === 0, 'GPC: no fbq calls and no request to Meta', JSON.stringify({ calls: calls.length, metaHits }));
    check(await page.evaluate(() => typeof window.fbq) === 'undefined', 'GPC: fbq never defined');
    check(errors.filter(e => !/Failed to load resource/.test(e)).length === 0, 'GPC: no console errors', errors.join(' | '));
    await ctx.close();
  }

  // ---- Placeholder id (the committed build): clean no-op ----
  {
    const { ctx, page, calls, metaHits, errors } = await newContext(browser);
    const O = `http://127.0.0.1:${OFF}`;
    await page.goto(`${O}/`, { waitUntil: 'networkidle' });
    const id = await reserveToStripe(page, O);
    await fetch(`${O}/__synthetic/pay?session_id=${id}`, { method: 'POST' });
    check(await receipt(page, O, id) === 'confirmed', 'placeholder: checkout and receipt still work');
    check(calls.length === 0 && metaHits.fbevents === 0 && metaHits.other.length === 0, 'placeholder: no fbq calls and no request to Meta', JSON.stringify({ calls: calls.length, metaHits }));
    check(await page.evaluate(() => typeof window.fbq) === 'undefined', 'placeholder: fbq never defined');
    check(errors.filter(e => !/Failed to load resource/.test(e)).length === 0, 'placeholder: no console errors', errors.join(' | '));
    await ctx.close();
  }
} finally {
  await browser.close();
  for (const h of harnesses) h.kill();
  fs.writeFileSync(path.join(OUT, 'pixel-browser-results.json'), JSON.stringify({ when: new Date().toISOString(), note: 'LOCAL harness + SYNTHETIC provider + stubbed fbevents.js; Meta and Stripe never contacted', results }, null, 2));
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} pixel browser checks passed`);
process.exit(failed.length ? 1 : 0);
