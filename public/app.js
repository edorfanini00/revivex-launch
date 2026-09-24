/* Revivex app.js — scroll sequence, film player, waitlist */
'use strict';

// ─── SCROLL SEQUENCE ─────────────────────────────────────────────────────────
(function initScrollSeq() {
  const section = document.getElementById('scrollSeq');
  const canvas  = document.getElementById('seqCanvas');
  const tagline = document.getElementById('seqTagline');
  const callout = document.getElementById('seqCallout');
  if (!section || !canvas) return;

  const ctx = canvas.getContext('2d');
  const MANIFEST = 'assets/frames/manifest.json';
  const CALLOUTS = [
    { pct: 0.40, text: 'Precision dispensing, down to the milligram.' },
    { pct: 0.60, text: 'Built for daily use. Designed for life.' },
    { pct: 0.80, text: 'Your routine, on autopilot.' },
  ];

  let frames = [];
  let images = [];
  let frameCount = 0;
  let currentFrame = -1;

  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    drawFrame(currentFrame >= 0 ? currentFrame : 0);
  }

  function drawFrame(index) {
    if (!images[index] || !images[index].complete) return;
    currentFrame = index;
    const img = images[index];
    const cw = canvas.width, ch = canvas.height;
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const scale = Math.max(cw / iw, ch / ih);
    const dw = iw * scale, dh = ih * scale;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
  }

  function onScroll() {
    const rect   = section.getBoundingClientRect();
    const total  = section.offsetHeight - window.innerHeight;
    const scrolled = Math.max(0, -rect.top);
    const pct   = Math.min(1, scrolled / total);

    // Frame
    const idx = Math.min(frameCount - 1, Math.floor(pct * (frameCount - 1)));
    if (idx !== currentFrame) drawFrame(idx);

    // Tagline at 20%
    if (pct >= 0.20) {
      tagline.classList.add('visible');
    } else {
      tagline.classList.remove('visible');
    }

    // Callouts
    let active = '';
    for (const c of CALLOUTS) {
      if (pct >= c.pct && pct < c.pct + 0.18) active = c.text;
    }
    if (callout.textContent !== active) {
      callout.textContent = active;
      callout.classList.toggle('visible', !!active);
    }
  }

  fetch(MANIFEST)
    .then(r => r.json())
    .then(data => {
      frameCount = data.frameCount;
      const ext  = data.ext || 'jpg';
      frames = Array.from({ length: frameCount }, (_, i) => {
        const num = String(i).padStart(4, '0');
        return `assets/frames/revivex-${num}.${ext}`;
      });

      // Preload all frames
      images = frames.map((src, i) => {
        const img = new Image();
        img.src = src;
        img.onload = () => { if (i === 0) drawFrame(0); };
        return img;
      });

      resize();
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', resize);
      onScroll();
    })
    .catch(e => console.warn('Scroll sequence unavailable:', e));
})();

// ─── FILM PLAYER ─────────────────────────────────────────────────────────────
(function initFilmPlayer() {
  const video   = document.getElementById('filmVideo');
  const playBtn = document.getElementById('filmPlay');
  if (!video || !playBtn) return;

  playBtn.addEventListener('click', () => {
    video.play();
    playBtn.classList.add('hidden');
  });

  video.addEventListener('ended', () => {
    playBtn.classList.remove('hidden');
  });

  video.addEventListener('pause', () => {
    if (!video.ended) playBtn.classList.remove('hidden');
  });
})();

// ─── WAITLIST FORM ────────────────────────────────────────────────────────────
(function initWaitlist() {
  const form  = document.getElementById('waitlistForm');
  const input = document.getElementById('emailInput');
  const msg   = document.getElementById('formMsg');
  if (!form) return;

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const email = input.value.trim();
    if (!email) return;

    msg.textContent = '';
    msg.className = 'form-msg';

    try {
      const res = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        msg.textContent = data.message || 'You\'re on the list. We\'ll be in touch.';
        msg.classList.add('success');
        input.value = '';
      } else {
        msg.textContent = data.error || 'Something went wrong. Please try again.';
        msg.classList.add('error');
      }
    } catch {
      msg.textContent = 'Network error. Please try again.';
      msg.classList.add('error');
    }
  });
})();
