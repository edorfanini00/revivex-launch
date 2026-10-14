// Shared building blocks for Revivex emails: escaping, palette and a table layout that
// renders in Gmail, Apple Mail, iOS Mail and Outlook (inline CSS, 600px max, text links).
// Light by default; clients that honour prefers-color-scheme get a deliberate dark version.
import { COMPANY_ADDRESS, EMAIL_ASSET_ORIGIN } from '../crm-config.js';
import { SUPPORT_EMAIL } from '../deposit-config.js';

export const C = Object.freeze({
  page: '#FFFFFF',
  ink: '#1D1D1F',
  ink2: '#6E6E73',
  line: '#D2D2D7',
  band: '#F5F5F7',
  link: '#0066CC',
});
// Dark counterparts, applied through classes in the dark mode style block.
const D = Object.freeze({ page: '#000000', ink: '#F5F5F7', ink2: '#A1A1A6', line: '#424245', band: '#161617', link: '#2997FF' });
export const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Helvetica,Arial,sans-serif";
export const DISPLAY = "-apple-system,BlinkMacSystemFont,'SF Pro Display','Helvetica Neue',Helvetica,Arial,sans-serif";

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => HTML_ESCAPES[c]);

// Only https URLs (or our own http loopback in tests) ever reach an href/src.
export function safeUrl(u) {
  try {
    const url = new URL(String(u));
    if (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) return url.toString();
  } catch { /* fall through */ }
  return 'https://reserve.healthrevivex.com/';
}

export const asset = path => `${EMAIL_ASSET_ORIGIN}${path}`;

// A first name fit for a greeting: first word of the name, letters only, short.
export function greetingName(name) {
  const first = (String(name || '').trim().split(/\s+/)[0] || '').normalize('NFC');
  // Anything that is not plainly a name (markup, digits, symbols) gets the generic greeting.
  return first.length <= 40 && /^\p{L}[\p{L}\p{M}'’.-]*$/u.test(first) ? first : '';
}

export function formatDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
}

export const money = (cents, currency = 'usd') => `$${(Number(cents) / 100).toFixed(2)}${currency.toLowerCase() === 'usd' ? '' : ` ${currency.toUpperCase()}`}`;

// Only the fixed support address may use mailto. User-supplied URLs stay HTTPS-only.
const linkUrl = href => href === `mailto:${SUPPORT_EMAIL}` ? href : safeUrl(href);

// Inline text link in the body copy.
export const link = (href, label) => `<a class="lk" href="${esc(linkUrl(href))}" style="color:${C.link};text-decoration:none;">${esc(label)}</a>`;

// Wordmark at the top left, swapped for the light version in dark mode.
const wordmark = () => {
  const img = (file, cls) => `<img class="${cls}" src="${esc(asset(`/assets/brand/${file}`))}" width="85" height="12" alt="Revivex" style="width:85px;height:12px;color:${C.ink};font-family:${FONT};font-size:15px;font-weight:600;">`;
  return `${img('logo-dark.png', 'lm')}<!--[if !mso]><!--><div class="dm" style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${img('logo-light.png', 'dmi')}</div><!--<![endif]-->`;
};

// The machine alone on a transparent background, so it sits on white or on black.
export function heroImage({ alt }) {
  return `<img src="${esc(asset('/assets/email/revivex-machine.png'))}" width="600" height="460" alt="${esc(alt)}" style="width:100%;max-width:600px;height:auto;aspect-ratio:1200/920;color:${C.ink2};font-family:${FONT};font-size:13px;">`;
}

// Full document. `body` is trusted template HTML built from escaped values.
export function layout({ title, preheader, body, footerNote, links = [] }) {
  const linkHtml = links.map(([label, href]) => `<a class="fl" href="${esc(linkUrl(href))}" style="color:${C.ink2};text-decoration:underline;">${esc(label)}</a>`).join(`<span class="ink2" style="color:${C.line};">&nbsp;&nbsp;|&nbsp;&nbsp;</span>`);
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(title)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  body { margin:0; padding:0; width:100% !important; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  table { border-collapse:collapse; mso-table-lspace:0; mso-table-rspace:0; }
  img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; display:block; }
  a[x-apple-data-detectors] { color:inherit !important; text-decoration:none !important; }
  @media (max-width: 480px) {
    .px { padding-left:24px !important; padding-right:24px !important; }
    .h1 { font-size:28px !important; line-height:34px !important; }
  }
</style>
<style>
  @media (prefers-color-scheme: dark) {
    body, .bg { background:${D.page} !important; }
    .ink { color:${D.ink} !important; }
    .ink2, .fl { color:${D.ink2} !important; }
    .rule { border-color:${D.line} !important; }
    .band { background:${D.band} !important; }
    .lk { color:${D.link} !important; }
    .lm { display:none !important; }
    .dm { display:block !important; max-height:none !important; }
  }
  [data-ogsc] .ink { color:${D.ink} !important; }
  [data-ogsc] .ink2, [data-ogsc] .fl { color:${D.ink2} !important; }
  [data-ogsc] .lk { color:${D.link} !important; }
  [data-ogsb] .bg { background:${D.page} !important; }
  [data-ogsb] .band { background:${D.band} !important; }
  [data-ogsc] .lm { display:none !important; }
  [data-ogsc] .dm { display:block !important; max-height:none !important; }
</style>
</head>
<body class="bg" style="margin:0;padding:0;background:${C.page};" bgcolor="${C.page}">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.page};opacity:0;">${esc(preheader)}${'&#847;&zwnj;&nbsp;'.repeat(40)}</div>
<table role="presentation" class="bg" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="${C.page}" style="background:${C.page};">
  <tr><td align="center" style="padding:0;">
    <!--[if mso]><table role="presentation" width="600" border="0" cellspacing="0" cellpadding="0"><tr><td><![endif]-->
    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width:600px;table-layout:fixed;">
      <tr><td class="px" style="padding:44px 40px 0;">
        ${wordmark()}
      </td></tr>
${body}
      <tr><td class="band px" bgcolor="${C.band}" style="background:${C.band};padding:28px 40px 40px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.ink2};">
        <p class="ink2" style="margin:0 0 12px;">${esc(footerNote)}</p>
        <p class="ink2" style="margin:0 0 12px;">${esc(COMPANY_ADDRESS)}</p>
        <p class="ink2" style="margin:0;">${linkHtml}</p>
      </td></tr>
    </table>
    <!--[if mso]></td></tr></table><![endif]-->
  </td></tr>
</table>
</body>
</html>`;
}

// Plain text helper: wraps nothing, just joins sections with blank lines.
export const textDoc = sections => `${sections.filter(s => s !== null && s !== undefined).join('\n\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
