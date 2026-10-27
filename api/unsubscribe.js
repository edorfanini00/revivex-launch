// Vercel function: one-click unsubscribe from the waitlist emails (see lib/waitlist.js).
import { createUnsubscribeHandler } from '../lib/waitlist.js';

export default createUnsubscribeHandler();
