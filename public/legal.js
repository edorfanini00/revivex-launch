/* Shows the test-mode notice on the terms/privacy/reservation pages when the server
   reports Stripe test mode. Contact details are static in the HTML. */
(() => {
  fetch('/api/checkout', { headers: { Accept: 'application/json' }, cache: 'no-store' })
    .then(r => (r.ok ? r.json() : Promise.reject()))
    .then(d => {
      if (d.mode === 'test') document.querySelectorAll('[data-when="test"]').forEach(el => { el.hidden = false; });
    })
    .catch(() => {});
})();
