// Minimal Resend client (POST /emails). One attempt with a hard timeout; the
// Idempotency-Key makes a retried call within 24 hours return the first email instead
// of sending again. Errors carry status and Resend's error name only, never addresses.
export class EmailSendError extends Error {
  constructor(kind, { status = 0, name = '' } = {}) {
    super(`resend_${kind}${status ? `_${status}` : ''}`);
    this.kind = kind;
    this.status = status;
    this.name_ = String(name).slice(0, 60);
  }
}

export async function sendEmail(cfg, message, { idempotencyKey, fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const body = {
    from: cfg.from,
    to: [message.to],
    subject: message.subject,
    html: message.html,
    text: message.text,
    ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}),
    ...(message.headers ? { headers: message.headers } : {}),
    ...(message.tags ? { tags: message.tags } : {}),
  };
  const headers = {
    Authorization: `Bearer ${cfg.apiKey}`,
    'Content-Type': 'application/json',
    'User-Agent': 'revivex-crm/1.0',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey.slice(0, 256);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res, text;
  try {
    res = await fetchImpl('https://api.resend.com/emails', { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal, redirect: 'error' });
    text = await res.text();
  } catch {
    throw new EmailSendError(ac.signal.aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = JSON.parse(text); } catch { /* non-JSON */ }
  if (!res.ok) throw new EmailSendError('api', { status: res.status, name: data?.name || '' });
  if (!data || typeof data.id !== 'string') throw new EmailSendError('api', { status: res.status, name: 'invalid_response' });
  return { id: data.id };
}
