import type { Locator, Page, Request } from 'playwright';

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
  /**
   * When the step that waits is due, in ms from now (never less than `quietMs`). From then on only a page that is
   * really not ready holds the step up (a document loading, or a visible loading indicator); data requests and a
   * layout still moving no longer do, so a busy page does not make the step late. `onDue` is called when the settle
   * ends early for this reason while the page was still busy.
   */
  dueInMs?: number;
  onDue?: () => void;
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

/**
 * In-page check: two equal `body` rects one frame apart, and no visible loading indicator. With `layout` false, only
 * that the document has loaded and shows no loading indicator.
 */
async function pageIsStill(page: Page, layout = true): Promise<boolean> {
  try {
    return await page.evaluate(
      async ([loadingSel, layout]) => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
        if (!document.body || document.readyState === 'loading') return false;
        if (layout) {
          const a = document.body.getBoundingClientRect();
          await frame();
          await frame();
          const b = document.body.getBoundingClientRect();
          if (a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height) return false;
        }
        for (const el of document.querySelectorAll(loadingSel)) {
          if (el.closest('[data-scenecast-overlay]')) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
        }
        return true;
      },
      [LOADING_SELECTOR, layout] as const,
    );
  } catch {
    return false; // navigation in flight destroyed the context
  }
}

/** Counted document requests (navigations) younger than `maxMs`. */
function pendingDocuments(net: NetState, maxMs: number): number {
  const now = performance.now();
  let n = 0;
  for (const [r, started] of net.inflight) if (now - started < maxMs && r.resourceType() === 'document') n++;
  return n;
}

/**
 * Wait until the page is settled: no document/xhr/fetch requests in flight for `quietMs` (streams
 * and requests older than `maxMs` don't count), a stable layout (two equal
 * `body` rects), and no visible loading indicator. Once `dueInMs` has passed, see `SettleOpts.dueInMs`.
 * Returns false if `maxMs` ran out first; the caller carries on either way.
 */
export async function settle(page: Page, { quietMs = 350, maxMs = 9000, dueInMs, onDue }: SettleOpts = {}): Promise<boolean> {
  const net = trackNetwork(page);
  const deadline = performance.now() + maxMs;
  // Never before a first quiet window has passed: a request the previous action starts a few ms later, or a layout
  // that has not begun to change, must still be waited for.
  const due = dueInMs === undefined ? Infinity : performance.now() + Math.max(dueInMs, quietMs);
  while (performance.now() < deadline) {
    const quietFor = performance.now() - net.lastActivity;
    const busy = pending(net, maxMs);
    // The step is due: it goes ahead unless a document is still loading or a loading indicator shows. Only a page
    // that really is busy (requests in flight or recent, or a layout still moving) counts as cut short.
    if (performance.now() >= due && pendingDocuments(net, maxMs) === 0 && (await pageIsStill(page, false))) {
      if (busy > 0 || quietFor < quietMs || !(await pageIsStill(page))) onDue?.();
      return true;
    }
    if (busy === 0 && quietFor >= quietMs) {
      if (await pageIsStill(page)) return true;
      await new Promise((r) => setTimeout(r, 30));
    } else {
      const wait = busy === 0 ? quietMs - quietFor : 50;
      const untilDue = due > performance.now() ? due - performance.now() : Infinity;
      await new Promise((r) => setTimeout(r, Math.max(10, Math.min(wait, untilDue, deadline - performance.now()))));
    }
  }
  return false;
}

/**
 * Waits until `els` have stopped moving: two animation frames (so a style change just made, such as a hover, has
 * started its transitions), then until no finite CSS transition or animation is running on any of them or on their
 * ancestors (a row that lifts on hover moves what is inside it too). Gives up after `maxMs`; infinite animations
 * (spinners) never hold it up. Elements that are gone are skipped.
 */
export async function motionSettled(els: Locator[], maxMs: number): Promise<void> {
  await Promise.all(
    els.map((el) =>
      el
        .evaluate(async (target, cap) => {
          const deadline = performance.now() + cap;
          const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
          await frame();
          await frame();
          for (;;) {
            const moving = document.getAnimations().filter((a) => {
              const fx = a.effect as KeyframeEffect | null;
              const on = fx?.target;
              if (!fx || !on || !(on === target || on.contains(target))) return false;
              if (a.playState !== 'running' && !a.pending) return false;
              return Number.isFinite(Number(fx.getComputedTiming().endTime));
            });
            const left = deadline - performance.now();
            if (!moving.length || left <= 0) return;
            await Promise.race([Promise.all(moving.map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, left))]);
            await frame();
          }
        }, maxMs)
        .catch(() => {}),
    ),
  );
}
