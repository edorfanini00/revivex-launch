/* Meta pixel for the preorder deposit funnel.
   Sends nothing (and loads nothing from Meta) while the pixel id is the placeholder or
   the browser sends Global Privacy Control. The page scripts never call Meta directly:
   app.js announces "revivex:checkout-opening" just before it leaves for Stripe, and
   reservation.js announces "revivex:deposit-status" after the server lookup. Only a
   server-confirmed paid deposit becomes a Purchase. The same event ids are sent from the
   server (lib/meta-capi.js) so Meta counts each event once. */
import { META_PIXEL_ID } from './meta-pixel-id.js';

// Mirrors DEPOSIT in lib/deposit-config.js ($100.00 USD).
export const DEPOSIT_EVENT = Object.freeze({ content_name: 'Revivex machine preorder deposit', value: 100, currency: 'USD' });
export const PURCHASE_KEY_PREFIX = 'revivex.metaPurchase.';
const FBEVENTS_URL = 'https://connect.facebook.net/en_US/fbevents.js';
const SESSION_RE = /^cs_(test|live)_[A-Za-z0-9]{8,250}$/;
const OPERATION_ID_RE = /^[A-Za-z0-9_-]{22}$/;

export const validPixelId = id => typeof id === 'string' && /^[0-9]{6,20}$/.test(id);
export const gpcEnabled = nav => !!nav && nav.globalPrivacyControl === true;

// The random id inside the signed operation token (lib/operation-token.js). The server
// uses the same id for its InitiateCheckout, so the two copies deduplicate.
export function operationEventId(token) {
  if (typeof token !== 'string') return null;
  try {
    const b64 = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    const op = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
    return op && OPERATION_ID_RE.test(op.id) ? op.id : null;
  } catch {
    return null;
  }
}

export const purchaseEventId = sessionId => (typeof sessionId === 'string' && SESSION_RE.test(sessionId) ? `deposit_${sessionId}` : null);

// The standard Meta loader without the inline snippet (the CSP allows no inline script).
export function loadFbq(win) {
  if (win.fbq) return win.fbq;
  const fbq = function () { fbq.callMethod ? fbq.callMethod.apply(fbq, arguments) : fbq.queue.push(arguments); };
  if (!win._fbq) win._fbq = fbq;
  fbq.push = fbq;
  fbq.loaded = true;
  fbq.version = '2.0';
  fbq.queue = [];
  win.fbq = fbq;
  const s = win.document.createElement('script');
  s.async = true;
  s.src = FBEVENTS_URL;
  win.document.head.appendChild(s);
  return fbq;
}

export function createPixel({ win, id = META_PIXEL_ID, load = loadFbq }) {
  const enabled = validPixelId(id) && !gpcEnabled(win.navigator);
  let fbq = null;
  const track = (...args) => { if (!fbq) return null; fbq('track', ...args); return args; };
  return {
    enabled,
    // PageView everywhere; ViewContent on the home page only.
    start() {
      if (!enabled) return false;
      fbq = load(win);
      // No automatic button or page metadata collection: only the events below.
      fbq('set', 'autoConfig', false, id);
      fbq('init', id);
      track('PageView');
      const path = win.location.pathname;
      if (path === '/' || path === '/index.html') track('ViewContent', { ...DEPOSIT_EVENT });
      return true;
    },
    initiateCheckout(token) {
      const eventID = operationEventId(token);
      return eventID ? track('InitiateCheckout', { ...DEPOSIT_EVENT }, { eventID }) : null;
    },
    // Only a server-confirmed paid deposit, at most once per checkout session per browser.
    // If storage is unavailable nothing is sent (the server copy still reaches Meta).
    purchase({ state, sessionId } = {}) {
      if (!fbq || state !== 'confirmed') return null;
      const eventID = purchaseEventId(sessionId);
      if (!eventID) return null;
      const key = PURCHASE_KEY_PREFIX + sessionId;
      try {
        if (win.localStorage.getItem(key)) return null;
        win.localStorage.setItem(key, '1');
      } catch {
        return null;
      }
      return track('Purchase', { ...DEPOSIT_EVENT }, { eventID });
    },
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  try {
    const pixel = createPixel({ win: window });
    if (pixel.start()) {
      window.addEventListener('revivex:checkout-opening', e => { try { pixel.initiateCheckout(e.detail && e.detail.operation); } catch { /* never block checkout */ } });
      window.addEventListener('revivex:deposit-status', e => { try { pixel.purchase(e.detail || {}); } catch { /* ignore */ } });
    }
  } catch { /* measurement must never break the page */ }
}
