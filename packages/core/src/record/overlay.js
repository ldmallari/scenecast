// scenecast recording overlay. Injected with context.addInitScript into every document of a take.
// Draws the cursor, click ripples, highlight rings and the magenta flash marker, inside a closed
// shadow root on a host marked [data-scenecast-overlay] so it never takes part in element lookup or
// box measurement. Exposes window.__scenecast for the recorder. No external assets.
(() => {
  if (window.top !== window || window.__scenecast) return;

  const CURSOR_PX = 28;
  /** Touch mode (phone takes): a soft fingertip circle instead of the arrow. */
  // Touch mode (phone takes): a dot in the brand accent instead of the arrow. A 40% accent fill, a 3 px solid accent
  // ring and a soft dark shadow, so it reads on white UI and on dark UI alike. The recorder passes the accent
  // (`__scenecastTouchColour`, a #rgb or #rrggbb hex) in the same init script that turns touch mode on.
  const accentHex = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(window.__scenecastTouchColour || '') ? window.__scenecastTouchColour : '#F5C518';
  const rgb = (() => {
    const h = accentHex.slice(1);
    const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)).join(',');
  })();
  const TOUCH = {
    px: 34,
    fill: `rgba(${rgb},0.4)`,
    ring: accentHex,
    ringPx: 3,
    shadow: '0 2px 8px rgba(0,0,0,0.35), 0 0 0 1px rgba(0,0,0,0.18)',
    pressScale: 0.85,
    pressMs: 90,
    fadeOutMs: 250,
  };
  // The recorder sets this in an init script before the overlay runs, so every document of a phone take starts in touch mode.
  let mode = window.__scenecastInitMode === 'touch' ? 'touch' : 'mouse';
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
      .touch { position: absolute; left: 0; top: 0; width: ${TOUCH.px}px; height: ${TOUCH.px}px; box-sizing: border-box;
        margin: ${-TOUCH.px / 2}px 0 0 ${-TOUCH.px / 2}px; border-radius: 50%; background: ${TOUCH.fill};
        border: ${TOUCH.ringPx}px solid ${TOUCH.ring}; box-shadow: ${TOUCH.shadow};
        opacity: 0; display: none; will-change: transform, opacity; }
      .nudge { position: absolute; left: 0; top: 0; width: 1px; height: 1px; background: #000; opacity: 0.01; }
    </style>
    <div class="layer">
      <div class="nudge"></div>
      <div class="touch"></div>
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
  const touchEl = shadow.querySelector('.touch');
  /** The running touch animation; a new touch replaces it. */
  let touchRun = 0;
  const TOUCH_KEY = '__scenecastTouch';

  /**
   * Fades the indicator at (x, y) from opacity `from` (at epoch ms `start`) to 1 at `endAt`, then presses it to 0.85
   * and fades it out. Timed on the epoch clock, so a tap that navigates carries on in the next document.
   */
  function animateTouch(x, y, start, endAt, from, press) {
    const run = ++touchRun;
    touchEl.style.display = 'block';
    touchEl.style.left = `${x}px`;
    touchEl.style.top = `${y}px`;
    const tick = () => {
      if (run !== touchRun) return;
      const t = now();
      let opacity;
      let scale = 1;
      if (t < endAt) opacity = from + (1 - from) * Math.min(1, (t - start) / Math.max(1, endAt - start));
      else {
        const after = t - endAt;
        const p = Math.min(1, after / TOUCH.pressMs);
        // A hover shows the finger resting there: no press.
        if (press !== false) scale = 1 - (1 - TOUCH.pressScale) * (1 - (1 - p) * (1 - p));
        opacity = after <= TOUCH.pressMs ? 1 : Math.max(0, 1 - (after - TOUCH.pressMs) / TOUCH.fadeOutMs);
      }
      touchEl.style.opacity = String(opacity);
      touchEl.style.transform = `scale(${scale})`;
      if (t < endAt || opacity > 0) requestAnimationFrame(tick);
      else {
        touchEl.style.display = 'none';
        nudge(); // the frame without the indicator must reach the video (see nudge)
      }
    };
    tick();
  }

  let pos = null;
  try {
    pos = JSON.parse(sessionStorage.getItem(POS_KEY) || 'null');
  } catch {}

  function place(x, y) {
    pos = { x, y };
    cursor.style.display = mode === 'touch' ? 'none' : 'block';
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
  // A tap that opened this document: let its indicator finish pressing and fading here.
  function resumeTouch() {
    let t = null;
    try {
      t = JSON.parse(sessionStorage.getItem(TOUCH_KEY) || 'null');
    } catch {}
    if (t && touchRun === 0 && now() < t.endAt + TOUCH.pressMs + TOUCH.fadeOutMs) animateTouch(t.x, t.y, t.start, t.endAt, t.from, t.press);
  }
  if (document.documentElement) mount();
  else document.addEventListener('readystatechange', mount, { once: true });
  if (mode === 'touch') resumeTouch();
  // some apps replace <html> children wholesale; keep the overlay attached
  document.addEventListener('DOMContentLoaded', mount);

  const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  window.__scenecast = {
    /** 'touch' hides the arrow and shows taps with the touch indicator; 'mouse' is the arrow cursor. */
    mode(m) {
      mode = m === 'touch' ? 'touch' : 'mouse';
      if (pos) place(pos.x, pos.y);
    },
    /**
     * Touch indicator at (x, y): fades in until epoch ms `endAt` (the tap), presses down to 0.85 and fades out
     * over 250 ms. Calling it again while one shows moves that one there and restarts its timing.
     */
    touch(x, y, endAt, press = true) {
      mount();
      const start = now();
      const from = endAt > start && touchEl.style.display === 'block' ? Number(touchEl.style.opacity) || 0 : 0;
      pos = { x, y };
      remember();
      try {
        sessionStorage.setItem(TOUCH_KEY, JSON.stringify({ x, y, start, endAt, from, press }));
      } catch {}
      animateTouch(x, y, start, endAt, from, press);
    },
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
      if (mode === 'touch') return;
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
