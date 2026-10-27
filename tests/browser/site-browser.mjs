// Browser QA against the owned LOCAL harness (tests/harness/local-harness.mjs) using
// installed Google Chrome via playwright-core. Builds the static site with the real
// build script first.
//
// Covers the early access signup modal that every CTA opens (synthetic harness: PGlite
// waitlist database, recorded email and Meta transports), the receipt, reservation and
// legal pages kept for existing deposits (synthetic Stripe stand-in), the production-like
// unconfigured build and the desktop layout. Every request to checkout.stripe.com is
// intercepted; no Stripe, Neon, Resend, Meta or production request is made.
//
//   node tests/browser/site-browser.mjs [--out <screenshot dir>]
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
  results.push({ ok: !!ok, label, detail: String(detail).slice(0, 400) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail && !ok ? ` :: ${String(detail).slice(0, 400)}` : ''}`);
}

function startHarness(mode, port) {
  return new Promise((resolve, reject) => {
    const p = spawn('node', ['tests/harness/local-harness.mjs', '--mode', mode, '--port', String(port), '--root', path.join(BUILD, 'public')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
    p.stdout.on('data', d => { if (String(d).includes('harness ')) resolve(p); });
    p.on('exit', c => reject(new Error(`harness exited ${c}`)));
    setTimeout(() => reject(new Error('harness start timeout')), 15000);
  });
}

const VIEWPORTS = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false },
  { name: 'mobile', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
];
// Every CTA: [name, selector, label]. Linc's split: GET EARLY ACCESS in the nav, JOIN THE WAITLIST elsewhere.
const CTAS = [['nav', '.nav-cta', 'Get early access'], ['hero', '.hero-actions [data-signup]', 'Join the waitlist'], ['mid', '.split-side [data-signup]', 'Join the waitlist'], ['waitlist', '#waitlistBtn', 'Join the waitlist']];
const HERO_H1 = 'Your supplements, blended every morning';
const UTM = 'utm_source=meta&utm_medium=paid_social&utm_campaign=waitlist_launch&utm_content=angle_02&utm_term=supplements&gclid=SHOULDNOTPASS';

async function scrollSettled(page) {
  await page.waitForFunction(() => new Promise(r => { const a = scrollY; setTimeout(() => r(scrollY === a), 200); }), null, { timeout: 5000, polling: 50 }).catch(() => {});
}
const overflowX = page => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const modalOpen = page => page.evaluate(() => !document.getElementById('signup').hidden);
async function openFrom(page, sel, how = 'click') {
  const el = page.locator(sel);
  await el.scrollIntoViewIfNeeded();
  await scrollSettled(page);
  if (how === 'click') await el.click();
  else { await el.focus(); await page.keyboard.press(how); }
  await page.waitForFunction(() => document.getElementById('signup').classList.contains('is-open'), null, { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(350);
}
async function pickCountry(page, query) {
  await page.locator('#countryToggle').click();
  await page.keyboard.type(query);
  await page.keyboard.press('Enter');
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const harnesses = [];
try {
  const SP = 4393;
  harnesses.push(await startHarness('synthetic', SP));
  const S = `http://127.0.0.1:${SP}`;
  const api = async (p, method = 'GET') => (await fetch(S + p, { method })).json();
  const signups = () => api('/__synthetic/signups');
  const leadsOnServer = async () => (await api('/__synthetic/meta-events')).filter(e => e.event_name === 'Lead');

  // ================= Early access signup (both viewports) =================
  for (const vp of VIEWPORTS) {
    const tag = vp.name;
    await api('/__synthetic/reset-signups', 'POST');
    const ctx = await browser.newContext({ viewport: vp.viewport, deviceScaleFactor: vp.deviceScaleFactor, isMobile: vp.isMobile, hasTouch: vp.hasTouch });
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|fonts\.googleapis\.com|fonts\.gstatic\.com)/, route => route.abort());
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push(String(e)));
    const posts = [];
    page.on('request', r => { if (r.url().endsWith('/api/signup') && r.method() === 'POST') posts.push(r.postDataJSON()); });
    page.on('request', r => { if (r.url().includes('/api/checkout')) posts.push({ checkout: r.url() }); });

    // ---- The page stays as it was; only the call to action changed ----
    await page.goto(`${S}/?${UTM}`, { waitUntil: 'networkidle' });
    check((await page.locator('h1.hero-title').innerText()).replace(/\s+/g, ' ').trim() === HERO_H1, `${tag}: hero headline unchanged`);
    check(await page.locator('#heroCanvas').count() === 1 && await page.locator('img.hero-fallback[src="/assets/v11/hero-poster.jpg"]').count() === 1, `${tag}: hero canvas + approved poster retained`);
    const labels = await page.$$eval('[data-signup]', els => els.map(e => [e.dataset.signup, e.textContent.trim(), e.getAttribute('href')]));
    check(JSON.stringify(labels.map(l => l[1])) === JSON.stringify(CTAS.map(c => c[2])), `${tag}: CTA labels: nav Get early access, hero/mid/section Join the waitlist`, JSON.stringify(labels));
    check(labels.filter(l => l[2] !== null).every(l => l[2] === '#waitlist'), `${tag}: CTA links fall back to #waitlist without JavaScript`, JSON.stringify(labels));
    check(await page.locator('[data-checkout], #reserveBtn, #reserveForm, #depositPanel').count() === 0, `${tag}: no deposit checkout control left on the home page`);
    const bodyText = await page.locator('body').innerText();
    const meta = await page.evaluate(() => [document.querySelector('meta[name="description"]').content, document.querySelector('meta[property="og:description"]').content].join(' '));
    check(!/\$\s?50|\$100|20% off|refundable|\bpreorder|\bdeposit\b(?! terms)/i.test(bodyText.replace(/Deposit terms/g, '')) && !/\$|deposit|preorder|refundable/i.test(meta), `${tag}: no $50 deposit, 20% off, refundable or Preorder claims in the page or its meta`, (bodyText.match(/.{0,40}(\$\s?50|20% off|refundable|preorder|deposit).{0,40}/gi) || []).join(' | ') + ' || ' + meta);
    check((await page.locator('#waitlist-title').innerText()).trim() === 'Get early access.' && await page.locator('#waitlist .cta-copy p').count() === 1, `${tag}: waitlist section: heading, one line, one button`);
    check(/in development/.test(bodyText) && /final price and shipping date have not been announced/.test(bodyText), `${tag}: in development and no ship date honesty kept`);
    const faq = await page.$$eval('.faq details', ds => ds.map(d => d.textContent.replace(/\s+/g, ' ').trim()));
    check(faq.some(t => /How does the waitlist work\?/.test(t) && /unsubscribe at any time/.test(t)) && faq.every(t => !/deposit|refund/i.test(t)), `${tag}: FAQ describes the waitlist, no deposit entries`, faq.join(' | '));
    check(await page.locator('footer a[href="/privacy.html"]').count() === 1, `${tag}: footer privacy link retained`);
    check(await page.locator('#signup').isHidden(), `${tag}: modal closed on load`);
    check(await overflowX(page) <= 0, `${tag}: no horizontal overflow (page)`, await overflowX(page));
    const csp = await page.evaluate(async () => (await fetch('/', { cache: 'no-store' })).headers.get('content-security-policy'));
    check(/frame-ancestors 'none'/.test(csp || ''), `${tag}: CSP with frame-ancestors none served`);
    if (vp.name === 'desktop') await page.waitForFunction(() => document.getElementById('heroCanvas').classList.contains('ready'), null, { timeout: 10000 }).catch(() => {});
    check(vp.name !== 'desktop' || await page.evaluate(() => document.getElementById('heroCanvas').classList.contains('ready')), `${tag}: hero frame sequence still loads under CSP`);
    await page.screenshot({ path: path.join(OUT, `${tag}-01-hero-closed.png`) });

    // ---- Every CTA opens the one modal; Escape, backdrop and X close it; focus returns ----
    for (const [name, sel] of CTAS) {
      const y0 = await page.evaluate(() => Math.round(scrollY));
      await openFrom(page, sel);
      const st = await page.evaluate(() => {
        const root = document.getElementById('signup'), card = root.querySelector('.signup-card'), bd = getComputedStyle(root.querySelector('.signup-backdrop'));
        return { open: !root.hidden, dialog: card.getAttribute('role') === 'dialog' && card.getAttribute('aria-modal') === 'true', inCard: card.contains(document.activeElement), blur: /blur/.test(bd.backdropFilter || bd.webkitBackdropFilter || ''), dim: bd.backgroundColor, locked: getComputedStyle(document.documentElement).overflow === 'hidden', inert: document.querySelector('main').inert, hash: location.hash, ov: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      check(st.open && st.dialog && st.inCard, `${tag}: ${name} CTA opens the signup dialog with focus inside`, JSON.stringify(st));
      check(st.blur && /rgba\(10, 10, 10, 0\.3/.test(st.dim) && st.locked && st.inert && st.hash === '' && st.ov <= 0, `${tag}: ${name}: page behind blurred and dimmed, scroll locked, inert, no hash jump, no overflow`, JSON.stringify(st));
      const how = { nav: 'escape', hero: 'backdrop', mid: 'close', waitlist: 'escape' }[name];
      if (how === 'escape') await page.keyboard.press('Escape');
      else if (how === 'backdrop') await page.mouse.click(5, vp.viewport.height - 5);
      else await page.locator('.signup-close').click();
      await page.waitForTimeout(150);
      const after = await page.evaluate(s => ({ closed: document.getElementById('signup').hidden, focus: document.activeElement === document.querySelector(s), unlocked: getComputedStyle(document.documentElement).overflow !== 'hidden', inert: document.querySelector('main').inert }), sel);
      check(after.closed && after.focus && after.unlocked && !after.inert, `${tag}: ${name}: ${how} closes, focus returns to the ${name} CTA, scroll unlocked`, JSON.stringify(after));
      check(Math.abs((await page.evaluate(() => Math.round(scrollY))) - y0) <= 2 || name !== 'nav', `${tag}: ${name}: opening did not scroll the page`);
    }

    // ---- Keyboard: Enter and Space on the CTA links open it ----
    for (const [key, sel] of [['Enter', '.hero-actions [data-signup]'], ['Space', '.nav-cta']]) {
      await openFrom(page, sel, key);
      check(await modalOpen(page), `${tag}: ${key} on ${sel} opens the modal`);
      await page.keyboard.press('Escape');
    }

    // ---- Focus trap ----
    await openFrom(page, '.hero-actions [data-signup]');
    const ring = [];
    for (let i = 0; i < 9; i++) { await page.keyboard.press('Tab'); ring.push(await page.evaluate(() => [document.getElementById('signup').contains(document.activeElement), document.activeElement.id || document.activeElement.className])); }
    check(ring.every(r => r[0]), `${tag}: Tab x9 never leaves the dialog`, JSON.stringify(ring));
    check(new Set(ring.map(r => r[1])).size >= 4 && ring.some(r => r[1] === 'signupEmail') && ring.some(r => r[1] === 'signupSubmit') && ring.some(r => /signup-close/.test(r[1])), `${tag}: Tab cycles close, email, country and submit`, JSON.stringify(ring));
    await page.locator('#signupEmail').focus();
    await page.keyboard.press('Shift+Tab');
    const back = await page.evaluate(() => document.activeElement.className);
    await page.keyboard.press('Shift+Tab');
    const wrap = await page.evaluate(() => [document.getElementById('signup').contains(document.activeElement), document.activeElement.id]);
    check(/signup-close/.test(back) && wrap[0] && wrap[1] === 'signupSubmit', `${tag}: Shift+Tab from the first control wraps to the last`, JSON.stringify({ back, wrap }));
    await page.screenshot({ path: path.join(OUT, `${tag}-02-modal-open.png`) });
    const box = await page.evaluate(() => { const r = document.querySelector('.signup-card').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), left: r.left, right: r.right, vw: document.documentElement.clientWidth, media: getComputedStyle(document.querySelector('.signup-media')).display, radius: getComputedStyle(document.querySelector('.signup-card')).borderRadius, bg: getComputedStyle(document.querySelector('.signup-card')).backgroundColor }; });
    if (tag === 'desktop') check(box.w === 960 && box.h === 568 && box.media !== 'none' && box.radius === '12px' && box.bg === 'rgb(24, 25, 27)', `${tag}: 960x568 split card, image shown, 12px radius, #18191B`, JSON.stringify(box));
    else check(box.w === 330 && box.media === 'none' && box.radius === '12px' && box.left >= 0 && box.right <= box.vw, `${tag}: 330px card, no image, inside the viewport`, JSON.stringify(box));
    check(await overflowX(page) <= 0, `${tag}: no horizontal overflow with the modal open`);

    // ---- Validation: nothing is sent for an invalid email or a missing country ----
    const p0 = posts.length;
    await page.locator('#signupEmail').fill('not-an-email');
    await page.locator('#signupSubmit').click();
    let err = await page.locator('#signupError').innerText();
    check(/valid email/.test(err) && posts.length === p0 && await page.locator('#signupEmail').getAttribute('aria-invalid') !== null && await page.locator('#signupForm').isVisible(), `${tag}: invalid email rejected inline, nothing sent`, err);
    await page.locator('#signupEmail').fill('person.one@example.com');
    await page.locator('#signupSubmit').click();
    err = await page.locator('#signupError').innerText();
    check(/country/i.test(err) && posts.length === p0, `${tag}: missing country rejected inline, nothing sent`, err);
    // An address only the server can rule out: the server's 400 is shown, no success.
    await pickCountry(page, 'king');
    check((await page.locator('#countryValue').innerText()) === 'United Kingdom', `${tag}: searchable country list: "king" + Enter picks United Kingdom`);
    await page.locator('#signupEmail').fill('a..b@example.com');
    await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/signup') && r.request().method() === 'POST'), page.locator('#signupSubmit').click()]);
    await page.waitForTimeout(150);
    err = await page.locator('#signupError').innerText();
    check(/valid email/.test(err) && await page.locator('#signupDone').isHidden() && (await signups()).length === 0, `${tag}: server rejected email shows its error, no success, no row`, err);
    await page.screenshot({ path: path.join(OUT, `${tag}-05-error-invalid-email.png`) });

    // ---- 5xx: error shown, form kept, nothing saved ----
    await page.locator('#signupEmail').fill('person.one@example.com');
    await api('/__synthetic/signup-db-fail', 'POST');
    await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/signup') && r.request().method() === 'POST'), page.locator('#signupSubmit').click()]);
    await page.waitForTimeout(150);
    err = await page.locator('#signupError').innerText();
    check(/could not save your signup\. Nothing was saved/.test(err) && await page.locator('#signupDone').isHidden() && await page.locator('#signupForm').isVisible() && (await signups()).length === 0, `${tag}: 503 from the API shows an error and no success`, err);
    // ---- Network failure ----
    await page.route('**/api/signup', r => (r.request().method() === 'POST' ? r.abort('internetdisconnected') : r.continue()));
    await page.locator('#signupSubmit').click();
    await page.waitForFunction(() => /couldn't reach our server/.test(document.getElementById('signupError').textContent), null, { timeout: 5000 }).catch(() => {});
    err = await page.locator('#signupError').innerText();
    check(/couldn't reach our server, so nothing was saved/.test(err) && await page.locator('#signupDone').isHidden() && !(await page.locator('#signupSubmit').isDisabled()), `${tag}: network error shows an error, no success, button usable again`, err);
    await page.screenshot({ path: path.join(OUT, `${tag}-05b-error-network.png`) });
    await page.unroute('**/api/signup');

    // ---- Success only after the 200: the response is held, then released ----
    let release;
    const gate = new Promise(r => { release = r; });
    let held = 0;
    await page.route('**/api/signup', async r => { if (r.request().method() !== 'POST') return r.continue(); held++; const resp = await r.fetch(); await gate; return r.fulfill({ response: resp }); });
    await page.screenshot({ path: path.join(OUT, `${tag}-03-filled.png`) });
    await page.locator('#signupSubmit').click();
    await page.waitForTimeout(400);
    const during = await page.evaluate(() => ({ done: !document.getElementById('signupDone').hidden, busy: document.getElementById('signupSubmit').hasAttribute('aria-busy'), disabled: document.getElementById('signupSubmit').disabled, label: document.getElementById('signupSubmit').textContent.trim(), spinner: !!document.querySelector('#signupSubmit .btn-spinner') }));
    await page.locator('#signupSubmit').dispatchEvent('click');
    await page.keyboard.press('Enter');
    const rowsWhileHeld = (await signups()).length;
    check(!during.done && during.busy && during.disabled && during.spinner && /Please wait/.test(during.label), `${tag}: while the request is pending: loading state, no success yet`, JSON.stringify(during));
    check(rowsWhileHeld === 1, `${tag}: (row committed by the server before its 200 reached the page)`, rowsWhileHeld);
    release();
    await page.waitForFunction(() => !document.getElementById('signupDone').hidden, null, { timeout: 5000 }).catch(() => {});
    await page.unroute('**/api/signup');
    const doneText = (await page.locator('#signupDone').innerText()).replace(/\s+/g, ' ').trim();
    check(doneText === "You’re on the list. Thanks for joining the Revivex early access list. We’ll keep you updated as we get closer to launch." && await page.locator('#signupForm').isHidden(), `${tag}: success replaces the form after the 200`, doneText);
    check(held === 1, `${tag}: repeated clicks and Enter while pending sent one request`, held);
    const rows = await signups();
    const r0 = rows[0] || {};
    check(rows.length === 1 && r0.email === 'person.one@example.com' && r0.country === 'GB' && r0.source === 'homepage:hero' && r0.utm_source === 'meta' && r0.utm_term === 'supplements' && r0.consent_text_version === 'waitlist-v1' && /^[0-9a-f]{64}$/.test(r0.ip_hash), `${tag}: one row with email, country, source and UTM stored`, JSON.stringify({ ...r0, unsubscribe_token: '…' }));
    check(!JSON.stringify(rows).includes('SHOULDNOTPASS'), `${tag}: click ids are not stored`);
    check((await leadsOnServer()).length === 1, `${tag}: exactly one server Lead for the signup`, JSON.stringify(await leadsOnServer()));
    const mails = await api('/__synthetic/emails');
    check(mails.length === 1 && mails[0].text.includes(`/api/unsubscribe?token=${r0.unsubscribe_token}`) && /One-Click/.test(mails[0].headers['List-Unsubscribe-Post']), `${tag}: one welcome email with the unsubscribe link`, JSON.stringify(mails.map(m => m.subject)));
    await page.screenshot({ path: path.join(OUT, `${tag}-04-success.png`) });
    check(await overflowX(page) <= 0, `${tag}: no horizontal overflow in the success state`);
    await page.keyboard.press('Escape');

    // ---- Repeat signup: success, still one row, no second email or Lead ----
    await page.goto(`${S}/`, { waitUntil: 'networkidle' });
    await openFrom(page, '.nav-cta');
    await page.locator('#signupEmail').fill('PERSON.ONE@example.com ');
    await pickCountry(page, 'fran');
    await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/signup') && r.request().method() === 'POST'), page.locator('#signupSubmit').click()]);
    await page.waitForTimeout(200);
    check(await page.locator('#signupDone').isVisible() && (await signups()).length === 1 && (await api('/__synthetic/emails')).length === 1 && (await leadsOnServer()).length === 1, `${tag}: repeat signup succeeds without a duplicate row, email or Lead`);

    // ---- Unsubscribe link from the email ----
    await page.goto(`${S}/api/unsubscribe?token=${r0.unsubscribe_token}`, { waitUntil: 'networkidle' });
    const ut = await page.locator('body').innerText();
    check(/You're unsubscribed/.test(ut) && (await signups())[0].unsubscribed_at, `${tag}: unsubscribe link shows a confirmation and sets unsubscribed_at`, ut.slice(0, 120));

    // ---- Phone keyboard open: the card fits the visual viewport and scrolls inside ----
    if (vp.isMobile) {
      await page.goto(`${S}/`, { waitUntil: 'networkidle' });
      await openFrom(page, '.hero-actions [data-signup]');
      await page.locator('#signupEmail').focus();
      await page.setViewportSize({ width: 390, height: 430 }); // roughly 844 minus an iOS keyboard
      await page.waitForTimeout(400);
      const k = await page.evaluate(() => { const c = document.querySelector('.signup-card').getBoundingClientRect(); return { top: c.top, bottom: c.bottom, left: c.left, right: c.right, vh: innerHeight, vw: document.documentElement.clientWidth, scrolls: document.querySelector('.signup-card').scrollHeight > document.querySelector('.signup-card').clientHeight }; });
      check(k.top >= 0 && k.bottom <= k.vh && k.left >= 0 && k.right <= k.vw && k.scrolls, `${tag}: keyboard open (390x430): card inside the visible area and scrollable`, JSON.stringify(k));
      await page.locator('#signupSubmit').scrollIntoViewIfNeeded();
      const sb = await page.locator('#signupSubmit').boundingBox();
      check(sb && sb.y >= 0 && sb.y + sb.height <= 430 && await overflowX(page) <= 0, `${tag}: keyboard open: submit reachable, no horizontal overflow`, JSON.stringify(sb));
      await pickCountry(page, 'united s');
      check((await page.locator('#countryValue').innerText()) === 'United States', `${tag}: keyboard open: country search still usable`);
      await page.setViewportSize(vp.viewport);
    }

    check(!posts.some(p => p.checkout && /POST/.test(p.checkout)), `${tag}: the home page never posts to the checkout API`);
    check(consoleErrors.filter(e => !/Failed to load resource|ERR_INTERNET_DISCONNECTED|ERR_FAILED/.test(e)).length === 0, `${tag}: no console errors (incl. CSP violations)`, consoleErrors.join(' | '));
    await ctx.close();
  }

  // ---- Without JavaScript: the CTAs lead to the waitlist section and say JS is needed ----
  for (const vp of VIEWPORTS) {
    const tag = `${vp.name}-nojs`;
    const ctx = await browser.newContext({ viewport: vp.viewport, deviceScaleFactor: vp.deviceScaleFactor, isMobile: vp.isMobile, hasTouch: vp.hasTouch, javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto(`${S}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1300);
    const hb = await page.locator('.hero-actions [data-signup]').boundingBox();
    await page.mouse.click(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.waitForFunction(() => location.hash === '#waitlist', null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const v = await page.evaluate(() => {
      const op = el => { let o = 1; for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
      const ns = [...document.querySelectorAll('#waitlist p.form-msg')].find(p => /needs JavaScript/.test(p.textContent));
      const card = document.querySelector('#waitlist .cta-inner'), r = card.getBoundingClientRect();
      return { hash: location.hash, cardOpacity: op(card), notice: ns ? op(ns) : 0, inView: r.top < innerHeight && r.bottom > 0, modalHidden: document.getElementById('signup').hidden };
    });
    check(v.hash === '#waitlist' && v.inView && v.cardOpacity === 1 && v.notice === 1 && v.modalHidden, `${tag}: hero CTA leads to the waitlist section, which says joining needs JavaScript`, JSON.stringify(v));
    await ctx.close();
  }

  // ================= Existing deposits: receipt, reservation and legal routes =================
  for (const vp of VIEWPORTS) {
    const tag = `${vp.name} receipts`;
    const ctx = await browser.newContext({ viewport: vp.viewport, deviceScaleFactor: vp.deviceScaleFactor, isMobile: vp.isMobile, hasTouch: vp.hasTouch });
    await ctx.route('https://checkout.stripe.com/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>SYNTHETIC</h1>' }));
    const page = await ctx.newPage();
    const receipt = async id => {
      await page.goto(`${S}/reservation.html?session_id=${id}`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => document.getElementById('receipt').dataset.state !== 'loading');
      return {
        state: await page.locator('#receipt').getAttribute('data-state'),
        text: await page.locator('#receipt').innerText(),
        discountShown: await page.locator('#receiptDiscountRow').isVisible(),
        refundedShown: await page.locator('#receiptRefundedRow').isVisible(),
        termsHref: await page.locator('#receiptTermsLink').getAttribute('href'),
      };
    };
    const v3 = (await api('/__synthetic/seed-paid', 'POST')).session_id;
    let r = await receipt(v3);
    check(r.state === 'confirmed' && /\$50\.00 USD/.test(r.text) && /20% off the final price/.test(r.text) && /pi_SYNTH/.test(r.text), `${tag}: paid $50 receipt confirmed from the server lookup, with the 20% and the reference`, r.text);
    check(/support@revivex\.store/.test(r.text) && !/synthetic-buyer|Synthetic Buyer/.test(r.text), `${tag}: receipt shows the refund contact and no customer email/name`);
    await page.screenshot({ path: path.join(OUT, `${tag.replace(' ', '-')}-confirmed.png`), fullPage: true });
    await api(`/__synthetic/dispute?session_id=${v3}`, 'POST');
    check((await receipt(v3)).state === 'disputed', `${tag}: disputed deposit shown as disputed`);
    // An unpaid session (made through the unchanged checkout API) with paid-looking query params.
    const unpaid = await page.evaluate(async () => {
      const post = async b => (await fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ termsAccepted: true, termsVersion: 'deposit-terms-v3', displayedAmount: 5000, ...b }) })).json();
      const s = await post({ step: 'start', attribution: {} });
      return (await post({ step: 'create', operation: s.operation })).url.split('/').pop();
    });
    await page.goto(`${S}/reservation.html?session_id=${unpaid}&paid=true&payment_status=paid`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.getElementById('receipt').dataset.state !== 'loading');
    check(await page.locator('#receipt').getAttribute('data-state') === 'not_completed' && await page.locator('#receiptFacts').isHidden(), `${tag}: query params cannot fake a payment`);
    const legacy = (await api('/__synthetic/seed-paid?legacy=1', 'POST')).session_id;
    r = await receipt(legacy);
    check(r.state === 'confirmed' && /\$100\.00 USD/.test(r.text) && !/\$50|20%/.test(r.text) && !r.discountShown && r.termsHref === '/deposit-terms-v2.html', `${tag}: historical $100 receipt keeps $100, its v2 terms and no discount`, r.text);
    await api(`/__synthetic/refund?session_id=${legacy}`, 'POST');
    r = await receipt(legacy);
    check(r.state === 'refunded' && r.refundedShown && (r.text.match(/\$100\.00 USD/g) || []).length === 2, `${tag}: refunded $100 receipt shows paid and refunded $100`, r.text);
    await ctx.close();
  }
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    for (const p of ['/deposit-terms.html', '/deposit-terms-v2.html', '/privacy.html', '/reservation.html?session_id=cs_test_NOPE0000000']) {
      const resp = await page.goto(`${S}${p}`, { waitUntil: 'networkidle' });
      const t = await page.locator('body').innerText();
      check(resp.status() === 200 && !/convert/i.test(t) && !/before[^.]{0,40}final order/i.test(t), `rendered ${p.split('?')[0]}: served, no refund cutoff`);
    }
    await page.goto(`${S}/deposit-terms.html`, { waitUntil: 'networkidle' });
    check(/deposit-terms-v3/i.test(await page.locator('main').innerText()), 'terms page shows version deposit-terms-v3');
    await page.goto(`${S}/privacy.html`, { waitUntil: 'networkidle' });
    const pt = await page.locator('main').innerText();
    check(/email address and the country you choose/.test(pt) && /Neon, which encrypts it at rest and in transit/.test(pt) && /only to send you updates about the Revivex launch/.test(pt) && /unsubscribe link in every email/.test(pt) && /utm_source/.test(pt), 'privacy page describes the waitlist data, storage, use and unsubscribe');
    check(!/[‐-―]/.test(pt) && !/\w-\w/.test(pt.replace(/support@revivex\.store/g, '')), 'privacy page: no dashes in customer copy', (pt.match(/.{0,20}(\w-\w|[‐-―]).{0,20}/g) || []).join(' | '));
    const checkoutProbe = await page.evaluate(async () => { const r = await fetch('/api/checkout'); return { status: r.status, body: await r.json() }; });
    check(checkoutProbe.status === 200 && checkoutProbe.body.termsVersion === 'deposit-terms-v3', 'GET /api/checkout probe unchanged', JSON.stringify(checkoutProbe));
    await ctx.close();
  }

  // ================= Unconfigured (production-like) =================
  const UP = 4394;
  harnesses.push(await startHarness('unconfigured', UP));
  const U = `http://127.0.0.1:${UP}`;
  for (const vp of VIEWPORTS) {
    const tag = `${vp.name}-unconfigured`;
    const ctx = await browser.newContext({ viewport: vp.viewport, deviceScaleFactor: vp.deviceScaleFactor, isMobile: vp.isMobile, hasTouch: vp.hasTouch });
    const page = await ctx.newPage();
    await page.goto(`${U}/`, { waitUntil: 'networkidle' });
    await openFrom(page, '.hero-actions [data-signup]');
    await page.locator('#signupEmail').fill('browser-qa@example.com');
    await pickCountry(page, 'germ');
    await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/signup') && r.request().method() === 'POST'), page.locator('#signupSubmit').click()]);
    await page.waitForTimeout(200);
    const err = await page.locator('#signupError').innerText();
    check(/not available right now\. Nothing was saved/.test(err) && await page.locator('#signupDone').isHidden(), `${tag}: real signup export without a database answers 503; the modal shows an error, never success`, err);
    const r = await page.evaluate(async () => {
      const a = await fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ step: 'start', termsAccepted: true, termsVersion: 'deposit-terms-v3', displayedAmount: 5000 }) });
      return { a: a.status, aj: await a.json() };
    });
    check(r.a === 503 && r.aj.state === 'unavailable' && !r.aj.operation, `${tag}: real default checkout export still returns 503 unavailable`);
    for (const doc of ['deposit-terms', 'privacy']) {
      await page.goto(`${U}/${doc}.html`, { waitUntil: 'networkidle' });
      const t = await page.locator('main').innerText();
      check(/support@revivex\.store/.test(t) && !/not yet configured|LOCAL PREVIEW|SQLite/i.test(t), `${tag}: ${doc} shows official contact, no placeholders/local-only claims`);
      const ov = await overflowX(page);
      check(ov <= 0, `${tag}: ${doc} no horizontal overflow`, ov);
    }
    await ctx.close();
  }

  // ================= Desktop layout: one container for nav, sections and footer =================
  const MACHINE_LEFT_X = 942; // left edge of the machine body in the 1600x900 hero poster
  for (const [w, h, minGap] of [[981, 800, 40], [1024, 768, 40], [1024, 1366, 40], [1280, 800, 80], [1440, 900, 80], [1920, 1080, 80]]) {
    const tag = `layout-${w}x${h}`;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto(`${U}/`, { waitUntil: 'networkidle' });
    const m = await page.evaluate((mx) => {
      const R = s => document.querySelector(s).getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const links = [...document.querySelectorAll('.nav-links a, .nav .logo, .nav-cta')].map(e => e.getBoundingClientRect());
      const heads = [...document.querySelectorAll('.split-head')].map(e => e.getBoundingClientRect());
      const frame = R('.hero-frame');
      const glyphs = document.createRange();
      glyphs.selectNodeContents(document.querySelector('.hero-title'));
      const s = Math.max(frame.width / 1600, frame.height / 900);
      const machineLeft = frame.left + (frame.width - 1600 * s) * 0.64 + mx * s;
      return {
        vw, overflow: document.documentElement.scrollWidth - vw,
        linksInside: links.every(r => r.width > 0 && r.left >= 0 && r.right <= vw),
        linksOnHero: links.every(r => r.left >= frame.left + 8 && r.right <= frame.right - 8),
        navLeft: R('.nav-links a').left, navRight: R('.nav-cta').right,
        heads: heads.map(r => [r.left, r.right]),
        others: ['.steps-row', '.gallery', '.cta-inner', '.faq-wrap', '.footer'].map(q => [q, R(q).left, R(q).right]),
        titleRight: Math.max(...[...glyphs.getClientRects()].map(r => r.right)), machineLeft,
      };
    }, MACHINE_LEFT_X);
    check(m.overflow <= 0, `${tag}: no horizontal overflow`, m.overflow);
    check(m.linksInside, `${tag}: nav links, logo and CTA fully inside the viewport`);
    check(m.linksOnHero, `${tag}: nav sits over the hero image at the top of the page`);
    check(m.heads.every(([l, r]) => Math.abs(l - m.navLeft) <= 2 && Math.abs(r - m.navRight) <= 2), `${tag}: nav left/right edges align with every section head container`, JSON.stringify({ nav: [m.navLeft, m.navRight], heads: m.heads }));
    check(m.others.every(([, l, r]) => Math.abs(l - m.navLeft) <= 2 && Math.abs(r - m.navRight) <= 2), `${tag}: steps, gallery, waitlist, FAQ and footer share the nav container`, JSON.stringify(m.others));
    check(m.titleRight + minGap <= m.machineLeft, `${tag}: hero headline clears the machine by at least ${minGap}px`, JSON.stringify({ titleRight: m.titleRight, machineLeft: m.machineLeft }));
    await ctx.close();
  }
} finally {
  await browser.close();
  for (const h of harnesses) h.kill();
  fs.writeFileSync(path.join(OUT, 'browser-results.json'), JSON.stringify({ when: new Date().toISOString(), note: 'LOCAL harness + SYNTHETIC Stripe + PGlite waitlist; no provider contacted', results }, null, 2));
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
process.exit(failed.length ? 1 : 0);
