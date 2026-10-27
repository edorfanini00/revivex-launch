// Waitlist API: validation, honeypot, rate limit, idempotent upsert, welcome email,
// Lead measurement and unsubscribe. LOCAL: PGlite database, recorded email/Meta transport.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { req, res, logSink } from '../fixtures/deposit-fixtures.mjs';
import { createTestDb } from '../fixtures/pglite-db.mjs';
import { createMetaCapi } from '../../lib/meta-capi.js';
import { makeLogger } from '../../lib/http.js';
import { COUNTRIES } from '../../public/countries.js';
import {
  CONSENT_TEXT_VERSION, RATE_LIMIT, createSignupHandler, createUnsubscribeHandler, normalizeEmail, cleanAttribution, welcomeEmail, MIGRATION_SQL,
} from '../../lib/waitlist.js';

const HOST = 'reserve.healthrevivex.com';
const ORIGIN = `https://${HOST}`;
const ENV = Object.freeze({
  DATABASE_URL: 'postgres://local-test-only', REVIVEX_IP_HASH_SALT: 'test-ip-salt-0123456789abcdef0123456789',
  RESEND_API_KEY: 're_TEST_ONLY', RESEND_FROM: 'Revivex <hello@example.test>', RESEND_REPLY_TO: 'support@example.test',
  META_CAPI_ACCESS_TOKEN: 'TEST_CAPI_TOKEN', VERCEL_ENV: 'production', REVIVEX_SITE_ORIGIN: ORIGIN,
});
const signupReq = (body, headers = {}) => req({ url: '/api/signup', body, headers: { origin: ORIGIN, host: HOST, 'user-agent': 'TestAgent/1.0', cookie: '_fbp=fb.1.1730000000000.123456789; _fbc=fb.1.1730000000000.AbCdEf', ...headers } });

async function setup({ env = ENV, mailStatus = 200, mailThrows = false } = {}) {
  const t = await createTestDb();
  const mails = [], meta = [], logs = logSink();
  const fetchImpl = async (url, init) => {
    if (mailThrows) throw new Error('network down');
    mails.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response('{}', { status: mailStatus });
  };
  const metaFetch = async (url, init) => { meta.push(JSON.parse(init.body).data[0]); return new Response('{}', { status: 200 }); };
  const log = makeLogger({ log: logs.log });
  const handler = createSignupHandler({ getEnv: () => env, dbFactory: async () => t.db, fetchImpl, log, metaCapi: createMetaCapi({ pixelId: '123456789012345', fetchImpl: metaFetch, schedule: () => {} }) });
  const unsub = createUnsubscribeHandler({ getEnv: () => env, dbFactory: async () => t.db, log });
  const post = async (body, headers) => { const r = res(); await handler(signupReq(body, headers), r); await new Promise(s => setTimeout(s, 5)); return r; };
  return { ...t, handler, unsub, post, mails, meta, logs };
}
const ok = (o = {}) => ({ email: 'Person.Test@Example.com', country: 'US', source: 'hero', attribution: { utm_source: 'meta', utm_campaign: 'launch_q4' }, ...o });

test('normalizeEmail accepts real addresses and rejects malformed ones', () => {
  assert.equal(normalizeEmail('  A.B+tag@Sub.Example.co.uk '), 'a.b+tag@sub.example.co.uk');
  for (const bad of ['', 'plain', 'a@b', 'a@b.c', '@example.com', 'a@@example.com', 'a@ex ample.com', 'a..b@example.com', '.a@example.com', 'a.@example.com',
    'a@-example.com', 'a@example-.com', 'a@example.c0m', 'a@example..com', 'a b@example.com', `${'x'.repeat(65)}@example.com`, `a@${'d'.repeat(250)}.com`, 42, null, {}]) {
    assert.equal(normalizeEmail(bad), null, String(bad));
  }
});

test('country list is the full ISO 3166-1 alpha-2 set with dash free names', () => {
  assert.equal(COUNTRIES.length, 249);
  assert.equal(new Set(COUNTRIES.map(c => c[0])).size, 249);
  assert.ok(COUNTRIES.every(([c, n]) => /^[A-Z]{2}$/.test(c) && n && !/[-‐-―]/.test(n)));
});

