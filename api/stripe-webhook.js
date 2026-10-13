// Vercel function: Stripe webhook, source of truth for paid deposits (see lib/stripe-webhook.js).
import { createStripeWebhookHandler } from '../lib/stripe-webhook.js';

export default createStripeWebhookHandler();
