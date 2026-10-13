// Meta pixel (browser side, public/meta-pixel.js) plus static wiring checks.
// LOCAL only: fbq is a recorder, nothing is loaded from Meta.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEPOSIT_EVENT, PURCHASE_KEY_PREFIX, createPixel, gpcEnabled, loadFbq, operationEventId, purchaseEventId, validPixelId } from '../../public/meta-pixel.js';
import { META_PIXEL_ID } from '../../public/meta-pixel-id.js';
import { readCheckoutConfig } from '../../lib/deposit-config.js';
import { issueOperation, readOperation } from '../../lib/operation-token.js';
import { ENV } from '../fixtures/deposit-fixtures.mjs';

const ROOT = new URL('../../', import.meta.url);
const read = p => fs.readFileSync(new URL(p, ROOT), 'utf8');
const ID = '123456789012345';
const SID = 'cs_test_a1B2c3D4e5F6g7H8';

function fakeWin({ path = '/', gpc, storage } = {}) {
  const store = new Map();
  return {
    navigator: gpc === undefined ? {} : { globalPrivacyControl: gpc },
    location: { pathname: path },
    localStorage: storage || { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    store,
  };
}
function recorder() {
  const calls = [];
  const load = () => { load.loads += 1; return (...a) => calls.push(a); };
  load.loads = 0;
  load.calls = calls;
  return load;
}
const tracked = load => load.calls.filter(c => c[0] === 'track');
const realToken = () => issueOperation(readCheckoutConfig(ENV).config, { now: () => Date.now(), attribution: {} });

test('placeholder pixel id: clean no-op (nothing loaded, nothing tracked)', () => {
  assert.ok(META_PIXEL_ID === 'REVIVEX_PIXEL_ID_PLACEHOLDER' || validPixelId(META_PIXEL_ID), 'committed constant is a numeric pixel id or the placeholder');
  for (const id of ['REVIVEX_PIXEL_ID_PLACEHOLDER', '', 'abc123', null, 1403965125138676]) {
    const load = recorder();
    const px = createPixel({ win: fakeWin(), id, load });
    assert.equal(px.enabled, false);
    assert.equal(px.start(), false);
    assert.equal(px.initiateCheckout(realToken()), null);
    assert.equal(px.purchase({ state: 'confirmed', sessionId: SID }), null);
    assert.equal(load.loads, 0);
    assert.equal(load.calls.length, 0);
  }
});

test('Global Privacy Control: nothing loaded or sent to Meta', () => {
  assert.equal(gpcEnabled({ globalPrivacyControl: true }), true);
  assert.equal(gpcEnabled({ globalPrivacyControl: false }), false);
  assert.equal(gpcEnabled({}), false);
  const load = recorder();
  const win = fakeWin({ gpc: true });
  const px = createPixel({ win, id: ID, load });
  assert.equal(px.enabled, false);
  assert.equal(px.start(), false);
  px.initiateCheckout(realToken());
  px.purchase({ state: 'confirmed', sessionId: SID });
  assert.equal(load.loads, 0);
  assert.equal(load.calls.length, 0);
  assert.equal(win.store.size, 0, 'no purchase guard written either');
});

test('home page: autoConfig off, init, PageView, ViewContent with the deposit payload', () => {
  for (const path of ['/', '/index.html']) {
    const load = recorder();
    const px = createPixel({ win: fakeWin({ path }), id: ID, load });
    assert.equal(px.start(), true);
    assert.deepEqual(load.calls, [
      ['set', 'autoConfig', false, ID],
      ['init', ID],
      ['track', 'PageView'],
      ['track', 'ViewContent', { content_name: 'Revivex machine preorder deposit', value: 100, currency: 'USD' }],
    ]);
  }
  assert.deepEqual({ ...DEPOSIT_EVENT }, { content_name: 'Revivex machine preorder deposit', value: 100, currency: 'USD' });
});

test('other pages: PageView only', () => {
  for (const path of ['/privacy.html', '/deposit-terms.html', '/reservation.html']) {
    const load = recorder();
    createPixel({ win: fakeWin({ path }), id: ID, load }).start();
    assert.deepEqual(tracked(load), [['track', 'PageView']], path);
  }
});

test('InitiateCheckout event id is the operation id the server reads from the same token', () => {
  const token = realToken();
  const serverId = readOperation(token, ENV.REVIVEX_OPERATION_SIGNING_SECRET, Date.now()).op.id;
  assert.equal(operationEventId(token), serverId);
  const load = recorder();
  const px = createPixel({ win: fakeWin(), id: ID, load });
  px.start();
  assert.deepEqual(px.initiateCheckout(token), ['InitiateCheckout', { ...DEPOSIT_EVENT }, { eventID: serverId }]);
  assert.deepEqual(tracked(load).at(-1), ['track', 'InitiateCheckout', { ...DEPOSIT_EVENT }, { eventID: serverId }]);
  for (const bad of [undefined, '', 'nope', 'e30.sig', `${Buffer.from(JSON.stringify({ id: 'short' })).toString('base64url')}.x`]) {
    assert.equal(px.initiateCheckout(bad), null, String(bad));
  }
});

test('Purchase only for a server-confirmed paid deposit, deposit_<session id>, at most once per browser', () => {
  const win = fakeWin({ path: '/reservation.html' });
  const load = recorder();
  const px = createPixel({ win, id: ID, load });
  assert.equal(px.purchase({ state: 'confirmed', sessionId: SID }), null, 'nothing before the pixel starts');
  px.start();
  for (const state of ['processing', 'not_completed', 'expired', 'refunded', 'partially_refunded', 'disputed', 'not_recognized', 'not_found', 'retry', 'unavailable', 'paid', undefined]) {
    assert.equal(px.purchase({ state, sessionId: SID }), null, String(state));
  }
  assert.equal(px.purchase({ state: 'confirmed', sessionId: 'cs_test_x' }), null, 'malformed session id');
  assert.equal(purchaseEventId(SID), `deposit_${SID}`);
  assert.deepEqual(px.purchase({ state: 'confirmed', sessionId: SID }), ['Purchase', { ...DEPOSIT_EVENT }, { eventID: `deposit_${SID}` }]);
  assert.equal(win.store.get(PURCHASE_KEY_PREFIX + SID), '1');
  assert.equal(px.purchase({ state: 'confirmed', sessionId: SID }), null, 'second view of the receipt');
  // A fresh page load in the same browser still finds the guard.
  const again = recorder();
  const px2 = createPixel({ win, id: ID, load: again });
  px2.start();
  assert.equal(px2.purchase({ state: 'confirmed', sessionId: SID }), null);
  assert.equal(tracked(load).filter(c => c[1] === 'Purchase').length, 1);
  assert.equal(tracked(again).filter(c => c[1] === 'Purchase').length, 0);
});

test('Purchase is skipped (not sent unguarded) when localStorage is blocked', () => {
  const storage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const load = recorder();
  const px = createPixel({ win: fakeWin({ storage }), id: ID, load });
  px.start();
  assert.equal(px.purchase({ state: 'confirmed', sessionId: SID }), null);
  assert.equal(tracked(load).filter(c => c[1] === 'Purchase').length, 0);
});

test('loader queues calls and injects only the official fbevents script', () => {
  const appended = [];
  const win = { document: { createElement: tag => ({ tag }), head: { appendChild: el => appended.push(el) } } };
  const fbq = loadFbq(win);
  fbq('init', ID);
  assert.equal(win.fbq, fbq);
  assert.equal(fbq.queue.length, 1);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].tag, 'script');
  assert.equal(appended[0].src, 'https://connect.facebook.net/en_US/fbevents.js');
  assert.equal(appended[0].async, true);
  assert.equal(loadFbq(win), fbq, 'loads once');
  assert.equal(appended.length, 1);
});

