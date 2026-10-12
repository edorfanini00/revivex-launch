// Owned LOCAL harness: serves a built public/ directory and the real API handler code
// using the vercel.json route table, on 127.0.0.1 only.
//
//   --mode unconfigured  real default exports from api/*.js with every STRIPE_/REVIVEX_
//                        variable removed (what production does today)
//   --mode synthetic     the same handler factories wired to an in-memory SYNTHETIC
//                        Stripe stand-in, plus /__synthetic/* control routes.
//                        Not Stripe; never contacts any external service.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : dflt; };
const mode = arg('mode', 'unconfigured');
const port = Number(arg('port', '4310'));
const publicDir = path.resolve(arg('root', path.join(ROOT, 'public')));
const origin = `http://127.0.0.1:${port}`;

const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ttf': 'font/ttf', '.txt': 'text/plain', '.xml': 'application/xml', '.mp4': 'video/mp4' };

let handlers = {};
let control = null;
let clockOffsetMs = 0;

if (mode === 'synthetic') {
  const { createCheckoutHandler, createReservationHandler } = await import(pathToFileURL(path.join(ROOT, 'lib/deposit-handlers.js')));
  const { createSyntheticStripe } = await import(pathToFileURL(path.join(ROOT, 'tests/fixtures/synthetic-provider.mjs')));
  const env = {
    REVIVEX_CHECKOUT_ENABLED: 'true', STRIPE_MODE: 'test', STRIPE_SECRET_KEY: ['sk', 'test', 'SYNTHETICHARNESSONLY0000'].join('_'),
    STRIPE_EXPECTED_ACCOUNT_ID: 'acct_SYNTHETIC0001', STRIPE_DEPOSIT_PRICE_ID: 'price_SYNTHETIC0001', STRIPE_DEPOSIT_PRODUCT_ID: 'prod_SYNTHETIC0001',
    REVIVEX_SITE_ORIGIN: origin, REVIVEX_OPERATION_SIGNING_SECRET: 'synthetic-harness-signing-secret-0123456789',
  };
  const synth = createSyntheticStripe({ accountId: env.STRIPE_EXPECTED_ACCOUNT_ID, priceId: env.STRIPE_DEPOSIT_PRICE_ID, productId: env.STRIPE_DEPOSIT_PRODUCT_ID });
  control = synth.control;
  const { createInstanceRateLimiter } = await import(pathToFileURL(path.join(ROOT, 'lib/http.js')));
  // Browser QA drives many attempts from one loopback IP; per-IP limiting has its own unit tests.
  const deps = { getEnv: () => env, providerFactory: () => synth.provider, now: () => Date.now() + clockOffsetMs, limiter: createInstanceRateLimiter({ limit: 10000, windowMs: 60_000 }) };
  handlers['/api/checkout.js'] = createCheckoutHandler(deps);
  handlers['/api/reservation.js'] = createReservationHandler(deps);
  handlers['/api/signup.js'] = (await import(pathToFileURL(path.join(ROOT, 'api/signup.js')))).default;
  handlers['/api/health.js'] = (await import(pathToFileURL(path.join(ROOT, 'api/health.js')))).default;
} else {
  for (const k of Object.keys(process.env)) if (/^(STRIPE_|REVIVEX_)/.test(k)) delete process.env[k];
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
  if (req.method !== 'POST') return json(res, 405, {});
  if (op === 'fail-next') { control.failNext(url.searchParams.get('kind'), Number(url.searchParams.get('n') || 1)); return json(res, 200, { ok: true }); }
  if (op === 'advance-clock') { clockOffsetMs += Number(url.searchParams.get('hours')) * 3600_000; return json(res, 200, { ok: true }); }
  if (['pay', 'expire', 'dispute', 'refund'].includes(op)) return json(res, control[op](id) ? 200 : 404, { ok: true });
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
