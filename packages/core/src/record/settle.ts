import type { Page, Request } from 'playwright';

/** Visible elements matching this mean the page is still loading. */
export const LOADING_SELECTOR =
  '[aria-busy=true],[role=progressbar]:not([aria-valuenow]),.is-loading,.skeleton,[data-scenecast-loading]';

/** Only these requests hold up settling; event streams, websockets, media and the like never finish. */
const COUNTED = new Set(['document', 'xhr', 'fetch']);
/** Responses with these content types are streams that stay open: stop waiting for them once headers arrive. */
const STREAMING = /text\/event-stream|application\/(x-)?ndjson|multipart\/x-mixed-replace/i;

export interface SettleOpts {
  /** Network must have been idle this long. */
  quietMs?: number;
  /** Give up (and carry on) after this long. */
  maxMs?: number;
}

export interface NetState {
  /** Counted requests in flight, with the time each started (Node performance.now()). */
  inflight: Map<Request, number>;
  lastActivity: number;
}

const tracked = new WeakMap<Page, NetState>();

/**
 * Start counting in-flight document, xhr and fetch requests on `page`. Call it right after the page
 * is created so `settle` knows about requests that began before it was first called; `settle` calls
 * it lazily otherwise.
 */
export function trackNetwork(page: Page): NetState {
  const known = tracked.get(page);
  if (known) return known;
  const state: NetState = { inflight: new Map(), lastActivity: performance.now() };
  const done = (r: Request) => {
    if (state.inflight.delete(r)) state.lastActivity = performance.now();
  };
  page.on('request', (r) => {
    if (!COUNTED.has(r.resourceType())) return;
    state.inflight.set(r, performance.now());
    state.lastActivity = performance.now();
  });
  page.on('response', (res) => {
    if (STREAMING.test(res.headers()['content-type'] ?? '')) done(res.request());
  });
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  page.on('framenavigated', () => (state.lastActivity = performance.now()));
  tracked.set(page, state);
  return state;
}

/** Counted requests younger than `maxMs` (older ones are long polls or hung: ignore them). */
function pending(net: NetState, maxMs: number): number {
  const now = performance.now();
  let n = 0;
  for (const started of net.inflight.values()) if (now - started < maxMs) n++;
  return n;
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
 * Wait until the page is settled: no document/xhr/fetch requests in flight for `quietMs` (streams
 * and requests older than `maxMs` don't count), a stable layout (two equal
 * `body` rects), and no visible loading indicator. Returns false if `maxMs` ran out first; the
 * caller carries on either way.
 */
export async function settle(page: Page, { quietMs = 350, maxMs = 9000 }: SettleOpts = {}): Promise<boolean> {
  const net = trackNetwork(page);
  const deadline = performance.now() + maxMs;
  while (performance.now() < deadline) {
    const quietFor = performance.now() - net.lastActivity;
    const busy = pending(net, maxMs);
    if (busy === 0 && quietFor >= quietMs) {
      if (await pageIsStill(page)) return true;
      await new Promise((r) => setTimeout(r, 30));
    } else {
      const wait = busy === 0 ? quietMs - quietFor : 50;
      await new Promise((r) => setTimeout(r, Math.max(10, Math.min(wait, deadline - performance.now()))));
    }
  }
  return false;
}
