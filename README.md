# Revivex appliance early-release preview

Primary surface: **Decide / Learn**. Product reveal → intended experience → interest signup. This is a separate appliance site, not the Revivex commerce shop or app.

## Run

```sh
cd /Users/edorfanini/Projects/revivex-appliance-launch/site
npm install
npm run build
npm test
npm start
# http://127.0.0.1:4178
npm run qa
```

Runtime is Python 3 standard library (HTTP + SQLite); no runtime npm packages. `npm install` installs only the browser QA dependency. `dist/` is a standalone built copy; run `python3 dist/server.py` to serve it (its default DB is separate under dist/data). Use `REVIVEX_DB=/absolute/path/signups.sqlite3` to choose persistence. Never replace a database during a rebuild. Default server binds loopback only, not LAN/public interfaces.

## Actual behavior

POST `/api/signup` persists email, consent=true, UTC consent timestamp and fixed source `appliance-early-release`. Server-side validation, normalized email deduplication (unique primary key), same-origin request enforcement, 1-second minimum/30-minute form token, single-use token, honeypot, 4KB payload bound, and 8 submission attempts/minute/IP. Rate counters and token data are transient memory only; no request-body or access logging. Identical saved/already-saved message prevents direct duplicate disclosure in the UI. Responses differ 201/200 and should be unified before exposure if enumeration resistance is required. No email delivery or subscriber upload exists.

Form success is only shown following successful server storage. Pending, validation, server/network-error and success states are accessible. No-JS users get an explanation; forms require JS. Native required email/consent checks complement server validation. Data remains until the local operator deletes it; no automatic retention schedule is claimed.

## Tests / evidence

`npm test`: actual temporary SQLite writes, invalid email, consent, honeypot, duplicate, HTTP origin gate, missing/too-fast/reused token, rate limit, inaccessible database/source paths, built-server restart and exact row equality.

`npm run qa`: local installed Chrome through Playwright; desktop 1440px and mobile 390px, no horizontal overflow, local image/font load, visible keyboard skip link, reduced motion, FAQ and privacy, real form saved/duplicate/validation and simulated network interruption. Synthetic address only: `browser-qa@example.test`. QA reads the actual saved record separately. Evidence screenshots and report in `evidence/`.

## Source and claims

Supplied source: `ReviveX-machine-research/consumer-rebuild-v1/appearance-restoration-v9/visuals/03-restored-v9-L2-CPU.png`, matched `.blend`; derived WebP retains the actual appearance. Original authority is `design-authority/authoritative-v3.blend`. No fake device drawings or third-party product imagery. The render is an engineering visualization, not a photograph or proof of finished operation.

Read: appearance-restoration-v9/RESULTS.md; coordinated-handoff-v7/README.md and CLOSURE.md. Later instruction: v11 ingredients are an unapproved qualification backlog; installed-channel count and matched compact mixer are unselected. No channel count, cartridge count, medical result, performance guarantee, dates, pricing, or lab/wearable-driven dosing is advertised. Metering, refillable tank/no plumbing and internal blending into a passive cup are **intentions**, not demonstrated performance. Avoid cleaning-automation claims because v9 changes are unresolved.

Reference inspected live: https://www.ultrahuman.com/us/ at desktop and 390px mobile. Principles: product as the main visual, large calm type, sparse navigation, single dominant CTA, strong scale contrast, mobile reorder. Not copied: brand, ring/charger imagery, blue CTA, claimed performance, or layout. Current reference is a warm cream product scene, not falsely described as dark. Revivex's graphite direction follows the user's explicit request. Manrope is locally hosted with OFL license.

## Publication gates

NO deployment, DNS, production domains or mailing systems were touched. This is intentionally loopback-only. Before publication: approved business/controller identity, privacy contact, data retention/deletion/unsubscribe procedure, HTTPS, persistent hosting/backups, durable distributed abuse protection if scaling, and explicit authorization to send emails or export data. Review final copy and artwork as concept advertising. Do not simply proxy this development HTTP server to the public internet.

## Film integration

See `VIDEO-INTEGRATION.md`. Until a real finished film exists, the site uses the real device poster only; no empty/broken video source or pretend play control.

## Local design audit

No gradient, generic accent color, feature-card grid, glass blur, fake metric, icon topper or center-stack template. The feature list is a quiet numbered editorial sequence; number labels are ordering, not metrics. Manrope chosen for a light geometric industrial tone. Main screenshot verified; hardware geometry itself is not changed. Accessibility relies on semantic landmarks, native inputs/details, white focus ring, live status, explicit labels and reduced-motion preference.
