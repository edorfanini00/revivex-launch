// Plain text alternative of the preorder confirmation.
import { COMPANY_ADDRESS } from '../crm-config.js';
import { SUPPORT_EMAIL } from '../deposit-config.js';
import { textDoc } from './shared.js';

export function preorderConfirmationText(d) {
  return textDoc([
    `You're in, ${d.firstName || 'there'}.`,
    'Thank you for preordering Revivex. Your $100 deposit is confirmed and your machine is reserved while we finish building it.',
    [`Deposit: ${d.amount}`, `Date: ${d.date}`, `Order reference: ${d.reference}`, `Email: ${d.email}`].join('\n'),
    'WHAT HAPPENS NEXT',
    [
      '1. We build it. Revivex is in development. We\'ll email you before production starts.',
      '2. Price and ship date. The final price and shipping date will be announced later. You\'ll hear it from us first.',
      '3. Your $100 counts. The full deposit is credited toward your machine. We never charge a balance automatically.',
      `4. Change of plans? Your deposit is fully refundable. Just reply to this email or write to ${SUPPORT_EMAIL}.`,
    ].join('\n'),
    `View your preorder: ${d.viewUrl}`,
    'You received this because you placed a preorder with Revivex. This is a one time confirmation, not a marketing email.',
    COMPANY_ADDRESS,
    `Deposit terms: ${d.termsUrl}\nPrivacy: ${d.privacyUrl}`,
  ]);
}
