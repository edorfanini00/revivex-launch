// Small request/response helpers shared by the deposit API routes.
// Handlers use the plain Node http API so they run unchanged on Vercel and in the
// local test harness.
import { isIP } from 'node:net';

export class HttpError extends Error {
  constructor(status, state, message) { super(message || state); this.status = status; this.state = state; }
}

export function sendJson(res, status, body, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

// Reads at most `limit` bytes of a JSON object body. Rejects anything else.
export async function readJsonBody(req, limit) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (!/^application\/json(\s*;\s*charset=utf-8)?$/.test(type.trim())) throw new HttpError(415, 'unsupported_media_type');
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new HttpError(413, 'payload_too_large');

  let raw = '';
  if (!req.readableEnded && typeof req[Symbol.asyncIterator] === 'function') {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new HttpError(413, 'payload_too_large');
      chunks.push(Buffer.from(chunk));
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  // Vercel's Node helpers buffer the body before the handler runs and expose it as a
  // lazy req.body getter that THROWS for invalid JSON. Read it defensively and bound it.
  if (!raw) {
    let pre;
    try { pre = req.body; } catch { throw new HttpError(400, 'invalid_json'); }
    if (pre !== undefined && pre !== null) {
      if (Buffer.isBuffer(pre)) raw = pre.toString('utf8');
      else if (typeof pre === 'string') raw = pre;
      else if (typeof pre === 'object') {
        try { raw = JSON.stringify(pre); } catch { throw new HttpError(400, 'invalid_json'); }
      } else throw new HttpError(400, 'invalid_json');
    }
  }
  if (Buffer.byteLength(raw) > limit) throw new HttpError(413, 'payload_too_large');

  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new HttpError(400, 'invalid_json'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'invalid_body');
  return parsed;
}

// Same-origin gate for state-changing requests. Requires an exact Origin match;
// Sec-Fetch-Site, when the browser sends it, must agree.
export function assertSameOrigin(req, siteOrigin) {
  const origin = req.headers.origin;
  if (origin !== siteOrigin) throw new HttpError(403, 'forbidden_origin');
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') throw new HttpError(403, 'forbidden_origin');
}

// Vercel overwrites x-vercel-forwarded-for / x-forwarded-for / x-real-ip at its edge to
// prevent spoofing (vercel.com/docs/headers/request-headers). Off Vercel (local harness)
// these headers are client-controlled, so per-IP limits are only meaningful on Vercel.
export function clientIp(req) {
  const first = h => String(req.headers[h] || '').split(',')[0].trim();
  return first('x-vercel-forwarded-for') || first('x-real-ip') || first('x-forwarded-for') || req.socket?.remoteAddress || 'unknown';
}

// Per-IP limiter key. A single IPv6 subscriber usually holds a whole /64, so IPv6
// clients are keyed by their /64 prefix; IPv4 (including IPv4-mapped IPv6) by the
// full address. Anything unparseable is used as-is.
export function rateLimitKey(ip) {
  let a = String(ip || '').trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) a = mapped[1];
  const kind = isIP(a);
  if (kind !== 6) return a || 'unknown';
  // An embedded IPv4 tail (with or without '::') becomes its two hex groups.
  a = a.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_, w, x, y, z) => `${((w << 8) | x).toString(16)}:${((y << 8) | z).toString(16)}`);
  let [head, tail = null] = a.split('::');
  head = head ? head.split(':') : [];
  let groups = head;
  if (tail !== null) {
    const t = tail ? tail.split(':') : [];
    groups = [...head, ...Array(8 - head.length - t.length).fill('0'), ...t];
  }
  const n = groups.map(g => parseInt(g, 16));
  if (n.length === 8 && n.slice(0, 5).every(x => x === 0) && n[5] === 0xffff) return [n[6] >> 8, n[6] & 255, n[7] >> 8, n[7] & 255].join('.');
  return `${groups.slice(0, 4).map(g => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

// Best-effort fixed-window limiter held in this function instance's memory.
// Not durable and not shared between instances or regions; it only blunts bursts
// against a warm instance. A platform rule (Vercel Firewall rate limit on /api/*) is
// the required durable control before live traffic. When the table is full, expired
// entries go first, then the oldest entry that is not currently throttled; throttled
// entries are never dropped early, and if every slot is throttled the new key is
// refused rather than resetting anyone.
export function createInstanceRateLimiter({ limit, windowMs, now = () => Date.now(), maxKeys = 5000 }) {
  const hits = new Map();
  function makeRoom(t) {
    for (const [k, e] of hits) if (t - e.start >= windowMs) hits.delete(k);
    if (hits.size < maxKeys) return true;
    for (const [k, e] of hits) if (e.count <= limit) { hits.delete(k); return true; }
    return false;
  }
  return function take(key) {
    const t = now();
    let e = hits.get(key);
    if (!e || t - e.start >= windowMs) {
      if (e) hits.delete(key);
      if (hits.size >= maxKeys && !makeRoom(t)) return { ok: false, retryAfter: Math.ceil(windowMs / 1000) };
      e = { start: t, count: 0 };
      hits.set(key, e);
    }
    e.count += 1;
    return e.count <= limit ? { ok: true } : { ok: false, retryAfter: Math.ceil((e.start + windowMs - t) / 1000) };
  };
}

// Operational log: event names and codes only. Never emails, names, keys,
// request bodies or full Stripe objects.
const LOG_FIELDS = ['state', 'reason', 'kind', 'status', 'type', 'code', 'param', 'requestId'];
export function makeLogger(sink = console) {
  return (event, fields = {}) => {
    const entry = { event };
    for (const k of LOG_FIELDS) {
      const v = fields[k];
      if (v !== undefined && v !== '' && v !== null) entry[k] = String(v).slice(0, 80);
    }
    sink.log(JSON.stringify(entry));
  };
}
