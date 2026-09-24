/* Frame-sequence scroll hero + form logic */

(async () => {
  // ── FRAME SEQUENCE SCROLL HERO ──────────────────────────────
  const canvas = document.getElementById('hero-canvas');
  const ctx = canvas ? canvas.getContext('2d') : null;
  const scrollSection = document.getElementById('scroll-hero');
  const heroText = document.getElementById('hero-text');
  const heroCta = document.getElementById('hero-cta');

  // Build frame list — frames/revivex-NNNN.webp (populated when animation is ready)
  // Fallback: use static images if no frames directory
  // Load frame manifest then all frames
  const frames = [];
  let framesLoaded = 0;
  let manifestLoaded = false;

  function resizeCanvas() {
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Load frames from manifest
  async function loadFrames() {
    try {
      const r = await fetch('assets/frames/manifest.json');
      const m = await r.json();
      const count = m.frameCount || 0;
      const ext = m.ext || 'jpg';
      for (let i = 1; i <= count; i++) {
        const img = new Image();
        const n = String(i).padStart(4, '0');
        img.src = `assets/frames/revivex-${n}.${ext}`;
        img.onload = () => { framesLoaded++; if (framesLoaded === 1) drawFrame(0); };
        frames.push(img);
      }
      manifestLoaded = true;
    } catch {
      // Fallback to 2-frame static
      const startImg = new Image();
      startImg.src = 'assets/hero-ai.png';
      startImg.onload = () => { framesLoaded++; drawFrame(0); };
      const endImg = new Image();
      endImg.src = 'assets/hero-endframe.png';
      endImg.onload = () => framesLoaded++;
      frames.push(startImg, endImg);
    }
  }
  loadFrames();

  function drawFrame(progress) {
    if (!ctx || frames.length === 0) return;
    const idx = Math.min(Math.floor(progress * (frames.length - 1)), frames.length - 1);
    const img = frames[idx];
    if (!img || !img.complete) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Draw centered, maintain aspect ratio
    const scale = Math.max(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  }

  // Initial draw
  if (frames[0]) {
    frames[0].onload = () => drawFrame(0);
    if (frames[0].complete) drawFrame(0);
  }

  // Scroll handler
  function onScroll() {
    if (!scrollSection || !canvas) return;
    const rect = scrollSection.getBoundingClientRect();
    const scrollable = scrollSection.offsetHeight - window.innerHeight;
    const progress = Math.min(Math.max(-rect.top / scrollable, 0), 1);

    drawFrame(progress);

    // Text fades in after 5% scroll
    if (progress > 0.05) {
      heroText?.classList.add('visible');
    } else {
      heroText?.classList.remove('visible');
    }

    // CTA appears after 25% scroll
    if (progress > 0.25) {
      heroCta?.classList.add('visible');
    } else {
      heroCta?.classList.remove('visible');
    }
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ── FADE-UP SECTIONS ─────────────────────────────────────────
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add('visible'); observer.unobserve(e.target); }
    });
  }, { threshold: 0.12 });

  document.querySelectorAll('.fade-up').forEach(el => observer.observe(el));

  // ── FILM PLAY ────────────────────────────────────────────────
  const film = document.getElementById('product-film');
  const playBtn = document.getElementById('film-play');
  if (film && playBtn) {
    playBtn.addEventListener('click', () => {
      film.play();
      playBtn.classList.add('hidden');
    });
  }

  // ── FORM HELPERS ─────────────────────────────────────────────
  async function getToken() {
    try {
      const r = await fetch('/api/form');
      const j = await r.json();
      return j.token || '';
    } catch { return ''; }
  }

  async function submitEmail(email, consent, msgEl) {
    const token = await getToken();
    try {
      const r = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, consent, token, source: 'revivex-launch' })
      });
      const j = await r.json();
      if (msgEl) msgEl.textContent = j.message || (j.ok ? 'You\'re on the list.' : 'Something went wrong.');
    } catch {
      if (msgEl) msgEl.textContent = 'Something went wrong. Try again.';
    }
  }

  // Hero form
  const heroForm = document.getElementById('hero-form');
  if (heroForm) {
    heroForm.addEventListener('submit', async e => {
      e.preventDefault();
      const email = document.getElementById('hero-email')?.value;
      const btn = heroForm.querySelector('button');
      if (btn) btn.textContent = '...';
      await submitEmail(email, true, null);
      if (btn) btn.textContent = "You're on the list ✓";
      setTimeout(() => { document.querySelector('#waitlist')?.scrollIntoView({ behavior: 'smooth' }); }, 1200);
    });
  }

  // Waitlist form
  const wlForm = document.getElementById('waitlist-form');
  const wlMsg = document.getElementById('wl-msg');
  if (wlForm) {
    wlForm.addEventListener('submit', async e => {
      e.preventDefault();
      const email = document.getElementById('wl-email')?.value;
      const btn = wlForm.querySelector('button');
      if (btn) btn.textContent = '...';
      await submitEmail(email, true, wlMsg);
      if (btn) btn.textContent = 'Joined ✓';
    });
  }
})();
