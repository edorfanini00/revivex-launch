# Verified local handoff

- [x] Scope isolated to site/; no shop, app, source CAD, domain or production deployment changes.
- [x] Live Ultrahuman desktop and 390px reference inspected; principles transformed, not cloned.
- [x] Approved actual v9 render used; original design-authority retained untouched.
- [x] v9 RESULTS and v7 README/CLOSURE read; latest v11 steering honored.
- [x] Original dark/white editorial Decide/Learn page, local font, responsive media, intended-feature copy.
- [x] SQLite saved signup: validation, consent, dedup, UTC timestamp/source, honeypot, origin/token/rate protections.
- [x] Truthful local-preview privacy page; no outgoing email or subscriber upload.
- [x] `npm run build` passed: standalone assets and Python server in dist/.
- [x] `npm test` passed: 3 tests covering actual storage and built-server HTTP/restart/security behaviors.
- [x] `npm run qa` passed: 1440px/390px screenshots, 768px overflow, image/font loading, normal/reduced motion, keyboard focus, form errors/success/duplicate/network failure, FAQ/privacy.
- [x] Real DB readback: exactly one synthetic QA row, `browser-qa@example.test`, consent 1, source appliance-early-release. Tests for HTTP restart use temporary isolated databases.
- [x] Final live health readback: http://127.0.0.1:4178/api/health → ok true, PID 64558.
- [x] Desktop, full desktop, mobile, mobile signup screenshots visually inspected. No overlap or horizontal overflow observed. Mobile concept disclosure increased to 11px after inspection.

## Preview

http://127.0.0.1:4178/ (loopback only)
http://127.0.0.1:4178/#early-access
http://127.0.0.1:4178/privacy
Server PID: 64558. Background tool session: proc_e0da582adbd4.

## Evidence files

- evidence/desktop-1440.png — primary desktop
- evidence/full-1440.png — full composition
- evidence/desktop-390.png — mobile hero
- evidence/full-390.png — full mobile
- evidence/signup-390.png — form default
- evidence/signup-success-390.png — actual persisted form response
- evidence/signup-error-390.png — simulated network failure feedback
- evidence/browser-qa.json — browser acceptance report

## Remaining / integration

Film integration deliberately deferred: actual poster is live and no video URL is referenced. See VIDEO-INTEGRATION.md. No public launch authorized. Public-hosting privacy/business identity, persistent deployment, security and email/unsubscribe provider gates are listed in README.md. No fabricated email delivery or hardware completion claimed.

## Reusable workflow lesson (saved locally within ownership)

For an engineering-concept appliance landing page: bind artwork to the approved assembled render before copywriting; distinguish intended metering/blending from validated hardware; make signup a server-committed opt-in, not a console-only demo; verify restart persistence against the actual built server; keep film slots poster-only until a verified export exists; isolate public launch and email activation as separate authorization gates.
