# V2 landing delivery

Local preview: http://127.0.0.1:4178 (no publication, DNS or storefront changes).

## Changed
Rebuilt public/index.html and styles.css around a full-width cinema stage, restrained lower-left copy, one light editorial section, a different control close-up, compact signup and FAQ. Original typography file retained; no giant repeating headings/card grid/repeated full render. app.js preserves the signup implementation and adds opt-in v2 media with reduced-motion handling, pause and native dialog focus restoration.

## Current media state — still-based interim, NOT finished film
New actual film-v2 render `film-v2/qa/approved-look-0045.png` supplies hero-v2.webp and a separately cropped mobile hero. Control close-up derives from `film-v2/qa/repaired-0120.png`. These are real v2 assets with a handled ceramic mug, not the rejected v1 cylinder-cup footage. Both were visually inspected. No v1 video is shown.

The v2 film exports were not yet present at final verification. Do not claim the page currently plays the new film. Playback buttons remain hidden until real assets are integrated. Once the film worker finishes:

```
cd /Users/edorfanini/Projects/revivex-appliance-launch/site
python3 scripts/integrate-v2.py
npm run build
npm run qa
node scripts/media-qa.mjs
```

The integrator requires `film-v2/export/hero-loop.mp4` and `film-v2/export/revivex-appliance-preview-v2.mp4`, fully decodes both before copying, writes explicit v2 filenames and provenance hashes, and never falls back to v1. Keep the existing dark hero still rather than replace it with an arbitrary film poster. Inspect the actual moving composition on both viewport sizes after integration; do not infer visual acceptance from media tests alone.

## Verification executed
- npm test: 3 existing suites/tests passed: SQLite validation/persistence/dedup/consent, real HTTP restart/security/rate limiting.
- npm run build: passed.
- npm run qa: 1440, 390 and 768px; no overflow; loaded font/images; keyboard skip, tab order and visible focus; reduced motion; FAQ; privacy; invalid-email/required-consent rejection; real signup/duplicate success; simulated network failure feedback. No unexpected browser errors.
- node scripts/media-qa.mjs: 1440/390 × normal/reduced motion passed for actual still state, hidden unavailable video controls, loaded v2 images. Playback branch exists but has NOT run with the pending real film.
- Original SQLite records compared by full tuple to consistent backup: all preserved (1 original, 1 current). No live user emails printed. Backend/security/old tests unchanged.
- Visually reviewed exact final screenshots: `evidence/v2-final-desktop-1440.png`, `v2-final-desktop-390.png`, `v2-final-full-1440.png`, `v2-final-full-390.png`, and signup capture. These final names distinguish the dark composition from the earlier brighter experiment.

## Research + preservation
Research source links, specific lessons, and limitations: ../research-page-v2/RESEARCH.md. Linc desktop/mobile actual screenshots and DOM; Jack Roberts verified author/title, full transcript, decoded visual frames. Browser YouTube seeks were black, recovered with downloaded video-only source and ffmpeg frames; no false claim of watching the whole video.
Previous site/public + screenshots + consistent SQLite backup: ../research-page-v2/previous-site/ (not served by the static allowlist). No competitor assets enter public/.

## Visual critique / limits
Dark frame improves the empty-space balance and keeps the metal hardware distinct; mobile uses an intentional portrait crop rather than shrinking a landscape frame into a tiny strip. There is no independent visual approval; the result remains a review candidate. The hero image and macro are concept renders, not photography or working prototype proof. Motion/film acceptance awaits real exports.
