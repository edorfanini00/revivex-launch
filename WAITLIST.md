# Early access waitlist

The home page's only call to action. Every CTA (nav "Get early access"; hero, mid page and section "Join the waitlist") opens one signup modal copied from drinklinc.com: a 960x568 split card on desktop (machine photo `assets/v13/g-side.jpg` with the white wordmark on the left, form on the right), a 330px single column card on phones. The deposit checkout is no longer reachable from the home page; its routes stay for existing depositors (`DEPOSIT-CHECKOUT.md`).

## Flow

1. **Modal** (`public/signup.js`, markup at the end of `public/index.html`, styles at the end of `public/styles.css`). Escape, the backdrop and the X close it. Focus is trapped inside (the rest of the page is `inert`) and returns to the CTA that opened it. Page scroll is locked. The overlay follows `visualViewport`, so with the phone keyboard open the card shrinks to the visible area and scrolls inside itself.
2. **Fields:** email (`type=email`, required) and a searchable country list (the 249 ISO 3166-1 alpha-2 codes in `public/countries.js`, shared with the server). The country defaults to `x-vercel-ip-country` via `GET /api/signup` when Vercel reports one. A hidden honeypot field (`hp_extra`) is sent with every submission.
3. **`POST /api/signup`** (`lib/waitlist.js`), JSON only, 4 KB limit, Origin must equal the request host:
   - honeypot filled → 400, nothing saved;
   - email normalised (trimmed, lowercased) and validated strictly; country must be an ISO code → 400 `invalid_email` / `invalid_country`;
   - per IP (IPv6 by /64) rate limit, **counted in Postgres** (`revivex_waitlist_rate`, fixed 10 minute windows, 10 attempts), so it holds across function instances → 429;
   - one upsert into `revivex_waitlist` (`on conflict (email)`): a repeat signup touches `updated_at`, fills a missing country, clears `unsubscribed_at` (signing up again is a new explicit consent) and keeps first touch attribution. One row per email, case insensitive (`citext`).
   - `{ ok: true, lead }` only after that statement has committed. Any database error, a missing table or missing configuration answers 503 with "Nothing was saved". The modal shows success only for a 200 with `ok: true`; anything else, including a network error, is an inline error.
4. **First signup only** (`lead` is null on repeats):
   - welcome email through Resend (`RESEND_API_KEY`, `RESEND_FROM`, `RESEND_REPLY_TO`), `Idempotency-Key: revivex-welcome-<row id>`, with `List-Unsubscribe` (https link and mailto) and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. A failure is logged as `waitlist_email_failed` with a status or kind only; the signup still succeeds.
   - Meta `Lead`: the server sends the CAPI copy (hashed email, client IP, user agent, `_fbp`/`_fbc` from the request cookies) with event id `lead_<random>`, and the page fires the browser `Lead` with the same `eventID`, so Meta counts it once. The server sends only from the production deployment (`VERCEL_ENV=production`) and never with `Sec-GPC: 1`; the browser pixel starts only on `META_PIXEL_ORIGIN` and never with Global Privacy Control (unchanged). The home page no longer sends `InitiateCheckout`; its `ViewContent` carries the waitlist label and no value.
5. **`GET /api/unsubscribe?token=…`** sets `unsubscribed_at` (the first time only) and shows a plain confirmation page. `POST` is the RFC 8058 one-click request from mail apps. Unknown tokens get a 404 page with the support address.

Repeat signups answer `lead: null`, so a caller can tell whether an address was already on the list. That is accepted (low sensitivity, rate limited); hiding it would mean sending a Lead for every repeat.

## Data (`revivex_waitlist`)

`id`, `email` (citext, unique), `country`, `source` (`homepage:nav|hero|mid|waitlist`), `utm_source/medium/campaign/content/term`, `fbp`, `fbc`, `user_agent`, `ip_hash` (HMAC-SHA256 of the IP with `REVIVEX_IP_HASH_SALT`), `consent_text_version` (`waitlist-v1`), `created_at`, `updated_at`, `unsubscribed_at`, `unsubscribe_token` (32 random bytes, base64url, unique).

Logs carry event names and codes only: never an email address, token or IP address.

## Configuration

| Name | Where | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Neon integration, all environments | Production and previews share this database. |
| `REVIVEX_IP_HASH_SALT` | Production, Preview, Development (one value) | 48 random bytes, base64. Signup answers 503 without it (32+ chars). |
| `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_REPLY_TO` | Production, Preview | Without them the signup still saves; no email is sent. |
| `META_CAPI_ACCESS_TOKEN` | Production | Optional, as for the deposit events. |

## Migration

`scripts/migrate-waitlist.mjs` (`npm run migrate:waitlist`, needs `DATABASE_URL`) runs `MIGRATION_SQL` from `lib/waitlist.js`: `create extension if not exists citext`, `create table if not exists` for both tables and `create unique index if not exists`. It is additive and idempotent; it never drops or alters anything. `--check` describes the tables without changing anything.

Order: migrate before (or right after) the deploy that ships this code. Until the table exists, signups answer 503 and nothing is saved.

## Rollback

Promote the previous production deployment: the home page returns to the deposit CTA and `/api/signup` to its 503 stub. The tables can stay (nothing else reads them). Waitlist rows are kept until deleted on request.

## Tests

`tests/js/waitlist.test.mjs` (PGlite, an in-memory Postgres with citext, `tests/fixtures/pglite-db.mjs`), `tests/browser/site-browser.mjs` and the Lead cases in `tests/browser/meta-pixel-browser.mjs`. The local harness runs the real handlers on PGlite with recorded email and Meta transports (`/__synthetic/signups`, `/__synthetic/emails`, `/__synthetic/signup-db-fail`).
