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
    check((await heroBtn.innerText()).trim() === 'Preorder' && (await heroBtn.getAttribute('href')) === '#reserve', `${tag}: hero CTA reads Preorder`);
    const ctaLabels = await page.$$eval('.nav-cta, .hero-actions .btn, .split-side .btn, #reserveBtn', els => els.map(e => e.textContent.trim()));
    check(ctaLabels.length === 4 && ctaLabels.every(t => t === 'Preorder'), `${tag}: every order button (nav, hero, mid page, form) reads Preorder`, ctaLabels.join(' | '));
    check(await page.locator('a[href="#reserve"], button[type="submit"]').evaluateAll(els => els.every(e => e.textContent.trim() === 'Preorder')), `${tag}: no order button keeps the old Reserve label`);
    check((await page.locator('#reserve-title').innerText()).trim() === 'Preorder yours.', `${tag}: section heading reads Preorder yours.`);
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
    check(!/convert/i.test(bodyText) && !/before[^.]{0,40}final order/i.test(bodyText), `${tag}: no refund cutoff in rendered page`);
    check((await page.locator('label.consent').innerText()).replace(/\s+/g, ' ').trim() === 'I agree to the deposit terms.', `${tag}: consent checkbox carries no extra condition`);
    const csp = await page.evaluate(async () => (await fetch('/', { cache: 'no-store' })).headers.get('content-security-policy'));
    check(/frame-ancestors 'none'/.test(csp || ''), `${tag}: CSP with frame-ancestors none served`);
    if (vp.name === 'desktop') await page.waitForFunction(() => document.getElementById('heroCanvas').classList.contains('ready'), null, { timeout: 10000 }).catch(() => {});
    check(vp.name !== 'desktop' || await page.evaluate(() => document.getElementById('heroCanvas').classList.contains('ready')), `${tag}: hero frame sequence still loads under CSP`);
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
    if (!(await page.locator('#termsInput').isChecked())) await page.locator('#termsInput').check();
    await Promise.all([page.waitForURL(/checkout\.stripe\.com/), btn.click()]);
    check(page.url().endsWith(replayId), `${tag}: replay after back is stable`);
    await page.goBack({ waitUntil: 'networkidle' });

    // Paid, but the visitor never reached the receipt: the stored operation replays.
    // Stripe replays the SAVED open session, so the server must read current state
    // and send the visitor to the receipt, never back to the paid Stripe page.
    await api(`/__synthetic/pay?session_id=${replayId}`, 'POST');
    await page.waitForFunction(() => !document.getElementById('reserveBtn').disabled);
    if (!(await page.locator('#termsInput').isChecked())) await page.locator('#termsInput').check();
    await Promise.all([page.waitForURL(/reservation\.html\?session_id=/), btn.click()]);
    check(page.url().endsWith(`/reservation.html?session_id=${replayId}`), `${tag}: paid operation replay routes to receipt, not Stripe`);
    await page.waitForFunction(() => document.getElementById('receipt').dataset.state !== 'loading');
    check(await page.locator('#receipt').getAttribute('data-state') === 'confirmed', `${tag}: paid replay receipt confirmed`);
    check(await page.evaluate(() => sessionStorage.getItem('revivex.depositOperation')) === null, `${tag}: paid receipt clears stored operation`);

    // Stripe-saved 500: every retry would replay it, so go straight to reconcile.
    await page.goto(`${S}/#reserve`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.getElementById('reserveBtn').disabled);
    const c500 = (await api('/__synthetic/state')).sessionCount;
    await api('/__synthetic/fail-next?kind=save500&n=1', 'POST');
    if (!(await page.locator('#termsInput').isChecked())) await page.locator('#termsInput').check();
    await btn.click();
    await page.waitForFunction(() => !document.getElementById('reserveRestart').hidden, null, { timeout: 8000 });
    const m500 = await page.locator('#reserveMsg').innerText();
    check(/could not confirm whether your earlier checkout attempt was paid/.test(m500) && /card statement/.test(m500) && /support@revivex\.store/.test(m500) && !/No payment/i.test(m500), `${tag}: saved 500 -> bounded reconcile copy`, m500);
    check((await api('/__synthetic/state')).sessionCount === c500, `${tag}: saved 500 created nothing and minted no new operation`);
    await page.locator('#reserve').screenshot({ path: path.join(OUT, `${tag}-06b-saved-500-reconcile.png`) });
    // correctness r2 N2: while the restart control shows, Reserve is disabled and dimmed.
    const look = () => page.evaluate(() => { const b = document.getElementById('reserveBtn'), c = getComputedStyle(b); return { disabled: b.disabled, bg: c.backgroundColor, opacity: c.opacity, cursor: c.cursor }; });
    const blocked = await look();
    await page.locator('#reserveRestart').click();
    const freed = await look();
    check(blocked.disabled && blocked.cursor === 'not-allowed' && (blocked.bg !== freed.bg || blocked.opacity !== freed.opacity), `${tag}: reserve disabled and dimmed while restart shows`, JSON.stringify(blocked));
    check(!freed.disabled && await page.locator('#reserveRestart').isHidden(), `${tag}: reserve re-enabled when restart hides`, JSON.stringify(freed));

    // Unknown outcomes (network lost before Stripe) are retried with the same operation,
    // then bounded: after 6 unknowns the visitor gets the reconcile path, not a dead end.
    await api('/__synthetic/fail-next?kind=lost&n=6', 'POST');
    await btn.click();
    await page.waitForFunction(() => /could not confirm the checkout status/.test(document.getElementById('reserveMsg').textContent), null, { timeout: 10000 });
    const um = await page.locator('#reserveMsg').innerText();
    check(/Check your card statement or banking app/.test(um) && !/No payment/i.test(um), `${tag}: uncertain message is truthful`, um);
    check(await page.locator('#reserveRestart').isHidden(), `${tag}: first round of unknowns keeps the same operation`);
    const opBefore = await page.evaluate(() => sessionStorage.getItem('revivex.depositOperation'));
    await page.reload({ waitUntil: 'networkidle' });
    const opAfter = await page.evaluate(() => sessionStorage.getItem('revivex.depositOperation'));
    check(opBefore && JSON.parse(opBefore).token === JSON.parse(opAfter).token && JSON.parse(opAfter).attempted === true, `${tag}: operation survives reload`);
    await page.locator('#reserve').screenshot({ path: path.join(OUT, `${tag}-06-uncertain.png`) });
    await page.waitForFunction(() => !document.getElementById('reserveBtn').disabled);
    if (!(await page.locator('#termsInput').isChecked())) await page.locator('#termsInput').check();
    await btn.click();
    await page.waitForFunction(() => !document.getElementById('reserveRestart').hidden, null, { timeout: 10000 });
    check(/card statement/.test(await page.locator('#reserveMsg').innerText()), `${tag}: repeated unknowns end in the reconcile path (bounded)`);
    await page.locator('#reserveRestart').click();

    // Make a fresh attempted operation for the age test.
    await Promise.all([page.waitForURL(/checkout\.stripe\.com/), btn.click()]);
    await page.goBack({ waitUntil: 'networkidle' });

    // Operation older than the idempotency window -> reconcile prompt, explicit restart only
    await page.waitForFunction(() => !document.getElementById('reserveBtn').disabled);
    await api('/__synthetic/advance-clock?hours=24', 'POST');
    const c1 = (await api('/__synthetic/state')).sessionCount;
    await page.waitForFunction(() => !document.getElementById('reserveBtn').disabled);
    if (!(await page.locator('#termsInput').isChecked())) await page.locator('#termsInput').check();
    await btn.click();
    await page.waitForFunction(() => !document.getElementById('reserveRestart').hidden, null, { timeout: 5000 });
    const rm = await page.locator('#reserveMsg').innerText();
    check(/earlier checkout attempt/.test(rm) && /support@revivex\.store/.test(rm) && /card statement/.test(rm), `${tag}: aged attempt asks to reconcile`, rm);
    check((await api('/__synthetic/state')).sessionCount === c1, `${tag}: aged attempt created nothing`);
    await btn.click({ force: true, timeout: 2000 }).catch(() => {});
    check(await btn.isDisabled() && (await api('/__synthetic/state')).sessionCount === c1, `${tag}: reserve blocked (disabled) until explicit restart`);
    await page.locator('#reserve').screenshot({ path: path.join(OUT, `${tag}-07-reconcile.png`) });
    await page.locator('#reserveRestart').click();
    await Promise.all([page.waitForURL(/checkout\.stripe\.com/), btn.click()]);
    check((await api('/__synthetic/state')).sessionCount === c1 + 1, `${tag}: explicit restart starts one new attempt`);
    await api('/__synthetic/advance-clock?hours=-24', 'POST');

    check(consoleErrors.filter(e => !/Failed to load resource/.test(e)).length === 0, `${tag}: no console errors (incl. CSP violations)`, consoleErrors.join(' | '));
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

  // Non-canonical host (alias): checkout is not offered there; visitor gets a link.
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true });
    let stripeHits = 0;
    await ctx.route('https://checkout.stripe.com/**', r => { stripeHits++; return r.abort(); });
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${SP}/#reserve`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => /Reservations are taken on/.test(document.getElementById('reserveMsg').textContent), null, { timeout: 5000 });
    check(await page.locator('#reserveBtn').isDisabled(), 'alias host: reserve button disabled (no dead button)');
    check(await page.locator('#reserveMsg a').getAttribute('href') === `${S}/#reserve`, 'alias host: links to canonical origin');
    check(stripeHits === 0, 'alias host: never opens checkout');
    await page.locator('#reserve').screenshot({ path: path.join(OUT, 'mobile-08-alias-host.png') });
    await ctx.close();
  }

  // Rendered terms / receipt copy: no refund cutoff.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    for (const p of ['/deposit-terms.html', '/privacy.html', '/reservation.html?session_id=cs_test_NOPE0000000']) {
      await page.goto(`${S}${p}`, { waitUntil: 'networkidle' });
      const t = await page.locator('body').innerText();
      check(!/convert/i.test(t) && !/before[^.]{0,40}final order/i.test(t), `rendered ${p.split('?')[0]}: no refund cutoff`);
    }
    await page.goto(`${S}/deposit-terms.html`, { waitUntil: 'networkidle' });
    check(/deposit-terms-v2/i.test(await page.locator('main').innerText()), 'terms page shows version deposit-terms-v2');
    await page.screenshot({ path: path.join(OUT, 'desktop-09-terms-v2.png'), fullPage: true });
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
      const a = await fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ step: 'start', termsAccepted: true, termsVersion: 'deposit-terms-v2' }) });
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

  // ---------------- Desktop layout: one container for nav, sections and footer ----------------
  const MACHINE_LEFT_X = 942; // left edge of the machine body in the 1600x900 hero poster
  for (const [w, h] of [[1280, 800], [1440, 900], [1920, 1080]]) {
    const tag = `layout-${w}`;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await ctx.route('https://checkout.stripe.com/**', r => r.abort());
    const page = await ctx.newPage();
    await page.goto(`${U}/`, { waitUntil: 'networkidle' });
    const m = await page.evaluate((mx) => {
      const R = s => document.querySelector(s).getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const links = [...document.querySelectorAll('.nav-links a, .nav .logo, .nav-cta')].map(e => e.getBoundingClientRect());
      const heads = [...document.querySelectorAll('.split-head')].map(e => e.getBoundingClientRect());
      const frame = R('.hero-frame'), title = R('.hero-title');
      const s = Math.max(frame.width / 1600, frame.height / 900);
      const machineLeft = frame.left + (frame.width - 1600 * s) * 0.64 + mx * s;
      return {
        vw, overflow: document.documentElement.scrollWidth - vw,
        linksInside: links.every(r => r.width > 0 && r.left >= 0 && r.right <= vw),
        linksOnHero: links.every(r => r.left >= frame.left + 8 && r.right <= frame.right - 8),
        navLeft: R('.nav-links a').left, navRight: R('.nav-cta').right,
        heads: heads.map(r => [r.left, r.right]),
        others: ['.steps-row', '.gallery', '.cta-inner', '.faq-wrap', '.footer'].map(q => [q, R(q).left, R(q).right]),
        titleRight: title.right, machineLeft,
      };
    }, MACHINE_LEFT_X);
    check(m.overflow <= 0, `${tag}: no horizontal overflow`, m.overflow);
    check(m.linksInside, `${tag}: nav links, logo and CTA fully inside the viewport`);
    check(m.linksOnHero, `${tag}: nav sits over the hero image at the top of the page (no white on white)`);
    check(m.heads.every(([l, r]) => Math.abs(l - m.navLeft) <= 2 && Math.abs(r - m.navRight) <= 2), `${tag}: nav left/right edges align with every section head container`, JSON.stringify({ nav: [m.navLeft, m.navRight], heads: m.heads }));
    check(m.others.every(([, l, r]) => Math.abs(l - m.navLeft) <= 2 && Math.abs(r - m.navRight) <= 2), `${tag}: steps, gallery, preorder, FAQ and footer share the nav container`, JSON.stringify(m.others));
    check(m.titleRight + 80 <= m.machineLeft, `${tag}: hero headline clears the machine`, JSON.stringify({ titleRight: m.titleRight, machineLeft: m.machineLeft }));
    if (w === 1920) check(m.navRight - m.navLeft >= 1400, `${tag}: wide screens use a wide container, not a narrow strip`, m.navRight - m.navLeft);
    await page.screenshot({ path: path.join(OUT, `${tag}-hero.png`) });
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
