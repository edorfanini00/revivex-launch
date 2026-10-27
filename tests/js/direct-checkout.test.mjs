// The home page no longer opens checkout: every CTA opens the early access signup modal.
// The checkout server contract is unchanged for existing deposit flows: it still requires
// termsAccepted + the current terms version, and refuses requests without them.
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

// The signup modal's behaviour (every CTA, focus trap, Escape, errors, success only after
// a 200, Lead once) is tested in a real browser: tests/browser/site-browser.mjs and
// tests/browser/meta-pixel-browser.mjs. These tests cover the static page that ships,
// which is what a visitor without JavaScript gets.

test('no terms checkbox and no checkout control on the home page', () => {
  assert.doesNotMatch(html, /type="checkbox"|termsInput|class="consent"|I agree/);
  assert.doesNotMatch(html, /data-checkout|id="reserveBtn"|id="reserveForm"|id="depositPanel"|id="reserveMsg"|testModeNote/);
});

test('all four CTAs open the signup modal (nav Get early access, the rest Join the waitlist); links keep #waitlist as the no-JS fallback', () => {
  const ctas = html.match(/<(a|button)\b[^>]*\bdata-signup="[a-z]+"[^>]*>[^<]+<\/\1>/g) || [];
  assert.equal(ctas.length, 4, ctas.join('\n'));
  assert.match(ctas[0], /^<a href="#waitlist" class="btn nav-cta" data-signup="nav">Get early access<\/a>$/);
  assert.equal(ctas.slice(1).filter(b => />Join the waitlist</.test(b)).length, 3, ctas.join('\n'));
  assert.equal(ctas.filter(b => /^<a href="#waitlist"/.test(b)).length, 3, ctas.join('\n'));
  assert.doesNotMatch(html, />\s*Preorder\s*</);
  assert.match(html, /<div class="signup" id="signup" hidden>/);
  assert.match(html, /<script type="module" src="\/signup\.js"><\/script>/);
});

test('without JavaScript the reveal-on-scroll content is shown (no-JS stylesheet, no inline style)', () => {
  assert.match(html, /<noscript><link rel="stylesheet" href="\/nojs\.css"><\/noscript>/);
  const css = read('public/nojs.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.reveal\s*\{\s*opacity:\s*1;\s*transform:\s*none;\s*\}/);
  assert.doesNotMatch(html, /<style|style="/, 'the CSP allows no inline style');
});

test('no deposit offer on the home page; the nav CTA stands alone; footer links and waitlist FAQ remain', () => {
  assert.doesNotMatch(html, /class="[^"]*\b(?:cta-terms|hero-terms|deposit-note|deposit-panel)\b/);
  assert.doesNotMatch(html, /By preordering you accept|Preordering means you accept/);
  assert.doesNotMatch(html, /\$\s?\d|20% off|refundable|preorder/i, 'no $50 deposit, 20% off, refundable or preorder claim (copy or meta)');
  const nav = html.match(/<header class="nav"[\s\S]*?<\/header>/)[0];
  assert.doesNotMatch(nav, /nav-order|nav-terms|navTerms|aria-describedby|deposit-terms|\$\d|20%|refundable/i, 'no tag beside the nav CTA (owner request)');
  const footer = html.match(/<footer[\s\S]*?<\/footer>/)[0];
  assert.match(footer, /href="\/deposit-terms\.html">Deposit terms<\/a>/, 'existing depositors can still reach their terms');
  assert.match(footer, /href="\/privacy\.html">Privacy<\/a>/);
  const faq = html.match(/<section class="faq"[\s\S]*?<\/section>/)[0];
  assert.match(faq, /How does the waitlist work\?/);
  assert.match(faq, /final price and shipping date have not been announced/);
  assert.doesNotMatch(faq, /deposit|refund/i);
  const section = html.match(/<section class="cta" id="waitlist"[\s\S]*?<\/section>/)[0];
  assert.match(section, /<h2 id="waitlist-title">Get early access\.<\/h2>/);
  assert.match(section, /<span id="reserve" class="anchor-alias"/, 'old #reserve links (Stripe cancel_url) still land on this section');
});

test('server still requires termsAccepted and the current terms version (unchanged contract)', async () => {
  const synth = createSyntheticStripe({ accountId: ENV.STRIPE_EXPECTED_ACCOUNT_ID, priceId: ENV.STRIPE_DEPOSIT_PRICE_ID, productId: ENV.STRIPE_DEPOSIT_PRODUCT_ID });
  const checkout = createCheckoutHandler({ getEnv: () => ENV, providerFactory: () => synth.provider, log: makeLogger(logSink()), limiter: createInstanceRateLimiter({ limit: 1000, windowMs: 60_000 }) });
  const call = async body => { const r = res(); await checkout(req({ body }), r); return r; };
  assert.equal((await call({ step: 'start', termsVersion: DEPOSIT.termsVersion, attribution: {} })).statusCode, 400);
  assert.equal((await call({ step: 'start', termsAccepted: true, termsVersion: 'deposit-terms-v1', attribution: {} })).statusCode, 409);
  const ok = await call({ step: 'start', termsAccepted: true, termsVersion: DEPOSIT.termsVersion, displayedAmount: DEPOSIT.amount, attribution: {} });
  assert.equal(ok.json().state, 'started', ok.body);
  assert.equal(synth.control.calls().length, 0, 'start makes no Stripe call');
});

test('Stripe Checkout: no consent collection, $50 submit text with the machine discount, v3 terms metadata', () => {
  const p = checkoutSessionParams(readCheckoutConfig(ENV).config, { id: 'x'.repeat(22), binding: 'b', attribution: {} });
  assert.equal(p.consent_collection, undefined);
  assert.equal(p.metadata.terms_version, 'deposit-terms-v3');
  assert.equal(p.custom_text.submit.message, '$50 USD fully refundable preorder deposit for the Revivex machine, which is in development. Includes 20% off the final machine price, then your $50 is credited toward the rest. No automatic balance charge. The final price and shipping date have not been announced.');
});
