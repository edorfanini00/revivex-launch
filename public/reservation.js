/* Reservation status: asks our server, which retrieves the Checkout Session from
   Stripe. Only a server-confirmed "confirmed" state is shown as a received deposit, and
   the machine discount only when the server reports it for that confirmed deposit. The
   amount is always what that deposit actually paid, under the terms it was paid under. */
(() => {
  const $ = id => document.getElementById(id);
  const root = $('receipt'), title = $('receiptTitle'), text = $('receiptText');
  const facts = $('receiptFacts'), refund = $('receiptRefund'), retry = $('receiptRetry');
  const sessionId = new URLSearchParams(location.search).get('session_id') || '';

  const COPY = {
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
  const PAID = new Set(['confirmed', 'refunded', 'partially_refunded', 'disputed']);
  const isAmount = v => Number.isInteger(v) && v > 0;
  const usd = minor => '$' + (minor / 100).toFixed(2) + ' USD';
  const dollars = minor => '$' + (minor % 100 ? (minor / 100).toFixed(2) : String(minor / 100));

  // A confirmed deposit, worded for the terms it was paid under.
  function confirmedCopy(d) {
    // The only machine discount any offer has granted (deposit-terms-v3).
    const discount = d.machineDiscountPercent === 20 ? 20 : null;
    if (discount) {
      return {
        title: 'Thank you for preordering.',
        text: 'Stripe confirmed your ' + dollars(d.amount) + ' fully refundable deposit for Revivex.',
        discount: discount + '% off the final price',
        next: 'Revivex is in development. When the final price is announced, you choose whether to order. The ' + discount + '% comes off first, then your ' + dollars(d.amount) + ' is credited. This deposit is not a final order, a shipping commitment or a place in a queue, and nothing more is charged unless you order.',
        terms: '/deposit-terms.html',
      };
    }
    return {
      title: 'Thank you for preordering.',
      text: 'Stripe confirms your ' + dollars(d.amount) + ' fully refundable deposit. It is applied to the final machine price.',
      discount: null,
      next: 'This confirms the deposit only. It is not a final order, a shipping commitment or a place in a queue. Revivex is in development, and the final price and shipping date have not been announced. We will not charge a balance automatically.',
      terms: d.termsVersion === 'deposit-terms-v3' ? '/deposit-terms.html' : '/deposit-terms-v2.html',
    };
  }

  function render(state, d) {
    const confirmed = state === 'confirmed' && isAmount(d.amount);
    const paid = PAID.has(state) && isAmount(d.amount);
    if (PAID.has(state) && !paid) state = 'not_recognized';
    const c = confirmed ? confirmedCopy(d) : null;
    const copy = COPY[state] || COPY.unavailable;
    root.dataset.state = state;
    $('receiptKicker').textContent = confirmed ? 'Deposit confirmed' : 'Reservation status';
    title.textContent = c ? c.title : copy[0];
    text.textContent = c ? c.text : copy[1];
    $('receiptPhoto').hidden = !confirmed;
    facts.hidden = !paid;
    if (paid) {
      $('receiptAmount').textContent = usd(d.amount);
      $('receiptRef').textContent = d.reference || '';
      const refunded = (state === 'refunded' || state === 'partially_refunded') && isAmount(d.amountRefunded);
      $('receiptRefundedRow').hidden = !refunded;
      if (refunded) $('receiptRefunded').textContent = usd(d.amountRefunded);
      $('receiptDiscountRow').hidden = !(c && c.discount);
      if (c && c.discount) $('receiptDiscount').textContent = c.discount;
    }
    $('receiptNext').hidden = !confirmed;
    if (c) { $('receiptNextText').textContent = c.next; $('receiptTermsLink').href = c.terms; }
    refund.hidden = !confirmed;
    retry.hidden = !RETRYABLE.has(state);
    if (d && d.mode === 'test') document.querySelectorAll('[data-when="test"]').forEach(el => { el.hidden = false; });
    // A paid deposit exists for this checkout: drop the stored attempt so pressing
    // Reserve again starts a deliberate new reservation rather than replaying this one.
    if (paid) { try { sessionStorage.removeItem('revivex.depositOperation'); } catch { /* ignore */ } }
    // Measurement hook (public/meta-pixel.js): only a "confirmed", fresh, live deposit counts there.
    try { window.dispatchEvent(new CustomEvent('revivex:deposit-status', { detail: { state, sessionId, fresh: !!d && d.fresh === true, mode: d && d.mode, amount: d && d.amount } })); } catch { /* ignore */ }
  }

  async function check() {
    retry.hidden = true;
    if (!/^cs_(test|live)_[A-Za-z0-9]{8,250}$/.test(sessionId)) return render('not_found', {});
    try {
      const r = await fetch('/api/reservation?session_id=' + encodeURIComponent(sessionId), { headers: { Accept: 'application/json' }, cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      render((COPY[d.state] || d.state === 'confirmed') ? d.state : 'unavailable', d);
    } catch {
      render('retry', {});
    }
  }
  retry.addEventListener('click', check);
  check();
})();
