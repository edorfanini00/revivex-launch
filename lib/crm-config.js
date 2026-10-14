// Preorder CRM configuration (database, Stripe webhook secret, Resend sender, signing
// secret). Every part is optional at load time; each route checks only what it needs
// and fails closed without calling anyone when its part is missing.
import { parseOrigin } from './deposit-config.js';

const clean = v => (typeof v === 'string' ? v.trim() : '');

// Images in emails always load from the production site (mail clients need public URLs).
export const EMAIL_ASSET_ORIGIN = 'https://reserve.healthrevivex.com';
export const PUBLIC_SITE_ORIGIN = 'https://reserve.healthrevivex.com';
export const COMPANY_ADDRESS = 'Revivex LLC, 1331 Brickell Bay Dr, Miami, FL 33131';
export const SIGNUP_CONSENT_TEXT = "We'll email you about Revivex. Unsubscribe anytime.";

const WHSEC_RE = /^whsec_[A-Za-z0-9+/=_-]{16,200}$/;
const RESEND_KEY_RE = /^re_[A-Za-z0-9_]{8,200}$/;
// "Name <local@domain>" or a bare address.
const FROM_RE = /^(?:[^<>@\r\n]{1,60} <[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/;
const EMAIL_RE = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;

export function readDatabaseUrl(env = process.env) {
  // A deployment can point at its own database (the preview branch) without touching
  // the Marketplace-managed DATABASE_URL.
  const url = clean(env.REVIVEX_DATABASE_URL) || clean(env.DATABASE_URL);
  return /^postgres(ql)?:\/\//.test(url) ? url : null;
}

export function readWebhookSecret(env = process.env) {
  const s = clean(env.STRIPE_WEBHOOK_SECRET);
  return WHSEC_RE.test(s) ? s : null;
}

export function readEmailConfig(env = process.env) {
  const apiKey = clean(env.RESEND_API_KEY);
  const from = clean(env.RESEND_FROM);
  const replyTo = clean(env.RESEND_REPLY_TO);
  if (!RESEND_KEY_RE.test(apiKey) || !FROM_RE.test(from) || (replyTo && !EMAIL_RE.test(replyTo))) return null;
  return { apiKey, from, replyTo: replyTo || null };
}

// HMAC key for unsubscribe links and IP hashes. Separate from the checkout operation
// secret so rotating one never breaks the other.
export function readCrmSecret(env = process.env) {
  const s = typeof env.REVIVEX_CRM_SIGNING_SECRET === 'string' ? env.REVIVEX_CRM_SIGNING_SECRET : '';
  return s.length >= 32 && new Set(s).size >= 10 ? s : null;
}

// Origin used in links inside emails and pages. Falls back to production.
export function readLinkOrigin(env = process.env) {
  const mode = clean(env.STRIPE_MODE) || 'live';
  return parseOrigin(clean(env.REVIVEX_SITE_ORIGIN), mode) || PUBLIC_SITE_ORIGIN;
}
