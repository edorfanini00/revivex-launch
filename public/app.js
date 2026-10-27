/* Revivex round 3: nav state, reveals, How it works steps, deposit reservation */
(() => {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Nav turns solid once the page moves off the top of the hero */
  const nav = document.getElementById('nav');
  const onNav = () => nav.classList.toggle('scrolled', window.scrollY > 8);
  onNav(); window.addEventListener('scroll', onNav, { passive: true });

  /* Reveal on scroll */
  const io = new IntersectionObserver(es => es.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }), { rootMargin: '0px 0px -10% 0px' });
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));

  /* How it works. Desktop: the section pins while the page scrolls through four steps;
     each step swaps the photo and the real app screen. Phone: a swipe carousel. */
  const row = document.getElementById('hiw');
  const list = document.getElementById('hiwSteps');
  if (row && list) {
    const steps = [...list.querySelectorAll('.hiw-step')];
    const shots = [...row.querySelectorAll('.hiw-shot')];
    const screens = [...row.querySelectorAll('.phone-screen')];
    const phone = row.querySelector('.hiw-phone');
    const count = document.getElementById('hiwCount');
    const prev = document.getElementById('hiwPrev');
    const next = document.getElementById('hiwNext');
    const desktop = window.matchMedia('(min-width: 861px)');
    let active = -1;
    const show = i => {
      if (i === active) return;
      active = i;
      steps.forEach((s, n) => s.classList.toggle('is-on', n === i));
      shots.forEach(s => s.classList.toggle('is-on', Number(s.dataset.step) === i));
      screens.forEach(s => s.classList.toggle('is-on', Number(s.dataset.step) === i));
      if (phone) phone.classList.toggle('is-off', !screens.some(s => Number(s.dataset.step) === i));
      if (count) count.textContent = `0${i + 1} / 0${steps.length}`;
      if (prev) prev.disabled = i === 0;
      if (next) next.disabled = i === steps.length - 1;
    };
    // Scroll distance over which the pinned stage stays in place.
    const span = () => row.offsetHeight - row.querySelector('.hiw-pin').offsetHeight;
    const onScroll = () => {
      if (!desktop.matches) return;
      const p = Math.min(0.999, Math.max(0, -row.getBoundingClientRect().top / Math.max(1, span())));
      show(Math.floor(p * steps.length));
    };
    const toStep = i => {
      if (desktop.matches) {
        const top = row.getBoundingClientRect().top + window.scrollY + span() * (i + 0.5) / steps.length;
        window.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
      } else {
        list.scrollTo({ left: steps[i].offsetLeft - steps[0].offsetLeft, behavior: reduce ? 'auto' : 'smooth' });
      }
    };
    steps.forEach((s, i) => {
      s.addEventListener('click', () => { if (desktop.matches) toStep(i); });
    });
    if (prev) prev.addEventListener('click', () => toStep(Math.max(0, active - 1)));
    if (next) next.addEventListener('click', () => toStep(Math.min(steps.length - 1, active + 1)));
    // Phone: the card whose left edge is nearest the start of the track is the current one.
    let ticking = false;
    list.addEventListener('scroll', () => {
      if (desktop.matches || ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const x = list.scrollLeft, w = steps[1] ? steps[1].offsetLeft - steps[0].offsetLeft : 1;
        show(Math.min(steps.length - 1, Math.round(x / w)));
      });
    }, { passive: true });
    window.addEventListener('scroll', () => requestAnimationFrame(onScroll), { passive: true });
    desktop.addEventListener('change', () => { active = -1; show(0); onScroll(); });
    show(0); onScroll();
  }

  /* Preorder: refundable deposit through Stripe-hosted Checkout.
     Every Preorder button (nav, hero, mid page and the #reserve form) opens checkout
     directly; without JavaScript the links still lead to #reserve. Selecting Preorder
     accepts the deposit terms disclosed on the page, so each request carries
     termsAccepted plus the terms version and amount this page shows (data attributes
     on #depositPanel). A page showing anything other than the server's current offer,
     such as an old cached copy, asks for a reload instead of opening checkout.
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
  const panel = document.getElementById('depositPanel');
  const pageTerms = (panel && panel.dataset.termsVersion) || null;
  const pageAmount = panel ? Number(panel.dataset.depositAmount) : NaN;
  const triggers = [...document.querySelectorAll('[data-checkout]')];
  const labels = new Map(triggers.map(t => [t, t.innerHTML]));
  const notes = new Map();
  const OP_KEY = 'revivex.depositOperation';
  const ATTR_KEY = 'revivex.attribution';
  const AUTO_RETRIES = 2;
  const UNCERTAIN_LIMIT = 6; // unknown outcomes per attempt before the reconcile path
  let available = false, loaded = false, inFlight = false, elsewhere = null, stale = false;

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

  // The form button is disabled in the HTML (no-JS) and enabled once this script runs. It
  // stays disabled (and dimmed by its :disabled style) while checkout is known to be
  // unavailable or the reconcile/restart control is showing, because only that control
  // may start another attempt. Before the configuration arrives it is enabled; a click
  // then waits for it.
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
  const UNCERTAIN = 'We could not confirm the checkout status. Check your card statement or banking app for a Revivex payment before trying again.';
  const RECONCILE = 'We could not confirm whether your earlier checkout attempt was paid. Before reserving again, check your card statement or banking app for a Revivex payment (a receipt email may not arrive). If you were charged, or are unsure, contact support@revivex.store and we will check it for you.';
  const TERMS_CHANGED = 'The deposit terms have been updated. Please reload the page and review them.';

  const config = fetch('/api/checkout', { headers: { Accept: 'application/json' }, cache: 'no-store' })
    .then(r => r.ok ? r.json() : Promise.reject())
    .then(d => {
      // `configured` only means the server has a complete configuration; Stripe can
      // still refuse, which the create step reports. Checkout is only offered on the
      // canonical origin, because the server refuses POSTs from any other host.
      const configured = d.configured === true && typeof d.termsVersion === 'string';
      if (d.mode === 'test') testNote.hidden = false;
      if (configured && (d.termsVersion !== pageTerms || d.amount !== pageAmount)) {
        available = false;
        stale = true;
        say(TERMS_CHANGED, false);
      } else if (configured && d.siteOrigin && d.siteOrigin !== location.origin) {
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
        body: JSON.stringify({ termsAccepted: true, termsVersion: pageTerms, displayedAmount: pageAmount, ...body }),
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
        if (stale) fail(TERMS_CHANGED, true);
        else if (!elsewhere) fail(UNAVAILABLE, true);
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
          // Announced once per operation: Back from Stripe and a retry replay the same
          // session, so the stored operation remembers that it was already announced.
          if (!op.announced) {
            op.announced = true;
            saveOp(op);
            try { window.dispatchEvent(new CustomEvent('revivex:checkout-opening', { detail: { operation: op.token } })); } catch { /* never block checkout */ }
          }
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
        // offer_changed: the token was issued for the previous deposit amount.
        const stopped = d.state === 'reconcile' || d.state === 'invalid_operation' || d.state === 'offer_changed';
        if (stopped && d.preWrite === true && !wasAttempted && fresh === 0) {
          // Neither this request nor any earlier one sent this token to Stripe, so
          // replacing it cannot duplicate anything.
          dropOp(); op = null; fresh++;
          continue;
        }
        if (stopped) {
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

  // With the script running the Preorder links act as buttons: announced as buttons and
  // activated by Enter (native link behaviour) and Space. Space does not scroll the page;
  // like a native button it activates on release, once however long it is held, and it
  // goes through the same click path and in-flight guard as a pointer click.
  for (const t of triggers) {
    if (t === btn) continue;
    t.setAttribute('role', 'button');
    let spaceDown = false;
    t.addEventListener('keydown', e => {
      if (e.key !== ' ' || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      if (!e.repeat) spaceDown = true;
    });
    t.addEventListener('keyup', e => {
      if (e.key !== ' ') return;
      e.preventDefault();
      if (spaceDown) { spaceDown = false; t.click(); }
    });
    t.addEventListener('blur', () => { spaceDown = false; });
  }
  // Without the script the section button stays disabled (nothing could take a deposit).
  refresh();
})();
