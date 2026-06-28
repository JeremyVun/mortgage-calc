/* ============================ DOM helpers ============================ */
export function byId(id) { return document.getElementById(id); }

export const NARROW = window.matchMedia ? window.matchMedia("(max-width: 520px)") : { matches: false, addEventListener() {} };
export const REDUCE_MOTION = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };

/* ============================ Number animation ============================ */
export const anim = new WeakMap();
export function setNum(el, value, fmt) {
  const target = isFinite(value) ? value : 0;
  const prev = anim.get(el);
  if (REDUCE_MOTION.matches) { if (el._raf) cancelAnimationFrame(el._raf); anim.set(el, target); el.textContent = fmt(target); return; }
  if (prev === undefined || Math.abs(target) < 1e-9 && prev === 0) { anim.set(el, target); el.textContent = fmt(target); return; }
  if (prev === target) { el.textContent = fmt(target); return; }
  const start = prev, t0 = performance.now(), dur = 420;
  if (el._raf) cancelAnimationFrame(el._raf);
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    const cur = start + (target - start) * e;
    el.textContent = fmt(cur);
    if (k < 1) el._raf = requestAnimationFrame(step);
    else { anim.set(el, target); el.textContent = fmt(target); }
  };
  el._raf = requestAnimationFrame(step);
}

/* Reflect a value across a segmented-button group (sets .on + aria-pressed). */
export function segState(segId, attr, value) {
  byId(segId).querySelectorAll("button").forEach((b) => {
    const on = b.dataset[attr] === value;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
}

/* ============================ SVG icons ============================ */
// Padlock icon; `closed` swaps only the shackle path tail (full loop vs open hook).
export function lockSVG(closed) {
  const d = closed ? "8 0v4" : "7.5-1.5";
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 ${d}"/></svg>`;
}
