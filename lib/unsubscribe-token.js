// Signed unsubscribe tokens: `<subscriber uuid>.<mac>`. They never expire (an old
// email's link must keep working) and reveal nothing beyond the random subscriber id.
import crypto from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const mac = (secret, id) => crypto.createHmac('sha256', secret).update(`rvx-unsub-v1.${id}`).digest('base64url').slice(0, 32);

export function unsubscribeToken(secret, subscriberId) {
  if (!UUID_RE.test(subscriberId)) throw new Error('invalid subscriber id');
  return `${subscriberId}.${mac(secret, subscriberId)}`;
}

// Returns the subscriber id, or null.
export function readUnsubscribeToken(secret, token) {
  if (!secret || typeof token !== 'string' || token.length > 100) return null;
  const [id, given, extra] = token.split('.');
  if (extra !== undefined || !UUID_RE.test(id || '') || typeof given !== 'string') return null;
  const a = Buffer.from(given);
  const b = Buffer.from(mac(secret, id));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? id : null;
}

export const hashIp = (secret, ip) => crypto.createHmac('sha256', secret).update(`rvx-ip-v1.${ip}`).digest('base64url').slice(0, 32);
