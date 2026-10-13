// "You're on the list": sent once when someone opts in to launch updates.
import { C, FONT, button, esc, heroRows, layout } from './shared.js';

export const WELCOME_SUBJECT = "You're on the Revivex list";
export const WELCOME_PREHEADER = "We'll keep you posted on the launch.";

export function welcomeHtml(d) {
  const body = `${heroRows({ alt: 'The Revivex machine pouring a glass of water on a kitchen counter' })}
      <tr><td class="px" style="padding:40px 40px 8px;font-family:${FONT};">
        <p style="margin:0 0 14px;font-size:12px;line-height:16px;letter-spacing:0.16em;text-transform:uppercase;font-weight:600;color:${C.navy};">Launch updates</p>
        <h1 class="h1" style="margin:0 0 14px;font-size:34px;line-height:40px;letter-spacing:-0.025em;font-weight:600;color:${C.ink};">You&rsquo;re on the list, ${esc(d.firstName || 'friend')}.</h1>
        <p style="margin:0 0 14px;font-size:16px;line-height:25px;color:${C.ink2};">Thanks for signing up. Revivex is a countertop machine in development, designed to blend your supplements into one drink each morning from your data.</p>
        <p style="margin:0;font-size:16px;line-height:25px;color:${C.ink2};">We&rsquo;ll write when there is real news: the final price, the shipping date and the first look at the finished machine. No noise.</p>
      </td></tr>
      <tr><td class="px" align="center" style="padding:30px 40px 40px;">
${button(d.siteUrl, 'See Revivex')}
      </td></tr>`;
  return layout({
    title: WELCOME_SUBJECT,
    preheader: WELCOME_PREHEADER,
    body,
    footerNote: 'You received this because you signed up for Revivex launch updates.',
    links: [['Unsubscribe', d.unsubscribeUrl], ['Privacy', d.privacyUrl]],
  });
}
