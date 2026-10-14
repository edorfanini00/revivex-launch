// Launch updates signup, unsubscribe and email rendering. LOCAL: PGlite, fake Resend.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSignupHandler, createUnsubscribeHandler, normalizeEmail } from '../../lib/signup.js';
import { createCrmStore } from '../../lib/crm-store.js';
import { createInstanceRateLimiter } from '../../lib/http.js';
import { readUnsubscribeToken, unsubscribeToken } from '../../lib/unsubscribe-token.js';
import { renderPreorderConfirmation, renderWelcome, orderReference } from '../../lib/email/index.js';
import { sendEmail } from '../../lib/resend.js';
import { ORIGIN, req, res, logSink } from '../fixtures/deposit-fixtures.mjs';
import { createTestDb } from '../fixtures/pglite-db.mjs';
import { CRM_ENV } from './crm-webhook.test.mjs';

const SECRET = CRM_ENV.REVIVEX_CRM_SIGNING_SECRET;
const read = p => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

async function setup({ env = CRM_ENV, limit = 5 } = {}) {
  const db = await createTestDb();
  const sent = [];
  const sink = logSink();
  const storeFactory = () => createCrmStore(db.query);
  const signup = createSignupHandler({
    getEnv: () => env, storeFactory,
    sendMail: async (cfg, msg, opts) => { sent.push({ msg, opts }); return { id: `re_${sent.length}` }; },
    log: (e, f = {}) => sink.log(JSON.stringify({ e, ...f })),
    limiter: createInstanceRateLimiter({ limit, windowMs: 60_000 }),
  });
  const unsub = createUnsubscribeHandler({ getEnv: () => env, storeFactory, log: () => {} });
  const post = async (body, opts = {}) => { const r = res(); await signup(req({ url: '/api/signup', body, ...opts }), r); return r; };
  const unsubscribe = async (method, t) => { const r = res(); await unsub(req({ method, url: `/api/unsubscribe?t=${encodeURIComponent(t)}`, headers: { 'content-type': undefined, origin: undefined } }), r); return r; };
  return { db, sent, sink, post, unsubscribe, close: () => db.close() };
}

test('signup stores an opt in with consent text, source and utm, and sends one welcome with unsubscribe headers', async () => {
  const s = await setup();
  try {
    const r = await s.post({ email: '  Pat@Example.TEST ', firstName: 'Pat', website: '', source: 'reserve', attribution: { utm_source: 'instagram', evil: 'x' } });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json(), { ok: true, state: 'ok', message: "Thanks. You're on the list." });
    const [row] = await s.db.query('select * from subscribers');
    assert.equal(row.email, 'pat@example.test');
    assert.equal(row.first_name, 'Pat');
    assert.equal(row.consent_marketing, true);
    assert.equal(row.consent_text, "We'll email you about Revivex. Unsubscribe anytime.");
    assert.equal(row.source, 'reserve');
    assert.deepEqual(row.utm, { utm_source: 'instagram' });
    assert.match(row.ip_hash, /^[A-Za-z0-9_-]{32}$/);
    assert.doesNotMatch(row.ip_hash, /203\.0\.113/);
    assert.equal(s.sent.length, 1);
    const { msg } = s.sent[0];
    assert.equal(msg.to, 'pat@example.test');
    assert.equal(msg.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    const url = /<(https:[^>]+)>/.exec(msg.headers['List-Unsubscribe'])[1];
    assert.ok(url.startsWith(`${ORIGIN}/api/unsubscribe?t=`));
    assert.equal(readUnsubscribeToken(SECRET, new URL(url).searchParams.get('t')), row.id);
    assert.ok(msg.html.includes(url.replace(/&/g, '&amp;')), 'unsubscribe link in the body');
  } finally { await s.close(); }
});

