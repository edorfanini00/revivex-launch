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
const app = read('public/app.js');

test('no terms checkbox or checkbox gating in the page or the script', () => {
  assert.doesNotMatch(html, /type="checkbox"|termsInput|class="consent"|I agree/);
  assert.doesNotMatch(app, /termsInput|terms\.checked|agree to the deposit terms/);
  assert.doesNotMatch(html, /id="reserveBtn"[^>]*\bdisabled\b/, 'the section button is not disabled before the configuration loads');
});

test('all four Preorder buttons open checkout and keep #reserve as the no-JS fallback', () => {
  const buttons = html.match(/<(a|button)\b[^>]*\bdata-checkout\b[^>]*>Preorder<\/\1>/g) || [];
  assert.equal(buttons.length, 4, buttons.join('\n'));
  assert.equal(buttons.filter(b => b.includes('href="#reserve"')).length, 3);
  assert.match(buttons.join(''), /class="btn nav-cta"/);
  assert.match(buttons.join(''), /id="reserveBtn"/);
  assert.match(app, /querySelectorAll\('\[data-checkout\]'\)/);
  assert.match(app, /e\.preventDefault\(\)/);
});

test('deposit terms stay disclosed next to the buttons, with terms and privacy links, no dashes', () => {
  const lines = html.match(/<p class="cta-terms[^"]*">[^\n]*<\/p>/g) || [];
  assert.equal(lines.length, 2, 'hero and mid page disclosure lines');
  for (const l of lines) assert.match(l, /\$100 fully refundable deposit\. Credited toward your machine\. <a href="\/deposit-terms\.html">Terms<\/a>/);
  const note = html.match(/<p class="deposit-note">[^\n]*<\/p>/)[0];
  assert.match(note, /^<p class="deposit-note">Preordering means you accept the <a href="\/deposit-terms\.html">deposit terms<\/a>\./);
  assert.match(note, /href="\/privacy\.html"/);
  for (const t of [...lines, note]) assert.doesNotMatch(t.replace(/<[^>]+>/g, ''), /[–—]| - /);
});

test('the page still sends termsAccepted and the current terms version on every request', () => {
  assert.match(app, /JSON\.stringify\(\{ termsAccepted: true, termsVersion, \.\.\.body \}\)/);
  assert.match(app, /termsVersion = d\.termsVersion;/);
});

test('the InitiateCheckout hook still fires once, just before the redirect, with the operation token', () => {
  const hook = app.match(/dispatchEvent\(new CustomEvent\('revivex:checkout-opening', \{ detail: \{ operation: op\.token \} \}\)\)/g) || [];
  assert.equal(hook.length, 1);
  const i = app.indexOf("'revivex:checkout-opening'");
  assert.ok(i > app.indexOf("d.state === 'redirect'") && i < app.indexOf('window.location.assign(d.url)'));
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
