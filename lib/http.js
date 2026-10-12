// Small request/response helpers shared by the deposit API routes.
// Handlers use the plain Node http API so they run unchanged on Vercel and in the
// local test harness.

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
  // Some runtimes buffer the body before invoking the handler.
  if (!raw && req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) raw = req.body.toString('utf8');
    else if (typeof req.body === 'string') raw = req.body;
    else if (typeof req.body === 'object') raw = JSON.stringify(req.body);
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

export function clientIp(req) {
  const v = req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return v || req.socket?.remoteAddress || 'unknown';
}

// Best-effort fixed-window limiter held in this function instance's memory.
// Not durable and not shared between instances; it only blunts bursts against a
// warm instance. Platform-level rate limiting is the durable control.
export function createInstanceRateLimiter({ limit, windowMs, now = () => Date.now(), maxKeys = 5000 }) {
  const hits = new Map();
  return function take(key) {
    const t = now();
    let e = hits.get(key);
    if (!e || t - e.start >= windowMs) {
      if (hits.size >= maxKeys) hits.clear();
      e = { start: t, count: 0 };
      hits.set(key, e);
    }
    e.count += 1;
    return e.count <= limit ? { ok: true } : { ok: false, retryAfter: Math.ceil((e.start + windowMs - t) / 1000) };
  };
}

// Operational log: event names and codes only. Never emails, names, keys,
// request bodies or full Stripe objects.
const LOG_FIELDS = ['state', 'reason', 'kind', 'status', 'type', 'code', 'requestId'];
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
