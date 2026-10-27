# Round 3 test changes

Every change to a test file in `feat/r3-photo-rebuild`, with the reason. No behavioural assertion was deleted. Checkout, pixel, terms, receipt and route tests are otherwise unchanged; `tests/browser/meta-pixel-browser.mjs` is identical to origin/main.

## 1. `tests/js/fix-r1-regressions.test.mjs`: hero subtitle copy

- **Before:** pinned the old hero subtitle markup, `<p class="hero-sub reveal-now">Designed to read your sleep, recovery and biomarker data overnight. …</p>`.
- **After:** pins the new subtitle, `<p class="hero-sub">Revivex is a countertop machine designed to read your wearable and lab data through the Revivex app, then pour your daily supplement&nbsp;drink.</p>`, and, after the parent review moved the legal line out of the hero, requires the preorder card's development statement (`<p class="cta-lede">Revivex is in development. The final price and shipping date have not been announced.</p>`).
- **Why:** the redesign intentionally replaces the hero copy. The test still checks the same thing, that the hero copy is qualified as design intent ("designed to"), and it now also requires the in-development statement.

## 2. `tests/browser/deposit-browser.mjs`: hero copy and markup that the redesign replaces

1. **Headline:** `HERO_H1` changes from `'Your supplements, blended every morning'` to `'Let your data fill the glass.'`, the new verb-led headline.
2. **Hero media:** the scroll-scrubbed canvas and its poster (`#heroCanvas`, `img.hero-fallback[src="/assets/v11/hero-poster.jpg"]`) are gone. The page uses one full-bleed photo. The check now requires that photo (`.hero-media img.hero-img` from `/assets/r3/hero-d-…`), "designed to" in the hero subtitle and the development statement in the preorder card.
3. **Hero load under CSP:** "hero frame sequence still loads under CSP" waited for the canvas `ready` class. It now waits for the hero photo to decode (`complete && naturalWidth > 0`, `currentSrc` under `/assets/r3/hero-…`) on both desktop and mobile. That is a stronger check, because it previously ran on desktop only.
4. **Headline clears the machine (layout block, same six viewports, same minimum gaps):**
   - **Before:** computed the machine's left edge from the old 1600x900 poster's geometry (`MACHINE_LEFT_X = 942`, canvas focus 0.64) and compared it with the headline's right edge.
   - **After:** derives the machine box from the hero image that is actually rendered:
     - the desktop photo `hero-d`, machine at x 978 to 1383 and y 234 to 770 of 1672x941;
     - or the portrait photo `hero-m` on phones and tall viewports, machine at x 345 to 830 and y 740 to 1385 of 941x1672;
     - its box on screen and its `object-fit` / `object-position`.
   - It then checks that every headline glyph rectangle stays at least `minGap` px clear of the machine box, either beside it or above it. At 1024x1366 the portrait photo puts the headline above the machine, which a horizontal-only check cannot express.
   - **Added:** an assertion that the hero crop keeps the whole machine inside the hero frame.
   - **Unchanged:** the nav, container alignment, overflow and wide-screen container assertions in this block.

**Not changed:** all assertions on:

- the four Preorder buttons;
- the busy spinner and "Opening checkout…" (and "Opening…" on mobile for the nav and hero);
- no scroll and no hash change;
- one operation per burst of keys and clicks;
- the canonical link next to the button on the alias host;
- fail closed when unconfigured;
- the disabled section button and the "needs JavaScript" notice without JavaScript;
- reveal behaviour;
- the receipt, terms, privacy and CSP.

## 3. `tests/browser/meta-pixel-browser.mjs`: not changed (identical to origin/main)

The C1 probe still fails. C1 opens 8 receipt tabs at once and requires exactly one Purchase. It fails the same way on `origin/main` (`e5dbeec`), so the failure is pre-existing and this redesign does not cause it. The file is byte-identical to `origin/main`.

**Evidence:**

- **Earlier rounds on a clean detached `origin/main`:**
  - PROGRESS.md round 2: "Main branch independently reproduces pixel 8-tab timeout".
  - Round 1: "pixel browser suite times out in its 8-tab concurrent fixture".
- **This branch, unmodified test:** checks 1 to 29 pass (home, InitiateCheckout, Back and retry, unpaid, test-mode and live receipts, S1). The run then stops in C1 at `page.goto` and was killed after more than 10 minutes with no further output.
- **Diagnosis (probe, not committed):** the 6-connection-per-origin explanation from round 1 is wrong. All 8 lookups do reach the route barrier, which releases at about 2.9 s. The run still stalls with no barrier and no routes at all, so the fixture's own synchronisation doesn't cause it.
  - With 8 tabs in one context, headless Chrome 155 dispatches network requests only for the foreground tab.
  - The other 7 tabs' `/api/checkout` and `/api/reservation` fetches stay pending inside the browser, and the harness answers a direct request in 3 ms.
  - Calling `bringToFront()` on a stalled tab completes its requests at once.
  - Cycling `bringToFront()` across the tabs made all 8 confirm, with exactly one Purchase.
- **That fixture fix is not committed.** It was reverted on the owner's instruction to time-box the investigation; it is recorded here for follow-up.
- **Every other pixel check passes:** a temporary, uncommitted copy of the test with only the C1 block removed gives `46/46 pixel browser checks passed`.

## 4. Documentation fix that makes an existing test pass (no test file changed)

- **Symptom:** `tests/js/fix-r3-regressions.test.mjs` "R3-1: runbook does not claim a per-IP Firewall rule controls distributed floods" fails on `origin/main` (`e5dbeec`), with 155/156. Reproduced in a clean detached main worktree.
- **Cause:** the runbook sentence the test expects ("per-IP … does not stop or control … distributed") lost the word "distributed" in an earlier edit.
- **Fix:** `DEPOSIT-CHECKOUT.md` now reads "does not stop or control this distributed pattern". The meaning is unchanged; the paragraph describes the distributed token-pool residual.
