# Test changes: deposit checkout CTA replaced by the early access signup

Every test that pinned the home page's deposit CTA now asserts the signup behaviour instead. Tests of the checkout API, the receipt (`/reservation.html`, `/api/reservation`) and the legal pages are unchanged or kept, so they still prove the routes existing depositors rely on.

## New

- `tests/js/waitlist.test.mjs` (18 tests, PGlite Postgres in memory): strict email validation; ISO country list (249 codes, names without dashes); additive, idempotent migration; stored columns; 400 for an invalid email, unknown country and malformed body; honeypot (400, nothing saved, mailed or measured); idempotent repeat and concurrent signups (one row, one welcome email, one Lead, first-touch attribution kept); Resend request with the unsubscribe link and `List-Unsubscribe`/`One-Click` headers; email 5xx or network failure still answers ok and logs no address; never ok before a commit (database error, missing table, missing configuration); database-backed per-IP rate limit shared across handler instances; cross-origin and wrong methods refused; GET country hint; server Lead (same event id as the response, hashed email, ip/ua/fbp/fbc); no server Lead with GPC or outside production; unsubscribe GET and one-click POST, bad and unknown tokens, signing up again clears `unsubscribed_at`; UTM allowlist; logs carry no email, token or IP.
- `tests/fixtures/pglite-db.mjs`: the PGlite test database behind the same `{ query }` shape as the Neon driver, with failure injection.
- `tests/browser/site-browser.mjs` (replaces `tests/browser/deposit-browser.mjs`; `npm run test:browser` points to it), desktop 1440x900 and mobile 390x844:
  - page unchanged apart from the CTA: hero headline, hero canvas and poster, layout container checks at six widths (kept from the old suite);
  - CTA labels (nav "Get early access", the rest "Join the waitlist"), `#waitlist` no-JS fallback, no checkout control, no $50/20% off/refundable/Preorder claims in the copy or meta, waitlist section and FAQ copy, honesty lines kept;
  - the modal opens from every CTA (nav, hero, mid, section) by click, plus Enter and Space on the links; backdrop blur and dim, scroll lock, `inert` page, no hash jump; Escape, backdrop click and the X close it and focus returns to the CTA;
  - focus trap (Tab x9 stays inside, Shift+Tab wraps);
  - card geometry (960x568, 12px radius, #18191B on desktop; 330px, no image on the phone);
  - invalid email and missing country are rejected inline and nothing is sent; a server-rejected email shows the server's error;
  - a 503 and a network error show an error, no success, no row;
  - success only after the 200 (the response is held: loading state, no success; released: success replaces the form); one request despite repeated clicks; stored row (email, country, source, UTM, consent version, hashed IP); one server Lead; one welcome email with the unsubscribe link;
  - repeat signup: success, no duplicate row, email or Lead; the unsubscribe link sets `unsubscribed_at`;
  - phone with the keyboard open (390x430): card inside the visible area, scrolls inside, submit reachable, country search usable;
  - no horizontal overflow at 390 and 1440 (page, open modal, success state);
  - without JavaScript the CTA leads to the waitlist section, which says joining needs JavaScript;
  - kept for existing deposits: confirmed $50 receipt, disputed, query params cannot fake payment, historical $100 receipt and its refund, all legal pages served without a refund cutoff, terms v3, `GET /api/checkout` probe unchanged; unconfigured build: checkout 503, signup 503 shows an error in the modal and never success, legal pages show the official contact without overflow.
- `tests/js/meta-pixel.test.mjs`: `Lead` uses the server event id, is sent once per id and never for a malformed id; no `initiateCheckout` method remains; the Lead hook sits only in the success path of `signup.js`.

## Changed

- `tests/js/direct-checkout.test.mjs`: "section button starts disabled", "all four Preorder buttons are marked for checkout" and "offer, footer links and functional messages remain" now assert no checkout control or deposit offer on the home page, the four `data-signup` CTAs with their labels and `#waitlist` fallback, the nav CTA standing alone, footer links, the waitlist FAQ and the `#reserve` alias (Stripe `cancel_url`). The server contract tests in the file are unchanged.
- `tests/js/fix-r1-regressions.test.mjs` (refund cutoff): the offer wording is checked on the deposit terms only; the home page must no longer contain $50, 20% off or refundable.
- `tests/js/fix-r2-regressions.test.mjs` (refund instruction): checked on the terms and receipt; the home page FAQ must no longer carry a refund instruction.
- `tests/js/price50.test.mjs`: the app.js offer_changed check became "the home page no longer runs the checkout client" (server copy checks kept); "page, terms and receipt agree" now requires the home page to carry no offer attributes; terms and receipt checks kept.
- `tests/js/stripe-rest-and-routes.test.mjs`: the legacy signup stub test now runs the real signup export without a database (503, "Nothing was saved", no address logged); route table checks include `/api/unsubscribe` and the no-store headers on `/api/signup` and `/api/unsubscribe`.
- `tests/js/meta-pixel.test.mjs`: home `ViewContent` carries the waitlist label without the deposit value; the placeholder and GPC cases call `lead` instead of `initiateCheckout`; the InitiateCheckout event id test was replaced by the Lead test above; the page hook test asserts that app.js never announces a checkout.
- `tests/browser/meta-pixel-browser.mjs`: the home flow is now signup → browser Lead exactly once with the server's event id → one server Lead → repeat signup sends nothing; "a failed start sends no InitiateCheckout" became "a failed signup (503, network) sends no Lead and the retry sends exactly one". Receipt sessions are created through the unchanged checkout API (`checkoutViaApi`) instead of the removed home page button; GPC and placeholder runs also check that signup works. The 8-tab C1 case is wrapped so its timeout is recorded as that case's failure and the rest of the suite still runs (before, the uncaught timeout ended the run).
- `tests/harness/local-harness.mjs`: synthetic mode runs the real signup and unsubscribe handlers on PGlite with recorded Resend and Meta transports (`/__synthetic/signups`, `/emails`, `/signup-db-fail`, `/reset-signups`); unconfigured mode also clears database, Resend and Meta variables.
- `DEPOSIT-CHECKOUT.md`: one sentence now says the per-IP rule "does not stop or control this distributed pattern", which makes the R3-1 doc test (`tests/js/fix-r3-regressions.test.mjs`) pass. It also failed on origin/main.

## Removed

- `tests/browser/deposit-browser.mjs`: its home page checkout cases (busy labels, start/create from each Preorder button, double clicks, Back and retry, uncertain and reconcile messages, storage blocked, alias host, the cached $100 page, offer_changed from a stale tab, no-JS `#reserve`) tested UI that no longer exists. The checkout and reservation API behaviour behind them is still covered by `tests/js/checkout-handler.test.mjs`, `price50.test.mjs`, `fix-r*-regressions.test.mjs` and `reservation-handler.test.mjs`; the receipt, legal and layout cases moved to `site-browser.mjs`.

## Known failure

- `npm run test:pixel-browser`, C1 (8 simultaneous receipt tabs): times out on this machine, as on origin/main. It is the only failing case.
