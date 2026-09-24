/* Revivex v10 — scroll-scrubbed hero, reveals, parallax, waitlist */
(() => {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Nav background after hero starts */
  const nav = document.getElementById('nav');
  const onNav = () => nav.classList.toggle('scrolled', window.scrollY > document.getElementById('hero').offsetHeight - window.innerHeight - 20);
  onNav(); window.addEventListener('scroll', onNav, { passive: true });

  /* Reveal on scroll */
  const io = new IntersectionObserver(es => es.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }), { rootMargin: '0px 0px -10% 0px' });
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));

  /* Scroll-scrubbed hero: frame sequence drawn to canvas (cover fit) */
  const hero = document.getElementById('hero');
  const canvas = document.getElementById('heroCanvas');
  const bar = document.getElementById('heroBar');
  const ctx = canvas.getContext('2d');
  const frames = [];
  let count = 0, current = -1, ready = false;

  function size() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    current = -1; render();
  }
  function draw(img) {
    const cw = canvas.width, ch = canvas.height;
    const s = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
    const w = img.naturalWidth * s, h = img.naturalHeight * s;
    const focusX = window.innerWidth <= 640 ? 0.74 : 0.64;
    const x = (cw - w) * focusX, y = (ch - h) / 2;
    ctx.drawImage(img, x, y, w, h);
  }
  function progress() {
    const r = hero.getBoundingClientRect();
    const total = hero.offsetHeight - window.innerHeight;
    return Math.min(1, Math.max(0, -r.top / total));
  }
  function render() {
    const p = progress();
    if (bar) bar.style.width = (p * 100) + '%';
    if (!ready) return;
    let i = Math.round(p * (count - 1));
    while (i > 0 && !(frames[i] && frames[i].complete && frames[i].naturalWidth)) i--;
    if (!frames[i] || !frames[i].naturalWidth || i === current) return;
    current = i; draw(frames[i]);
  }
  let ticking = false;
  window.addEventListener('scroll', () => {
    if (!ticking) { ticking = true; requestAnimationFrame(() => { render(); ticking = false; }); }
  }, { passive: true });
  window.addEventListener('resize', size);

  if (!reduce) {
    fetch('/assets/v11/frames/manifest.json').then(r => r.ok ? r.json() : Promise.reject()).then(m => {
      count = m.frameCount;
      for (let i = 1; i <= count; i++) {
        const img = new Image();
        img.decoding = 'async';
        img.src = `/assets/v11/frames/f-${String(i).padStart(4, '0')}.${m.ext}`;
        if (i === 1) img.onload = () => { ready = true; canvas.classList.add('ready'); size(); };
        frames.push(img);
      }
    }).catch(() => { /* keep static fallback image */ });
  }

  /* Gentle parallax on full-bleed image */
  const bleed = document.querySelector('.bleed img');
  if (bleed && !reduce) {
    const par = () => {
      const r = bleed.parentElement.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) return;
      const t = (r.top + r.height / 2 - window.innerHeight / 2) / window.innerHeight;
      bleed.style.transform = `translate3d(0, ${(-8 + t * 10).toFixed(2)}%, 0)`;
    };
    par(); window.addEventListener('scroll', () => requestAnimationFrame(par), { passive: true });
  }

  /* Waitlist */
  const form = document.getElementById('waitlistForm');
  const email = document.getElementById('emailInput');
  const consent = document.getElementById('consentInput');
  const hp = document.getElementById('website');
  const msg = document.getElementById('formMsg');
  const btn = document.getElementById('submitBtn');
  const say = (t, ok) => { msg.textContent = t; msg.className = 'form-msg ' + (ok ? 'ok' : 'err'); };

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const v = email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { say('Enter a valid email address.', false); email.focus(); return; }
    if (!consent.checked) { say('Please tick the box so we can email you.', false); consent.focus(); return; }
    btn.disabled = true; btn.textContent = 'Joining…';
    try {
      const res = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: v, consent: true, website: hp.value, source: 'landing-v11' })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok !== false) {
        say(data.message || "You're on the list.", true);
        form.reset();
      } else {
        say(data.message || 'Something went wrong. Please try again.', false);
      }
    } catch {
      say('Network error. Please try again.', false);
    } finally {
      btn.disabled = false; btn.textContent = 'Join the waitlist';
    }
  });
})();
