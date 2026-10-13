// Shared building blocks for Revivex emails: escaping, palette and a table layout that
// renders in Gmail, Apple Mail, iOS Mail and Outlook (inline CSS, 600px max, VML button).
import { COMPANY_ADDRESS, EMAIL_ASSET_ORIGIN } from '../crm-config.js';

export const C = Object.freeze({
  page: '#F1EFEA',
  card: '#FFFFFF',
  paper: '#F8F7F4',
  ink: '#0A0A0A',
  ink2: '#5C5C5C',
  ink3: '#8A8A8A',
  navy: '#0F1F38',
  graphite: '#16181B',
  line: '#E7E4DE',
});
export const FONT = "-apple-system,BlinkMacSystemFont,'Inter','Segoe UI','Helvetica Neue',Helvetica,Arial,sans-serif";

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

export function button(href, label) {
  const h = esc(safeUrl(href));
  return `<table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin:0 auto;">
  <tr><td align="center" bgcolor="${C.navy}" style="border-radius:999px;background:${C.navy};">
    <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${h}" style="height:52px;v-text-anchor:middle;width:260px;" arcsize="50%" stroke="f" fillcolor="${C.navy}"><w:anchorlock/><center style="color:#FFFFFF;font-family:Arial,sans-serif;font-size:16px;font-weight:600;">${esc(label)}</center></v:roundrect><![endif]-->
    <!--[if !mso]><!--><a href="${h}" target="_blank" style="display:inline-block;padding:17px 36px;font-family:${FONT};font-size:16px;line-height:18px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:999px;background:${C.navy};mso-hide:all;">${esc(label)}</a><!--<![endif]-->
  </td></tr>
</table>`;
}

// Full document. `body` is trusted template HTML built from escaped values.
export function layout({ title, preheader, body, footerNote, links = [] }) {
  const linkHtml = links.map(([label, href]) => `<a href="${esc(safeUrl(href))}" style="color:${C.ink2};text-decoration:underline;">${esc(label)}</a>`).join('&nbsp;&nbsp;&middot;&nbsp;&nbsp;');
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${esc(title)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
  :root { color-scheme: light only; supported-color-schemes: light only; }
  body { margin:0; padding:0; width:100% !important; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  table { border-collapse:collapse; mso-table-lspace:0; mso-table-rspace:0; }
  img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; display:block; }
  a[x-apple-data-detectors] { color:inherit !important; text-decoration:none !important; }
  @media (max-width: 620px) {
    .px { padding-left:24px !important; padding-right:24px !important; }
    .h1 { font-size:30px !important; line-height:36px !important; }
    .wrap { padding:0 !important; }
    .card { border-radius:0 !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${C.page};" bgcolor="${C.page}">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.page};opacity:0;">${esc(preheader)}${'&#847;&zwnj;&nbsp;'.repeat(40)}</div>
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="${C.page}" style="background:${C.page};">
  <tr><td align="center" class="wrap" style="padding:32px 12px;">
    <!--[if mso]><table role="presentation" width="600" border="0" cellspacing="0" cellpadding="0"><tr><td><![endif]-->
    <table role="presentation" class="card" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width:600px;background:${C.card};border-radius:22px;overflow:hidden;">
${body}
      <tr><td class="px" style="padding:28px 40px 36px;border-top:1px solid ${C.line};font-family:${FONT};font-size:12px;line-height:19px;color:${C.ink3};">
        <p style="margin:0 0 10px;">${esc(footerNote)}</p>
        <p style="margin:0 0 10px;">${esc(COMPANY_ADDRESS)}</p>
        <p style="margin:0;">${linkHtml}</p>
      </td></tr>
    </table>
    <!--[if mso]></td></tr></table><![endif]-->
  </td></tr>
</table>
</body>
</html>`;
}

// Dark header band with the white wordmark, then the machine render.
export function heroRows({ alt }) {
  return `      <tr><td bgcolor="${C.graphite}" style="background:${C.graphite};padding:26px 40px 22px;" class="px">
        <img src="${esc(asset('/assets/brand/logo-light.png'))}" width="112" height="16" alt="Revivex" style="width:112px;height:16px;color:#FFFFFF;font-family:${FONT};font-size:16px;font-weight:600;">
      </td></tr>
      <tr><td bgcolor="${C.graphite}" style="background:${C.graphite};line-height:0;font-size:0;">
        <img src="${esc(asset('/assets/email/preorder-hero.jpg'))}" width="600" alt="${esc(alt)}" style="width:100%;max-width:600px;height:auto;background:${C.graphite};color:#FFFFFF;font-family:${FONT};font-size:14px;">
      </td></tr>`;
}

// Plain text helper: wraps nothing, just joins sections with blank lines.
export const textDoc = sections => `${sections.filter(s => s !== null && s !== undefined).join('\n\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
