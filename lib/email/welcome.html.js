// "You're on the list": sent once when someone opts in to launch updates.
import { C, DISPLAY, FONT, esc, heroImage, layout, link } from './shared.js';

export const WELCOME_SUBJECT = "You're on the Revivex list";
export const WELCOME_PREHEADER = 'We will write when there is news.';

export function welcomeHtml(d) {
  const thanks = d.firstName ? `Thank you, ${esc(d.firstName)}.` : 'Thank you.';
  const body = `      <tr><td class="px" style="padding:48px 40px 0;font-family:${FONT};">
        <h1 class="h1 ink" style="margin:0;font-family:${DISPLAY};font-size:32px;line-height:38px;letter-spacing:-0.015em;font-weight:400;color:${C.ink};">You&rsquo;re on the list.</h1>
        <p class="ink" style="margin:14px 0 0;font-size:17px;line-height:25px;overflow-wrap:anywhere;word-wrap:break-word;color:${C.ink};">${thanks} We will write when there is news: the price, the ship date and a first look at the finished machine.</p>
      </td></tr>
      <tr><td align="center" style="padding:16px 0 8px;line-height:0;font-size:0;">
        ${heroImage({ alt: 'Revivex' })}
      </td></tr>
      <tr><td class="px" style="padding:0 40px 56px;font-family:${FONT};">
        <p class="ink2" style="margin:0 0 18px;font-size:15px;line-height:22px;color:${C.ink2};">Revivex is a countertop machine in development, designed to use your data to blend your daily supplements into one drink.</p>
        <p style="margin:0;font-size:15px;line-height:22px;">${link(d.siteUrl, 'See Revivex')}</p>
      </td></tr>`;
  return layout({
    title: WELCOME_SUBJECT,
    preheader: WELCOME_PREHEADER,
    body,
    footerNote: 'You received this because you signed up for Revivex launch updates.',
    links: [['Unsubscribe', d.unsubscribeUrl], ['Privacy', d.privacyUrl]],
  });
}
