// Owned LOCAL harness: serves a built public/ directory and the real API handler code
// using the vercel.json route table, on 127.0.0.1 only.
//
//   --mode unconfigured  real default exports from api/*.js with every STRIPE_/REVIVEX_
//                        variable removed (what production does today)
//   --mode synthetic     the same handler factories wired to an in-memory SYNTHETIC
//                        Stripe stand-in, plus /__synthetic/* control routes.
//                        Not Stripe; never contacts any external service. The Meta
//                        Conversions API is enabled with a fake token and a recorder
//                        transport (GET /__synthetic/meta-events); nothing reaches Meta.
//                        The waitlist (/api/signup, /api/unsubscribe) runs on an in-memory
//                        PGlite Postgres with a recorder in place of Resend
//                        (GET /__synthetic/signups, /__synthetic/emails).
//   --stripe-mode live   (synthetic only) imitate a live mode account. Checkout stays
//                        unconfigured (live needs an https origin); receipts work, and
//                        /__synthetic/seed-paid creates paid live deposits.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : dflt; };
const mode = arg('mode', 'unconfigured');
const stripeMode = arg('stripe-mode', 'test');
const port = Number(arg('port', '4310'));
const publicDir = path.resolve(arg('root', path.join(ROOT, 'public')));
const origin = `http://127.0.0.1:${port}`;

const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ttf': 'font/ttf', '.txt': 'text/plain', '.xml': 'application/xml', '.mp4': 'video/mp4' };

let handlers = {};
let control = null;
let clockOffsetMs = 0;
const metaEvents = [];
const emails = [];
let waitlist = null;

if (mode === 'synthetic') {
  const { createCheckoutHandler, createReservationHandler } = await import(pathToFileURL(path.join(ROOT, 'lib/deposit-handlers.js')));
  const { createSyntheticStripe } = await import(pathToFileURL(path.join(ROOT, 'tests/fixtures/synthetic-provider.mjs')));
  const { DEPOSIT } = await import(pathToFileURL(path.join(ROOT, 'lib/deposit-config.js')));
  const { createMetaCapi } = await import(pathToFileURL(path.join(ROOT, 'lib/meta-capi.js')));
  const env = {
    REVIVEX_CHECKOUT_ENABLED: 'true', STRIPE_MODE: stripeMode, STRIPE_SECRET_KEY: ['sk', stripeMode, 'SYNTHETICHARNESSONLY0000'].join('_'),
    REVIVEX_LIVE_APPROVED_TERMS_VERSION: DEPOSIT.termsVersion, META_CAPI_ACCESS_TOKEN: 'SYNTHETIC_HARNESS_CAPI_TOKEN',
    STRIPE_EXPECTED_ACCOUNT_ID: 'acct_SYNTHETIC0001', STRIPE_DEPOSIT_PRICE_ID: 'price_SYNTHETIC0050', STRIPE_DEPOSIT_PRODUCT_ID: 'prod_SYNTHETIC0001',
    STRIPE_LEGACY_DEPOSIT_PRICE_IDS: 'price_SYNTHETIC0001',
    REVIVEX_SITE_ORIGIN: origin, REVIVEX_OPERATION_SIGNING_SECRET: 'synthetic-harness-signing-secret-0123456789',
  };
  const synth = createSyntheticStripe({ accountId: env.STRIPE_EXPECTED_ACCOUNT_ID, priceId: env.STRIPE_DEPOSIT_PRICE_ID, productId: env.STRIPE_DEPOSIT_PRODUCT_ID, legacyPriceId: env.STRIPE_LEGACY_DEPOSIT_PRICE_IDS, live: stripeMode === 'live' });
  control = synth.control;
  const { createInstanceRateLimiter } = await import(pathToFileURL(path.join(ROOT, 'lib/http.js')));
  // Browser QA drives many attempts from one loopback IP; per-IP limiting has its own unit tests.
  // Recorder in place of graph.facebook.com: keeps the event, never the token.
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    for (const e of body.data) metaEvents.push({ event_name: e.event_name, event_id: e.event_id, event_time: e.event_time, has_em: !!e.user_data.em });
    return new Response('{"events_received":1}', { status: 200 });
  };
  const metaCapi = () => createMetaCapi({ pixelId: '123456789012345', fetchImpl, schedule: () => {} });
  const deps = { getEnv: () => env, providerFactory: () => synth.provider, now: () => Date.now() + clockOffsetMs, limiter: createInstanceRateLimiter({ limit: 10000, windowMs: 60_000 }) };
  handlers['/api/checkout.js'] = createCheckoutHandler({ ...deps, metaCapi: metaCapi() });
  handlers['/api/reservation.js'] = createReservationHandler({ ...deps, metaCapi: metaCapi() });
  const { createSignupHandler, createUnsubscribeHandler } = await import(pathToFileURL(path.join(ROOT, 'lib/waitlist.js')));
  const { createTestDb } = await import(pathToFileURL(path.join(ROOT, 'tests/fixtures/pglite-db.mjs')));
  waitlist = await createTestDb();
  const waitlistEnv = { DATABASE_URL: 'pglite://harness', REVIVEX_IP_HASH_SALT: 'synthetic-harness-ip-salt-0123456789abcdef', RESEND_API_KEY: 'SYNTHETIC_RESEND', RESEND_FROM: 'Revivex <synthetic@example.test>', META_CAPI_ACCESS_TOKEN: 'SYNTHETIC_HARNESS_CAPI_TOKEN', REVIVEX_META_MODE: 'live' };
  const mailFetch = async (url, init) => { const b = JSON.parse(init.body); emails.push({ to: b.to, subject: b.subject, text: b.text, headers: b.headers }); return new Response('{"id":"synthetic"}', { status: 200 }); };
  handlers['/api/signup.js'] = createSignupHandler({ getEnv: () => waitlistEnv, dbFactory: async () => waitlist.db, fetchImpl: mailFetch, metaCapi: metaCapi(), rateLimit: 10000 });
  handlers['/api/unsubscribe.js'] = createUnsubscribeHandler({ getEnv: () => waitlistEnv, dbFactory: async () => waitlist.db });
  handlers['/api/health.js'] = (await import(pathToFileURL(path.join(ROOT, 'api/health.js')))).default;
} else {
  for (const k of Object.keys(process.env)) if (/^(STRIPE_|REVIVEX_|DATABASE_|POSTGRES_|PG|RESEND_|META_)/.test(k)) delete process.env[k];
  globalThis.fetch = async () => { throw new Error('harness: outbound network disabled'); };
  for (const f of fs.readdirSync(path.join(ROOT, 'api'))) {
    handlers[`/api/${f}`] = (await import(pathToFileURL(path.join(ROOT, 'api', f)))).default;
  }
}