test('migration is additive and idempotent: a second run keeps existing rows', async () => {
  const s = await setup();
  assert.equal((await s.post(ok())).statusCode, 200);
  await s.runMigration();
  await s.runMigration();
  assert.equal((await s.rows()).length, 1);
  assert.doesNotMatch(MIGRATION_SQL, /\b(drop|alter|truncate|delete|rename)\b/i);
});

test('valid signup commits one row with the stored fields, then answers ok with a Lead id', async () => {
  const s = await setup();
  const r = await s.post(ok());
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.equal(j.ok, true);
  assert.match(j.lead, /^lead_[A-Za-z0-9_-]{22}$/);
  const [row] = await s.rows();
  assert.equal(row.email, 'person.test@example.com');
  assert.equal(row.country, 'US');
  assert.equal(row.source, 'homepage:hero');
  assert.equal(row.utm_source, 'meta');
  assert.equal(row.utm_campaign, 'launch_q4');
  assert.equal(row.utm_medium, null);
  assert.equal(row.fbp, 'fb.1.1730000000000.123456789');
  assert.equal(row.fbc, 'fb.1.1730000000000.AbCdEf');
  assert.equal(row.user_agent, 'TestAgent/1.0');
  assert.match(row.ip_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(row.ip_hash, '203.0.113.7');
  assert.equal(row.consent_text_version, CONSENT_TEXT_VERSION);
  assert.match(row.unsubscribe_token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(row.created_at instanceof Date && row.updated_at instanceof Date);
  assert.equal(row.unsubscribed_at, null);
});

test('invalid email, unknown country and malformed bodies are rejected and save nothing', async () => {
  const s = await setup();
  for (const [body, err] of [[ok({ email: 'not-an-email' }), 'invalid_email'], [ok({ email: 'a@b' }), 'invalid_email'], [ok({ country: 'XX' }), 'invalid_country'], [ok({ country: '' }), 'invalid_country'], [ok({ country: 'United States' }), 'invalid_country']]) {
    const r = await s.post(body);
    assert.equal(r.statusCode, 400);
    assert.deepEqual([r.json().ok, r.json().error], [false, err]);
  }
  const bad = res();
  await s.handler(signupReq('{not json'), bad);
  assert.equal(bad.statusCode, 400);
  assert.equal((await s.rows()).length, 0);
  assert.equal(s.mails.length, 0);
});

test('honeypot: a filled hidden field is refused, nothing is saved, mailed or measured', async () => {
  const s = await setup();
  const r = await s.post(ok({ hp_extra: 'https://spam.example' }));
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().ok, false);
  assert.equal((await s.rows()).length, 0);
  assert.equal(s.mails.length + s.meta.length, 0);
  assert.ok(s.logs.lines.some(l => /honeypot/.test(l)));
});

test('repeat signups are idempotent: one row, one welcome email, one Lead', async () => {
  const s = await setup();
  const first = (await s.post(ok())).json();
  const again = await s.post(ok({ email: '  PERSON.test@example.COM ', country: 'GB', source: 'nav', attribution: { utm_source: 'other' } }));
  const [both] = await Promise.all([s.post(ok()), s.post(ok())]);
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.json(), { ok: true, lead: null });
  assert.equal(both.json().ok, true);
  const rows = await s.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].country, 'US', 'first country kept');
  assert.equal(rows[0].utm_source, 'meta', 'first touch attribution kept');
  assert.ok(rows[0].updated_at >= rows[0].created_at);
  assert.equal(s.mails.length, 1);
  assert.equal(s.meta.filter(e => e.event_name === 'Lead').length, 1);
  assert.equal(s.meta[0].event_id, first.lead);
});

