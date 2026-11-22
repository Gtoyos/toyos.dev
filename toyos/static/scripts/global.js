/* global.js — the page title resolves out of scrambled glyphs, left to right. */
(() => {
  const h1 = document.querySelector('main article h1');
  if (!h1 || h1.children.length || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const text = h1.textContent;
  const chars = [...text];
  // no '-' or '/': they are line-break opportunities and would make the title reflow while it decodes
  const pool = '<>_[]{}=+*^#%&0123456789abcdef';
  const D = 900, t0 = performance.now();
  h1.setAttribute('aria-label', text.trim());
  function tick(now) {
    const p = Math.min(1, (now - t0) / D);
    const done = Math.floor(p * chars.length);
    let out = '';
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      out += i < done || /\s/.test(c) ? c : pool[(Math.random() * pool.length) | 0];
    }
    h1.textContent = out;
    if (p < 1) requestAnimationFrame(tick);
    else { h1.textContent = text; h1.removeAttribute('aria-label'); }
  }
  requestAnimationFrame(tick);
})();
