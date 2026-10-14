// Plain text alternative of the preorder confirmation.
import { COMPANY_ADDRESS } from '../crm-config.js';
import { SUPPORT_EMAIL } from '../deposit-config.js';
import { textDoc } from './shared.js';

export function preorderConfirmationText(d) {
  return textDoc([
    'Your preorder is confirmed.',
    `${d.firstName ? `Thank you, ${d.firstName}.` : 'Thank you.'} We received your $100 deposit.`,
    [`Order reference: ${d.reference}`, `Date: ${d.date}`, `Deposit: ${d.amount}`, `Email: ${d.email}`].join('\n'),
    'Your deposit is credited toward your machine. We never charge the balance automatically.',
    'The price and shipping date have not been announced. We will email you first.',
    `Your deposit is fully refundable at any time. Reply to this email or write to ${SUPPORT_EMAIL}.`,
    `View your preorder: ${d.viewUrl}`,
    'You received this because you placed a preorder with Revivex.',
    COMPANY_ADDRESS,
    `Deposit terms: ${d.termsUrl}\nPrivacy: ${d.privacyUrl}`,
  ]);
}
