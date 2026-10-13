# Refundable $100 preorder deposit

Stripe-hosted Checkout in `payment` mode for a one-time $100 USD deposit. The deposit is fully refundable and is credited toward the final machine price. There is no automatic balance charge. Revivex is in development; the final price and shipping date have not been announced. The terms page is versioned `deposit-terms-v2`. v1 carried an unapproved refund cutoff, was never used for a real payment, and stays recognised only for lookups.

**On the page:** every Preorder button (nav, hero, mid page and the one in `#reserve`) starts checkout directly, by pointer, Enter or Space; there is no terms checkbox. With the script running the three links are exposed as buttons (Space activates on release and does not scroll), and every activation goes through one in-flight guard, so held or repeated keys and clicks make one operation. The clicked button shows "Opening checkout…" with a spinner, and a failure restores it with the message next to it. The deposit is disclosed beside the hero and mid page buttons, which say "$100 fully refundable deposit, credited toward your machine. By preordering you accept the deposit terms."; `#reserve` says "Preordering means you accept the deposit terms". Selecting Preorder is the acceptance, so the page sends `termsAccepted: true` with the current `termsVersion` exactly as before. Without JavaScript the links lead to `#reserve`, the section is fully visible (`nojs.css`, loaded from `<noscript>`, turns off the reveal-on-scroll fade), and its button stays disabled with the "Reserving needs JavaScript" notice. While the reconcile/restart prompt is showing, the links scroll to `#reserve` instead of starting another attempt.

**Default state: off.** With no configuration, the reserve button is disabled, `POST /api/checkout` returns 503 `unavailable` and no Stripe request is made.

## How it works

1. **`GET /api/checkout`: configuration probe only.** It returns `configured`, `siteOrigin`, the mode, the fixed amount and the terms version, and makes **no Stripe call**.
   - `configured: true` means every variable is present and well formed. It does **not** mean Stripe will accept a payment: the key may lack permissions, or the account may have charges disabled.
   - The page offers checkout only when it is served from `siteOrigin`. On any other host (www/apex, preview or deployment aliases) the button is disabled and links to the canonical origin.
2. **`POST /api/checkout {step:"start"}`** returns a signed operation token (HMAC, canonical encoding). This step makes no Stripe call.
   - The token holds a random id, the issue time, a digest of the mode, account, price, product, terms version, site origin and Checkout parameter version, plus allowlisted UTM labels.
   - The browser keeps `{token, attempted, uncertain}` in `sessionStorage`.
