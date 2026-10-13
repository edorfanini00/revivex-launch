// "Your Revivex preorder is confirmed": transactional confirmation for a paid deposit.
import { SUPPORT_EMAIL } from '../deposit-config.js';
import { C, FONT, button, esc, heroRows, layout } from './shared.js';

export const PREORDER_SUBJECT = 'Your Revivex preorder is confirmed';
export const PREORDER_PREHEADER = 'Your $100 deposit is in. Here is what happens next.';

const row = (label, value, last = false) => `            <tr>
              <td style="padding:13px 0;${last ? '' : `border-bottom:1px solid ${C.line};`}font-family:${FONT};font-size:14px;line-height:20px;color:${C.ink2};">${esc(label)}</td>
              <td align="right" style="padding:13px 0;${last ? '' : `border-bottom:1px solid ${C.line};`}font-family:${FONT};font-size:14px;line-height:20px;color:${C.ink};font-weight:600;word-break:break-all;">${esc(value)}</td>
            </tr>`;

const step = (n, title, text) => `          <tr>
            <td width="40" valign="top" style="padding:0 0 18px;">
              <table role="presentation" border="0" cellspacing="0" cellpadding="0"><tr><td align="center" valign="middle" width="26" height="26" bgcolor="${C.navy}" style="width:26px;height:26px;border-radius:13px;background:${C.navy};font-family:${FONT};font-size:12px;line-height:26px;font-weight:600;color:#FFFFFF;">${n}</td></tr></table>
            </td>
            <td valign="top" style="padding:2px 0 18px;font-family:${FONT};font-size:15px;line-height:23px;color:${C.ink2};"><strong style="color:${C.ink};font-weight:600;">${esc(title)}</strong><br>${text}</td>
          </tr>`;

export function preorderConfirmationHtml(d) {
  const mail = `<a href="mailto:${esc(SUPPORT_EMAIL)}" style="color:${C.navy};text-decoration:underline;">${esc(SUPPORT_EMAIL)}</a>`;
  const body = `${heroRows({ alt: 'The Revivex machine pouring a glass of water on a kitchen counter' })}
      <tr><td class="px" style="padding:40px 40px 8px;font-family:${FONT};">
        <p style="margin:0 0 14px;font-size:12px;line-height:16px;letter-spacing:0.16em;text-transform:uppercase;font-weight:600;color:${C.navy};">Preorder confirmed</p>
        <h1 class="h1" style="margin:0 0 14px;font-size:34px;line-height:40px;letter-spacing:-0.025em;font-weight:600;color:${C.ink};">You&rsquo;re in, ${esc(d.firstName || 'there')}.</h1>
        <p style="margin:0;font-size:16px;line-height:25px;color:${C.ink2};">Thank you for preordering Revivex. Your $100 deposit is confirmed and your machine is reserved while we finish building it.</p>
      </td></tr>
      <tr><td class="px" style="padding:28px 40px 8px;">
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="${C.paper}" style="background:${C.paper};border-radius:16px;">
          <tr><td style="padding:8px 22px;">
            <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
${row('Deposit', d.amount)}
${row('Date', d.date)}
${row('Order reference', d.reference)}
${row('Email', d.email, true)}
            </table>
          </td></tr>
        </table>
      </td></tr>
      <tr><td class="px" style="padding:32px 40px 6px;font-family:${FONT};">
        <h2 style="margin:0 0 20px;font-size:20px;line-height:26px;letter-spacing:-0.015em;font-weight:600;color:${C.ink};">What happens next</h2>
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
${step(1, 'We build it.', 'Revivex is in development. We&rsquo;ll email you before production starts.')}
${step(2, 'Price and ship date.', 'The final price and shipping date will be announced later. You&rsquo;ll hear it from us first.')}
${step(3, 'Your $100 counts.', 'The full deposit is credited toward your machine. We never charge a balance automatically.')}
${step(4, 'Change of plans?', `Your deposit is fully refundable. Just reply to this email or write to ${mail}.`)}
        </table>
      </td></tr>
      <tr><td class="px" align="center" style="padding:14px 40px 40px;">
${button(d.viewUrl, 'View your preorder')}
      </td></tr>`;
  return layout({
    title: PREORDER_SUBJECT,
    preheader: PREORDER_PREHEADER,
    body,
    footerNote: 'You received this because you placed a preorder with Revivex. This is a one time confirmation, not a marketing email.',
    links: [['Deposit terms', d.termsUrl], ['Privacy', d.privacyUrl], ['Support', `mailto:${SUPPORT_EMAIL}`]],
  });
}
