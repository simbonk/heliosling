export const $ = (s) => document.querySelector(s);

export function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

// Phones: act on finger lift instead of waiting for the browser's synthesized click. That click
// gets dropped when the main thread is busy or when the HUD re-renders the button mid-tap,
// which is what made buttons feel sticky. Whatever button is under the finger at lift wins.
export function installFastTap() {
  let down = null, swallowUntil = 0;
  const target = (e) => e.target.closest?.('button, .chip, [data-tap]');
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    const b = target(e);
    down = b ? { id: e.pointerId, x: e.clientX, y: e.clientY, b } : null;
    b?.classList.add('pressed');
  }, true);
  const clear = () => { down?.b.classList.remove('pressed'); down = null; };
  document.addEventListener('pointercancel', clear, true);
  document.addEventListener('pointerup', (e) => {
    if (!down || e.pointerId !== down.id) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    clear();
    if (moved > 14) return; // a scroll or a drag, not a tap
    const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('button, .chip, [data-tap]');
    if (!hit || hit.disabled) return;
    swallowUntil = performance.now() + 600;
    hit.click();
  }, true);
  // the browser's own click for the same tap arrives later; drop it so nothing fires twice
  document.addEventListener('click', (e) => {
    if (e.isTrusted && performance.now() < swallowUntil && e.detail > 0) { e.preventDefault(); e.stopPropagation(); swallowUntil = 0; }
  }, true);
}

let lastFocus = null;
export function modal({ title, body, actions = [] }) {
  closeModal();
  lastFocus = document.activeElement;
  const root = $('#modal-root');
  const card = el('div', 'modal', `<h2>${title}</h2><div class="modal-body">${body}</div><div class="modal-actions"></div>`);
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  const acts = card.querySelector('.modal-actions');
  for (const a of actions) {
    const b = el('button', a.primary ? 'primary' : '', a.label);
    b.onclick = a.onClick;
    acts.appendChild(b);
  }
  const scrim = el('div', 'scrim');
  scrim.onclick = (e) => { if (e.target === scrim && actions.length) { /* require an explicit choice */ } };
  scrim.appendChild(card);
  root.appendChild(scrim);
  (acts.querySelector('.primary') || acts.querySelector('button'))?.focus();
}

export function closeModal() {
  $('#modal-root').innerHTML = '';
  lastFocus?.focus?.();
  lastFocus = null;
}

// Bottom sheet on phones, side panel on desktop.
export function sheet(title, html, wire) {
  closeModal();
  const root = $('#modal-root');
  const scrim = el('div', 'scrim sheet-scrim');
  const s = el('div', 'sheet', `<div class="grab"></div><header><h2>${title}</h2><button class="x" aria-label="Close">✕</button></header><div class="sheet-body">${html}</div>`);
  s.setAttribute('role', 'dialog');
  scrim.appendChild(s);
  root.appendChild(scrim);
  scrim.onclick = (e) => { if (e.target === scrim) closeModal(); };
  s.querySelector('.x').onclick = closeModal;
  wire?.(s);
  return s;
}

export function toast(html, kind = '') {
  const box = $('#toasts');
  const t = el('div', `toast ${kind}`, html);
  box.appendChild(t);
  while (box.children.length > 3) box.firstChild.remove();
  if (kind !== 'sticky') setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, kind === 'achievement' ? 4200 : 3200);
  else setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, 15000);
  return t;
}

const EARTH = 3.0035e-6, MSUN_KG = 1.989e30;
export function fmtMass(m, short) {
  if (m >= 0.01) return `${+m.toPrecision(3)} M☉`;
  if (m >= EARTH * 0.01) return `${+(m / EARTH).toPrecision(3)} M⊕`;
  const kg = m * MSUN_KG;
  const e = Math.floor(Math.log10(kg));
  return short ? `10^${e} kg` : `${(kg / 10 ** e).toFixed(1)}×10<sup>${e}</sup> kg`;
}

export function fmtNum(n) {
  return n >= 1000 ? Math.round(n).toLocaleString('en-US') : n.toPrecision(3);
}
