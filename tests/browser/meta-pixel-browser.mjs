// Meta pixel browser QA against the owned LOCAL harness (SYNTHETIC Stripe stand-in,
// PGlite waitlist database).
// Meta is never contacted: connect.facebook.net/en_US/fbevents.js is answered with a stub
// that records every fbq call, any other request to a Meta host is counted and aborted,
// and the harness records server (Conversions API) events instead of sending them.
// Runs under the real vercel.json headers, so a CSP gap shows as a console error.
//
// Harnesses: ON (test mode, canonical origin), LIVE (live mode receipts, canonical
// origin), ALIAS (the ON build on another origin), OFF (placeholder pixel id).
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

const ON = 4395, OFF = 4396, LIVE = 4397, ALIAS = 4398;
const local = port => `http://127.0.0.1:${port}`;

// Builds of the real site with the pixel constants rewritten: placeholder id, and a test
// pixel id whose canonical origin is the ON or the LIVE harness.
const BUILD_OFF = path.join(ROOT, '.tmp/pixel-build-off');
const BUILD_ON = path.join(ROOT, '.tmp/pixel-build-on');
const BUILD_LIVE = path.join(ROOT, '.tmp/pixel-build-live');
const BUILD_BASE = path.join(ROOT, '.tmp/pixel-build-base');
fs.rmSync(BUILD_BASE, { recursive: true, force: true });
execFileSync('node', ['scripts/build.mjs', '--out', BUILD_BASE], { cwd: ROOT, stdio: 'inherit' });
for (const [b, id, origin] of [[BUILD_OFF, 'REVIVEX_PIXEL_ID_PLACEHOLDER', local(OFF)], [BUILD_ON, TEST_PIXEL, local(ON)], [BUILD_LIVE, TEST_PIXEL, local(LIVE)]]) {
  fs.rmSync(b, { recursive: true, force: true });
  fs.cpSync(BUILD_BASE, b, { recursive: true });
  const idFile = path.join(b, 'public/meta-pixel-id.js');
  const src = fs.readFileSync(idFile, 'utf8');
  if (!/export const META_PIXEL_ID = '[^']*';/.test(src) || !/export const META_PIXEL_ORIGIN = '[^']*';/.test(src)) throw new Error('pixel constants not found');
  fs.writeFileSync(idFile, src
    .replace(/export const META_PIXEL_ID = '[^']*';/, `export const META_PIXEL_ID = '${id}';`)
    .replace(/export const META_PIXEL_ORIGIN = '[^']*';/, `export const META_PIXEL_ORIGIN = '${origin}';`));
}

const results = [];
function check(ok, label, detail = '') {
  results.push({ ok: !!ok, label, detail: String(detail).slice(0, 600) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail && !ok ? ` :: ${detail}` : ''}`);
}
function startHarness(port, root, stripeMode = 'test') {
  return new Promise((resolve, reject) => {
    const p = spawn('node', ['tests/harness/local-harness.mjs', '--mode', 'synthetic', '--stripe-mode', stripeMode, '--port', String(port), '--root', path.join(root, 'public')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
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

// gpc: navigator.globalPrivacyControl; gpcHeader: the real Sec-GPC: 1 request header.
async function newContext(browser, { gpc = false, gpcHeader = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, ...(gpcHeader ? { extraHTTPHeaders: { 'Sec-GPC': '1' } } : {}) });
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
const DEPOSIT = { content_name: 'Revivex machine preorder deposit', value: 50, currency: 'USD' };
const WAITLIST = { content_name: 'Revivex early access waitlist' };

// The home page no longer opens checkout; an existing-deposit session is made through the
// unchanged checkout API from the page origin (as an earlier visitor's checkout was).
async function checkoutViaApi(page, base) {
  if (!page.url().startsWith(base)) await page.goto(`${base}/privacy.html`, { waitUntil: 'networkidle' });
  return page.evaluate(async () => {
    const post = async b => (await fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ termsAccepted: true, termsVersion: 'deposit-terms-v3', displayedAmount: 5000, ...b }) })).json();
    const s = await post({ step: 'start', attribution: {} });
    const c = await post({ step: 'create', operation: s.operation });
    return c.url.split('/').pop();
  });
}
// Opens the modal from a CTA, fills it and submits; resolves to the API response body.
async function signUp(page, { email, cta = '.hero-actions [data-signup]', country = 'united k' } = {}) {
  await page.locator(cta).click();
  await page.locator('#signupEmail').fill(email);
  if (await page.locator('#countryValue').innerText() === 'Country') { await page.locator('#countryToggle').click(); await page.keyboard.type(country); await page.keyboard.press('Enter'); }
  const [resp] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/signup') && r.request().method() === 'POST'), page.locator('#signupSubmit').click()]);
  await page.waitForTimeout(300);
  return resp.json().catch(() => null);
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
  harnesses.push(await startHarness(ON, BUILD_ON), await startHarness(OFF, BUILD_OFF), await startHarness(LIVE, BUILD_LIVE, 'live'), await startHarness(ALIAS, BUILD_ON));
  const S = local(ON), L = local(LIVE);
  const api = async (p, method = 'GET', base = S) => (await fetch(base + p, { method })).json();
  const seedPaid = async (hours = 0) => (await api(`/__synthetic/seed-paid?hours=${hours}`, 'POST', L)).session_id;
  const serverEvents = async (base, id) => (await api('/__synthetic/meta-events', 'GET', base)).filter(e => !id || e.event_id === `deposit_${id}`);
  const purchases = calls => calls.filter(c => c.args[0] === 'track' && c.args[1] === 'Purchase');

  // ---- Pixel on: home -> waitlist signup (Lead) -> an existing deposit's receipt ----
  {
    const { ctx, page, calls, metaHits, errors } = await newContext(browser);
    await page.goto(`${S}/`, { waitUntil: 'networkidle' });
    await settle(page);
    check(JSON.stringify(calls.map(c => c.args)) === JSON.stringify([['set', 'autoConfig', false, TEST_PIXEL], ['init', TEST_PIXEL], ['track', 'PageView'], ['track', 'ViewContent', WAITLIST]]), 'home: autoConfig off, init, PageView, ViewContent (waitlist label, no deposit value)', JSON.stringify(calls));
    check(await page.locator('[data-checkout], #reserveBtn').count() === 0, 'home: no checkout button left on the page');
    const leads = () => calls.filter(c => c.args[0] === 'track' && c.args[1] === 'Lead');
    check(leads().length === 0, 'no Lead before any signup');

    const j = await signUp(page, { email: 'pixel-lead@example.com' });
    const l1 = leads();
    check(j && j.ok === true && /^lead_/.test(j.lead) && await page.locator('#signupDone').isVisible(), 'signup: 200 ok with a Lead id, success shown', JSON.stringify(j));
    check(l1.length === 1 && l1[0].path === '/' && JSON.stringify(l1[0].args) === JSON.stringify(['track', 'Lead', WAITLIST, { eventID: j.lead }]), 'signup: browser Lead fired exactly once, event id = server Lead id', JSON.stringify(l1));
    const sl = (await serverEvents(S)).filter(e => e.event_name === 'Lead');
    check(sl.length === 1 && sl[0].event_id === j.lead && sl[0].has_em, 'signup: one server (CAPI) Lead with the same event id and a hashed email', JSON.stringify(sl));
    check(!tracks(calls).some(t => /InitiateCheckout|Purchase/.test(t)), 'home: no InitiateCheckout or Purchase from the signup page');

    // The same address again (new page load): idempotent success, no second Lead anywhere.
    await page.goto(`${S}/`, { waitUntil: 'networkidle' });
    const j2 = await signUp(page, { email: 'PIXEL-lead@example.com', cta: '.nav-cta' });
    check(j2 && j2.ok === true && j2.lead === null && await page.locator('#signupDone').isVisible(), 'repeat signup: success shown, no Lead id', JSON.stringify(j2));
    check(leads().length === 1 && (await serverEvents(S)).filter(e => e.event_name === 'Lead').length === 1, 'repeat signup: still exactly one browser and one server Lead');

    const sessionId = await checkoutViaApi(page, S);
    const before = calls.length;
    check(await receipt(page, S, sessionId) === 'not_completed', 'unpaid receipt is not_completed');
    check(!calls.slice(before).some(c => c.args[1] === 'Purchase'), 'no Purchase for an unpaid receipt');
    check(!calls.slice(before).some(c => c.args[1] === 'ViewContent'), 'no ViewContent on the receipt page');

    await api(`/__synthetic/pay?session_id=${sessionId}`, 'POST');
    const paidFrom = calls.length;
    check(await receipt(page, S, sessionId) === 'confirmed', 'test mode paid receipt confirmed by the server');
    const paidCalls = calls.slice(paidFrom).filter(c => c.args[0] === 'track');
    check(JSON.stringify(paidCalls.map(c => c.args)) === JSON.stringify([['track', 'PageView']]), 'S3: test mode paid receipt: PageView only, no browser Purchase', JSON.stringify(paidCalls));
    check((await serverEvents(S)).filter(e => e.event_name !== 'Lead').length === 0, 'S3: test mode: no server (CAPI) deposit event at all, though the token is set', JSON.stringify(await serverEvents(S)));

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

  // ---- A failed signup (5xx or network) sends no Lead; the successful retry sends exactly one ----
  {
    const { ctx, page, calls, errors } = await newContext(browser);
    await page.goto(`${S}/`, { waitUntil: 'networkidle' });
    await settle(page);
    const leads = () => calls.filter(c => c.args[0] === 'track' && c.args[1] === 'Lead');
    const server0 = (await serverEvents(S)).filter(e => e.event_name === 'Lead').length;
    await api('/__synthetic/signup-db-fail', 'POST');
    const j = await signUp(page, { email: 'pixel-retry@example.com' });
    check(j && j.ok === false && leads().length === 0 && !(await page.locator('#signupDone').isVisible()), 'failed signup (503): no Lead, no success', JSON.stringify({ j, leads: leads().length }));
    await page.route('**/api/signup', r => (r.request().method() === 'POST' ? r.abort() : r.continue()));
    await page.locator('#signupSubmit').click();
    await page.waitForFunction(() => /couldn't reach/.test(document.getElementById('signupError').textContent), null, { timeout: 5000 }).catch(() => {});
    check(leads().length === 0 && !(await page.locator('#signupDone').isVisible()), 'network failure: no Lead, no success');
    await page.unroute('**/api/signup');
    const [resp] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/signup') && r.request().method() === 'POST'), page.locator('#signupSubmit').click()]);
    const j2 = await resp.json();
    await settle(page);
    check(j2.ok === true && leads().length === 1 && leads()[0].args[3].eventID === j2.lead && (await serverEvents(S)).filter(e => e.event_name === 'Lead').length === server0 + 1, 'retry after the failures: exactly one browser and one server Lead', JSON.stringify({ leads: leads().length }));
    check(errors.filter(e => !/Failed to load resource|ERR_FAILED|503/.test(e)).length === 0, 'failed signup: no console errors', errors.join(' | '));
    await ctx.close();
  }

  // ---- Live mode receipt: browser and server Purchase with one event id, once ----
  {
    const { ctx, page, calls, metaHits, errors } = await newContext(browser);
    const id = await seedPaid(0);
    const t0 = Math.floor(Date.now() / 1000);
    check(await receipt(page, L, id) === 'confirmed', 'live: fresh paid receipt confirmed');
    const t = calls.filter(c => c.args[0] === 'track').map(c => c.args);
    check(JSON.stringify(t) === JSON.stringify([['track', 'PageView'], ['track', 'Purchase', DEPOSIT, { eventID: `deposit_${id}` }]]), 'live receipt: PageView then Purchase (50 USD, event id deposit_<session id>)', JSON.stringify(t));
    const ev = await serverEvents(L, id);
    check(ev.length === 1 && ev[0].event_name === 'Purchase' && Math.abs(ev[0].event_time - t0) < 120 && ev[0].has_em, 'live: one server Purchase with the same event id, event_time = payment time, hashed email', JSON.stringify(ev));
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.getElementById('receipt').dataset.state === 'confirmed');
    await settle(page);
    check(purchases(calls).length === 1, 'reload of the paid receipt: no second browser Purchase');
    check((await serverEvents(L, id)).length === 1, 'reload of the paid receipt: no second server Purchase');
    check(metaHits.other.length === 0, 'live: no other Meta request', metaHits.other.join(' '));
    check(errors.filter(e => !/Failed to load resource/.test(e)).length === 0, 'live: no console errors (incl. CSP violations)', errors.join(' | '));
    await ctx.close();
  }

  // ---- S1: a payment older than 48 h is not reported (browser or server) ----
  {
    const { ctx, page, calls } = await newContext(browser);
    const id = await seedPaid(49);
    check(await receipt(page, L, id) === 'confirmed', 'S1: 49 h old deposit still shows as received');
    check(purchases(calls).length === 0, 'S1: no browser Purchase for a 49 h old payment', JSON.stringify(purchases(calls)));
    check((await serverEvents(L, id)).length === 0, 'S1: no server Purchase for a 49 h old payment');
    await ctx.close();
  }

  // ---- C1: simultaneous receipt tabs in one browser send exactly one Purchase ----
  // Reviewer probe: 8 tabs, the real server-confirmed API responses held and released together.
  {
    const TABS = 8, ROUNDS = 6;
    const { ctx, calls } = await newContext(browser);
    const pages = await Promise.all(Array.from({ length: TABS }, () => ctx.newPage()));
    const counts = [];
    // Known to time out on origin/main as well (8 tabs on one loaded machine): a timeout
    // is recorded as this case's failure and the rest of the suite still runs.
    try {
    for (let round = 0; round < ROUNDS; round++) {
      const id = await seedPaid(0);
      let waiting = [];
      const route = `**/api/reservation?session_id=${id}`;
      await ctx.route(route, async r => {
        const response = await r.fetch();
        await new Promise(resolve => { waiting.push(resolve); if (waiting.length === TABS) { const go = waiting; waiting = []; setTimeout(() => go.forEach(f => f()), 100); } });
        await r.fulfill({ response });
      });
      const before = calls.length;
      await Promise.all(pages.map(p => p.goto(`${L}/reservation.html?session_id=${id}`, { waitUntil: 'networkidle' })));
      await Promise.all(pages.map(p => p.waitForFunction(() => document.getElementById('receipt').dataset.state === 'confirmed')));
      await new Promise(r => setTimeout(r, 400));
      const sent = purchases(calls.slice(before));
      counts.push(sent.length);
      check(sent.length === 1 && sent[0].args[3].eventID === `deposit_${id}`, `C1: round ${round + 1}: ${TABS} simultaneous tabs -> exactly 1 Purchase`, `got ${sent.length}`);
      await ctx.unroute(route);
    }
    } catch (e) {
      check(false, `C1: ${TABS} simultaneous tabs completed every round`, `${String(e).split('\n')[0]} after ${counts.length} rounds`);
    }
    console.log('C1 purchases per round:', counts.join(', '));
    await ctx.close();
  }

  // ---- C3: the real Sec-GPC: 1 header reaches the server; nothing is reported ----
  {
    const g = await newContext(browser, { gpc: true, gpcHeader: true });
    const sentGpc = [];
    g.page.on('request', r => { if (r.url().includes('/api/reservation')) sentGpc.push(r.headers()['sec-gpc']); });
    const id = await seedPaid(0);
    check(await receipt(g.page, L, id) === 'confirmed', 'C3: GPC browser: receipt confirmed');
    check(sentGpc.length > 0 && sentGpc.every(v => v === '1'), 'C3: the receipt lookup carried Sec-GPC: 1', JSON.stringify(sentGpc));
    check(g.calls.length === 0 && g.metaHits.fbevents === 0, 'C3: GPC browser: no fbq calls, no pixel load');
    check((await serverEvents(L, id)).length === 0, 'C3: GPC header: no server Purchase (token configured)', JSON.stringify(await serverEvents(L, id)));
    await g.ctx.close();
    // C2: the skipped GPC view did not use up the server's dedup entry.
    const n = await newContext(browser);
    check(await receipt(n.page, L, id) === 'confirmed', 'C2: later non-GPC view confirmed');
    check((await serverEvents(L, id)).length === 1, 'C2: later non-GPC view on the same instance reports once', JSON.stringify(await serverEvents(L, id)));
    check(purchases(n.calls).length === 1, 'C2: later non-GPC browser sends its Purchase');
    await n.ctx.close();
  }

  // ---- S3: off the canonical origin (preview or alias) the pixel never starts ----
  {
    const { ctx, page, calls, metaHits } = await newContext(browser);
    const A = local(ALIAS);
    await page.goto(`${A}/`, { waitUntil: 'networkidle' });
    await settle(page);
    await page.goto(`${A}/privacy.html`, { waitUntil: 'networkidle' });
    await settle(page);
    check(calls.length === 0 && metaHits.fbevents === 0 && metaHits.other.length === 0, 'S3: non-canonical origin: no fbq calls and no request to Meta', JSON.stringify({ calls: calls.length, metaHits }));
    check(await page.evaluate(() => typeof window.fbq) === 'undefined', 'S3: non-canonical origin: fbq never defined');
    await ctx.close();
  }

  // ---- Global Privacy Control: nothing loaded, nothing sent; signup and receipts still work ----
  {
    const { ctx, page, calls, metaHits, errors } = await newContext(browser, { gpc: true });
    await page.goto(`${S}/`, { waitUntil: 'networkidle' });
    const gj = await signUp(page, { email: 'pixel-gpc@example.com' });
    check(gj && gj.ok === true && await page.locator('#signupDone').isVisible(), 'GPC: signup still works');
    const id = await checkoutViaApi(page, S);
    await api(`/__synthetic/pay?session_id=${id}`, 'POST');
    check(await receipt(page, S, id) === 'confirmed', 'GPC: existing deposit receipt still works');
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
    const pj = await signUp(page, { email: 'pixel-off@example.com' });
    check(pj && pj.ok === true, 'placeholder: signup still works');
    const id = await checkoutViaApi(page, O);
    await fetch(`${O}/__synthetic/pay?session_id=${id}`, { method: 'POST' });
    check(await receipt(page, O, id) === 'confirmed', 'placeholder: existing deposit receipt still works');
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
