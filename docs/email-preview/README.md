# Revivex email previews

These are local Chromium renders of the two actual templates, with synthetic customer data. They are design evidence, not proof of hosted image availability or native email client rendering. The HTML keeps production asset URLs; the renderer substitutes local files only while capturing screenshots.

Run `node scripts/crm/render-email-previews.mjs /tmp/revivex-email-previews` to reproduce all eight captures. The renderer asserts viewport width, no horizontal overflow, and every local image loaded; the manifest records HTML hashes and color modes.

## Screenshots

- Confirmation: [375 light](preorder-confirmation-375-light.png), [375 dark](preorder-confirmation-375-dark.png), [600 light](preorder-confirmation-600-light.png), [600 dark](preorder-confirmation-600-dark.png).
- Welcome: [375 light](welcome-375-light.png), [375 dark](welcome-375-dark.png), [600 light](welcome-600-light.png), [600 dark](welcome-600-dark.png).
- Before and after: [confirmation](compare-preorder-confirmation.png), [welcome](compare-welcome.png).

## Design and asset source

Reference: five real Apple transactional emails already saved in the owner's private campaign evidence: Apple Store gift card and dispatch (July 2023), Online Personal Session (November 2023), Apple receipt (September 2026), and subscription confirmation (June 2026). Their personal order data and raw messages stay outside this public repository. The design follows their whitespace, sentence headings, plain rows and quiet footer while retaining Revivex branding.

The machine comes from the campaign's canonical `apple-film/keyframes/A11.png`. The existing background extraction is preserved: original geometry, screen and contact shadow, on a transparent 1200 × 920 canvas. This export preserves the full alpha channel and compresses RGB channels to 48 levels to avoid the old indexed-alpha shadow bands. No generative machine edits. The source image and extraction intermediates remain in the campaign evidence.

## Compatibility and release limits

The 600px layout uses tables and inline styles, with an MSO width wrapper and ordinary text links. Apple Mail dark mode uses `prefers-color-scheme`; Outlook web selectors have dark overrides. Gmail/Outlook transformations and native Apple Mail rendering still need client testing; Chromium color-mode captures cannot establish those results.

The machine URL returned HTTP 404 on October 13, 2026 before deployment. Both wordmarks returned HTTP 200. Customer sending must wait for an approved deployment and an actual public PNG load. No deployment, migration, provider configuration change or production data write is part of this email commit. The confirmation retains the current deposit terms' unlimited refund promise rather than introducing a shipping cutoff. Subjects, renderer entry signatures, signed unsubscribe links, headers and sending/idempotency code stay unchanged.

To roll back only the design, restore `lib/email/` from `5f05784` and keep the new image available for already-delivered messages. Do not undo CRM migrations to roll back email styling.
