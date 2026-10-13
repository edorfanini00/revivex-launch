// The one place the Meta pixel (dataset) id lives. It is public, not a secret.
// Imported by the browser pixel (public/meta-pixel.js) and the server Conversions API
// (lib/meta-capi.js). Set it to 'REVIVEX_PIXEL_ID_PLACEHOLDER' to switch both off.
export const META_PIXEL_ID = '1403965125138676';
// The browser pixel starts only on this origin (the production REVIVEX_SITE_ORIGIN), so
// previews, deployment aliases and local copies never send to the live dataset.
export const META_PIXEL_ORIGIN = 'https://reserve.healthrevivex.com';