test('one pixel id constant, imported by both the browser pixel and the server CAPI', () => {
  assert.match(read('public/meta-pixel.js'), /import \{ META_PIXEL_ID \} from '\.\/meta-pixel-id\.js';/);
  assert.match(read('lib/meta-capi.js'), /import \{ META_PIXEL_ID \} from '\.\.\/public\/meta-pixel-id\.js';/);
  for (const f of ['public/meta-pixel.js', 'lib/meta-capi.js', 'lib/deposit-handlers.js', 'public/app.js', 'public/reservation.js', 'public/index.html', 'vercel.json']) {
    assert.doesNotMatch(read(f), /['"`][0-9]{12,20}['"`]/, `${f} carries no literal pixel id`);
  }
  for (const page of ['index', 'privacy', 'deposit-terms', 'reservation']) {
    assert.match(read(`public/${page}.html`), /<script type="module" src="\/meta-pixel\.js"><\/script>/, page);
  }
  // On the receipt the pixel must be listening before reservation.js runs its lookup.
  const r = read('public/reservation.html');
  assert.ok(r.indexOf('/meta-pixel.js') < r.indexOf('/reservation.js'));
});

test('CSP allows exactly the Meta pixel hosts, nothing broader', () => {
  const v = JSON.parse(read('vercel.json'));
  for (const src of ['/(.*)', '/reservation\\.html']) {
    const csp = v.routes.find(r => r.src === src).headers['Content-Security-Policy'];
    assert.match(csp, /script-src 'self' https:\/\/connect\.facebook\.net;/, src);
    assert.match(csp, /img-src 'self' https:\/\/www\.facebook\.com;/, src);
    assert.match(csp, /connect-src 'self' https:\/\/www\.facebook\.com;/, src);
    assert.doesNotMatch(csp, /\*|unsafe-inline|unsafe-eval/, src);
  }
});

test('privacy notice discloses the Meta pixel and the opt out, with no dashes in the new copy', () => {
  const html = read('public/privacy.html');
  const section = html.slice(html.indexOf('<h2>Meta pixel</h2>'), html.indexOf('<h2>Keeping and deleting records</h2>'));
  assert.ok(section.length > 200);
  const text = section.replace(/<[^>]+>/g, ' ');
  assert.match(text, /Global Privacy Control/);
  assert.match(text, /sends nothing to Meta/);
  assert.match(text, /hashed/);
  assert.doesNotMatch(text, /[-‐-―]|&[mn]dash;/, 'no dashes in customer copy');
  assert.doesNotMatch(html, /This site sets no cookies and runs no analytics/, 'old "no trackers" claim removed');
  assert.match(html, /Apart from the Meta pixel described below, this site sets no cookies and runs no other analytics or advertising trackers\./);
  assert.doesNotMatch(read('public/index.html'), /facebook-domain-verification/, 'domain verification is DNS based (no meta tag)');
});

test('page hooks: checkout opening announced only on the Stripe redirect path; receipt announces its state', () => {
  const app = read('public/app.js');
  const hook = app.indexOf("'revivex:checkout-opening'");
  assert.ok(hook > -1);
  assert.equal(app.split("'revivex:checkout-opening'").length, 2, 'announced in one place');
  const redirect = app.indexOf("d.state === 'redirect'");
  const assign = app.indexOf('window.location.assign(d.url)');
  assert.ok(redirect < hook && hook < assign, 'inside the redirect branch, before leaving');
  assert.match(read('public/reservation.js'), /'revivex:deposit-status', \{ detail: \{ state, sessionId \} \}/);
});
