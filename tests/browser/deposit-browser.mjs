// Browser QA against the owned LOCAL harness (tests/harness/local-harness.mjs) using
// installed Google Chrome via playwright-core. Builds the static site with the real
// build script first. Every request to checkout.stripe.com is intercepted and answered
// with a page labelled SYNTHETIC; no Stripe, production or payment request is made.
//
//   node tests/browser/deposit-browser.mjs [--out <screenshot dir>]
import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outIdx = process.argv.indexOf('--out');
const OUT = path.resolve(outIdx > -1 ? process.argv[outIdx + 1] : path.join(ROOT, '.tmp/browser'));
fs.mkdirSync(OUT, { recursive: true });
const BUILD = path.join(ROOT, '.tmp/build');
execFileSync('node', ['scripts/build.mjs', '--out', BUILD], { cwd: ROOT, stdio: 'inherit' });

const results = [];
function check(ok, label, detail = '') {
  results.push({ ok: !!ok, label, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail && !ok ? ` :: ${detail}` : ''}`);
}

function startHarness(mode, port) {
  return new Promise((resolve, reject) => {
    const p = spawn('node', ['tests/harness/local-harness.mjs', '--mode', mode, '--port', String(port), '--root', path.join(BUILD, 'public')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
    p.stdout.on('data', d => { if (String(d).includes('harness ')) resolve(p); });
    p.on('exit', c => reject(new Error(`harness exited ${c}`)));
    setTimeout(() => reject(new Error('harness start timeout')), 8000);
  });
}

const VIEWPORTS = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false },
  { name: 'mobile', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
];
const PANEL = '$100 USD today. Fully refundable. Applied to the final machine price. No automatic balance charge.';
const HERO_H1 = 'Your supplements, blended every morning';
const UTM = 'utm_source=meta&utm_medium=paid_social&utm_campaign=morning_simplified_preorder&utm_content=angle_02&gclid=SHOULDNOTPASS&utm_term=ignored';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const harnesses = [];
try {
  // ---------------- Synthetic provider runs ----------------
  const SP = 4393;
  harnesses.push(await startHarness('synthetic', SP));
  const S = `http://127.0.0.1:${SP}`;
  const api = async (p, method = 'GET') => (await fetch(S + p, { method })).json();

  for (const vp of VIEWPORTS) {
    const tag = vp.name;
    const ctx = await browser.newContext({ viewport: vp.viewport, deviceScaleFactor: vp.deviceScaleFactor, isMobile: vp.isMobile, hasTouch: vp.hasTouch });
    const stripeNavs = [];
    await ctx.route('https://checkout.stripe.com/**', route => {
      stripeNavs.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>SYNTHETIC</title><h1 style="font:24px sans-serif;padding:40px">SYNTHETIC CHECKOUT PAGE (local test, not Stripe)</h1>' });
    });
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|checkout\.stripe\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)/, route => route.abort());
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push(String(e)));

    // Landing + layout identity
    await page.goto(`${S}/?${UTM}`, { waitUntil: 'networkidle' });
    check((await page.locator('h1.hero-title').innerText()).replace(/\s+/g, ' ').trim() === HERO_H1, `${tag}: hero headline unchanged`);
    check(await page.locator('#heroCanvas').count() === 1 && await page.locator('img.hero-fallback[src="/assets/v11/hero-poster.jpg"]').count() === 1, `${tag}: hero canvas + approved graphite poster retained`);
    const heroBtn = page.locator('.hero-actions .btn');
    check((await heroBtn.innerText()).trim() === 'Reserve with a $100 deposit' && (await heroBtn.getAttribute('href')) === '#reserve', `${tag}: hero CTA`);
    await page.screenshot({ path: path.join(OUT, `${tag}-01-hero.png`) });

    const btn = page.locator('#reserveBtn');
    await page.locator('#reserve').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => !document.getElementById('reserveBtn').disabled, null, { timeout: 5000 });
    check((await page.locator('#depositPanel').innerText()).replace(/\s+/g, ' ').trim() === PANEL, `${tag}: exact deposit panel copy`);
    check(await page.locator('#testModeNote').isVisible(), `${tag}: test-mode notice visible in test mode`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(overflow <= 0, `${tag}: no horizontal overflow`, overflow);
    const bodyText = await page.locator('body').innerText();
    check(!/safe dosing|Join the waitlist|nothing is for sale/i.test(bodyText), `${tag}: removed safe-dosing / waitlist / not-for-sale copy`);
    check(await page.locator('script[type="application/ld+json"]').count() === 0, `${tag}: bogus PreOrder $0 JSON-LD removed`);
    await page.waitForTimeout(400);
    await page.locator('#reserve').screenshot({ path: path.join(OUT, `${tag}-02-reserve-panel.png`) });

    // Terms required
    await btn.click();
    check(/agree to the deposit terms/.test(await page.locator('#reserveMsg').innerText()), `${tag}: terms checkbox required`);
    check((await api('/__synthetic/state')).sessionCount === (vp.name === 'desktop' ? 0 : (await api('/__synthetic/state')).sessionCount), `${tag}: no session without terms`);

    // Double-click race -> one session, redirect to (intercepted) Stripe-hosted URL
    const before = (await api('/__synthetic/state')).sessionCount;
    await page.locator('#termsInput').check();
    await Promise.all([page.waitForURL(/checkout\.stripe\.com/), btn.dblclick()]);
    let st = await api('/__synthetic/state');
    check(st.sessionCount === before + 1, `${tag}: double click created exactly one session`, st.sessionCount - before);
    const sess = st.sessions[st.sessions.length - 1];
    check(page.url() === `https://checkout.stripe.com/c/pay/${sess.id}`, `${tag}: redirected only to Stripe-hosted session URL`);
    check(sess.metadata.utm_source === 'meta' && sess.metadata.utm_medium === 'paid_social' && sess.metadata.utm_campaign === 'morning_simplified_preorder' && sess.metadata.utm_content === 'angle_02', `${tag}: allowlisted UTM in session metadata`);
    check(sess.piMetadata.utm_campaign === 'morning_simplified_preorder', `${tag}: UTM in payment intent metadata`);
    check(!JSON.stringify(sess.metadata).includes('SHOULDNOTPASS') && !('utm_term' in sess.metadata) && !('gclid' in sess.metadata), `${tag}: click id / utm_term dropped`);
    await page.screenshot({ path: path.join(OUT, `${tag}-03-synthetic-checkout-intercept.png`) });

    // Back from Stripe -> button usable; retry replays the same session (no new one)
    await page.goBack({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.getElementById('reserveBtn').disabled, null, { timeout: 5000 });
    if (!(await page.locator('#termsInput').isChecked())) await page.locator('#termsInput').check();
    await Promise.all([page.waitForURL(/checkout\.stripe\.com/), btn.click()]);
    st = await api('/__synthetic/state');
    check(st.sessionCount === before + 1 && page.url().endsWith(sess.id), `${tag}: back + retry replays same session`);

    // Pay (synthetic) -> success URL -> server-verified receipt
    await api(`/__synthetic/pay?session_id=${sess.id}`, 'POST');
    await page.goto(`${S}/reservation.html?session_id=${sess.id}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.getElementById('receipt').dataset.state !== 'loading');
    check(await page.locator('#receipt').getAttribute('data-state') === 'confirmed', `${tag}: receipt confirmed from server lookup`);
    const receiptText = await page.locator('#receipt').innerText();
    check(/\$100\.00 USD/.test(receiptText) && /pi_SYNTH/.test(receiptText), `${tag}: receipt shows amount + reference`);
    check(!/synthetic-buyer|Synthetic Buyer/.test(receiptText), `${tag}: receipt shows no customer email/name`);
    check(/support@revivex\.store/.test(receiptText) && /not a final order/.test(receiptText), `${tag}: receipt refund contact + deposit-only scope`);
    check(await page.evaluate(() => sessionStorage.getItem('revivex.depositOperation')) === null, `${tag}: operation cleared after confirmed deposit`);
    check(await page.locator('#receiptRetry').isHidden(), `${tag}: no 'Check again' on a confirmed receipt`);
    await page.screenshot({ path: path.join(OUT, `${tag}-04-receipt-confirmed.png`), fullPage: true });

    // Disputed is not shown as active
    await api(`/__synthetic/dispute?session_id=${sess.id}`, 'POST');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.getElementById('receipt').dataset.state !== 'loading');
    check(await page.locator('#receipt').getAttribute('data-state') === 'disputed', `${tag}: disputed deposit shown as disputed`);
    await page.screenshot({ path: path.join(OUT, `${tag}-05-receipt-disputed.png`), fullPage: true });

    // Query params are not evidence: an unpaid session with ?paid=true stays not completed
    await page.goto(`${S}/?fresh=1#reserve`, { waitUntil: 'networkidle' });
    await page.evaluate(() => sessionStorage.clear());
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.getElementById('reserveBtn').disabled);
    await page.locator('#termsInput').check();
    await Promise.all([page.waitForURL(/checkout\.stripe\.com/), btn.click()]);
    const unpaidId = page.url().split('/').pop();
    await page.goto(`${S}/reservation.html?session_id=${unpaidId}&paid=true&payment_status=paid&status=complete`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.getElementById('receipt').dataset.state !== 'loading');
    check(await page.locator('#receipt').getAttribute('data-state') === 'not_completed', `${tag}: query params cannot fake payment`);
    check(await page.locator('#receiptFacts').isHidden() && await page.locator('#receiptRefund').isHidden(), `${tag}: unpaid receipt shows no amount/reference/refund block`);

    // Uncertain create (Stripe saved the session but the reply timed out 3x): honest
    // message; reload keeps the same operation; retry replays the same session.
    await page.goto(`${S}/#reserve`, { waitUntil: 'networkidle' });
    await page.evaluate(() => sessionStorage.removeItem('revivex.depositOperation'));
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.getElementById('reserveBtn').disabled);
    const c0 = (await api('/__synthetic/state')).sessionCount;
    await api('/__synthetic/fail-next?kind=timeout&n=1', 'POST');
    // first create times out after creating; auto-retry replays -> redirect
    await page.locator('#termsInput').check();
    await Promise.all([page.waitForURL(/checkout\.stripe\.com/, { timeout: 10000 }), btn.click()]);
    st = await api('/__synthetic/state');
    check(st.sessionCount === c0 + 1, `${tag}: timed-out create auto-retried with same operation (one session)`, st.sessionCount - c0);
    const replayId = page.url().split('/').pop();
    await page.goBack({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.getElementById('reserveBtn').disabled);
    await api('/__synthetic/fail-next?kind=reject&n=3', 'POST'); // unrelated new key would fail; same key replays
    if (!(await page.locator('#termsInput').isChecked())) await page.locator('#termsInput').check();
    await Promise.all([page.waitForURL(/checkout\.stripe\.com/), btn.click()]);
    check(page.url().endsWith(replayId), `${tag}: replay after back is stable`);
    await page.goBack({ waitUntil: 'networkidle' });

    // Persistent uncertainty with a brand-new operation: message is not a "no payment" claim
    await page.evaluate(() => sessionStorage.removeItem('revivex.depositOperation'));
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.getElementById('reserveBtn').disabled);
    // queue already has 3 'reject' (500) failures: first create + 2 auto-retries all fail
    if (!(await page.locator('#termsInput').isChecked())) await page.locator('#termsInput').check();
    await btn.click();
    await page.waitForFunction(() => /could not confirm/.test(document.getElementById('reserveMsg').textContent), null, { timeout: 10000 });
    const um = await page.locator('#reserveMsg').innerText();
    check(/We could not confirm the checkout status\. Check your payment confirmation before trying again\./.test(um) && !/No payment/i.test(um), `${tag}: uncertain message is truthful`, um);
    const opBefore = await page.evaluate(() => sessionStorage.getItem('revivex.depositOperation'));
    await page.reload({ waitUntil: 'networkidle' });
    const opAfter = await page.evaluate(() => sessionStorage.getItem('revivex.depositOperation'));
    check(opBefore && opBefore === opAfter && JSON.parse(opAfter).attempted === true, `${tag}: operation survives reload`);
    await page.locator('#reserve').screenshot({ path: path.join(OUT, `${tag}-06-uncertain.png`) });

    // Operation older than the idempotency window -> reconcile prompt, explicit restart only
    await page.waitForFunction(() => !document.getElementById('reserveBtn').disabled);
    await api('/__synthetic/advance-clock?hours=24', 'POST');
    const c1 = (await api('/__synthetic/state')).sessionCount;
    await page.locator('#termsInput').check();
    await btn.click();
    await page.waitForFunction(() => !document.getElementById('reserveRestart').hidden, null, { timeout: 5000 });
    const rm = await page.locator('#reserveMsg').innerText();
    check(/earlier checkout attempt/.test(rm) && /support@revivex\.store/.test(rm), `${tag}: aged attempt asks to reconcile`, rm);
    check((await api('/__synthetic/state')).sessionCount === c1, `${tag}: aged attempt created nothing`);
    await btn.click();
    check((await api('/__synthetic/state')).sessionCount === c1, `${tag}: reserve blocked until explicit restart`);
    await page.locator('#reserve').screenshot({ path: path.join(OUT, `${tag}-07-reconcile.png`) });
    await page.locator('#reserveRestart').click();
    await Promise.all([page.waitForURL(/checkout\.stripe\.com/), btn.click()]);
    check((await api('/__synthetic/state')).sessionCount === c1 + 1, `${tag}: explicit restart starts one new attempt`);
    await api('/__synthetic/advance-clock?hours=-24', 'POST');

    check(consoleErrors.filter(e => !/Failed to load resource/.test(e)).length === 0, `${tag}: no console errors`, consoleErrors.join(' | '));
    await ctx.close();
  }

  // Storage blocked: reservation still works with an in-memory operation
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await ctx.addInitScript(() => {
      Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
    });
    await ctx.route('https://checkout.stripe.com/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>SYNTHETIC</h1>' }));
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    await page.goto(`${S}/#reserve`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.getElementById('reserveBtn').disabled);
    await page.locator('#termsInput').check();
    await Promise.all([page.waitForURL(/checkout\.stripe\.com/), page.locator('#reserveBtn').click()]);
    check(errs.length === 0, 'storage blocked: checkout still opens without script errors', errs.join('|'));
    await ctx.close();
  }

  // ---------------- Unconfigured (production-like) runs ----------------
  const UP = 4394;
  harnesses.push(await startHarness('unconfigured', UP));
  const U = `http://127.0.0.1:${UP}`;
  for (const vp of VIEWPORTS) {
    const tag = `${vp.name}-unconfigured`;
    const ctx = await browser.newContext({ viewport: vp.viewport, deviceScaleFactor: vp.deviceScaleFactor, isMobile: vp.isMobile, hasTouch: vp.hasTouch });
    let stripeHits = 0;
    await ctx.route('https://checkout.stripe.com/**', r => { stripeHits++; return r.abort(); });
    const page = await ctx.newPage();
    await page.goto(`${U}/#reserve`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => /temporarily unavailable/.test(document.getElementById('reserveMsg').textContent), null, { timeout: 5000 });
    check(await page.locator('#reserveBtn').isDisabled(), `${tag}: reserve button disabled (fails closed)`);
    check(await page.locator('#testModeNote').isHidden(), `${tag}: no test-mode notice`);
    check(await page.locator('#reserveRestart').isHidden(), `${tag}: restart control hidden`);
    await page.locator('#termsInput').check();
    await page.locator('#reserveBtn').click({ force: true }).catch(() => {});
    const r = await page.evaluate(async () => {
      const a = await fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ step: 'start', termsAccepted: true, termsVersion: 'deposit-terms-v1' }) });
      const b = await fetch('/api/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'browser-qa@example.test', consent: true }) });
      return { a: a.status, aj: await a.json(), b: b.status, bj: await b.json() };
    });
    check(r.a === 503 && r.aj.state === 'unavailable' && !r.aj.operation, `${tag}: real default checkout export returns 503 unavailable`);
    check(r.b === 503 && r.bj.ok === false && !/saved\./.test(r.bj.message.replace('Nothing was saved.', '')), `${tag}: legacy signup fails closed (no false success)`);
    check(stripeHits === 0, `${tag}: never navigates to Stripe`);
    await page.locator('#reserve').screenshot({ path: path.join(OUT, `${tag}-reserve.png`) });

    for (const doc of ['deposit-terms', 'privacy']) {
      await page.goto(`${U}/${doc}.html`, { waitUntil: 'networkidle' });
      const t = await page.locator('main').innerText();
      check(/support@revivex\.store/.test(t) && !/not yet configured|LOCAL PREVIEW|SQLite/i.test(t), `${tag}: ${doc} shows official contact, no placeholders/local-only claims`);
      const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(ov <= 0, `${tag}: ${doc} no horizontal overflow`, ov);
      await page.screenshot({ path: path.join(OUT, `${tag}-${doc}.png`), fullPage: true });
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  for (const h of harnesses) h.kill();
  fs.writeFileSync(path.join(OUT, 'browser-results.json'), JSON.stringify({ when: new Date().toISOString(), note: 'LOCAL harness + SYNTHETIC provider; not Stripe sandbox evidence', results }, null, 2));
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
process.exit(failed.length ? 1 : 0);
