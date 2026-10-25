// scenecast recording overlay. Injected with context.addInitScript into every document of a take.
// Draws the cursor, click ripples, highlight rings and the magenta flash marker, inside a closed
// shadow root on a host marked [data-scenecast-overlay] so it never takes part in element lookup or
// box measurement. Exposes window.__scenecast for the recorder. No external assets.
(() => {
  if (window.top !== window || window.__scenecast) return;

  const CURSOR_PX = 28;
  const RING = { color: '#F5C518', width: 3, opacity: 0.9, fadeMs: 150, radius: 10 };
  const POS_KEY = '__scenecastCursor';
  const now = () => performance.timeOrigin + performance.now();

  const host = document.createElement('div');
  host.setAttribute('data-scenecast-overlay', '');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .layer { position: fixed; inset: 0; pointer-events: none; overflow: hidden; }
      .cursor { position: absolute; left: 0; top: 0; width: ${CURSOR_PX}px; height: ${CURSOR_PX}px; will-change: transform; display: none; }
      .ripple { position: absolute; width: 36px; height: 36px; margin: -18px 0 0 -18px; border-radius: 50%;
        background: rgba(255,255,255,0.55); box-shadow: 0 0 0 2px rgba(30,30,30,0.35);
        animation: ripple 420ms ease-out forwards; }
      @keyframes ripple { from { transform: scale(0.2); opacity: 0.9; } to { transform: scale(1.6); opacity: 0; } }
      .ring { position: absolute; box-sizing: border-box; border: ${RING.width}px solid ${RING.color};
        border-radius: ${RING.radius}px; opacity: 0; transition: opacity ${RING.fadeMs}ms ease; }
      .flash { position: fixed; inset: 0; background: #FF00FF; }
      .nudge { position: absolute; left: 0; top: 0; width: 1px; height: 1px; background: #000; opacity: 0.01; }
    </style>
    <div class="layer">
      <div class="nudge"></div>
      <svg class="cursor" viewBox="0 0 28 28" aria-hidden="true">
        <path d="M3 2 L3 23 L8.6 18 L12.4 26.2 L16.2 24.5 L12.5 16.6 L20 16.4 Z"
          fill="#ffffff" stroke="#1a1a1a" stroke-width="1.6" stroke-linejoin="round" />
      </svg>
    </div>`;
  const layer = shadow.querySelector('.layer');
  const nudgeEl = shadow.querySelector('.nudge');
  /** Frames repainted after a ring goes: a frame with the ring half faded must not be the take's last. */
  const NUDGE_FRAMES = 8;
  let ringsUp = 0;
  let nudging = Promise.resolve();
  let idleWaiters = [];

  /**
   * Repaint a 1 px, 1% speck for a few frames. While the page is otherwise still, Chromium's screencast
   * only sends a frame when something changes; under load it can drop the frame that removed the ring and
   * keep showing a half-faded ring until the next change. These changed frames carry the ring-free page.
   */
  function nudge() {
    nudging = new Promise((resolve) => {
      let n = 0;
      const step = () => {
        nudgeEl.style.opacity = n % 2 ? '0.01' : '0.02';
        if (++n < NUDGE_FRAMES) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    return nudging;
  }
  function settleIdle() {
    if (ringsUp > 0) return;
    nudging.then(() => {
      if (ringsUp > 0) return;
      const waiters = idleWaiters;
      idleWaiters = [];
      waiters.forEach((w) => w());
    });
  }
  const cursor = shadow.querySelector('.cursor');

  let pos = null;
  try {
    pos = JSON.parse(sessionStorage.getItem(POS_KEY) || 'null');
  } catch {}

  function place(x, y) {
    pos = { x, y };
    cursor.style.display = 'block';
    // the arrow tip sits at (3, 2) in the 28 px box
    cursor.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
  }
  function remember() {
    try {
      sessionStorage.setItem(POS_KEY, JSON.stringify(pos));
    } catch {}
  }

  function mount() {
    if (!host.isConnected) document.documentElement.appendChild(host);
    if (pos) place(pos.x, pos.y);
  }
  if (document.documentElement) mount();
  else document.addEventListener('readystatechange', mount, { once: true });
  // some apps replace <html> children wholesale; keep the overlay attached
  document.addEventListener('DOMContentLoaded', mount);

  const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  window.__scenecast = {
    /** Put the cursor at (x, y) CSS px with no visible travel. */
    cursor(x, y) {
      mount();
      place(x, y);
      remember();
    },
    /** Glide to (x, y) on an eased, slightly curved cubic path, arriving at epoch ms `endAt`. */
    moveTo(x, y, endAt) {
      mount();
      const from = pos || { x, y };
      const start = now();
      const span = Math.max(1, endAt - start);
      const dx = x - from.x;
      const dy = y - from.y;
      // control points pushed sideways by 8% of the distance for a gentle arc
      const bend = 0.08;
      const c1 = { x: from.x + dx / 3 - dy * bend, y: from.y + dy / 3 + dx * bend };
      const c2 = { x: from.x + (2 * dx) / 3 - dy * bend, y: from.y + (2 * dy) / 3 + dx * bend };
      const bez = (a, b, c, d, t) => {
        const u = 1 - t;
        return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
      };
      const tick = () => {
        const t = Math.min(1, (now() - start) / span);
        const e = easeInOutCubic(t);
        place(bez(from.x, c1.x, c2.x, x, e), bez(from.y, c1.y, c2.y, y, e));
        if (t < 1) requestAnimationFrame(tick);
        else remember();
      };
      requestAnimationFrame(tick);
    },
    /** Soft click ripple at (x, y). */
    ripple(x, y) {
      mount();
      const r = document.createElement('div');
      r.className = 'ripple';
      r.style.left = `${x}px`;
      r.style.top = `${y}px`;
      layer.insertBefore(r, cursor);
      setTimeout(() => r.remove(), 500);
    },
    /** Highlight ring around a CSS-px box: fades in, holds `holdMs`, fades out. */
    ring(box, holdMs) {
      mount();
      const r = document.createElement('div');
      r.className = 'ring';
      Object.assign(r.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
      layer.insertBefore(r, cursor);
      ringsUp++;
      requestAnimationFrame(() => requestAnimationFrame(() => (r.style.opacity = String(RING.opacity))));
      setTimeout(() => (r.style.opacity = '0'), RING.fadeMs + holdMs);
      setTimeout(() => {
        r.remove();
        ringsUp--;
        nudge();
        settleIdle();
      }, 2 * RING.fadeMs + holdMs + 50);
    },
    /** Resolves once no ring is up and the repaints after the last one removed have run. */
    ringsGone() {
      if (ringsUp === 0) return nudging;
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    /**
     * Full-viewport magenta flash held for at least `minMs`. Resolves with the epoch ms stamped in the
     * second animation frame, i.e. just after the first frame with the flash was painted: the take's t = 0.
     */
    flash(minMs) {
      mount();
      const f = document.createElement('div');
      f.className = 'flash';
      layer.appendChild(f);
      return new Promise((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const shownAt = now();
            const tick = () => {
              if (now() - shownAt >= minMs) {
                f.remove();
                resolve(shownAt);
              } else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }),
        );
      });
    },
  };
})();