test('signup is idempotent and does not reveal existing addresses; honeypot stores nothing', async () => {
  const s = await setup();
  try {
    const first = await s.post({ email: 'pat@example.test', source: 'footer' });
    const second = await s.post({ email: 'PAT@example.test', firstName: 'Patricia', source: 'reserve' });
    assert.equal(first.body, second.body);
    const rows = await s.db.query('select * from subscribers');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].first_name, 'Patricia');
    assert.equal(rows[0].source, 'footer', 'original source kept for an existing opt in');
    assert.equal(s.sent.length, 1, 'no second welcome');
    const bot = await s.post({ email: 'bot@example.test', website: 'http://spam.example' });
    assert.equal(bot.body, first.body);
    assert.equal((await s.db.query("select count(*)::int as n from subscribers where email = 'bot@example.test'"))[0].n, 0);
    assert.equal(s.sent.length, 1);
  } finally { await s.close(); }
});

test('signup validation: bad email, long name, unknown fields, cross origin, wrong method', async () => {
  const s = await setup({ limit: 50 });
  try {
    for (const email of ['', 'nope', 'a@b', 'a b@example.test', `${'a'.repeat(250)}@example.test`, 'x@example.test<script>', 42]) {
      const r = await s.post({ email });
      assert.equal(r.statusCode, 400, String(email));
      assert.equal(r.json().state, 'invalid_email');
    }
    assert.equal((await s.post({ email: 'ok@example.test', firstName: 'x'.repeat(61) })).json().state, 'invalid_name');
    assert.equal((await s.post({ email: 'ok@example.test', admin: true })).statusCode, 400);
    assert.equal((await s.post({ email: 'ok@example.test' }, { headers: { origin: 'https://evil.example' } })).statusCode, 403);
    assert.equal((await s.post({ email: 'ok@example.test' }, { headers: { 'content-type': 'text/plain' } })).statusCode, 415);
    const g = res();
    await createSignupHandler({ getEnv: () => CRM_ENV })(req({ method: 'GET', url: '/api/signup' }), g);
    assert.equal(g.statusCode, 405);
    assert.equal((await s.db.query('select count(*)::int as n from subscribers'))[0].n, 0);
    assert.equal(normalizeEmail(' A@B.example '), 'a@b.example');
  } finally { await s.close(); }
});

test('signup rate limit: the sixth request in a minute from one address is refused', async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 5; i += 1) assert.equal((await s.post({ email: `p${i}@example.test` })).statusCode, 200);
    const r = await s.post({ email: 'p6@example.test' });
    assert.equal(r.statusCode, 429);
    assert.ok(r.headers['retry-after']);
    assert.equal((await s.db.query('select count(*)::int as n from subscribers'))[0].n, 5);
  } finally { await s.close(); }
});

test('signup without database or signing secret fails closed and says nothing was saved', async () => {
  const { DATABASE_URL, ...noDb } = CRM_ENV;
  const s = await setup({ env: noDb });
  try {
    const r = await s.post({ email: 'pat@example.test' });
    assert.equal(r.statusCode, 503);
    assert.match(r.json().message, /Nothing was saved/);
  } finally { await s.close(); }
});

test('signup without Resend config still stores the opt in and never logs the address', async () => {
  const { RESEND_API_KEY, ...noMail } = CRM_ENV;
  const s = await setup({ env: noMail });
  try {
    assert.equal((await s.post({ email: 'pii-person@example.test', firstName: 'Secretname' })).statusCode, 200);
    assert.equal(s.sent.length, 0);
    assert.equal((await s.db.query('select count(*)::int as n from subscribers'))[0].n, 1);
    assert.doesNotMatch(s.sink.lines.join('\n'), /pii-person|Secretname/);
  } finally { await s.close(); }
});

test('unsubscribe: GET only shows a confirm form; POST unsubscribes; tampered tokens fail; re-signup opts in again', async () => {
  const s = await setup();
  try {
    await s.post({ email: 'pat@example.test' });
    const [{ id }] = await s.db.query('select id from subscribers');
    const t = unsubscribeToken(SECRET, id);
    const g = await s.unsubscribe('GET', t);
    assert.equal(g.statusCode, 200);
    assert.match(g.body, /<form method="post"/);
    assert.match(g.headers['content-security-policy'], /default-src 'none'/);
    assert.equal((await s.db.query('select unsubscribed_at from subscribers'))[0].unsubscribed_at, null, 'GET changes nothing');
    const p = await s.unsubscribe('POST', t);
    assert.equal(p.statusCode, 200);
    assert.match(p.body, /unsubscribed/);
    let [row] = await s.db.query('select * from subscribers');
    assert.ok(row.unsubscribed_at);
    assert.equal(row.consent_marketing, false);
    assert.equal((await s.unsubscribe('POST', t)).statusCode, 200, 'repeat is harmless');
    for (const bad of [`${t}x`, t.replace(/.$/, c => (c === 'A' ? 'B' : 'A')), unsubscribeToken('another-secret-0123456789abcdefghijklmn', id), 'x', '']) {
      assert.equal((await s.unsubscribe('POST', bad)).statusCode, 400, bad);
    }
    assert.equal((await s.post({ email: 'pat@example.test' })).statusCode, 200);
    [row] = await s.db.query('select * from subscribers');
    assert.equal(row.unsubscribed_at, null);
    assert.equal(row.consent_marketing, true);
    assert.equal(s.sent.length, 2, 'opting in again sends a new welcome');
  } finally { await s.close(); }
});

