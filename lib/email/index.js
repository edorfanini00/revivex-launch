// Renders complete messages (subject, html, text) from plain data. Every dynamic value
// is escaped in the HTML templates; nothing here reads the environment.
import { DEPOSIT } from '../deposit-config.js';
import { formatDate, greetingName, money } from './shared.js';
import { PREORDER_PREHEADER, PREORDER_SUBJECT, preorderConfirmationHtml } from './preorder-confirmation.html.js';
import { preorderConfirmationText } from './preorder-confirmation.txt.js';
import { WELCOME_PREHEADER, WELCOME_SUBJECT, welcomeHtml } from './welcome.html.js';
import { welcomeText } from './welcome.txt.js';

// Short, human readable form of a Checkout Session id (its last 8 characters).
export const orderReference = sessionId => String(sessionId || '').replace(/[^A-Za-z0-9]/g, '').slice(-8).toUpperCase();

export function renderPreorderConfirmation({ sessionId, email, name, paidAt, amountCents = DEPOSIT.amount, currency = DEPOSIT.currency, origin }) {
  const d = {
    firstName: greetingName(name),
    amount: money(amountCents, currency),
    date: formatDate(paidAt || new Date()),
    reference: orderReference(sessionId),
    email: String(email || ''),
    viewUrl: `${origin}/reservation.html?session_id=${encodeURIComponent(sessionId)}`,
    termsUrl: `${origin}/deposit-terms.html`,
    privacyUrl: `${origin}/privacy.html`,
  };
  return { subject: PREORDER_SUBJECT, preheader: PREORDER_PREHEADER, html: preorderConfirmationHtml(d), text: preorderConfirmationText(d) };
}

export function renderWelcome({ firstName, unsubscribeUrl, origin }) {
  const d = { firstName: greetingName(firstName), unsubscribeUrl, siteUrl: `${origin}/`, privacyUrl: `${origin}/privacy.html` };
  return { subject: WELCOME_SUBJECT, preheader: WELCOME_PREHEADER, html: welcomeHtml(d), text: welcomeText(d) };
}
