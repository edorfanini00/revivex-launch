// Plain text alternative of the welcome email.
import { COMPANY_ADDRESS } from '../crm-config.js';
import { textDoc } from './shared.js';

export function welcomeText(d) {
  return textDoc([
    `You're on the list, ${d.firstName || 'friend'}.`,
    'Thanks for signing up. Revivex is a countertop machine in development, designed to blend your supplements into one drink each morning from your data.',
    "We'll write when there is real news: the final price, the shipping date and the first look at the finished machine. No noise.",
    `See Revivex: ${d.siteUrl}`,
    'You received this because you signed up for Revivex launch updates.',
    COMPANY_ADDRESS,
    `Unsubscribe: ${d.unsubscribeUrl}\nPrivacy: ${d.privacyUrl}`,
  ]);
}