test('preorder confirmation: content, escaping, absolute https assets, plain text, no dashes or refund cutoff', () => {
  const m = renderPreorderConfirmation({
    sessionId: 'cs_live_a1B2c3D4e5F6g7H8', email: 'o\'brien"<x>@example.test', name: '<script>alert(1)</script> Pat',
    paidAt: '2026-10-13T15:00:00Z', origin: 'https://reserve.healthrevivex.com',
  });
  assert.equal(m.subject, 'Your Revivex preorder is confirmed');
  assert.equal(m.preheader, 'We received your $100 deposit.');
  assert.doesNotMatch(m.html, /<script>|alert\(1\)/);
  assert.match(m.html, /Thank you\. We received your \$100&nbsp;deposit\./, 'unusable name falls back to a plain thank you');
  assert.match(m.html, /o&#39;brien&quot;&lt;x&gt;@example\.test/);
  assert.match(m.html, /\$100\.00/);
  assert.match(m.html, /October 13, 2026/);
  assert.equal(orderReference('cs_live_a1B2c3D4e5F6g7H8'), 'E5F6G7H8');
  assert.match(m.html, /E5F6G7H8/);
  assert.match(m.html, /href="https:\/\/reserve\.healthrevivex\.com\/reservation\.html\?session_id=cs_live_a1B2c3D4e5F6g7H8"/);
  assert.match(m.html, /View your preorder/);
  assert.match(m.html, />View your preorder<\/a>/, 'ordinary text link also works without CSS');
  for (const src of m.html.match(/src="[^"]+"/g)) assert.match(src, /^src="https:\/\/reserve\.healthrevivex\.com\/assets\//);
  for (const img of m.html.match(/<img [^>]+>/g)) assert.match(img, /alt="[^"]+"/);
  assert.match(m.html, /max-width:600px/);
  assert.match(m.html, /Revivex LLC, 1331 Brickell Bay Dr, Miami, FL 33131/);
  assert.match(m.html, /You received this because you placed a preorder/);
  assert.match(m.html, /deposit-terms\.html/);
  assert.match(m.html, /privacy\.html/);
  assert.match(m.html, /support@revivex\.store/);
  assert.match(m.text, /Thank you\. We received your \$100 deposit\./);
  assert.match(m.html, /src="https:\/\/reserve\.healthrevivex\.com\/assets\/email\/revivex-machine\.png"/);
  assert.match(m.html, /prefers-color-scheme: dark/, 'deliberate dark mode');
  assert.match(renderPreorderConfirmation({ sessionId: 'cs_x', email: 'a@b.test', name: 'Pat Example', origin: 'https://reserve.healthrevivex.com' }).text, /^Your preorder is confirmed\.\n\nThank you, Pat\./);
  assert.match(m.text, /Order reference: E5F6G7H8/);
  for (const out of [m.html, m.text]) {
    assert.match(out, /credited toward your machine/);
    assert.match(out, /never charge the balance automatically/);
    assert.match(out, /price and shipping date have not been announced/);
    assert.match(out, /We will email you first/);
    assert.match(out, /fully refundable at any time/);
    assert.match(out, /Reply to this email/);
    assert.doesNotMatch(out, /Unsubscribe|You're in|What happens next|border-radius/);
  }
  assert.match(m.html, /href="mailto:support@revivex\.store"/);
  assert.match(m.html, /prefers-color-scheme: dark/);
  assert.match(m.html, /assets\/email\/revivex-machine\.png/);

  const copy = s => s.replace(/<[^>]+>/g, ' ').replace(/https?:\/\/\S+|[\w.'"&;#+<>-]+@[\w.-]+/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  for (const out of [copy(m.html.slice(m.html.indexOf('<body'))), copy(m.text)]) {
    assert.doesNotMatch(out, /[‐-―]|&[mn]dash;| - /, 'no dashes in customer copy');
    assert.doesNotMatch(out, /\b(before|until)\b[^.]{0,40}\bships?\b/i, 'no refund cutoff (deposit terms v2)');
  }
});

test('welcome email: escaping, unsubscribe link, transactional footer copy', () => {
  const m = renderWelcome({ firstName: 'Ana"><img src=x>', unsubscribeUrl: 'https://reserve.healthrevivex.com/api/unsubscribe?t=a.b', origin: 'https://reserve.healthrevivex.com' });
  assert.equal(m.subject, "You're on the Revivex list");
  assert.doesNotMatch(m.html, /<img src=x>/);
  assert.match(m.html, /Thank you\. We will write/);
  assert.doesNotMatch(m.html, /border-radius|Launch updates<|friend/);
  assert.match(m.html, /Unsubscribe/);
  assert.match(m.html, /api\/unsubscribe\?t=a\.b/);
  assert.match(m.text, /Unsubscribe: https:\/\/reserve\.healthrevivex\.com\/api\/unsubscribe\?t=a\.b/);
  const bad = renderWelcome({ firstName: 'x', unsubscribeUrl: 'javascript:alert(1)', origin: 'https://reserve.healthrevivex.com' });
  assert.doesNotMatch(bad.html, /javascript:/);
});

test('Resend client sends the idempotency key and maps failures without leaking the address', async () => {
  const calls = [];
  const ok = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, text: async () => '{"id":"re_123"}' }; };
  const r = await sendEmail({ apiKey: 're_FAKE_12345678', from: 'Revivex <a@b.example>', replyTo: 'support@revivex.store' }, { to: 'x@example.test', subject: 's', html: '<p>h</p>', text: 't' }, { idempotencyKey: 'preorder-confirmation/cs_test_1', fetchImpl: ok });
  assert.equal(r.id, 're_123');
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'preorder-confirmation/cs_test_1');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.to, ['x@example.test']);
  assert.equal(body.reply_to, 'support@revivex.store');
  const bad = async () => ({ ok: false, status: 422, text: async () => '{"name":"validation_error","message":"x@example.test is invalid"}' });
  await assert.rejects(sendEmail({ apiKey: 'k', from: 'f' }, { to: 'x@example.test' }, { fetchImpl: bad }), e => e.status === 422 && !e.message.includes('x@example'));
});

