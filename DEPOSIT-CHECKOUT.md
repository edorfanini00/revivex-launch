# Refundable $100 preorder deposit

Stripe-hosted Checkout in `payment` mode for a one-time $100 USD deposit. The deposit is fully refundable and is credited toward the final machine price. There is no automatic balance charge. Revivex is in development; the final price and shipping date have not been announced. The terms page is versioned `deposit-terms-v2`. v1 carried an unapproved refund cutoff, was never used for a real payment, and stays recognised only for lookups.

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

## Provider setup (scoped; no merchant-wide setting changes needed by the code)

- Payment methods are limited per session with `allowed_payment_method_types: ['card']`, documented for API `2026-09-30.endive`. That API version rejects `payment_method_types` (seen in the TEST sandbox). No payment method configuration is created or changed. Card must stay enabled in the account's Dashboard payment method settings.
- The hosted header shows `branding_settings.display_name = "Revivex"`. Per Stripe's docs this changes **only the top of the Checkout page**. The account's public business name still appears in the Checkout terms, on receipts and elsewhere. The TEST account currently reports `settings.dashboard.display_name = "Individual"` and `business_profile.name = null`. **The owner must set the public business name to Revivex** in the Dashboard (Settings → Business → Public details) for receipts and terms to read correctly. This code makes no account-settings writes.
- Receipt emails: Checkout sends a customer receipt only if the account's "Successful payments" email setting is on. The site does not rely on receipts (the reconcile copy points to card statements and support), but enabling them is recommended and should be verified in the sandbox.

## Rate limiting (limits stated honestly)

- In code: a per-instance, per-IP limit (20/min for checkout, 30/min for lookups) plus a per-instance ceiling across all callers that bounds Stripe call amplification even when IPs rotate. The checkout ceiling (120/min) counts only `create` requests that will call Stripe, after the token, age and binding checks; `start` (no Stripe call) has its own generous ceiling (600/min), so free requests cannot lock visitors out of checkout. The lookup ceiling (240/min) counts only well-formed session ids, each of which calls Stripe. Throttled entries are never reset early. Residual: 120 *valid* creates/min can still use up the checkout ceiling; the Firewall rule below is the control for that.
- Limits: the counters live in one warm function instance, so they are **not shared across instances or regions** and reset on cold start. Per-IP keys use `x-vercel-forwarded-for` / `x-real-ip` (IPv4: full address; IPv6: the /64 prefix, because one subscriber usually holds a whole /64), which Vercel overwrites at its edge to prevent spoofing (vercel.com/docs/headers/request-headers). That is not verified on a deployment here.
- **Required before live (not configured by this code):** a Vercel Firewall rate-limit rule on `/api/checkout` and `/api/reservation`, with IPv6 clients keyed equivalently (by /64), or confirm how Firewall keys IPv6.

## Security headers

All static responses, including `/reservation.html`, carry a CSP:
- `default-src 'self'`; scripts from self only;
- styles from self and fonts.googleapis.com; fonts from self and fonts.gstatic.com;
- `connect-src 'self'`, `frame-ancestors 'none'`;
- plus `X-Frame-Options: DENY`.

The API routes are `no-store` and `no-referrer`.

## Tests

```sh
npm ci
npm run test:js        # node --test tests/js/  (LOCAL/MOCK; Stripe-faithful synthetic fake)
npm run test:browser   # builds to .tmp/build, local harness, Chrome, desktop+mobile, SYNTHETIC provider
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
4. Live: create the live product, price and restricted key. Add the Vercel Firewall rate-limit rule. Set **Production** variables, including `REVIVEX_LIVE_APPROVED_TERMS_VERSION=deposit-terms-v2`. Merge, then run `vercel --prod`.
5. Read back production:
   - `GET /api/checkout` shows `configured:true, mode:"live", siteOrigin` equal to the public origin;
   - served file hashes equal the merged commit;
   - provider acceptance steps 1–3 (an unpaid live session, expired afterwards) or an authorised controlled live deposit + refund, if separately approved.

## Rollback

- **Pause new deposits (preferred):** set `REVIVEX_CHECKOUT_ENABLED=false` and redeploy. The button disables and receipts still load for existing depositors.
- **Full code rollback:** promote the previous production deployment in Vercel. This restores the old log-only signup that falsely reported "saved", so prefer pausing.
- Existing deposits remain in Stripe. Refund from the Dashboard on request.
