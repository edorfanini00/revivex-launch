/* Reservation status: asks our server, which retrieves the Checkout Session from
   Stripe. Only a server-confirmed "confirmed" state is shown as a received deposit. */
(() => {
  const $ = id => document.getElementById(id);
  const root = $('receipt'), title = $('receiptTitle'), text = $('receiptText');
  const facts = $('receiptFacts'), refund = $('receiptRefund'), retry = $('receiptRetry');
  const sessionId = new URLSearchParams(location.search).get('session_id') || '';

  const COPY = {
    confirmed: ['Deposit received', 'Stripe confirms your $100 fully refundable deposit. This confirms the deposit only: it is not a final order, shipping commitment or place in a queue, and it does not sign you up for marketing email. Revivex is in development; the final price and shipping date have not been announced. We will not charge a balance automatically.'],
    processing: ['Payment processing', 'Stripe has not confirmed this payment yet. This page will not show your deposit as received until it does. Check again shortly.'],
    not_completed: ['Checkout not completed', 'No payment was taken for this checkout. You can reserve again from the main page.'],
    expired: ['Checkout expired', 'This checkout page expired without a payment. You can reserve again from the main page.'],
    refunded: ['Deposit refunded', 'Stripe shows this deposit as refunded.'],
    partially_refunded: ['Partly refunded', 'Stripe shows part of this deposit as refunded. Contact support@revivex.store if this is unexpected.'],
    disputed: ['Payment disputed', 'Stripe shows a dispute on this payment, so we cannot show it as an active deposit. Contact support@revivex.store with the reference below.'],
    not_recognized: ['Reservation not recognised', 'This checkout is not a Revivex deposit we can confirm.'],
    not_found: ['Reservation not found', 'We could not find this checkout. Check the link, or reserve from the main page.'],
    retry: ['We could not check right now', 'Stripe did not answer in time. Nothing has changed with your payment. Please check again.'],
    unavailable: ['Status temporarily unavailable', 'We cannot check reservations right now. Nothing has changed with your payment.'],
    rate_limited: ['Please wait a moment', 'Too many checks in a short time. Please try again in a minute.'],
  };
  const RETRYABLE = new Set(['processing', 'retry', 'unavailable', 'rate_limited']);
  const usd = minor => '$' + (minor / 100).toFixed(2) + ' USD';

  function render(state, d) {
    const c = COPY[state] || COPY.unavailable;
    root.dataset.state = state;
    title.textContent = c[0];
    text.textContent = c[1];
    const paid = state === 'confirmed' || state === 'refunded' || state === 'partially_refunded' || state === 'disputed';
    facts.hidden = !paid;
    if (paid) { $('receiptAmount').textContent = usd(d.amount); $('receiptRef').textContent = d.reference || ''; }
    refund.hidden = state !== 'confirmed';
    retry.hidden = !RETRYABLE.has(state);
    if (d && d.mode === 'test') document.querySelectorAll('[data-when="test"]').forEach(el => { el.hidden = false; });
    // A paid deposit exists for this checkout: drop the stored attempt so pressing
    // Reserve again starts a deliberate new reservation rather than replaying this one.
    if (paid) { try { sessionStorage.removeItem('revivex.depositOperation'); } catch { /* ignore */ } }
    // Measurement hook (public/meta-pixel.js): only a "confirmed", fresh, live deposit counts there.
    try { window.dispatchEvent(new CustomEvent('revivex:deposit-status', { detail: { state, sessionId, fresh: !!d && d.fresh === true, mode: d && d.mode } })); } catch { /* ignore */ }
  }

  async function check() {
    retry.hidden = true;
    if (!/^cs_(test|live)_[A-Za-z0-9]{8,250}$/.test(sessionId)) return render('not_found', {});
    try {
      const r = await fetch('/api/reservation?session_id=' + encodeURIComponent(sessionId), { headers: { Accept: 'application/json' }, cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      render(COPY[d.state] ? d.state : 'unavailable', d);
    } catch {
      render('retry', {});
    }
  }
  retry.addEventListener('click', check);
  check();
})();
