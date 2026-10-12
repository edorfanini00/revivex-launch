# Refundable $100 preorder deposit

Stripe-hosted Checkout in `payment` mode for a fully refundable $100 USD deposit, applied to the final machine price, with no automatic balance charge. Revivex is in development; the final price and shipping date have not been announced.

**Default state: off.** With no configuration, the reserve button is disabled, `POST /api/checkout` returns 503 `unavailable` and no Stripe request is made.

## How it works

1. `GET /api/checkout` returns availability, test/live mode, the fixed amount and the terms version. It makes no Stripe call.
2. `POST /api/checkout {step:"start"}` returns a signed operation token (HMAC). The token holds a random id, the issue time, a digest of the account, mode, price, product, terms version and site origin, plus allowlisted UTM labels. This step makes no Stripe call. The browser keeps the token in `sessionStorage`.
3. `POST /api/checkout {step:"create", operation}` verifies the token, then checks the merchant: the account id is pinned and `charges_enabled` must be true. It also checks the price: exactly $100 USD, one-time, active, no other currencies, and the expected product. It then creates the Checkout Session with an idempotency key derived only from the token, and redirects only to a `https://checkout.stripe.com/` URL.
   - Retrying the same token replays the same session: double clicks, a timeout, Back from Stripe, a reload.
   - A token older than 23 hours (inside Stripe's 24h idempotency retention) is never re-sent to Stripe. The same applies if the price, product, account, terms or origin changed, or if Stripe returns `idempotency_error`. In those cases the visitor is asked to check for a Stripe receipt first and contact support@revivex.store if needed. Only an explicit click starts a new reservation.
4. `GET /api/reservation?session_id=` retrieves the session from Stripe. It checks the account, mode, amount, currency, metadata, terms version, line item, PaymentIntent and charge. It returns only the state, the amount and the PaymentIntent reference.
   - States: `confirmed`, `processing`, `not_completed`, `expired`, `refunded`, `partially_refunded`, `disputed`, `not_recognized`, `not_found`.
   - Query parameters are never evidence of payment.

There is **no webhook and no fulfillment**. Stripe is the deposit ledger. Session and PaymentIntent metadata carry `purpose=revivex_preorder_deposit`, `terms_version`, `operation` and any `utm_*` labels. A paid deposit is not an order, a shipment, a queue position or an email signup. Refunds are manual, from the Stripe Dashboard, after an email to support@revivex.store.

The legacy `/api/signup` now always returns 503 "Nothing was saved" and logs nothing. The free waitlist remains unconfigured.

## Environment (Vercel, per environment; never in code)

| Name | Value |
| --- | --- |
| `REVIVEX_CHECKOUT_ENABLED` | `true` to allow new deposits (kill switch) |
| `STRIPE_MODE` | `test` or `live`; must match the key prefix |
| `STRIPE_SECRET_KEY` | Restricted key (`rk_…`) preferred. Needs write on Checkout Sessions; read on Prices, Products, PaymentIntents and Charges; plus whatever lets `GET /v1/account` succeed. Confirm all of these in the sandbox. |
| `STRIPE_EXPECTED_ACCOUNT_ID` | `acct_…` of the verified Revivex merchant |
| `STRIPE_DEPOSIT_PRICE_ID` | `price_…`: one-time, 10000 USD, no `currency_options` |
| `STRIPE_DEPOSIT_PRODUCT_ID` | `prod_…` the price belongs to |
| `REVIVEX_SITE_ORIGIN` | e.g. `https://revivex-launch.vercel.app` (exact origin, https) |
| `REVIVEX_OPERATION_SIGNING_SECRET` | ≥32 random characters, e.g. `openssl rand -base64 48`. Rotating it invalidates in-flight attempts; those visitors get the reconcile message. |
| `REVIVEX_LIVE_APPROVED_TERMS_VERSION` | live only: `deposit-terms-v1` after terms, merchant identity, refund handling and tax/jurisdiction sign-off |

## Tests

```sh
npm ci
npm run test:js        # node --test tests/js/  (LOCAL/MOCK handler + REST tests)
npm run test:browser   # builds to .tmp/build, local harness, Chrome, desktop+mobile, SYNTHETIC provider
npm test               # legacy Python preview tests (not evidence for the Vercel routes)
```

The browser test intercepts every `checkout.stripe.com` navigation and serves a page labelled SYNTHETIC. None of these tests is Stripe sandbox evidence.

## Deploy (owner-run, after merchant verification and two reviews)

1. In the **verified Revivex** Stripe account, sandbox/test mode: create the product and a one-time $100 USD price, and a restricted test key. Optionally enable receipt emails for successful payments.
2. Set the variables above for **Preview only** (`STRIPE_MODE=test`, origin = the preview URL). Deploy a preview with `vercel` (not `--prod`).
3. Sandbox acceptance on the preview, using Stripe test cards:
   - pay and see the receipt `confirmed`;
   - check the Dashboard readback: amount, metadata and `utm_*`;
   - refund in the Dashboard and see `refunded`;
   - use a dispute test card and see `disputed`;
   - cancel and Back;
   - double click;
   - confirm the function logs contain no email addresses.
4. Live: create the live product, price and restricted key. Set **Production** variables, including `REVIVEX_LIVE_APPROVED_TERMS_VERSION`. Merge, then run `vercel --prod`.
5. Read back production:
   - `GET /api/checkout` shows `available:true, mode:"live"`;
   - served `index.html`, `app.js` and `deposit-terms.html` hashes equal the merged commit;
   - an authorised controlled live deposit + refund, if separately approved.

## Rollback

- **Pause new deposits (preferred):** set `REVIVEX_CHECKOUT_ENABLED=false` and redeploy. The button disables and receipts still load for existing depositors (Stripe variables kept).
- **Full code rollback:** promote the previous production deployment in Vercel. Note that this restores the old log-only signup that falsely reports "saved", so pause checkout instead where possible.
- Existing deposits remain in Stripe. Refund from the Dashboard on request.
