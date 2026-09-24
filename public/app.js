/* Revivex app.js — v6 — Scroll-driven video scrub */
'use strict';

(function () {

  /* ── SCROLL-SCRUBBED HERO VIDEO ─────────────────────
     Hero section is 300vh tall. The video element is
     position:sticky inside, so it stays in viewport.
     JS maps scrollY → video.currentTime as the user
     scrolls through the 300vh hero section.
  ──────────────────────────────────────────────────── */
  var heroSection = document.getElementById('hero');
  var heroVideo   = document.getElementById('heroVideo');
  var heroContent = document.getElementById('heroContent');
  var heroForm    = document.getElementById('heroForm');

  var heroScrollHandler = null;

  if (heroSection && heroVideo) {
    // Pre-load video so currentTime seeking works
    heroVideo.load();

    heroScrollHandler = function () {
      var heroTop    = heroSection.getBoundingClientRect().top + window.scrollY;
      var heroHeight = heroSection.offsetHeight; // 300vh
      var scrolled   = window.scrollY - heroTop;
      var scrollable = heroHeight - window.innerHeight;
      if (scrollable <= 0) return;

      var progress = Math.max(0, Math.min(1, scrolled / scrollable));

      // Scrub video: map scroll progress to video time
      if (heroVideo.readyState >= 1 && heroVideo.duration) {
        heroVideo.currentTime = progress * heroVideo.duration;
      }

      // Fade in hero headline + sub after 5% scroll
      if (heroContent) {
        if (progress > 0.05) {
          heroContent.classList.add('visible');
        } else {
          heroContent.classList.remove('visible');
        }
      }

      // Show CTA form after 30% scroll
      if (heroForm) {
        if (progress > 0.30) {
          heroForm.style.opacity = '1';
          heroForm.style.pointerEvents = 'auto';
        } else {
          heroForm.style.opacity = '0';
          heroForm.style.pointerEvents = 'none';
        }
      }
    };

    window.addEventListener('scroll', heroScrollHandler, { passive: true });

    // Run once on load so initial state is correct
    heroScrollHandler();

    // If page loads mid-scroll (back button), run after video meta loads
    heroVideo.addEventListener('loadedmetadata', heroScrollHandler);
  }

  /* ── FORM HELPERS ───────────────────────────────── */
  function getToken(cb) {
    fetch('/api/form')
      .then(function (r) { return r.json(); })
      .then(function (d) { cb(null, d.token || ''); })
      .catch(function (e) { cb(e, ''); });
  }

  function submitSignup(email, token, honeypot, msgEl, btnEl, cb) {
    btnEl.disabled = true;
    fetch('/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, consent: true, token: token, website: honeypot })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        btnEl.disabled = false;
        if (d.ok) {
          msgEl.textContent = d.message || 'You\'re on the list.';
          msgEl.className = msgEl.className.replace(/\berror\b/, '') + ' success';
          cb(true);
        } else {
          msgEl.textContent = d.message || 'Something went wrong. Please try again.';
          msgEl.className = msgEl.className.replace(/\bsuccess\b/, '') + ' error';
          cb(false);
        }
      })
      .catch(function () {
        btnEl.disabled = false;
        msgEl.textContent = 'Network error. Please try again.';
        msgEl.className = msgEl.className.replace(/\bsuccess\b/, '') + ' error';
        cb(false);
      });
  }

  function wireForm(formId, msgId) {
    var form = document.getElementById(formId);
    var msgEl = document.getElementById(msgId);
    if (!form || !msgEl) return;

    var emailInput    = form.querySelector('input[type="email"]');
    var honeypotInput = form.querySelector('input[name="website"]');
    var btn           = form.querySelector('button[type="submit"]');

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      msgEl.textContent = '';
      msgEl.className = msgEl.className.replace(/\b(error|success)\b/g, '');

      var email = emailInput ? emailInput.value.trim() : '';
      if (!email) {
        msgEl.textContent = 'Please enter your email address.';
        msgEl.className += ' error';
        return;
      }

      var honeypot = honeypotInput ? honeypotInput.value : '';

      getToken(function (err, token) {
        if (err) {
          msgEl.textContent = 'Unable to connect. Please try again.';
          msgEl.className += ' error';
          return;
        }
        submitSignup(email, token, honeypot, msgEl, btn, function (ok) {
          if (ok && emailInput) emailInput.value = '';
        });
      });
    });
  }

  wireForm('heroForm', 'heroMsg');
  wireForm('waitlistForm', 'waitlistMsg');

  /* ── SCROLL FADE-UP (features, waitlist, faq) ───── */
  function initFadeUp() {
    var els = document.querySelectorAll('.fade-up');
    if (!els.length) return;

    if (!window.IntersectionObserver) {
      for (var i = 0; i < els.length; i++) {
        els[i].classList.add('visible');
      }
      return;
    }

    var observer = new IntersectionObserver(function (entries) {
      for (var j = 0; j < entries.length; j++) {
        var entry = entries[j];
        if (entry.isIntersecting) {
          var el = entry.target;
          var delay = el.getAttribute('data-delay');
          if (delay) {
            el.style.transitionDelay = delay + 'ms';
          }
          el.classList.add('visible');
          observer.unobserve(el);
        }
      }
    }, { threshold: 0.12 });

    for (var k = 0; k < els.length; k++) {
      observer.observe(els[k]);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFadeUp);
  } else {
    initFadeUp();
  }

})();