test('page: two signup forms with honeypot, consent line and privacy link; no checkbox; checkout buttons unchanged', () => {
  const html = read('public/index.html');
  const forms = html.match(/<form class="signup-form"[\s\S]*?<\/form>/g) || [];
  assert.equal(forms.length, 2);
  for (const f of forms) {
    assert.match(f, /type="email"[^>]*name="email"/);
    assert.match(f, /name="firstName"/);
    assert.match(f, /<div class="hp" aria-hidden="true">[\s\S]*name="website" tabindex="-1"/);
    assert.match(f, />Keep me posted</);
    assert.match(f, /We&rsquo;ll email you about Revivex\. Unsubscribe anytime\. <a href="\/privacy\.html">Privacy<\/a>/);
  }
  assert.doesNotMatch(html, /type="checkbox"/);
  assert.equal((html.match(/data-checkout/g) || []).length, 4);
  assert.ok(html.indexOf('id="updates"') > html.indexOf('id="reserve"'));
  const privacy = read('public/privacy.html').replace(/<[^>]+>/g, ' ');
  for (const re of [/Neon/, /Resend/, /Stripe/, /do not sell/, /support@revivex\.store/, /unsubscribe/i]) assert.match(privacy, re);
  assert.doesNotMatch(privacy, /waitlist on this site is not open/);
  assert.doesNotMatch(privacy, /[‐-―]|&[mn]dash;/);
});
