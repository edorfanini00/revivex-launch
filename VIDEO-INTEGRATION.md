# Integration contract for the finished appliance film

Incoming file (not assumed to exist):
`../film/export/revivex-appliance-preview.mp4`

The site currently has **no video src**. It uses the supplied actual v9 device image. This prevents broken media requests and fake player behavior.

1. Parent must first inspect the final export with ffprobe and sample frames, checking the approved original/v9 appearance and no unsupported ingredient/clinical/performance copy.
2. Copy only the approved export to `public/assets/revivex-appliance-preview.mp4`. Do not mutate the film worker's files.
3. Replace the content of `#film-slot` in `public/index.html` with a real `<video controls playsinline preload="metadata" poster="/assets/appliance-v9.webp" aria-label="Revivex appliance concept film"><source src="/assets/revivex-appliance-preview.mp4" type="video/mp4"></video>` and retain a visible concept label. Keep `#film-title` heading outside the player so section aria-labelledby remains valid.
4. Add `.film-poster video{display:block;width:100%;height:100%;object-fit:contain;background:#0b0c0c}`. If the finished video has different ratio, use `aspect-ratio` and `height:auto` instead of cropping the approved device. Do not add autoplay. User-operated playback naturally respects reduced-motion intent; do not auto-loop.
5. If narration/audio conveys information not already on the page, include a transcript and captions with the video.
6. Run `npm run build`, `npm test`, `npm run qa`; add browser play/pause, loadedmetadata, error handling, network 200 and desktop/mobile screenshot tests. Verify HTTP serving of the finished asset. This preview server does not implement range streaming; for a large video use an appropriate production static server only when hosting is authorized.
7. Stay local. A working video does not authorize publishing the site or changing any existing domain.
