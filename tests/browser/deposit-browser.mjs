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
// The four Preorder buttons. Each must open checkout directly (no scroll to #reserve).
const PREORDER_BUTTONS = [['nav', '.nav-cta'], ['hero', '.hero-actions [data-checkout]'], ['mid', '.split-side [data-checkout]'], ['section', '#reserveBtn']];

// html has scroll-behavior: smooth, so wait until a scroll in progress has finished.
async function scrollSettled(page) {
  await page.waitForFunction(() => new Promise(r => { const a = scrollY; setTimeout(() => r(scrollY === a), 200); }), null, { timeout: 5000, polling: 50 }).catch(() => {});
}

// Clicks a Preorder button while holding its first checkout POST, so the busy state and
// the scroll position can be read before the browser leaves for (intercepted) Stripe.
// Waits until the scroll reveal around an element (if any) has fully faded in.
const revealed = (page, sel) => page.waitForFunction(s => { const r = document.querySelector(s).closest('.reveal'); return !r || (r.classList.contains('in') && getComputedStyle(r).opacity === '1'); }, sel, { timeout: 5000 }).catch(() => {});

// how: 'click' (pointer), or a key ('Enter' / 'Space') pressed on the focused button.
// During the held request `more(page)` may press further keys or click other buttons.
async function openFrom(page, sel, shot, { how = 'click', more } = {}) {
  const el = page.locator(sel);
  await el.scrollIntoViewIfNeeded();
  // Lazy images above the button load after the jump and scroll anchoring adjusts for them.
  await page.waitForLoadState('networkidle');
  await revealed(page, sel);
  await page.waitForTimeout(300);
  await scrollSettled(page);
  if (how !== 'click') { await el.focus(); await scrollSettled(page); }
  const y0 = await page.evaluate(() => { window.__scrolls = 0; addEventListener('scroll', () => { window.__scrolls++; }); return Math.round(scrollY); });
  const bodies = [];
  let release, held = false;
  const gate = new Promise(r => { release = r; });
  const hold = async route => {
    if (route.request().method() === 'POST') {
      bodies.push(route.request().postDataJSON());
      if (!held) { held = true; await gate; }
    }
    return route.continue();
  };
  await page.route('**/api/checkout', hold);
  // Settles to true / false (never rejects), so a broken guard is reported with counts.
  const left = page.waitForURL(/checkout\.stripe\.com/, { timeout: 10000 }).then(() => true, () => false);
  if (how === 'click') {
    // A plain pointer click at the button (locator.click may itself scroll first).
    const box = await el.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  } else {
    await page.keyboard.press(how);
  }
  await page.waitForFunction(s => document.querySelector(s).getAttribute('aria-busy') === 'true', sel, { timeout: 3000 }).catch(() => {});
  const busy = await page.evaluate(s => {
    const b = document.querySelector(s), r = b.getBoundingClientRect(), vw = document.documentElement.clientWidth;
    return { ariaBusy: b.getAttribute('aria-busy'), text: b.textContent.trim(), label: b.innerText.trim(), spinner: !!b.querySelector('.btn-spinner'), y: Math.round(scrollY), scrolls: window.__scrolls, hash: location.hash, overflow: document.documentElement.scrollWidth - vw, inside: r.left >= 0 && r.right <= vw, fits: b.scrollWidth <= b.clientWidth + 1, clearOfLogo: !b.closest('.nav') || r.left >= document.querySelector('.nav .logo').getBoundingClientRect().right + 8 };
  }, sel);
  if (shot) await page.screenshot({ path: shot });
  if (more) await more(page);
  const whileHeld = bodies.length;
  release();
  const gone = await left;
  await page.unroute('**/api/checkout', hold);
  return { y0, busy, bodies, whileHeld, gone, steps: bodies.map(b => b.step), url: page.url() };
}
// Operation counts for failure details: starts, creates and new sessions.
const counts = (r, sessions) => JSON.stringify({ steps: r.steps.join(','), starts: r.steps.filter(x => x === 'start').length, creates: r.steps.filter(x => x === 'create').length, postsWhileHeld: r.whileHeld, newSessions: sessions, redirected: r.gone, url: r.url });
// Held and rapid keys plus pointer clicks on every Preorder button while one request is outstanding.
async function hammer(page) {
  for (let i = 0; i < 4; i++) await page.keyboard.down('Space'); // auto-repeat while held
  await page.keyboard.up('Space');
  for (let i = 0; i < 4; i++) await page.keyboard.down('Enter');
  await page.keyboard.up('Enter');
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Space'); await page.keyboard.press('Enter'); }
  for (const [, sel] of PREORDER_BUTTONS) {
    const t = page.locator(sel);
    if (await t.isVisible()) { await t.focus(); await page.keyboard.press('Space'); await page.keyboard.press('Enter'); await t.dispatchEvent('click'); }
  }
  await page.waitForTimeout(300);
}

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
    check((await heroBtn.innerText()).trim() === 'Preorder' && (await heroBtn.getAttribute('href')) === '#reserve', `${tag}: hero CTA reads Preorder (no-JS fallback still links to #reserve)`);
    check(await page.locator('.nav-cta[href="#reserve"][data-checkout], .hero-actions .btn[href="#reserve"][data-checkout], .split-side .btn[href="#reserve"][data-checkout], #reserveBtn[data-checkout]').count() === 4, `${tag}: all four Preorder buttons open checkout and keep a #reserve fallback`);
    const ctaLabels = await page.$$eval('.nav-cta, .hero-actions .btn, .split-side .btn, #reserveBtn', els => els.map(e => e.textContent.trim()));
    check(ctaLabels.length === 4 && ctaLabels.every(t => t === 'Preorder'), `${tag}: every order button (nav, hero, mid page, form) reads Preorder`, ctaLabels.join(' | '));
    check(await page.locator('a[href="#reserve"], button[type="submit"]').evaluateAll(els => els.every(e => e.textContent.trim() === 'Preorder')), `${tag}: no order button keeps the old Reserve label`);
    check((await page.locator('#reserve-title').innerText()).trim() === 'Preorder yours.', `${tag}: section heading reads Preorder yours.`);
    const preorderCopy = await page.evaluate(() => [document.querySelector('meta[name="description"]').content, document.querySelector('meta[property="og:description"]').content, ...[...document.querySelectorAll('.faq details p')].map(p => p.textContent)]);
    check(preorderCopy[0].includes('Preorder with a fully refundable $100 deposit.') && preorderCopy[1].includes('Preorder with a fully refundable $100 deposit.') && preorderCopy.every(t => !/\breserv/i.test(t)), `${tag}: meta, og and FAQ copy say Preorder, not reserve`, preorderCopy.filter(t => /\breserv/i.test(t)).join(' | '));
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
    check(await page.locator('input[type="checkbox"], label.consent, #termsInput').count() === 0, `${tag}: no terms checkbox anywhere on the page`);
    const disclosures = await page.$$eval('.hero-terms, .split-side .cta-terms', els => els.map(e => [e.textContent.replace(/\s+/g, ' ').trim(), e.querySelector('a') && e.querySelector('a').getAttribute('href')]));
    check(disclosures.length === 2 && disclosures.every(([t, h]) => t === '$100 fully refundable deposit, credited toward your machine. By preordering you accept the deposit terms.' && h === '/deposit-terms.html'), `${tag}: hero and mid page disclose the deposit and that preordering accepts the linked terms`, JSON.stringify(disclosures));
    check(await page.locator('.hero-terms').isVisible(), `${tag}: hero disclosure visible under the hero button`);
    // The fixed nav Preorder discloses the deposit right beside it, at the top and once
    // scrolled, and the disclosure is the button's accessible description.
    for (const where of ['top', 'scrolled']) {
      if (where === 'top') { await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })); await page.waitForTimeout(600); }
      if (where === 'scrolled') { await page.evaluate(() => window.scrollTo({ top: document.getElementById('details').offsetTop, behavior: 'instant' })); await page.waitForTimeout(600); }
      const nd = await page.evaluate(() => {
        const b = document.querySelector('.nav-cta'), d = document.getElementById(b.getAttribute('aria-describedby') || '-'), logo = document.querySelector('.nav .logo').getBoundingClientRect();
        if (!d) return { missing: true };
        const r = d.getBoundingClientRect(), br = b.getBoundingClientRect(), vw = document.documentElement.clientWidth;
        return { text: d.textContent.replace(/\s+/g, ' ').trim(), href: d.getAttribute('href'), visible: r.width > 0 && getComputedStyle(d).visibility === 'visible' && getComputedStyle(d).display !== 'none', inside: r.left >= 0 && r.right <= vw, besideButton: r.right <= br.left && Math.abs((r.top + r.bottom) / 2 - (br.top + br.bottom) / 2) <= 6, clearOfLogo: r.left >= logo.right + 8, scrolled: document.getElementById('nav').classList.contains('scrolled') };
      });
      check(nd.text === '$100 deposit, Fully refundable' && nd.href === '/deposit-terms.html' && nd.visible && nd.inside && nd.besideButton && nd.clearOfLogo && nd.scrolled === (where === 'scrolled'), `${tag}: nav Preorder has the deposit disclosure beside it (${where}), linked to the terms and as its description`, JSON.stringify(nd));
    }
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    const note = page.locator('#reserveForm .deposit-note');
    check(/^Preordering means you accept the deposit terms\./.test((await note.innerText()).trim()) && await note.locator('a[href="/deposit-terms.html"]').count() === 1 && await note.locator('a[href="/privacy.html"]').count() === 1, `${tag}: Preorder section discloses terms acceptance and links terms + privacy`);
    check(!/[\u2013\u2014]| - /.test(disclosures.map(d => d[0]).join(' ') + await note.innerText()), `${tag}: disclosure copy has no dashes`);
    const csp = await page.evaluate(async () => (await fetch('/', { cache: 'no-store' })).headers.get('content-security-policy'));
    check(/frame-ancestors 'none'/.test(csp || ''), `${tag}: CSP with frame-ancestors none served`);
    if (vp.name === 'desktop') await page.waitForFunction(() => document.getElementById('heroCanvas').classList.contains('ready'), null, { timeout: 10000 }).catch(() => {});
    check(vp.name !== 'desktop' || await page.evaluate(() => document.getElementById('heroCanvas').classList.contains('ready')), `${tag}: hero frame sequence still loads under CSP`);
    check(await page.locator('script[type="application/ld+json"]').count() === 0, `${tag}: bogus PreOrder $0 JSON-LD removed`);
    await page.waitForTimeout(400);
    await page.locator('#reserve').screenshot({ path: path.join(OUT, `${tag}-02-reserve-panel.png`) });

    // Every Preorder button (nav, hero, mid page, section) opens checkout directly:
    // busy label + spinner, start/create POSTs carrying the current terms version, a
    // redirect to the Stripe-hosted URL, and no scroll to #reserve on the way.
    for (const [name, sel] of PREORDER_BUTTONS) {
      await page.goto(`${S}/`, { waitUntil: 'networkidle' });
      await page.evaluate(() => sessionStorage.removeItem('revivex.depositOperation'));
      const c = (await api('/__synthetic/state')).sessionCount;
      const r = await openFrom(page, sel, path.join(OUT, `${tag}-02b-busy-${name}.png`));
      const st0 = await api('/__synthetic/state');
      check(r.busy.ariaBusy === 'true' && r.busy.text === 'Opening checkout\u2026' && ((name === 'nav' || name === 'hero') && vp.name === 'mobile' ? r.busy.label === 'Opening\u2026' : r.busy.label === 'Opening checkout\u2026') && r.busy.spinner, `${tag}: ${name} button shows Opening checkout with a spinner`, JSON.stringify(r.busy));
      check(r.busy.y === r.y0 && r.busy.scrolls === 0 && r.busy.hash === '', `${tag}: ${name} click does not scroll to #reserve`, JSON.stringify({ y0: r.y0, ...r.busy }));
      check(r.busy.overflow <= 0 && r.busy.inside && r.busy.fits && r.busy.clearOfLogo, `${tag}: ${name} busy label fits its button, inside the viewport and clear of the logo`, JSON.stringify(r.busy));
      check(r.steps.join() === 'start,create' && r.bodies.every(b => b.termsAccepted === true && b.termsVersion === 'deposit-terms-v2'), `${tag}: ${name} sends start then create with the current terms version`, JSON.stringify(r.bodies));
      check(st0.sessionCount === c + 1 && r.url === `https://checkout.stripe.com/c/pay/${st0.sessions[st0.sessions.length - 1].id}`, `${tag}: ${name} redirects to the Stripe-hosted session URL`, r.url);
    }

    // Keyboard: Enter and Space on each of the four buttons open checkout directly (Space
    // does not scroll), and held / rapid keys and clicks on any button while the first
    // request is outstanding still make one operation: one start, one create, one session.
    check(await page.locator('.nav-cta, .hero-actions [data-checkout], .split-side [data-checkout]').evaluateAll(els => els.every(e => e.getAttribute('role') === 'button')), `${tag}: enhanced Preorder links are exposed as buttons`);
    for (const [name, sel] of PREORDER_BUTTONS) {
      for (const key of ['Enter', 'Space']) {
        const c = (await api('/__synthetic/state')).sessionCount;
        let r;
        try {
          await page.goto(`${S}/`, { waitUntil: 'networkidle' });
          await page.evaluate(() => sessionStorage.removeItem('revivex.depositOperation'));
          r = await openFrom(page, sel, null, { how: key, more: hammer });
        } catch (e) {
          await page.waitForTimeout(1500);
          const n = (await api('/__synthetic/state')).sessionCount - c;
          check(false, `${tag}: ${key} on ${name} = one operation`, `${String(e).split('\n')[0]} :: newSessions=${n}`);
          continue;
        }
        const st0 = await api('/__synthetic/state');
        const n = st0.sessionCount - c;
        check(r.busy.ariaBusy === 'true' && r.busy.spinner, `${tag}: ${key} on the ${name} button starts checkout (busy + spinner)`, JSON.stringify(r.busy));
        check(r.busy.y === r.y0 && r.busy.scrolls === 0 && r.busy.hash === '', `${tag}: ${key} on the ${name} button does not scroll or change the hash`, JSON.stringify({ y0: r.y0, y: r.busy.y, scrolls: r.busy.scrolls, hash: r.busy.hash }));
        check(r.whileHeld === 1 && r.steps.join() === 'start,create' && n === 1 && r.gone && r.url === `https://checkout.stripe.com/c/pay/${st0.sessions[st0.sessions.length - 1].id}`, `${tag}: ${key} on ${name} plus held/rapid keys and clicks during the request = one operation, one session, one redirect`, counts(r, n));
      }
    }

    // Configuration still loading: the first click (nav or section) waits for it; rapid
    // clicks and keys on every button in the meantime start nothing more.
    for (const first of ['.nav-cta', '#reserveBtn']) {
      let releaseGet, held = 0;
      const gate = new Promise(r => { releaseGet = r; });
      const posts = [];
      const holdGet = async route => {
        if (route.request().method() === 'GET') { held++; await gate; } else posts.push(route.request().postDataJSON().step);
        return route.continue();
      };
      try {
        await page.route('**/api/checkout', holdGet);
        await page.goto(`${S}/`, { waitUntil: 'domcontentloaded' });
        await page.evaluate(() => sessionStorage.removeItem('revivex.depositOperation'));
        await page.waitForFunction(() => document.readyState === 'complete' || document.querySelector('.nav-cta').getAttribute('role') === 'button', null, { timeout: 5000 }).catch(() => {});
        const c = (await api('/__synthetic/state')).sessionCount;
        const left = page.waitForURL(/checkout\.stripe\.com/, { timeout: 10000 }).then(() => true, () => false);
        await page.locator(first).click();
        await page.locator('#reserveBtn').dispatchEvent('click');
        for (let i = 0; i < 8; i++) await page.locator(i % 2 ? '.nav-cta' : '.hero-actions [data-checkout]').dispatchEvent('click');
        await page.locator('.hero-actions [data-checkout]').focus();
        await page.keyboard.press('Space'); await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
        const before = posts.length;
        const navBusy = await page.locator(first).getAttribute('aria-busy');
        releaseGet();
        const gone = await left;
        await page.unroute('**/api/checkout', holdGet);
        const n = (await api('/__synthetic/state')).sessionCount - c;
        check(held >= 1 && before === 0 && navBusy === 'true' && posts.join() === 'start,create' && n === 1 && gone, `${tag}: ${first} first, then clicks and keys on every button while the configuration loads = one operation`, JSON.stringify({ heldGets: held, postsBeforeConfig: before, navBusy, steps: posts.join(','), newSessions: n, redirected: gone }));
      } catch (e) {
        releaseGet();
        await page.unroute('**/api/checkout', holdGet).catch(() => {});
        check(false, `${tag}: ${first} first while the configuration loads = one operation`, `${String(e).split('\n')[0]} :: ${JSON.stringify({ heldGets: held, steps: posts.join(',') })}`);
      }
    }

    // Double-click race on the hero link -> one session, redirect to (intercepted) Stripe-hosted URL
    await page.goto(`${S}/`, { waitUntil: 'networkidle' });
    await page.evaluate(() => sessionStorage.removeItem('revivex.depositOperation'));
    const before = (await api('/__synthetic/state')).sessionCount;
    await Promise.all([page.waitForURL(/checkout\.stripe\.com/), heroBtn.dblclick()]);
    let st = await api('/__synthetic/state');
    check(st.sessionCount === before + 1, `${tag}: hero double click created exactly one session`, st.sessionCount - before);
    await page.goBack({ waitUntil: 'networkidle' });
    await page.evaluate(() => sessionStorage.removeItem('revivex.depositOperation'));

    // Double-click race on the section button -> one session
    const before2 = (await api('/__synthetic/state')).sessionCount;
    await page.locator('#reserve').scrollIntoViewIfNeeded();
    await Promise.all([page.waitForURL(/checkout\.stripe\.com/), btn.dblclick()]);
    st = await api('/__synthetic/state');
    check(st.sessionCount === before2 + 1, `${tag}: double click created exactly one session`, st.sessionCount - before2);
    const sess = st.sessions[st.sessions.length - 1];
    check(page.url() === `https://checkout.stripe.com/c/pay/${sess.id}`, `${tag}: redirected only to Stripe-hosted session URL`);
    check(sess.metadata.utm_source === 'meta' && sess.metadata.utm_medium === 'paid_social' && sess.metadata.utm_campaign === 'morning_simplified_preorder' && sess.metadata.utm_content === 'angle_02', `${tag}: allowlisted UTM in session metadata`);
    check(sess.piMetadata.utm_campaign === 'morning_simplified_preorder', `${tag}: UTM in payment intent metadata`);
    check(!JSON.stringify(sess.metadata).includes('SHOULDNOTPASS') && !('utm_term' in sess.metadata) && !('gclid' in sess.metadata), `${tag}: click id / utm_term dropped`);
    await page.screenshot({ path: path.join(OUT, `${tag}-03-synthetic-checkout-intercept.png`) });

    // Back from Stripe -> button usable; retry replays the same session (no new one)
    await page.goBack({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.getElementById('reserveBtn').disabled, null, { timeout: 5000 });
    await Promise.all([page.waitForURL(/checkout\.stripe\.com/), btn.click()]);
    st = await api('/__synthetic/state');
    check(st.sessionCount === before2 + 1 && page.url().endsWith(sess.id), `${tag}: back + retry replays same session`);

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
    await Promise.all([page.waitForURL(/checkout\.stripe\.com/, { timeout: 10000 }), btn.click()]);
    st = await api('/__synthetic/state');
    check(st.sessionCount === c0 + 1, `${tag}: timed-out create auto-retried with same operation (one session)`, st.sessionCount - c0);
    const replayId = page.url().split('/').pop();
    await page.goBack({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.getElementById('reserveBtn').disabled);
    await Promise.all([page.waitForURL(/checkout\.stripe\.com/), btn.click()]);
    check(page.url().endsWith(replayId), `${tag}: replay after back is stable`);
    await page.goBack({ waitUntil: 'networkidle' });

    // Paid, but the visitor never reached the receipt: the stored operation replays.
    // Stripe replays the SAVED open session, so the server must read current state
    // and send the visitor to the receipt, never back to the paid Stripe page.
    await api(`/__synthetic/pay?session_id=${replayId}`, 'POST');
    await page.waitForFunction(() => !document.getElementById('reserveBtn').disabled);
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
    await btn.click();
    await page.waitForFunction(() => !document.getElementById('reserveRestart').hidden, null, { timeout: 5000 });
    const rm = await page.locator('#reserveMsg').innerText();
    check(/earlier checkout attempt/.test(rm) && /support@revivex\.store/.test(rm) && /card statement/.test(rm), `${tag}: aged attempt asks to reconcile`, rm);
    check((await api('/__synthetic/state')).sessionCount === c1, `${tag}: aged attempt created nothing`);
    await btn.click({ force: true, timeout: 2000 }).catch(() => {});
    check(await btn.isDisabled() && (await api('/__synthetic/state')).sessionCount === c1, `${tag}: reserve blocked (disabled) until explicit restart`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('.hero-actions [data-checkout]').click();
    await page.waitForFunction(() => location.hash === '#reserve', null, { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(400);
    check(await page.evaluate(() => location.hash) === '#reserve' && (await api('/__synthetic/state')).sessionCount === c1, `${tag}: while restart shows, Preorder links go to #reserve and start nothing`);
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
    await Promise.all([page.waitForURL(/checkout\.stripe\.com/), page.locator('#reserveBtn').click()]);
    check(errs.length === 0, 'storage blocked: checkout still opens without script errors', errs.join('|'));
    await ctx.close();
  }

  // A failed attempt restores the clicked button and shows the message next to it.
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: vp.viewport, deviceScaleFactor: vp.deviceScaleFactor, isMobile: vp.isMobile, hasTouch: vp.hasTouch });
    await ctx.route('https://checkout.stripe.com/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>SYNTHETIC</h1>' }));
    const page = await ctx.newPage();
    await page.goto(`${S}/`, { waitUntil: 'networkidle' });
    for (const [name, sel] of [['mid', '.split-side [data-checkout]'], ['nav', '.nav-cta']]) {
      await page.evaluate(() => sessionStorage.removeItem('revivex.depositOperation'));
      const c = (await api('/__synthetic/state')).sessionCount;
      await api('/__synthetic/fail-next?kind=lost&n=3', 'POST');
      await page.locator(sel).scrollIntoViewIfNeeded();
      await page.locator(sel).click();
      const note = page.locator(`${sel} + .cta-msg`);
      await page.waitForFunction(s => /could not confirm the checkout status/.test((document.querySelector(s).nextElementSibling || {}).textContent || ''), sel, { timeout: 10000 }).catch(() => {});
      const b = await page.evaluate(s => { const e = document.querySelector(s); return { text: e.textContent.trim(), busy: e.hasAttribute('aria-busy'), minWidth: e.style.minWidth }; }, sel);
      check(await note.isVisible() && /Check your card statement/.test(await note.innerText()), `${vp.name}: ${name} failure shows the friendly message next to that button`, await note.innerText().catch(() => ''));
      check(b.text === 'Preorder' && !b.busy && b.minWidth === '', `${vp.name}: ${name} button restored after the failure`, JSON.stringify(b));
      const ov = await page.evaluate(s => { const r = document.querySelector(s).nextElementSibling.getBoundingClientRect(), vw = document.documentElement.clientWidth; return { overflow: document.documentElement.scrollWidth - vw, left: Math.round(r.left), right: Math.round(r.right), vw }; }, sel);
      check(ov.overflow <= 0 && ov.left >= 8 && ov.right <= ov.vw - 8, `${vp.name}: ${name} failure message fully inside the viewport, no horizontal overflow`, JSON.stringify(ov));
      await revealed(page, sel);
      if (name === 'mid') await page.evaluate(s => document.querySelector(s).scrollIntoView({ block: 'center', behavior: 'instant' }), sel);
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(OUT, `${vp.name}-06c-error-${name}.png`) });
      await Promise.all([page.waitForURL(/checkout\.stripe\.com/), page.locator(sel).click()]);
      check((await api('/__synthetic/state')).sessionCount === c + 1, `${vp.name}: ${name} retry after the failure opens one checkout`);
      await page.goBack({ waitUntil: 'networkidle' });
    }
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
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('.hero-actions [data-checkout]').click();
    await page.waitForFunction(() => /Reservations are taken on/.test((document.querySelector('.hero-actions .cta-msg') || {}).textContent || ''), null, { timeout: 5000 }).catch(() => {});
    check(await page.locator('.hero-actions .cta-msg a').getAttribute('href').catch(() => null) === `${S}/#reserve` && await page.evaluate(() => scrollY) === 0, 'alias host: hero Preorder shows the canonical link next to it, no scroll');
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

  // ---------------- JavaScript disabled ----------------
  // The links still lead to #reserve; the reserve card, its disclosure and the "needs
  // JavaScript" notice are visible (nothing waits for the reveal script); the section
  // button is disabled, and nothing posts to the checkout API.
  for (const vp of VIEWPORTS) {
    const tag = `${vp.name}-nojs`;
    const ctx = await browser.newContext({ viewport: vp.viewport, deviceScaleFactor: vp.deviceScaleFactor, isMobile: vp.isMobile, hasTouch: vp.hasTouch, javaScriptEnabled: false });
    const posts = [];
    await ctx.route('**/api/checkout', r => { if (r.request().method() === 'POST') posts.push(r.request().url()); return r.continue(); });
    let stripeHits = 0;
    await ctx.route('https://checkout.stripe.com/**', r => { stripeHits++; return r.abort(); });
    const page = await ctx.newPage();
    await page.goto(`${S}/`, { waitUntil: 'networkidle' });
    check(await page.locator('.nav-cta').getAttribute('role') === null, `${tag}: Preorder links stay plain links (no enhancement ran)`);
    const navTerms = page.locator('#navTerms');
    check(await navTerms.isVisible(), `${tag}: nav deposit disclosure visible`);
    // A real pointer click at the link (Playwright's actionability wait for stable
    // animation frames does not settle with page JavaScript disabled).
    await page.waitForTimeout(1300); // hero copy rise animation
    const hb = await page.locator('.hero-actions [data-checkout]').boundingBox();
    await page.mouse.click(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.waitForFunction(() => location.hash === '#reserve', null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const v = await page.evaluate(() => {
      const op = el => { let o = 1; for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
      const ns = [...document.querySelectorAll('#reserveForm p.form-msg')].find(p => /needs JavaScript/.test(p.textContent));
      const card = document.querySelector('.cta-inner'), r = card.getBoundingClientRect();
      return { hash: location.hash, cardOpacity: op(card), noteOpacity: op(document.querySelector('#reserveForm .deposit-note')), noscript: ns ? { text: ns.textContent.trim(), opacity: op(ns), shown: ns.getBoundingClientRect().height > 0 } : null, inView: r.top < innerHeight && r.bottom > 0, btnDisabled: document.getElementById('reserveBtn').disabled, faqOpacity: op(document.querySelector('.faq details')) };
    });
    check(v.hash === '#reserve' && v.inView, `${tag}: hero Preorder link leads to #reserve`, JSON.stringify(v));
    check(v.cardOpacity === 1 && v.noteOpacity === 1 && v.faqOpacity === 1, `${tag}: reserve card, its terms note and the rest of the page are visible without the reveal script`, JSON.stringify(v));
    check(v.noscript && v.noscript.opacity === 1 && v.noscript.shown, `${tag}: "Reserving needs JavaScript" notice is visible`, JSON.stringify(v.noscript));
    check(v.btnDisabled && await page.locator('#reserveBtn').isDisabled(), `${tag}: section Preorder button is disabled without JavaScript`);
    const rb = await page.locator('#reserveBtn').boundingBox();
    await page.mouse.click(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await page.locator('#reserveBtn').dispatchEvent('click');
    await page.waitForTimeout(600);
    check(posts.length === 0 && stripeHits === 0 && !/\?/.test(page.url()), `${tag}: nothing posts to checkout and the form does not reload the page`, JSON.stringify({ posts: posts.length, stripeHits, url: page.url() }));
    await page.screenshot({ path: path.join(OUT, `${tag}-reserve.png`) });
    await ctx.close();
  }
  // With JavaScript the reveal still starts hidden (the no-JS stylesheet is not applied).
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${S}/`, { waitUntil: 'networkidle' });
    const o = await page.evaluate(() => ({ faq: getComputedStyle(document.querySelector('.faq details')).opacity, sheets: [...document.styleSheets].map(s => s.href || '').filter(h => /nojs/.test(h)).length }));
    check(o.faq === '0' && o.sheets === 0, 'js: reveal-on-scroll unchanged when JavaScript runs (no-JS stylesheet not loaded)', JSON.stringify(o));
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
    await page.locator('#reserveBtn').click({ force: true }).catch(() => {});
    // The #reserve hash load is still smooth scrolling (and lazy images still loading); start from the top.
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await scrollSettled(page);
    for (const [name, sel] of PREORDER_BUTTONS.slice(0, 3)) {
      await page.locator(sel).scrollIntoViewIfNeeded();
      await scrollSettled(page);
      const y0 = await page.evaluate(() => Math.round(scrollY));
      await page.locator(sel).click();
      await page.waitForFunction(s => /temporarily unavailable/.test((document.querySelector(s).nextElementSibling || {}).textContent || ''), sel, { timeout: 5000 }).catch(() => {});
      const u = await page.evaluate(s => { const e = document.querySelector(s); return { msg: (e.nextElementSibling || {}).textContent || '', text: e.textContent.trim(), busy: e.hasAttribute('aria-busy'), y: Math.round(scrollY) }; }, sel);
      check(/temporarily unavailable/.test(u.msg) && u.text === 'Preorder' && !u.busy && u.y === y0, `${tag}: ${name} Preorder fails closed with the message next to it, no scroll`, JSON.stringify({ y0, ...u }));
    }
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
  // [width, height, minimum clear px between headline glyphs and machine]; 1024x1366 is a tall desktop class viewport
  for (const [w, h, minGap] of [[981, 800, 40], [1024, 768, 40], [1024, 1366, 40], [1280, 800, 80], [1440, 900, 80], [1920, 1080, 80]]) {
    const tag = `layout-${w}x${h}`;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await ctx.route('https://checkout.stripe.com/**', r => r.abort());
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
    check(m.linksOnHero, `${tag}: nav sits over the hero image at the top of the page (no white on white)`);
    check(m.heads.every(([l, r]) => Math.abs(l - m.navLeft) <= 2 && Math.abs(r - m.navRight) <= 2), `${tag}: nav left/right edges align with every section head container`, JSON.stringify({ nav: [m.navLeft, m.navRight], heads: m.heads }));
    check(m.others.every(([, l, r]) => Math.abs(l - m.navLeft) <= 2 && Math.abs(r - m.navRight) <= 2), `${tag}: steps, gallery, preorder, FAQ and footer share the nav container`, JSON.stringify(m.others));
    check(m.titleRight + minGap <= m.machineLeft, `${tag}: hero headline clears the machine by at least ${minGap}px`, JSON.stringify({ titleRight: m.titleRight, machineLeft: m.machineLeft }));
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
