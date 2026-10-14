// Offline HTTP/browser integration: real signup/unsubscribe handlers and PGlite SQL.
// No provider credentials or external requests. Use an isolated build/output and port.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { createTestDb } from '../fixtures/pglite-db.mjs';
import { createCrmStore } from '../../lib/crm-store.js';
import { createSignupHandler, createUnsubscribeHandler } from '../../lib/signup.js';
import { unsubscribeToken } from '../../lib/unsubscribe-token.js';

const arg = (key, fallback) => { const i = process.argv.indexOf(key); return i < 0 ? fallback : process.argv[i + 1]; };
const out = path.resolve(arg('--out', '.tmp/crm-browser'));
const port = Number(arg('--port', '4781'));
const origin = `http://127.0.0.1:${port}`;
const publicDir = path.join(out, 'build/public');
fs.mkdirSync(out, { recursive: true });
execFileSync('node', ['scripts/build.mjs', '--out', path.join(out, 'build')], { stdio: 'inherit' });
const db = await createTestDb();
const store = createCrmStore(db.query);
const sent = [], checks = [];
const env = { REVIVEX_SITE_ORIGIN: origin, STRIPE_MODE: 'test', DATABASE_URL: 'postgres://fake:fake@local.test/offline',
  REVIVEX_CRM_SIGNING_SECRET: 'offline-browser-signing-secret-0123456789',
  RESEND_API_KEY: 're_FAKEKEY_12345678', RESEND_FROM: 'Revivex <test@example.test>', RESEND_REPLY_TO: 'support@revivex.store' };
const common = { getEnv: () => env, storeFactory: () => store, log: () => {} };
const signup = createSignupHandler({ ...common, sendMail: async (cfg, msg, opts) => { sent.push({ msg, opts }); return { id: `re_BROWSER_${sent.length}` }; } });
const unsubscribe = createUnsubscribeHandler(common);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    if (url.pathname === '/api/signup') return await signup(req, res);
    if (url.pathname === '/api/unsubscribe') return await unsubscribe(req, res);
    if (url.pathname === '/api/checkout') { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, configured: false })); }
    const file = path.resolve(publicDir, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
    if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) { res.writeHead(500); res.end('offline harness error'); console.error(e); }
});
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const check = (ok, label) => { checks.push({ ok: !!ok, label }); assert.ok(ok, label); console.log(`PASS ${label}`); };
try {
  for (const [name, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width, height } });
    await ctx.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await ctx.newPage();
    await page.goto(origin, { waitUntil: 'networkidle' });
    const form = page.locator('#updates .signup-form');
    await form.scrollIntoViewIfNeeded();
    const email = `${name}@example.test`;
    await form.locator('[name=email]').fill(email);
    await form.locator('[name=firstName]').fill('Synthetic');
    const response = page.waitForResponse(r => r.url() === `${origin}/api/signup` && r.request().method() === 'POST');
    await form.locator('button[type=submit]').click();
    check((await response).status() === 200, `${name}: real signup handler returned success`);
    await page.waitForFunction(() => document.querySelector('#updates .signup-form').textContent.includes("Thanks. You're on the list."));
    const [sub] = await db.query('select * from subscribers where email = $1', [email]);
    check(sub.consent_marketing && !!sub.consent_at, `${name}: SQL stores explicit marketing consent`);
    check(sent.filter(x => x.msg.to === email).length === 1, `${name}: one fake welcome`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: no horizontal overflow`);
    await page.screenshot({ path: path.join(out, `${name}-signup.png`) });
    const again = await page.evaluate(async email => {
      const r = await fetch('/api/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, source: 'reserve' }) });
      return { status: r.status, body: await r.json() };
    }, email);
    check(again.status === 200 && sent.filter(x => x.msg.to === email).length === 1, `${name}: duplicate signup has same public success and no second welcome`);
    const token = unsubscribeToken(env.REVIVEX_CRM_SIGNING_SECRET, sub.id);
    await page.goto(`${origin}/api/unsubscribe?t=${token}`);
    check((await db.query('select consent_marketing from subscribers where id = $1', [sub.id]))[0].consent_marketing, `${name}: GET does not unsubscribe`);
    await Promise.all([page.waitForURL(/api\/unsubscribe/), page.locator('button').click()]);
    await page.getByRole('heading', { name: "You're unsubscribed" }).waitFor();
    const [unsub] = await db.query('select consent_marketing, unsubscribed_at from subscribers where id = $1', [sub.id]);
    check(!unsub.consent_marketing && !!unsub.unsubscribed_at, `${name}: POST removes consent in real SQL`);
    await page.screenshot({ path: path.join(out, `${name}-unsubscribe.png`) });
    await ctx.close();
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  await db.close();
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ note: 'Offline PGlite SQL + fake mail, external browser requests blocked', checks }, null, 2));
}