3. **`POST /api/checkout {step:"create", operation}`:**
   1. Verifies the token.
   2. Checks the merchant: pinned account, `charges_enabled`.
   3. Checks the price: exactly $100 USD, one-time, active, no other currencies, the expected product.
   4. Creates the Checkout Session with an idempotency key derived only from the token, so a retry sends byte-identical parameters.
   5. **Retrieves the session's current state.** Stripe replays the *saved first response* for a key, which is the session as created, so the create reply alone can't be used for routing. The visitor is sent:
      - `open` → to Stripe;
      - `complete` → to the receipt;
      - `expired` → a new attempt.
   6. Before any redirect, the retrieved session must offer **card only**: `allowed_payment_method_types == ['card']` and `payment_method_types ⊆ ['card']`. Cards include Apple Pay and Google Pay wallets; Link, Klarna/BNPL, Cash App Pay and Amazon Pay are excluded. The session must also show **`branding_settings.display_name == 'Revivex'`**. Otherwise the session is never shown to the visitor.

   Outcomes:
   - **Unknown outcome** (timeout, network, unreadable 2xx body, 409 in flight, 429): `uncertain`. The browser retries the same token twice. After six unknowns for one attempt, it switches to the reconcile path.
   - **Stripe 5xx:** Stripe saves the 500 under the key and replays it, so this goes straight to `reconcile`.
   - **400 `idempotency_error`**, a token older than 23h (inside Stripe's 24h retention), or a changed binding: `reconcile`. The token is never re-keyed or re-parameterised.
   - **Reconcile message:** "check your card statement or banking app for a $100 Revivex payment (a receipt email may not arrive)… contact support@revivex.store". Only an explicit click starts a new reservation.
   - **Definite Stripe 4xx:** `unavailable` ("This request did not open a checkout page").
4. **`GET /api/reservation?session_id=`** retrieves the session from Stripe and checks the account, mode, amount, currency, metadata, known terms version, line item, PaymentIntent and charge. Malformed provider structures return `not_recognized`; they never throw. It returns only the state, the amount and the PaymentIntent reference.
   - States: `confirmed`, `processing`, `not_completed`, `expired`, `refunded`, `partially_refunded`, `disputed`, `not_recognized`, `not_found`.
   - Query parameters are never evidence of payment.
   - Any paid state clears the stored attempt in that tab.

There is **no webhook and no fulfillment**. Stripe is the deposit ledger. Session and PaymentIntent metadata carry `purpose=revivex_preorder_deposit`, `terms_version`, `operation` and any `utm_*` labels. A paid deposit is not an order, a shipment, a queue position or an email signup. Refunds are manual, from the Stripe Dashboard, after an email to support@revivex.store.

The legacy `/api/signup` always returns 503 "Nothing was saved" and logs nothing. **The free waitlist remains unconfigured.**

### Support notes

- **Separate tabs or devices create separate deposits.** There is no customer identity or database, so dedupe works only within one tab's attempt. To find duplicates, search the Stripe Dashboard payments for metadata `purpose=revivex_preorder_deposit` by customer email. Refund any extra deposit on request.
- If a visitor reports an unclear outcome, look the payment up by email or card last-4 in the Dashboard. The receipt page `reservation.html?session_id=…` shows the authoritative state.

## Environment (Vercel, per environment; never in code)

| Name | Value |
| --- | --- |
| `REVIVEX_CHECKOUT_ENABLED` | `true` to allow new deposits (kill switch) |
| `STRIPE_MODE` | `test` or `live`; must match the key prefix |
| `STRIPE_SECRET_KEY` | Restricted key (`rk_…`) preferred. Needs write on Checkout Sessions; read on Prices, Products, PaymentIntents and Charges; plus whatever lets `GET /v1/account` succeed. Confirm all of these in the sandbox. |
| `STRIPE_EXPECTED_ACCOUNT_ID` | `acct_…` of the verified Revivex merchant |
| `STRIPE_DEPOSIT_PRICE_ID` | `price_…`: one-time, 10000 USD, only the `usd` currency option |
| `STRIPE_DEPOSIT_PRODUCT_ID` | `prod_…` the price belongs to |
| `REVIVEX_SITE_ORIGIN` | the single canonical origin, e.g. `https://revivex-launch.vercel.app` (https, no path) |
| `REVIVEX_OPERATION_SIGNING_SECRET` | **must** be generated with `openssl rand -base64 48` and stored only in Vercel env. The code rejects anything under 32 characters or with fewer than 10 distinct characters; that is a sanity check, not an entropy guarantee. Rotating it sends in-flight attempts to the reconcile path. |
| `REVIVEX_LIVE_APPROVED_TERMS_VERSION` | live only: `deposit-terms-v2`, after sign-off on terms, merchant identity, refund handling and tax/jurisdiction |
| `META_CAPI_ACCESS_TOKEN` | optional: Meta Conversions API token (Events Manager → dataset → Settings). Unset = server events off. Never logged. |
| `META_TEST_EVENT_CODE` | optional, temporary: `TEST…` code from Events Manager → Test events, to watch server events arrive. Remove after checking. |

## Provider setup (scoped; no merchant-wide setting changes needed by the code)

- Payment methods are limited per session with `allowed_payment_method_types: ['card']`, documented for API `2026-09-30.endive`. That API version rejects `payment_method_types` (seen in the TEST sandbox). No payment method configuration is created or changed. Card must stay enabled in the account's Dashboard payment method settings.
- The hosted header shows `branding_settings.display_name = "Revivex"`. Per Stripe's docs this changes **only the top of the Checkout page**. The account's public business name still appears in the Checkout terms, on receipts and elsewhere. The TEST account currently reports `settings.dashboard.display_name = "Individual"` and `business_profile.name = null`. **The owner must set the public business name to Revivex** in the Dashboard (Settings → Business → Public details) for receipts and terms to read correctly. This code makes no account-settings writes.
- Receipt emails: Checkout sends a customer receipt only if the account's "Successful payments" email setting is on. The site does not rely on receipts (the reconcile copy points to card statements and support), but enabling them is recommended and should be verified in the sandbox.

## Rate limiting (limits stated honestly)

- In code: a per-instance, per-IP limit (20/min for checkout, 30/min for lookups) plus a per-instance ceiling across all callers that bounds Stripe call amplification even when IPs rotate.
  - The checkout ceiling (120/min) counts only `create` requests that will run the full Stripe flow, after the token, age and binding checks. `start` (no Stripe call) is limited per IP only, with no global ceiling, so free requests cannot lock visitors out of checkout.
  - Replays of an operation this instance answered in the last ~60 s (bounded to 5000 operations, least recently used dropped first) never use the ceiling. Concurrent duplicates share one Stripe flow. A replay of a `complete` or `expired` result makes no Stripe call. A replay of an open session (`redirect`) re-reads that session with one retrieve, so a payment made in the meantime routes to the receipt; those reads have their own ceiling (240/min), and once it is used up, replays are answered from the cache without a Stripe call. Uncertain and failed results are never cached.
  - So one self-issued token replayed from a few addresses can no longer exhaust the ceiling inside the ~60 s window. It does not hold past that window: a pool of tokens can re-enter the ceiling (measured cost below, review r4 finding R4-1).
  - The lookup ceiling (240/min) counts only well-formed session ids, each of which calls Stripe. Throttled entries are never reset early.
- Limits: the counters and the replay cache live in one warm function instance, so they are **not shared across instances or regions** and reset on cold start. Per-IP keys use `x-vercel-forwarded-for` / `x-real-ip` (IPv4, including IPv4-mapped IPv6 in any notation: full address; IPv6: the /64 prefix, because one subscriber usually holds a whole /64), which Vercel overwrites at its edge to prevent spoofing (vercel.com/docs/headers/request-headers). That is not verified on a deployment here.
- Residual (availability only; no money, PII or duplicate-charge risk), measured in review r4 (R4-1, probe P4, default limits on a fake clock):
  - **One-time warm-up:** mint about 120 tokens with `start` and use each once with `create`. This opens about 120 real Checkout Sessions, once, at any pace and from any addresses, because tokens stay valid for `OPERATION_MAX_AGE_S` (23 h).
  - **Then, every minute:** once the ~60 s cache entries have expired, about **6 addresses per instance**, each sending 20 creates/min with a different pool token, use up the checkout ceiling. These are Stripe idempotent replays, so they open **no new sessions** (about 480 Stripe calls/min). Visitors on that instance then see "Too many attempts". This can be repeated for **up to 23 h** from the warm-up.
  - A per-IP rate-limit rule (in code or in the Vercel Firewall) does not stop or control this, because each address stays below any per-IP threshold that would not also hurt real visitors.
- **Required before live (not configured by this code):**
  - a Vercel Firewall rate-limit rule on `/api/checkout` and `/api/reservation`, with IPv6 clients keyed equivalently (by /64), or confirm how Firewall keys IPv6. This blunts single-source bursts across instances; it is not the control for distributed floods;
  - for distributed floods and the token-pool residual above: enable Vercel bot protection, or a Firewall challenge rule, on `POST /api/checkout` (the page's own `fetch` must still pass it; verify in a preview deployment). Otherwise the owner explicitly accepts the residual above.
- **Live control (decision recorded 2026-10-13):** the control for the residual above is a Vercel Firewall challenge / bot protection rule on `POST /api/checkout`. The owner accepted the remaining residual risk (availability only, no money risk) on 2026-10-13. The Firewall configuration is not part of this code and has not been verified on a deployment here; confirm it is active before `vercel --prod` (Deploy step 4).

## Meta pixel and Conversions API

Lets Meta optimise campaigns on paid deposits. Measurement only: it changes no amount, idempotency key, Checkout Session parameter, terms or rate limit.

- **Pixel id:** one constant, `META_PIXEL_ID` in `public/meta-pixel-id.js`, imported by the browser pixel (`public/meta-pixel.js`) and the server (`lib/meta-capi.js`). While it is `REVIVEX_PIXEL_ID_PLACEHOLDER`, nothing loads from or is sent to Meta.
- **Canonical origin:** `META_PIXEL_ORIGIN` in the same file (`https://reserve.healthrevivex.com`, the production `REVIVEX_SITE_ORIGIN`). The browser pixel starts only there, so previews, deployment aliases and local copies never send to the live dataset. Change it together with `REVIVEX_SITE_ORIGIN`.
- **Live mode only:** test mode deposits are never reported. The server skips every event when `STRIPE_MODE` is not `live`, and the browser sends `Purchase` only when `/api/reservation` reports `mode: "live"` for a `cs_live_` session.
- **Browser events:** `PageView` on every page; `ViewContent` on the home page; `InitiateCheckout` only when the create step returns a Stripe redirect, just before leaving, once per operation (the stored operation remembers it was announced, so Back from Stripe and Preorder again, which replays the same session, sends nothing new; a failed start sends nothing), with `eventID` = the operation id inside the signed token; `Purchase` on the receipt only when `/api/reservation` returns `confirmed` with `fresh: true` in live mode, `eventID` = `deposit_<session id>`, at most once per session per browser even across simultaneous tabs (an atomic IndexedDB claim; nothing is sent if IndexedDB is unavailable). All carry `value: 100, currency: USD`. `autoConfig` is off, so Meta collects no automatic button or page metadata.
- **Recent payments only:** Meta deduplicates the browser and server copies only within 48 hours, and a receipt link can be reopened at any time. So `/api/reservation` returns `fresh: true` only for a confirmed deposit whose charge (else PaymentIntent) `created` is within 48 hours, and only then do the server and browser report `Purchase`, with `event_time` = the payment time. `fresh` is measurement only; the receipt page shows the same thing either way.
- **Server events (CAPI):** `InitiateCheckout` from `POST /api/checkout` on a `redirect` result and `Purchase` from `GET /api/reservation` on a fresh `confirmed`, with the same event ids, so Meta deduplicates. User data: client IP, user agent, `_fbp`/`_fbc` cookies (read from the request; nothing is added to Stripe metadata) and a SHA-256 hash of the Stripe customer email when present. Never a raw email, name or payment detail. Sent after the response is written, with a 1.5 s deadline, registered with Vercel `waitUntil` when available; failures log `meta_capi_failed` with a status or kind only. Each operation (`InitiateCheckout`) and each paid session (`Purchase`) is reported at most once per warm instance; the entry is kept only after Meta accepts the event, so a skipped (GPC, no token, ceiling) or failed send does not block a later eligible one. Each function instance makes at most 60 Conversions API sends per minute.
- **Privacy:** a browser with Global Privacy Control (`navigator.globalPrivacyControl`, `Sec-GPC: 1`) gets no pixel and no server events. `privacy.html` describes the pixel and the opt out.
- **Known limits:** the receipt URL (with the session id) is the page URL the pixel reports, and the `Purchase` event id contains the session id. The session id is a lookup handle with no personal data. If the fbevents request is still pending when the browser leaves for Stripe it can be lost; the server copy covers it.
- **Domain verification:** DNS based; there is no `facebook-domain-verification` meta tag.

## Security headers

All static responses, including `/reservation.html`, carry a CSP:
- `default-src 'self'`; scripts from self and `https://connect.facebook.net` (Meta pixel);
- styles from self and fonts.googleapis.com; fonts from self and fonts.gstatic.com;
- images and `connect-src` from self and `https://www.facebook.com` (pixel beacons), `frame-ancestors 'none'`;
- plus `X-Frame-Options: DENY`.

The API routes are `no-store` and `no-referrer`.

## Tests

```sh
npm ci
npm run test:js        # node --test tests/js/*.test.mjs  (LOCAL/MOCK; Stripe-faithful synthetic fake)
npm run test:browser   # builds to .tmp/build, local harness, Chrome, desktop+mobile, SYNTHETIC provider
npm run test:pixel-browser  # Meta pixel + CAPI with a stubbed fbevents.js and recorded server events: sequence, live/test mode, 48 h window, concurrent tabs, Sec-GPC, origin, placeholder
npm test               # legacy Python preview tests (not evidence for the Vercel routes)
```

The synthetic fake mirrors these behaviours of Stripe and the TEST sandbox:
- saved first responses, including 500s;
- 409 for requests racing an in-flight key; 400 for parameter mismatch;
- rejection of `payment_method_types`;
- a dynamic method set when not filtered;
- the account display name "Individual".

**It is not Stripe.** Only a real create through the handler in the Stripe sandbox proves provider acceptance.

## Provider acceptance (what counts as "ready")

`configured: true` is not readiness. Accept a deployment only after, on that exact deployment:
1. A real `start` → `create` through the handler returns `redirect` to a `checkout.stripe.com` session.
2. A read-back of that session shows:
   - amount 10000 usd;
   - one line of the configured price;
   - `allowed_payment_method_types == ['card']` and `payment_method_types == ['card']`;
   - `branding_settings.display_name == 'Revivex'`;
   - metadata with purpose, terms_version and any utm_* labels.
3. The hosted page header reads Revivex, and only card and card-wallet options are offered.
4. In TEST: one test payment shows `confirmed` on the receipt; a Dashboard refund shows `refunded`; cancel and Back return to `#reserve`.
5. Function logs contain no email, name, key or token.

## Deploy (owner-run, after merchant verification and two reviews)

1. In the **verified Revivex** Stripe account, test mode: create a one-time $100 USD product and price and a restricted test key. Set the public business name to Revivex.
2. Set the variables above for **Preview only** (`STRIPE_MODE=test`; origin = the preview URL, which is then the canonical origin for that preview). Deploy a preview with `vercel` (not `--prod`).
3. Run the provider acceptance above on the preview.
4. Live: create the live product, price and restricted key. Add the Vercel Firewall rate-limit rule, and the Firewall challenge / bot protection rule on `POST /api/checkout` (the live control; the owner accepted the token-pool residual on 2026-10-13, see Rate limiting). Set **Production** variables, including `REVIVEX_LIVE_APPROVED_TERMS_VERSION=deposit-terms-v2`. Merge, then run `vercel --prod`.
5. Read back production:
   - `GET /api/checkout` shows `configured:true, mode:"live", siteOrigin` equal to the public origin;
   - served file hashes equal the merged commit;
   - provider acceptance steps 1–3 (an unpaid live session, expired afterwards) or an authorised controlled live deposit + refund, if separately approved.

## Rollback

- **Pause new deposits (preferred):** set `REVIVEX_CHECKOUT_ENABLED=false` and redeploy. The button disables and receipts still load for existing depositors.
- **Full code rollback:** promote the previous production deployment in Vercel. This restores the old log-only signup that falsely reported "saved", so prefer pausing.
- Existing deposits remain in Stripe. Refund from the Dashboard on request.
