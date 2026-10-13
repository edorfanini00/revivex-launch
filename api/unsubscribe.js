// Vercel function: one click unsubscribe for launch update emails (see lib/signup.js).
import { createUnsubscribeHandler } from '../lib/signup.js';

export default createUnsubscribeHandler();
