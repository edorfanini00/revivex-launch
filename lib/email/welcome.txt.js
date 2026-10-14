// Plain text alternative of the welcome email.
import { COMPANY_ADDRESS } from '../crm-config.js';
import { textDoc } from './shared.js';

export function welcomeText(d) {
  return textDoc([
    "You're on the list.",
    `${d.firstName ? `Thank you, ${d.firstName}.` : 'Thank you.'} We will write when there is news: the price, the ship date and a first look at the finished machine.`,
    'Revivex is a countertop machine in development, designed to use your data to blend your daily supplements into one drink.',
    `See Revivex: ${d.siteUrl}`,
    'You received this because you signed up for Revivex launch updates.',
    COMPANY_ADDRESS,
    `Unsubscribe: ${d.unsubscribeUrl}\nPrivacy: ${d.privacyUrl}`,
  ]);
}
