// "Your Revivex preorder is confirmed": transactional confirmation for a paid deposit.
import { SUPPORT_EMAIL } from '../deposit-config.js';
import { C, DISPLAY, FONT, esc, heroImage, layout, link } from './shared.js';

export const PREORDER_SUBJECT = 'Your Revivex preorder is confirmed';
export const PREORDER_PREHEADER = 'We received your $100 deposit.';

const row = (label, value, first = false) => `          <tr>
            <td class="ink2 rule" width="36%" style="width:36%;padding:14px 0;${first ? `border-top:1px solid ${C.line};` : ''}border-bottom:1px solid ${C.line};font-family:${FONT};font-size:15px;line-height:20px;color:${C.ink2};">${esc(label)}</td>
            <td class="ink rule" align="right" style="padding:14px 0 14px 16px;${first ? `border-top:1px solid ${C.line};` : ''}border-bottom:1px solid ${C.line};font-family:${FONT};font-size:15px;line-height:20px;color:${C.ink};word-break:break-all;">${esc(value)}</td>
          </tr>`;

const note = text => `        <p class="ink2" style="margin:0 0 20px;font-size:15px;line-height:22px;color:${C.ink2};">${text}</p>`;

export function preorderConfirmationHtml(d) {
  const thanks = d.firstName ? `Thank you, ${esc(d.firstName)}.` : 'Thank you.';
  const body = `      <tr><td class="px" style="padding:48px 40px 0;font-family:${FONT};">
        <h1 class="h1 ink" style="margin:0;font-family:${DISPLAY};font-size:32px;line-height:38px;letter-spacing:-0.015em;font-weight:400;color:${C.ink};">Your preorder is confirmed.</h1>
        <p class="ink" style="margin:14px 0 0;font-size:17px;line-height:25px;overflow-wrap:anywhere;word-wrap:break-word;color:${C.ink};">${thanks} We received your $100&nbsp;deposit.</p>
      </td></tr>
      <tr><td align="center" style="padding:16px 0 8px;line-height:0;font-size:0;">
        ${heroImage({ alt: 'Revivex' })}
      </td></tr>
      <tr><td class="px" style="padding:0 40px;">
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="table-layout:fixed;">
${row('Order reference', d.reference, true)}
${row('Date', d.date)}
${row('Deposit', d.amount)}
${row('Email', d.email)}
        </table>
      </td></tr>
      <tr><td class="px" style="padding:36px 40px 10px;font-family:${FONT};">
${note('Your deposit is credited toward your machine. We never charge the balance automatically.')}
${note('The price and shipping date have not been announced. We will email you first.')}
${note(`Your deposit is fully refundable at any time. Reply to this email or write to ${link(`mailto:${SUPPORT_EMAIL}`, SUPPORT_EMAIL)}.`)}
      </td></tr>
      <tr><td class="px" style="padding:6px 40px 56px;">
        <p style="margin:0;font-family:${FONT};font-size:15px;line-height:22px;">${link(d.viewUrl, 'View your preorder')}</p>
      </td></tr>`;
  return layout({
    title: PREORDER_SUBJECT,
    preheader: PREORDER_PREHEADER,
    body,
    footerNote: 'You received this because you placed a preorder with Revivex.',
    links: [['Deposit terms', d.termsUrl], ['Privacy', d.privacyUrl], ['Support', `mailto:${SUPPORT_EMAIL}`]],
  });
}
