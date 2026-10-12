// Vercel function: server-side deposit status for the receipt page (see lib/deposit-handlers.js).
import { createReservationHandler } from '../lib/deposit-handlers.js';

export default createReservationHandler();
