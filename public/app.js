/* Revivex v10 — scroll-scrubbed hero, reveals, parallax, deposit reservation */
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
  // Phones get native portrait frames (1080x1920) so nothing is upscaled from a desktop crop.
  const MOBILE = window.matchMedia('(max-width: 640px), (orientation: portrait) and (max-width: 900px)').matches;
  const FRAMES = MOBILE ? '/assets/v11/frames-m-opt/' : '/assets/v11/frames-opt/';
  const frames = [];
  let count = 0, current = -1, ready = false;

  function size() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    current = -1; render();
  }
  function draw(img) {
    const cw = canvas.width, ch = canvas.height;
    const s = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
    const w = img.naturalWidth * s, h = img.naturalHeight * s;
    const focusX = MOBILE ? 0.5 : 0.64;
    const x = (cw - w) * focusX, y = (ch - h) / 2;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
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
    fetch(FRAMES + 'manifest.json').then(r => r.ok ? r.json() : Promise.reject()).then(m => {
      count = m.frameCount;
      for (let i = 1; i <= count; i++) {
        const img = new Image();
        img.decoding = 'async';
        img.src = `${FRAMES}f-${String(i).padStart(4, '0')}.${m.ext}`;
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

  /* Preorder: refundable $100 deposit through Stripe-hosted Checkout.
     Every Preorder button (nav, hero, mid page and the #reserve form) opens checkout
     directly; without JavaScript the links still lead to #reserve. Selecting Preorder
     accepts the deposit terms disclosed next to the buttons, so each request carries
     termsAccepted and the current terms version.
     The server fixes amount, price and redirect URLs. Each checkout attempt uses one
     signed operation token issued by the server (no Stripe call) and kept in
     sessionStorage with an "attempted" flag. Retries re-send the same token so Stripe
     replays the same session. A token that was ever sent for creation is never silently
     replaced: if the server cannot use it any more, or the outcome stays unknown after
     a bounded number of tries, the visitor is asked to check their card statement or
     contact support first, and only an explicit click starts a new reservation. */
  const form = document.getElementById('reserveForm');
  const btn = document.getElementById('reserveBtn');
  const restart = document.getElementById('reserveRestart');
  const msg = document.getElementById('reserveMsg');
  const testNote = document.getElementById('testModeNote');
  const triggers = [...document.querySelectorAll('[data-checkout]')];
  const labels = new Map(triggers.map(t => [t, t.innerHTML]));
  const notes = new Map();
  const OP_KEY = 'revivex.depositOperation';
  const ATTR_KEY = 'revivex.attribution';
  const AUTO_RETRIES = 2;
  const UNCERTAIN_LIMIT = 6; // unknown outcomes per attempt before the reconcile path
  let available = false, loaded = false, termsVersion = null, inFlight = false, elsewhere = null;

  // Messages show next to the button that was used: #reserveMsg for the form button,
  // a small status line created on first use for the others.
  const msgFor = t => {
    if (!t || t === btn) return msg;
    if (!notes.has(t)) {
      const p = document.createElement('p');
      p.className = 'form-msg cta-msg';
      p.setAttribute('role', 'status');
      p.setAttribute('aria-live', 'polite');
      t.insertAdjacentElement('afterend', p);
      notes.set(t, p);
    }
    return notes.get(t);
  };
  const say = (t, ok, el = msg) => { el.textContent = t || ''; el.className = (el === msg ? 'form-msg ' : 'form-msg cta-msg ') + (ok ? 'ok' : 'err'); };
  const clearAll = () => { say('', true); notes.forEach(p => say('', true, p)); };
  // Off the canonical host the visitor gets a link to it instead of a checkout.
  const sayElsewhere = el => {
    say('Reservations are taken on ', false, el);
    const a = document.createElement('a');
    a.href = elsewhere + '/#reserve';
    a.textContent = elsewhere.replace(/^https?:\/\//, '');
    el.append(a, '.');
  };
  const memory = {};
  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return memory[k] || null; } },
    set(k, v) { memory[k] = v; try { sessionStorage.setItem(k, v); } catch { /* storage blocked: memory only */ } },
    del(k) { delete memory[k]; try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
  };
  const readOp = () => { try { const o = JSON.parse(store.get(OP_KEY) || 'null'); return o && typeof o.token === 'string' ? o : null; } catch { return null; } };
  const saveOp = o => store.set(OP_KEY, JSON.stringify(o));
  const dropOp = () => store.del(OP_KEY);

  /* Campaign attribution: first allowlisted UTM values seen in this tab. The server
     re-validates them and binds them into the operation token. Nothing else is read. */
  (() => {
    const q = new URLSearchParams(location.search), a = {};
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']) {
      const v = q.get(k);
      if (v && /^[a-z0-9][a-z0-9_]{0,39}$/.test(v)) a[k] = v;
    }
    if (Object.keys(a).length && !store.get(ATTR_KEY)) store.set(ATTR_KEY, JSON.stringify(a));
  })();
  const attribution = () => { try { return JSON.parse(store.get(ATTR_KEY) || '{}'); } catch { return {}; } };

  // The form button stays disabled (and dimmed by its :disabled style) while checkout is
  // known to be unavailable or the reconcile/restart control is showing, because only
  // that control may start another attempt. Before the configuration arrives it stays
  // enabled; a click then waits for it.
  const refresh = () => { btn.disabled = inFlight || (loaded && !available) || !restart.hidden; };
  function busy(t) {
    t.setAttribute('aria-busy', 'true');
    t.setAttribute('aria-disabled', 'true');
    t.style.minWidth = `${t.offsetWidth}px`; // never narrower than the label it replaces
    t.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span><span>Opening<span class="busy-more"> checkout</span>…</span>';
  }
  function idle() {
    inFlight = false;
    for (const t of triggers) {
      if (t.hasAttribute('aria-busy')) { t.innerHTML = labels.get(t); t.style.minWidth = ''; }
      t.removeAttribute('aria-busy');
      t.removeAttribute('aria-disabled');
    }
    refresh();
  }
  const UNAVAILABLE = 'Reservations are temporarily unavailable. This page cannot open a checkout right now.';
  const UNCERTAIN = 'We could not confirm the checkout status. Check your card statement or banking app for a $100 Revivex payment before trying again.';
  const RECONCILE = 'We could not confirm whether your earlier checkout attempt was paid. Before reserving again, check your card statement or banking app for a $100 Revivex payment (a receipt email may not arrive). If you were charged, or are unsure, contact support@revivex.store and we will check it for you.';

  const config = fetch('/api/checkout', { headers: { Accept: 'application/json' }, cache: 'no-store' })
    .then(r => r.ok ? r.json() : Promise.reject())
    .then(d => {
      // `configured` only means the server has a complete configuration; Stripe can
      // still refuse, which the create step reports. Checkout is only offered on the
      // canonical origin, because the server refuses POSTs from any other host.
      const configured = d.configured === true && typeof d.termsVersion === 'string';
      termsVersion = d.termsVersion;
      if (d.mode === 'test') testNote.hidden = false;
      if (configured && d.siteOrigin && d.siteOrigin !== location.origin) {
        available = false;
        elsewhere = d.siteOrigin;
        sayElsewhere(msg);
      } else {
        available = configured;
        if (!available) say(UNAVAILABLE, false);
      }
    })
    .catch(() => { available = false; say(UNAVAILABLE, false); })
    .finally(() => { loaded = true; refresh(); });

  // Coming back from Stripe with the Back button can restore a frozen "busy" page.
  window.addEventListener('pageshow', e => { if (e.persisted) idle(); });

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function post(body) {
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({ termsAccepted: true, termsVersion, ...body }),
      });
      return await res.json().catch(() => ({ state: 'uncertain' }));
    } catch {
      return { state: 'uncertain' };
    }
  }
  async function begin() {
    const d = await post({ step: 'start', attribution: attribution() });
    if (d.state !== 'started' || typeof d.operation !== 'string') return { error: d };
    const op = { token: d.operation, attempted: false };
    saveOp(op);
    return { op };
  }

  restart.addEventListener('click', () => {
    dropOp();
    restart.hidden = true;
    clearAll();
    refresh();
    btn.focus();
  });

  async function open(trigger) {
    inFlight = true;
    let leaving = false;
    busy(trigger);
    refresh();
    clearAll();
    const out = msgFor(trigger);
    // Reconcile copy also goes to the #reserve section, where the restart control is.
    const fail = (t, both) => { say(t, false, out); if (both && out !== msg) say(t, false, msg); };
    try {
      await config;
      if (!available) {
        if (!elsewhere) fail(UNAVAILABLE, true);
        else { sayElsewhere(out); if (out !== msg) sayElsewhere(msg); }
        return;
      }
      let op = readOp(), fresh = 0;
      for (let n = 0; ; ) {
        if (!op) {
          const b = await begin();
          if (b.error) {
            // No checkout was created by this request; uncertain only if the network failed.
            if (b.error.state === 'unavailable') available = false;
            fail(b.error.message || (b.error.state === 'uncertain' ? 'Checkout could not be opened. Please try again.' : UNAVAILABLE), !available);
            break;
          }
          op = b.op;
        }
        const wasAttempted = op.attempted === true;
        op.attempted = true;
        saveOp(op);
        const d = await post({ step: 'create', operation: op.token });

        if (d.state === 'redirect' && typeof d.url === 'string' && d.url.startsWith('https://checkout.stripe.com/')) {
          leaving = true; // keep the button busy while the browser leaves
          // Measurement hook (public/meta-pixel.js): checkout is opening for this operation.
          try { window.dispatchEvent(new CustomEvent('revivex:checkout-opening', { detail: { operation: op.token } })); } catch { /* never block checkout */ }
          window.location.assign(d.url);
          return;
        }
        if (d.state === 'complete' && typeof d.reservationUrl === 'string' && d.reservationUrl.startsWith('/reservation.html?session_id=')) {
          leaving = true;
          window.location.assign(d.reservationUrl);
          return;
        }
        if (d.state === 'uncertain') {
          op.uncertain = (op.uncertain || 0) + 1;
          saveOp(op);
          if (op.uncertain >= UNCERTAIN_LIMIT) { fail(RECONCILE, true); restart.hidden = false; break; }
          if (n < AUTO_RETRIES) { n++; await sleep(1200 * n); continue; }
        } else if (op.uncertain) { op.uncertain = 0; saveOp(op); }
        if (d.state === 'expired') { dropOp(); fail(d.message); break; }
        if ((d.state === 'reconcile' || d.state === 'invalid_operation') && d.preWrite === true && !wasAttempted && fresh === 0) {
          // Neither this request nor any earlier one sent this token to Stripe, so
          // replacing it cannot duplicate anything.
          dropOp(); op = null; fresh++;
          continue;
        }
        if (d.state === 'reconcile' || d.state === 'invalid_operation') {
          // Ask before ever starting another attempt that could take a second deposit.
          fail(d.message || RECONCILE, true);
          restart.hidden = false;
          break;
        }
        if (d.state === 'unavailable') available = false;
        fail(d.message || UNCERTAIN, !available);
        break;
      }
    } finally {
      if (!leaving) idle();
    }
  }

  function onTrigger(e, trigger) {
    // Modified clicks (new tab or window) keep the plain link behaviour.
    if (e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    // While the reconcile/restart control is showing, no button may start another
    // attempt; the links fall back to scrolling to #reserve, where it is shown.
    if (!restart.hidden && trigger !== btn) return;
    e.preventDefault();
    if (inFlight || !restart.hidden) return;
    open(trigger);
  }
  for (const t of triggers) if (t !== btn) t.addEventListener('click', e => onTrigger(e, t));
  form.addEventListener('submit', e => onTrigger(e, btn));
})();
