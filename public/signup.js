/* Early access signup modal, opened by every CTA on the page ([data-signup]).
   Success is shown only after POST /api/signup answers 200 with { ok: true }, which the
   server sends only once the row is committed. Every other outcome shows an inline
   error and keeps the form. On a first signup the server returns a Lead event id;
   "revivex:lead" hands it to the Meta pixel (public/meta-pixel.js), which sends the
   browser copy of the server's Lead with the same id. */
import { COUNTRIES, isCountryCode } from './countries.js';

const root = document.getElementById('signup');
if (root) init();

function init() {
  const card = root.querySelector('.signup-card');
  const form = document.getElementById('signupForm');
  const email = document.getElementById('signupEmail');
  const submit = document.getElementById('signupSubmit');
  const errorEl = document.getElementById('signupError');
  const done = document.getElementById('signupDone');
  const toggle = document.getElementById('countryToggle');
  const valueEl = document.getElementById('countryValue');
  const pop = document.getElementById('countryPop');
  const search = document.getElementById('countrySearch');
  const list = document.getElementById('countryList');
  const none = document.getElementById('countryNone');
  const triggers = [...document.querySelectorAll('[data-signup]')];
  const ATTR_KEY = 'revivex.attribution';
  const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[A-Za-z]{2,63}$/;
  let opener = null, source = 'other', country = '', sending = false, hinted = false, active = -1, unlockScroll = null;

  /* Campaign labels from the landing URL, first seen in this tab (the server re-validates). */
  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* storage blocked */ } },
  };
  (() => {
    const q = new URLSearchParams(location.search), a = {};
    for (const k of UTM) { const v = (q.get(k) || '').trim(); if (v && v.length <= 100) a[k] = v; }
    if (Object.keys(a).length && !store.get(ATTR_KEY)) store.set(ATTR_KEY, JSON.stringify(a));
  })();
  const attribution = () => { try { const a = JSON.parse(store.get(ATTR_KEY) || '{}'); return a && typeof a === 'object' ? a : {}; } catch { return {}; } };

  /* ---------- Country dropdown (searchable listbox) ---------- */
  const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const options = COUNTRIES.map(([code, name]) => {
    const li = document.createElement('li');
    li.id = `country-${code}`;
    li.className = 'country-option';
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    li.dataset.code = code;
    li.textContent = name;
    list.append(li);
    const key = fold(name);
    return { code, name, key, words: key.split(/[\s(),.'’]+/).filter(Boolean), li };
  });
  const visible = () => options.filter(o => !o.li.hidden);
  function setActive(i) {
    const v = visible();
    if (active > -1 && v[active]) v[active].li.classList.remove('is-active');
    active = v.length ? Math.max(0, Math.min(i, v.length - 1)) : -1;
    if (active > -1) {
      v[active].li.classList.add('is-active');
      search.setAttribute('aria-activedescendant', v[active].li.id);
      v[active].li.scrollIntoView({ block: 'nearest' });
    } else search.removeAttribute('aria-activedescendant');
  }
  function filter() {
    const q = fold(search.value.trim());
    // A name matches when it, or any word in it, starts with the query ("king" finds
    // United Kingdom), or when the query is its two letter code.
    for (const o of options) o.li.hidden = !!q && !o.key.startsWith(q) && !o.words.some(w => w.startsWith(q)) && o.code.toLowerCase() !== q;
    const v = visible();
    none.hidden = v.length > 0;
    active = -1;
    setActive(q ? 0 : Math.max(0, v.findIndex(o => o.code === country)));
  }
  function choose(code, { silent } = {}) {
    if (!isCountryCode(code)) return;
    country = code;
    for (const o of options) o.li.setAttribute('aria-selected', String(o.code === code));
    valueEl.textContent = options.find(o => o.code === code).name;
    valueEl.classList.remove('is-empty');
    toggle.classList.remove('is-invalid');
    toggle.removeAttribute('aria-invalid');
    if (!silent && /country/i.test(errorEl.dataset.field || '')) clearError();
  }
  const popOpen = () => !pop.hidden;
  function openPop(seed = '') {
    pop.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    search.value = seed;
    filter();
    search.focus({ preventScroll: true });
    // Keep the open list in view inside the card (small screens, keyboard open).
    requestAnimationFrame(() => pop.scrollIntoView({ block: 'nearest' }));
  }
  function closePop({ focus = true } = {}) {
    if (!popOpen()) return;
    pop.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    if (focus) toggle.focus({ preventScroll: true });
  }
  toggle.addEventListener('click', () => (popOpen() ? closePop() : openPop()));
  toggle.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openPop(); }
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); openPop(e.key); }
  });
  search.addEventListener('input', filter);
  search.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Home' && !search.value) { e.preventDefault(); setActive(0); }
    else if (e.key === 'End' && !search.value) { e.preventDefault(); setActive(visible().length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); const v = visible()[active]; if (v) { choose(v.code); closePop(); } }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(); }
    else if (e.key === 'Tab') closePop({ focus: false });
  });
  list.addEventListener('mousedown', e => e.preventDefault()); // keep focus in the search box
  list.addEventListener('click', e => {
    const li = e.target.closest('.country-option');
    if (li) { choose(li.dataset.code); closePop(); }
  });
  document.addEventListener('pointerdown', e => {
    if (popOpen() && !e.target.closest('#country')) closePop({ focus: false });
  });

  // Default to the visitor's country when the edge reports one (Vercel x-vercel-ip-country).
  function hint() {
    if (hinted) return;
    hinted = true;
    fetch('/api/signup', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d && !country && isCountryCode(d.country)) choose(d.country, { silent: true }); })
      .catch(() => { /* leave it empty */ });
  }

  /* ---------- Errors and submit ---------- */
  function showError(text, field) {
    errorEl.textContent = text;
    errorEl.dataset.field = field || '';
    email.toggleAttribute('aria-invalid', field === 'email');
    email.classList.toggle('is-invalid', field === 'email');
    toggle.toggleAttribute('aria-invalid', field === 'country');
    toggle.classList.toggle('is-invalid', field === 'country');
  }
  function clearError() { showError('', ''); }
  email.addEventListener('input', () => { if (errorEl.dataset.field === 'email') clearError(); });

  const NETWORK = "We couldn't reach our server, so nothing was saved. Check your connection and try again.";
  const SERVER = 'We could not save your signup, so nothing was saved. Please try again in a moment.';
  function busy(on) {
    sending = on;
    submit.disabled = on;
    submit.toggleAttribute('aria-busy', on);
    submit.querySelector('.signup-submit-label').textContent = on ? 'Please wait' : 'Get early access';
    if (on) submit.insertAdjacentHTML('afterbegin', '<span class="btn-spinner" aria-hidden="true"></span>');
    else submit.querySelector('.btn-spinner')?.remove();
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (sending) return;
    const value = email.value.trim();
    if (!value) return showError('Enter your email address.', 'email'), email.focus();
    if (!EMAIL_RE.test(value) || value.length > 254) return showError('Enter a valid email address.', 'email'), email.focus();
    if (!isCountryCode(country)) return showError('Choose your country.', 'country'), toggle.focus();
    clearError();
    busy(true);
    let res = null, data = null;
    try {
      res = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({ email: value, country, source, attribution: attribution(), hp_extra: form.elements.hp_extra.value }),
      });
      data = await res.json().catch(() => null);
    } catch {
      busy(false);
      return showError(NETWORK, 'network');
    }
    busy(false);
    if (res.status === 200 && data && data.ok === true) return success(data);
    const field = data && data.error === 'invalid_email' ? 'email' : data && data.error === 'invalid_country' ? 'country' : 'server';
    const text = data && data.ok === false && typeof data.message === 'string' && data.message.length < 200 ? data.message : SERVER;
    showError(text, field);
    if (field === 'email') email.focus();
  });

  function success(data) {
    form.hidden = true;
    done.hidden = false;
    done.focus({ preventScroll: true });
    if (typeof data.lead === 'string' && data.lead) {
      try { window.dispatchEvent(new CustomEvent('revivex:lead', { detail: { eventId: data.lead } })); } catch { /* never block the signup */ }
    }
  }

  /* ---------- Open / close, focus trap, scroll lock ---------- */
  const isOpen = () => !root.hidden;
  const focusables = () => [...card.querySelectorAll('button, input, [href], [tabindex]:not([tabindex="-1"])')]
    .filter(el => !el.disabled && el.tabIndex !== -1 && el.getClientRects().length && !el.closest('[hidden], .signup-hp'));
  const outside = () => [...document.body.children].filter(el => el !== root && el.tagName !== 'SCRIPT');

  // The visual viewport shrinks when the phone keyboard opens: size the overlay to it so
  // the card stays reachable and scrolls inside itself.
  const vv = window.visualViewport;
  function fit() {
    if (!vv) return;
    root.style.height = `${Math.round(vv.height)}px`;
    root.style.top = `${Math.round(vv.offsetTop)}px`;
  }

  function lockScroll() {
    const html = document.documentElement;
    const gap = window.innerWidth - html.clientWidth;
    html.classList.add('signup-open');
    if (gap > 0) document.body.style.paddingRight = `${gap}px`;
    return () => { html.classList.remove('signup-open'); document.body.style.paddingRight = ''; };
  }

  function open(trigger) {
    if (isOpen()) return;
    opener = trigger || document.activeElement;
    source = (trigger && trigger.dataset.signup) || 'other';
    root.hidden = false;
    unlockScroll = lockScroll();
    for (const el of outside()) el.inert = true;
    fit();
    if (vv) { vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); }
    requestAnimationFrame(() => root.classList.add('is-open'));
    hint();
    // Phones: focus the dialog itself so the keyboard does not cover the card on open.
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const first = done.hidden ? (coarse ? card : email) : done;
    first.focus({ preventScroll: true });
  }
  function close() {
    if (!isOpen()) return;
    closePop({ focus: false });
    root.classList.remove('is-open');
    root.hidden = true;
    for (const el of outside()) el.inert = false;
    if (unlockScroll) { unlockScroll(); unlockScroll = null; }
    if (vv) { vv.removeEventListener('resize', fit); vv.removeEventListener('scroll', fit); }
    root.style.height = root.style.top = '';
    if (opener && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
    opener = null;
  }
  card.tabIndex = -1;

  root.addEventListener('click', e => { if (e.target.closest('[data-signup-close]')) close(); });
  document.addEventListener('keydown', e => {
    if (!isOpen()) return;
    if (e.key === 'Escape') { e.preventDefault(); if (popOpen()) closePop(); else close(); return; }
    if (e.key !== 'Tab') return;
    const f = focusables();
    if (!f.length) { e.preventDefault(); return; }
    const i = f.indexOf(document.activeElement);
    if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
  });

  for (const t of triggers) {
    t.addEventListener('click', e => {
      // Modified clicks (new tab or window) keep the plain link behaviour.
      if (e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      open(t);
    });
    if (t.tagName === 'A') {
      t.setAttribute('role', 'button');
      t.setAttribute('aria-haspopup', 'dialog');
      t.addEventListener('keydown', e => { if (e.key === ' ') e.preventDefault(); });
      t.addEventListener('keyup', e => { if (e.key === ' ') { e.preventDefault(); t.click(); } });
    } else t.setAttribute('aria-haspopup', 'dialog');
  }
  root.dataset.ready = 'true';
}
