// Direct checkout: every Preorder button opens Stripe Checkout, with no terms checkbox.
// The server contract is unchanged: the page still sends termsAccepted + the current
// terms version, and the server still refuses requests without them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCheckoutHandler, checkoutSessionParams } from '../../lib/deposit-handlers.js';
import { readCheckoutConfig, DEPOSIT } from '../../lib/deposit-config.js';
import { createInstanceRateLimiter, makeLogger } from '../../lib/http.js';
import { createSyntheticStripe } from '../fixtures/synthetic-provider.mjs';
import { ENV, req, res, logSink } from '../fixtures/deposit-fixtures.mjs';

const ROOT = new URL('../../', import.meta.url);
const read = p => fs.readFileSync(new URL(p, ROOT), 'utf8');
const html = read('public/index.html');

// The page script's behaviour (Enter/Space, the in-flight guard, no scroll, request body,
// once-per-operation InitiateCheckout, failed starts) is tested in a real browser:
// tests/browser/deposit-browser.mjs and tests/browser/meta-pixel-browser.mjs. These tests
// cover the static page that ships, which is what a visitor without JavaScript gets.

test('no terms checkbox; the section button starts disabled and only the script enables it', () => {
  assert.doesNotMatch(html, /type="checkbox"|termsInput|class="consent"|I agree/);
  assert.match(html, /<button type="submit" class="btn" id="reserveBtn" data-checkout disabled>Preorder<\/button>/);
});

test('all four Preorder buttons are marked for checkout; the three links keep #reserve as the no-JS fallback', () => {
  const buttons = html.match(/<(a|button)\b[^>]*\bdata-checkout\b[^>]*>Preorder<\/\1>/g) || [];
  assert.equal(buttons.length, 4, buttons.join('\n'));
  assert.equal(buttons.filter(b => /^<a href="#reserve"/.test(b)).length, 3, buttons.join('\n'));
  assert.ok(buttons.some(b => /class="btn nav-cta"/.test(b)) && buttons.some(b => /id="reserveBtn"/.test(b)));
});

test('without JavaScript the reveal-on-scroll content is shown (no-JS stylesheet, no inline style)', () => {
  assert.match(html, /<noscript><link rel="stylesheet" href="\/nojs\.css"><\/noscript>/);
  const css = read('public/nojs.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.reveal\s*\{\s*opacity:\s*1;\s*transform:\s*none;\s*\}/);
  assert.doesNotMatch(html, /<style|style="/, 'the CSP allows no inline style');
});

test('repeated CTA disclaimers are absent; offer, footer links and functional messages remain', () => {
  assert.doesNotMatch(html, /class="[^"]*\b(?:cta-terms|hero-terms|deposit-note)\b/);
  assert.doesNotMatch(html, /By preordering you accept|Preordering means you accept/);
  assert.match(html, /id="depositPanel"><b>\$100 USD today\.<\/b> Fully refundable\. Applied to the final machine price\. No automatic balance charge\./);
  const nav = html.match(/<header class="nav"[\s\S]*?<\/header>/)[0];
  assert.match(nav, /<a href="#reserve" class="btn nav-cta" data-checkout>Preorder<\/a>/, 'the nav Preorder stands alone');
  assert.doesNotMatch(nav, /nav-order|nav-terms|navTerms|aria-describedby|deposit-terms|\$100|refundable/i, 'no deposit tag in the nav (owner request)');
  const footer = html.match(/<footer[\s\S]*?<\/footer>/)[0];
  assert.match(footer, /href="\/deposit-terms\.html">Deposit terms<\/a>/);
  assert.match(footer, /href="\/privacy\.html">Privacy<\/a>/);
  assert.match(html, /id="reserveMsg" role="status" aria-live="polite"/);
  assert.match(html, /id="testModeNote" hidden>Test mode\. No real payment is taken\./);
  const faq = html.match(/<section class="faq"[\s\S]*?<\/section>/)[0];
  assert.match(faq, /\$100 deposit\. It is fully refundable, applied to the final machine price/);
});

test('server still requires termsAccepted and the current terms version (unchanged contract)', async () => {
  const synth = createSyntheticStripe({ accountId: ENV.STRIPE_EXPECTED_ACCOUNT_ID, priceId: ENV.STRIPE_DEPOSIT_PRICE_ID, productId: ENV.STRIPE_DEPOSIT_PRODUCT_ID });
  const checkout = createCheckoutHandler({ getEnv: () => ENV, providerFactory: () => synth.provider, log: makeLogger(logSink()), limiter: createInstanceRateLimiter({ limit: 1000, windowMs: 60_000 }) });
  const call = async body => { const r = res(); await checkout(req({ body }), r); return r; };
  assert.equal((await call({ step: 'start', termsVersion: DEPOSIT.termsVersion, attribution: {} })).statusCode, 400);
  assert.equal((await call({ step: 'start', termsAccepted: true, termsVersion: 'deposit-terms-v1', attribution: {} })).statusCode, 409);
  const ok = await call({ step: 'start', termsAccepted: true, termsVersion: DEPOSIT.termsVersion, attribution: {} });
  assert.equal(ok.json().state, 'started', ok.body);
  assert.equal(synth.control.calls().length, 0, 'start makes no Stripe call');
});

test('Stripe Checkout itself is unchanged: no consent collection, same submit text and terms version metadata', () => {
  const p = checkoutSessionParams(readCheckoutConfig(ENV).config, { id: 'x'.repeat(22), binding: 'b', attribution: {} });
  assert.equal(p.consent_collection, undefined);
  assert.equal(p.metadata.terms_version, 'deposit-terms-v2');
  assert.equal(p.custom_text.submit.message, '$100 USD fully refundable preorder deposit for the Revivex machine, which is in development. Applied to the final machine price. No automatic balance charge. The final price and shipping date have not been announced.');
});
