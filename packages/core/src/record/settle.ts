import type { Page, Request } from 'playwright';

/** Visible elements matching this mean the page is still loading. */
export const LOADING_SELECTOR = '[aria-busy=true],[role=progressbar],.is-loading,.skeleton,[data-scenecast-loading]';

export interface SettleOpts {
  /** Network must have been idle this long. */
  quietMs?: number;
  /** Give up (and carry on) after this long. */
  maxMs?: number;
}

export interface NetState {
  inflight: Set<Request>;
  lastActivity: number;
}

const tracked = new WeakMap<Page, NetState>();

/**
 * Start counting in-flight requests on `page`. Call it right after the page is created so `settle`
 * knows about requests that began before it was first called; `settle` calls it lazily otherwise.
 */
export function trackNetwork(page: Page): NetState {
  const known = tracked.get(page);
  if (known) return known;
  const state: NetState = { inflight: new Set(), lastActivity: performance.now() };
  const done = (r: Request) => {
    state.inflight.delete(r);
    state.lastActivity = performance.now();
  };
  page.on('request', (r) => {
    state.inflight.add(r);
    state.lastActivity = performance.now();
  });
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  page.on('framenavigated', () => (state.lastActivity = performance.now()));
  tracked.set(page, state);
  return state;
}

/** In-page check: two equal `body` rects one frame apart, and no visible loading indicator. */
async function pageIsStill(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(async (loadingSel) => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
      if (!document.body || document.readyState === 'loading') return false;
      const a = document.body.getBoundingClientRect();
      await frame();
      await frame();
      const b = document.body.getBoundingClientRect();
      if (a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height) return false;
      for (const el of document.querySelectorAll(loadingSel)) {
        if (el.closest('[data-scenecast-overlay]')) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
      }
      return true;
    }, LOADING_SELECTOR);
  } catch {
    return false; // navigation in flight destroyed the context
  }
}

/**
 * Wait until the page is settled: no requests in flight for `quietMs`, a stable layout (two equal
 * `body` rects), and no visible loading indicator. Returns false if `maxMs` ran out first; the
 * caller carries on either way.
 */
export async function settle(page: Page, { quietMs = 350, maxMs = 9000 }: SettleOpts = {}): Promise<boolean> {
  const net = trackNetwork(page);
  const deadline = performance.now() + maxMs;
  while (performance.now() < deadline) {
    const quietFor = performance.now() - net.lastActivity;
    if (net.inflight.size === 0 && quietFor >= quietMs) {
      if (await pageIsStill(page)) return true;
      await new Promise((r) => setTimeout(r, 30));
    } else {
      const wait = net.inflight.size === 0 ? quietMs - quietFor : 50;
      await new Promise((r) => setTimeout(r, Math.max(10, Math.min(wait, deadline - performance.now()))));
    }
  }
  return false;
}
