/* =========================================================
   REVIVEX app.js — Editorial warm aesthetic
   ========================================================= */

'use strict';

/* ---- Scroll-triggered fade-up animations ---- */
(function initFadeUp() {
  const els = document.querySelectorAll('.fade-up');
  if (!els.length) return;

  // Only hide elements if IntersectionObserver is available
  // (prevents blank page if JS/IO not supported)
  if (!('IntersectionObserver' in window)) return;

  // Mark as will-animate BEFORE observing so CSS hides them
  els.forEach((el) => el.classList.add('will-fade'));

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          entry.target.classList.remove('will-fade');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.08, rootMargin: '0px 0px -20px 0px' }
  );

  els.forEach((el) => observer.observe(el));
})();

/* ---- Signup form handler ---- */
function setupForm(formEl, msgEl) {
  if (!formEl || !msgEl) return;

  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();

    // Honeypot check
    const hp = formEl.querySelector('.hp');
    if (hp && hp.value) return;

    const emailInput = formEl.querySelector('input[type="email"]');
    const email = emailInput ? emailInput.value.trim() : '';

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      msgEl.textContent = 'Please enter a valid email address.';
      msgEl.className = 'form-msg error';
      return;
    }

    const submitBtn = formEl.querySelector('button[type="submit"]');
    const originalText = submitBtn ? submitBtn.textContent : '';
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = '…';
    }
    msgEl.textContent = '';
    msgEl.className = 'form-msg';

    // Get CSRF token
    let token = null;
    try {
      const tokRes = await fetch('/api/form');
      if (tokRes.ok) {
        const tokData = await tokRes.json();
        token = tokData.token || null;
      }
    } catch { /* ignore */ }

    // Wait 1s per server requirement
    await new Promise((r) => setTimeout(r, 1100));

    try {
      const body = { email, consent: true };
      if (token) body.token = token;

      const res = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json().catch(() => ({}));

      if (res.ok && data.ok) {
        msgEl.textContent = "You're on the list. We'll be in touch.";
        msgEl.className = 'form-msg success';
        if (emailInput) emailInput.value = '';
      } else {
        msgEl.textContent = data.message || 'Something went wrong. Please try again.';
        msgEl.className = 'form-msg error';
      }
    } catch {
      msgEl.textContent = 'Network error. Please try again.';
      msgEl.className = 'form-msg error';
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
      }
    }
  });
}

setupForm(document.getElementById('heroForm'), document.getElementById('heroMsg'));
setupForm(document.getElementById('waitlistForm'), document.getElementById('waitlistMsg'));

/* ---- Nav CTA smooth scroll ---- */
document.querySelectorAll('a[href^="#"]').forEach((link) => {
  link.addEventListener('click', (e) => {
    const target = document.querySelector(link.getAttribute('href'));
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
});