function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }

function synthControl(req, res, url) {
  const id = url.searchParams.get('session_id');
  const op = url.pathname.slice('/__synthetic/'.length);
  if (op === 'state') return json(res, 200, control.state());
  if (op === 'meta-events') return json(res, 200, metaEvents);
  if (op === 'emails') return json(res, 200, emails);
  if (op === 'signups') return waitlist.rows().then(rows => json(res, 200, rows));
  if (op === 'signup-db-fail' && req.method === 'POST') { waitlist.db.failNext(Object.assign(new Error('synthetic outage'), { code: '08006' })); return json(res, 200, { ok: true }); }
  if (op === 'reset-signups' && req.method === 'POST') return waitlist.pg.exec('truncate revivex_waitlist, revivex_waitlist_rate').then(() => { emails.length = 0; metaEvents.length = 0; return json(res, 200, { ok: true }); });
  if (req.method !== 'POST') return json(res, 405, {});
  if (op === 'fail-next') { control.failNext(url.searchParams.get('kind'), Number(url.searchParams.get('n') || 1)); return json(res, 200, { ok: true }); }
  if (op === 'advance-clock') { clockOffsetMs += Number(url.searchParams.get('hours')) * 3600_000; return json(res, 200, { ok: true }); }
  if (op === 'seed-paid') return json(res, 200, { session_id: control.seedPaid(Number(url.searchParams.get('hours') || 0), { legacy: url.searchParams.get('legacy') === '1' }) });
  if (op === 'pay') return json(res, control.pay(id, Number(url.searchParams.get('hours') || 0)) ? 200 : 404, { ok: true });
  if (['expire', 'dispute', 'refund'].includes(op)) return json(res, control[op](id) ? 200 : 404, { ok: true });
  return json(res, 404, {});
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    if (control && url.pathname.startsWith('/__synthetic/')) return synthControl(req, res, url);
    for (const route of vercel.routes) {
      const m = new RegExp(`^${route.src}$`).exec(url.pathname);
      if (!m) continue;
      for (const [k, v] of Object.entries(route.headers || {})) res.setHeader(k, v);
      const dest = route.dest.replace(/\$(\d+)/g, (_, i) => m[Number(i)] || '');
      if (dest.startsWith('/api/')) {
        const h = handlers[dest];
        if (!h) return json(res, 404, {});
        return await h(req, res);
      }
      let file = path.join(publicDir, decodeURIComponent(dest.replace(/^\/public\/?/, '')));
      if (!file.startsWith(publicDir)) return json(res, 403, {});
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      return fs.createReadStream(file).pipe(res);
    }
    res.writeHead(404); res.end();
  } catch (e) {
    res.writeHead(500); res.end('harness error');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`harness ${mode} ${origin} root=${publicDir}`));
