/* Revivex app.js — scroll sequence, FAQ, film player, waitlist */
'use strict';

// ─── HERO VIDEO PAUSE/PLAY ──────────────────────────────────────────────────
(function initHeroPause() {
  const video = document.querySelector('.hero-video');
  const btn = document.getElementById('heroPause');
  const pauseIcon = document.getElementById('pauseIcon');
  const playIcon = document.getElementById('playIcon');
  if (!video || !btn) return;

  btn.addEventListener('click', () => {
    if (video.paused) {
      video.play();
      pauseIcon.style.display = '';
      playIcon.style.display = 'none';
      btn.setAttribute('aria-label', 'Pause background video');
    } else {
      video.pause();
      pauseIcon.style.display = 'none';
      playIcon.style.display = '';
      btn.setAttribute('aria-label', 'Play background video');
    }
  });
})();

// ─── SCROLL SEQUENCE (frame-by-frame canvas) ────────────────────────────────
(function initScrollSeq() {
  const section = document.getElementById('scrollSeq');
  const canvas = document.getElementById('seqCanvas');
  if (!section || !canvas) return;

  const ctx = canvas.getContext('2d');
  const headline = document.getElementById('seqHeadline');
  const callout1 = document.getElementById('callout1');
  const callout2 = document.getElementById('callout2');
  const callout3 = document.getElementById('callout3');

  let frames = [];
  let frameCount = 0;
  let loaded = 0;
  let currentFrame = 0;
  let rafPending = false;

  // Resize canvas to fill viewport
  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    drawFrame(currentFrame);
  }

  function drawFrame(index) {
    if (!frames[index] || !frames[index].complete) return;
    const img = frames[index];
    const cw = canvas.width, ch = canvas.height;
    const scale = Math.min(cw / img.naturalWidth, ch / img.naturalHeight);
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    const dx = (cw - dw) / 2;
    const dy = (ch - dh) / 2;
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  function onScroll() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (!frameCount) return;

      const rect = section.getBoundingClientRect();
      const sectionScrollHeight = section.offsetHeight - window.innerHeight;
      const scrolled = -rect.top;
      const progress = Math.min(Math.max(scrolled / sectionScrollHeight, 0), 1);

      // Draw frame
      const idx = Math.min(Math.floor(progress * (frameCount - 1)), frameCount - 1);
      if (idx !== currentFrame) {
        currentFrame = idx;
        drawFrame(currentFrame);
      }

      // Text: fade in headline at 15-35%
      if (headline) {
        headline.classList.toggle('visible', progress >= 0.15 && progress <= 0.85);
      }

      // Callouts
      if (callout1) callout1.classList.toggle('visible', progress >= 0.35 && progress <= 0.85);
      if (callout2) callout2.classList.toggle('visible', progress >= 0.55 && progress <= 0.85);
      if (callout3) callout3.classList.toggle('visible', progress >= 0.72 && progress <= 0.92);
    });
  }

  // Load manifest then frames
  fetch('/assets/frames/manifest.json')
    .then(r => r.json())
    .then(manifest => {
      frameCount = manifest.frameCount;
      const ext = manifest.ext || 'jpg';

      // Pre-fill array
      frames = new Array(frameCount);

      // Load frames in batches to avoid overwhelming the browser
      for (let i = 1; i <= frameCount; i++) {
        const img = new Image();
        const num = String(i).padStart(4, '0');
        img.src = `/assets/frames/revivex-${num}.${ext}`;
        img.onload = () => {
          loaded++;
          // Draw first frame as soon as it loads
          if (loaded === 1) {
            resizeCanvas();
            drawFrame(0);
          }
        };
        frames[i - 1] = img;
      }

      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', resizeCanvas);
      resizeCanvas();
    })
    .catch(() => {
      // Graceful fallback: show canvas as black
      resizeCanvas();
    });
})();

// ─── INTERSECTION OBSERVER (fade-in .will-fade) ────────────────────────────
(function initFadeIn() {
  const els = document.querySelectorAll('.will-fade');
  if (!els.length) return;
  if (!('IntersectionObserver' in window)) {
    els.forEach(el => el.classList.add('visible'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });
  els.forEach(el => io.observe(el));
})();

// ─── FILM PLAYER ────────────────────────────────────────────────────────────
(function initFilmPlayer() {
  const video = document.getElementById('filmVideo');
  const playBtn = document.getElementById('filmPlayBtn');
  if (!video || !playBtn) return;

  playBtn.addEventListener('click', () => {
    video.play();
    playBtn.classList.add('hidden');
    video.controls = true;
  });

  video.addEventListener('pause', () => {
    if (video.ended || video.paused) {
      playBtn.classList.remove('hidden');
      video.controls = false;
    }
  });
  video.addEventListener('ended', () => {
    playBtn.classList.remove('hidden');
    video.controls = false;
  });
})();

// ─── FAQ ACCORDION ───────────────────────────────────────────────────────────
(function initFaq() {
  const items = document.querySelectorAll('.faq-item');
  items.forEach(item => {
    const btn = item.querySelector('.faq-q');
    const answer = item.querySelector('.faq-a');
    if (!btn || !answer) return;

    btn.addEventListener('click', () => {
      const isOpen = btn.getAttribute('aria-expanded') === 'true';

      // Close all
      items.forEach(i => {
        const b = i.querySelector('.faq-q');
        const a = i.querySelector('.faq-a');
        if (b) b.setAttribute('aria-expanded', 'false');
        if (a) a.style.maxHeight = '0';
      });

      // Open this one if it was closed
      if (!isOpen) {
        btn.setAttribute('aria-expanded', 'true');
        answer.style.maxHeight = answer.scrollHeight + 'px';
      }
    });
  });
})();

// ─── WAITLIST FORM ───────────────────────────────────────────────────────────
(function initWaitlist() {
  const form = document.getElementById('waitlistForm');
  const emailInput = document.getElementById('emailInput');
  const submitBtn = document.getElementById('submitBtn');
  const msg = document.getElementById('formMsg');
  const consentCheck = document.getElementById('consentCheck');
  if (!form) return;

  function setMsg(text, type) {
    msg.textContent = text;
    msg.className = 'form-msg ' + (type || '');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setMsg('');

    const email = emailInput.value.trim();
    const consent = consentCheck ? consentCheck.checked : true;
    const honeypot = form.querySelector('[name="website"]');

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setMsg('Enter a valid email address.', 'error');
      emailInput.focus();
      return;
    }
    if (!consent) {
      setMsg('Please agree to receive updates.', 'error');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = '...';

    try {
      const res = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          consent,
          website: honeypot ? honeypot.value : ''
        })
      });
      const data = await res.json();
      if (data.ok) {
        setMsg(data.message || 'You\'re on the list.', 'success');
        form.reset();
      } else {
        setMsg(data.message || 'Something went wrong.', 'error');
      }
    } catch {
      setMsg('Connection error. Please try again.', 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'JOIN';
    }
  });
})();
