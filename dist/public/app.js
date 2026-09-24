/* Revivex app.js — v5 */
'use strict';

(function () {

  /* ── Hero video toggle ──────────────────────────── */
  var heroVideo = document.querySelector('.hero-video');
  var heroToggle = document.getElementById('heroToggle');

  if (heroVideo && heroToggle) {
    var iconPause = heroToggle.querySelector('.icon-pause');
    var iconPlay = heroToggle.querySelector('.icon-play');

    heroToggle.addEventListener('click', function () {
      if (heroVideo.paused) {
        heroVideo.play();
        heroToggle.setAttribute('aria-label', 'Pause video');
        heroToggle.setAttribute('aria-pressed', 'false');
        iconPause.style.display = '';
        iconPlay.style.display = 'none';
      } else {
        heroVideo.pause();
        heroToggle.setAttribute('aria-label', 'Play video');
        heroToggle.setAttribute('aria-pressed', 'true');
        iconPause.style.display = 'none';
        iconPlay.style.display = '';
      }
    });
  }

  /* ── Film section play ──────────────────────────── */
  var filmVideo = document.getElementById('filmVideo');
  var filmPlay = document.getElementById('filmPlay');

  if (filmVideo && filmPlay) {
    filmPlay.addEventListener('click', function () {
      filmPlay.style.display = 'none';
      filmVideo.play();
      filmVideo.setAttribute('controls', '');
    });

    filmVideo.addEventListener('ended', function () {
      filmPlay.style.display = 'flex';
      filmVideo.removeAttribute('controls');
    });
  }

  /* ── Form helpers ───────────────────────────────── */
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

    var emailInput = form.querySelector('input[type="email"]');
    var honeypotInput = form.querySelector('input[name="website"]');
    var btn = form.querySelector('button[type="submit"]');

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

  /* ── Scroll fade-up ─────────────────────────────── */
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
    }, { threshold: 0.15 });

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