test('welcome email: Resend request carries the unsubscribe link and List-Unsubscribe headers', async () => {
  const s = await setup();
  await s.post(ok());
  const [row] = await s.rows();
  const [m] = s.mails;
  assert.equal(m.url, 'https://api.resend.com/emails');
  assert.deepEqual(m.body.to, ['person.test@example.com']);
  assert.equal(m.body.from, ENV.RESEND_FROM);
  assert.equal(m.body.reply_to, ENV.RESEND_REPLY_TO);
  const link = `${ORIGIN}/api/unsubscribe?token=${row.unsubscribe_token}`;
  assert.ok(m.body.text.includes(link) && m.body.html.includes(link));
  assert.equal(m.body.headers['List-Unsubscribe'], `<${link}>, <mailto:support@revivex.store?subject=unsubscribe>`);
  assert.equal(m.body.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.equal(m.headers['Idempotency-Key'], `revivex-welcome-${row.id}`);
  const copy = welcomeEmail({ unsubscribe: 'https://x.test/u' });
  for (const t of [copy.subject, copy.text]) { assert.doesNotMatch(t, /[–—]| - /); assert.doesNotMatch(t, /revive x|ReviveX|REVIVEX/); }
});

test('email failure (5xx or network) still answers ok, and the log has no address', async () => {
  for (const opts of [{ mailStatus: 500 }, { mailThrows: true }]) {
    const s = await setup(opts);
    const r = await s.post(ok());
    assert.equal(r.json().ok, true);
    assert.equal((await s.rows()).length, 1);
    assert.ok(s.logs.lines.some(l => /waitlist_email_failed/.test(l)));
    assert.ok(s.logs.lines.every(l => !/@|person\.test/i.test(l)), s.logs.lines.join('\n'));
  }
});

test('never ok before a commit: database errors and a missing table answer an error', async () => {
  const s = await setup();
  s.db.failNext(Object.assign(new Error('boom'), { code: '08006' }));
  let r = await s.post(ok());
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().ok, false);
  const fresh = await createTestDb({ migrate: false });
  const h = createSignupHandler({ getEnv: () => ENV, dbFactory: async () => fresh.db, fetchImpl: async () => new Response('{}'), log: () => {} });
  r = res();
  await h(signupReq(ok()), r);
  assert.equal(r.statusCode, 503);
  assert.deepEqual([r.json().ok, r.json().error], [false, 'unavailable']);
  for (const env of [{ ...ENV, DATABASE_URL: '' }, { ...ENV, REVIVEX_IP_HASH_SALT: 'short' }]) {
    const u = createSignupHandler({ getEnv: () => env, dbFactory: async () => { throw new Error('must not connect'); }, log: () => {} });
    r = res();
    await u(signupReq(ok()), r);
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().ok, false);
  }
});

test('per IP rate limit is counted in the database (shared across instances)', async () => {
  const s = await setup();
  const other = createSignupHandler({ getEnv: () => ENV, dbFactory: async () => s.db, fetchImpl: async () => new Response('{}'), log: () => {} });
  for (let i = 0; i < RATE_LIMIT; i++) {
    const r = res();
    await (i % 2 ? other : s.handler)(signupReq(ok({ email: `p${i}@example.com` })), r);
    assert.equal(r.statusCode, 200, `attempt ${i}`);
  }
  const r = await s.post(ok({ email: 'late@example.com' }));
  assert.equal(r.statusCode, 429);
  assert.equal(r.json().ok, false);
  assert.equal((await s.rows()).length, RATE_LIMIT);
  const elsewhere = await s.post(ok({ email: 'other-ip@example.com' }), { 'x-real-ip': '198.51.100.9' });
  assert.equal(elsewhere.statusCode, 200);
});

test('cross origin and wrong methods are refused', async () => {
  const s = await setup();
  let r = await s.post(ok(), { origin: 'https://evil.example' });
  assert.equal(r.statusCode, 403);
  r = await s.post(ok(), { 'sec-fetch-site': 'cross-site' });
  assert.equal(r.statusCode, 403);
  r = await s.post(ok(), { origin: undefined });
  assert.equal(r.statusCode, 403);
  r = res();
  await s.handler(req({ method: 'PUT', url: '/api/signup', headers: { origin: ORIGIN, host: HOST } }), r);
  assert.equal(r.statusCode, 405);
  assert.equal((await s.rows()).length, 0);
});

test('GET returns the edge country hint only when it is an ISO code', async () => {
  const s = await setup();
  for (const [h, want] of [['de', 'DE'], ['XX', null], [undefined, null]]) {
    const r = res();
    await s.handler(req({ method: 'GET', url: '/api/signup', headers: { 'x-vercel-ip-country': h } }), r);
    assert.deepEqual(r.json(), { country: want });
    assert.match(r.headers['cache-control'], /no-store/);
  }
});

test('Lead: server event shares the browser event id, hashes the email, sends ip/ua/fbp/fbc', async () => {
  const s = await setup();
  const j = (await s.post(ok())).json();
  const [e] = s.meta;
  assert.equal(e.event_name, 'Lead');
  assert.equal(e.event_id, j.lead);
  assert.deepEqual(e.custom_data, { content_name: 'Revivex early access waitlist' });
  assert.match(e.user_data.em[0], /^[0-9a-f]{64}$/);
  assert.equal(e.user_data.client_ip_address, '203.0.113.7');
  assert.equal(e.user_data.client_user_agent, 'TestAgent/1.0');
  assert.equal(e.user_data.fbp, 'fb.1.1730000000000.123456789');
  assert.ok(!JSON.stringify(e).includes('person.test'));
});

test('Lead: no server event with GPC or outside production', async () => {
  let s = await setup();
  await s.post(ok(), { 'sec-gpc': '1' });
  assert.equal(s.meta.length, 0);
  assert.equal((await s.rows()).length, 1);
  s = await setup({ env: { ...ENV, VERCEL_ENV: 'preview' } });
  const j = (await s.post(ok())).json();
  assert.equal(j.ok, true);
  assert.equal(s.meta.length, 0);
});

test('unsubscribe: the emailed token sets unsubscribed_at once; bad and unknown tokens do not', async () => {
  const s = await setup();
  await s.post(ok());
  const [row] = await s.rows();
  const get = async (url, method = 'GET') => { const r = res(); await s.unsub(req({ method, url, headers: {} }), r); return r; };
  let r = await get(`/api/unsubscribe?token=${row.unsubscribe_token}`);
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.match(r.body, /You're unsubscribed/);
  assert.doesNotMatch(r.body, /[–—]/);
  const after = (await s.rows())[0];
  assert.ok(after.unsubscribed_at instanceof Date);
  r = await get(`/api/unsubscribe?token=${row.unsubscribe_token}`);
  assert.equal(r.statusCode, 200);
  assert.equal((await s.rows())[0].unsubscribed_at.getTime(), after.unsubscribed_at.getTime(), 'first time kept');
  assert.equal((await get('/api/unsubscribe?token=short')).statusCode, 400);
  assert.equal((await get('/api/unsubscribe')).statusCode, 400);
  assert.equal((await get(`/api/unsubscribe?token=${'A'.repeat(43)}`)).statusCode, 404);
  // RFC 8058 one-click POST from a mail app.
  await s.pg.query('update revivex_waitlist set unsubscribed_at = null');
  r = await get(`/api/unsubscribe?token=${row.unsubscribe_token}`, 'POST');
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true });
  assert.ok((await s.rows())[0].unsubscribed_at instanceof Date);
  // Signing up again is a new explicit consent: it clears unsubscribed_at, still one row, no new email.
  await s.post(ok());
  const rows = await s.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].unsubscribed_at, null);
  assert.equal(s.mails.length, 1);
});

test('attribution keeps only the five utm labels, bounded', () => {
  assert.deepEqual(cleanAttribution({ utm_source: ' meta ', utm_term: 'shoes', gclid: 'x', utm_medium: 'a'.repeat(101), utm_content: '<script>' }), { utm_source: 'meta', utm_term: 'shoes' });
  assert.deepEqual(cleanAttribution('x'), {});
});

test('logs never contain the email address, the token or the raw IP', async () => {
  const s = await setup();
  await s.post(ok());
  await s.post(ok());
  await s.post(ok({ email: 'bad' }));
  const [row] = await s.rows();
  const r = res();
  await s.unsub(req({ method: 'GET', url: `/api/unsubscribe?token=${row.unsubscribe_token}` }), r);
  const all = s.logs.lines.join('\n');
  assert.ok(all.length > 0);
  assert.doesNotMatch(all, /@|person\.test|203\.0\.113\.7/);
  assert.ok(!all.includes(row.unsubscribe_token));
});
