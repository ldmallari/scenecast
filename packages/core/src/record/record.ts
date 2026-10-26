import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { DEFAULTS, type AppConn, type CursorCfg, type Scene, type Step } from '../scene/schema.js';
import { DEFAULT_TRAVEL_SEC, POINTER, spotPoint, type Point, type ScheduledStep } from '../schedule.js';
import { applyAppContext, captureSessionStorage, panelSelector } from './context.js';
import { LOADING_SELECTOR, settle, trackNetwork } from './settle.js';

// The pointer timing rules live in the pure scheduler; re-exported here, where v1 defined them.
export { DEFAULT_TRAVEL_SEC, travelSecFor } from '../schedule.js';
/** A selector must match a visible element within this long. */
export const SELECTOR_TIMEOUT_MS = 2500;

/** Pointer steps that glide onto a target (`sel`). A `do: park` step glides to a spot instead (recorded by its own branch). */
const onTarget = (d: Step['do']) => POINTER.has(d) && d !== 'park';
/** The automatic park glide takes the default travel time. */
const PARK_GLIDE_MS = DEFAULT_TRAVEL_SEC * 1000;
const CURSOR_PX = 28;
/** Where the arrow's tip sits inside its 28 px box (see overlay.js). */
const CURSOR_TIP = { x: 3, y: 2 };
/** The flash stays up this long: 2 frames of a 25 fps webm plus a vsync. */
const FLASH_MIN_MS = 100;
/** Re-check the target this long before the action fires. */
const AIM_CHECK_MS = 40;
/**
 * The glide ends this long before the action fires. While anything animates at 1080p, Playwright's
 * screencast runs about 100 ms behind (Chromium holds swaps while 5 JPEG frames are in flight), so an
 * action right at the end of the glide shows up late in the video. A short still moment lets that
 * backlog drain, and the action lands on its logged time (checked against the video in the tests).
 */
const GLIDE_LEAD_MS = 150;
/** Once a settle in a take has hit its full `maxMs`, later settles in that take are capped at this. */
const SHORT_SETTLE_MS = 1500;
/** Round trips used to measure the page clock against Node's. */
const CLOCK_SAMPLES = 5;
const TYPE_DELAY_MS = 35;
/** How long the recorder's ring holds at full strength when the step sets no `ms`. */
export const RING_HOLD_MS = 1200;
/** The recorder's ring fades in (and out) over this long; it is at full strength after it. */
export const RING_FADE_MS = 150;
/** The ring is at full strength this long after its fade-in ends (two animation frames, plus the screencast lag). */
const RING_PEAK_LAG_MS = 100;
/** Longest wait for the overlay to report its rings gone (a navigation takes them with it anyway). */
const RINGS_GONE_MAX_MS = 2000;
/** The overlay's repaints after a ring take about this long (8 frames), so waiting then never delays a step. */
const RINGS_GONE_MARGIN_MS = 300;

/** Waits until no ring is up and the overlay has repainted the page without it (see overlay.js nudge). */
async function ringsGone(page: Page): Promise<void> {
  await Promise.race([page.evaluate(() => window.__scenecast.ringsGone()).catch(() => {}), sleep(RINGS_GONE_MAX_MS)]);
}

/** Keep recording this long after the last step so its result is on screen. */
const TAIL_SEC = 1;

const OVERLAY_JS = fs.readFileSync(new URL('./overlay.js', import.meta.url), 'utf8');

/** Seconds from a ring step's action to its peak: faded in and settled, never past half its hold. */
export function ringPeakSec(holdMs: number = RING_HOLD_MS): number {
  return (RING_FADE_MS + Math.min(RING_PEAK_LAG_MS, holdMs / 2)) / 1000;
}

/** A box in the take's frame pixels. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TakeEvent {
  index: number;
  kind: Step['do'];
  /** Seconds after the flash marker when the action fired (pointer steps: when the cursor arrived). */
  at: number;
  /**
   * Box of the step's `sel` (union of all selectors). Zoom: `pad` added. Ring: the element's own box
   * (no pad), re-measured at the ring's peak, so it can be checked against `ringBox`.
   */
  target?: Box;
  /** Ring steps: the box the ring was drawn around at the cue (the element plus `pad`). */
  ringBox?: Box;
  /** Box covered by the cursor graphic at its destination. */
  cursorTo?: Box;
  /** Seconds after the flash when the cursor set off to park, after this pointer step (see `ScheduledStep.park`). */
  parkedAt?: number;
  /** Box covered by the cursor graphic where it parked (tip-anchored, like `cursorTo`). */
  parkTo?: Box;
  /** Open panels right after the action. */
  panels: Box[];
  /** A loading indicator was visible right after the action. */
  loading: boolean;
  /** A loading indicator was visible just before the action fired (after the settle and pre-position). */
  loadingBefore?: boolean;
  /** The settle before this step gave up (its cap ran out); the step ran anyway. */
  settleTimedOut?: boolean;
  /**
   * Seconds after the flash until the action itself is over: typing finished, the recorder's ring faded out,
   * or the step's `ms` hold ended. Absent when the action is instant. Retime never cuts inside it.
   */
  busyUntil?: number;
}

export interface Take {
  file: string;
  /** Estimated seconds into the video file where the flash marker shows (composition finds it exactly). */
  flashAt: number;
  /** Set for phone takes: boxes are in the 390×844 take's own pixels, which composition maps into the frame. */
  viewport?: 'phone';
  /** The declared navs (`app.nav`) that were visible when the take started, with their boxes. */
  navs?: { edge: 'left' | 'top'; box: Box }[];
  events: TakeEvent[];
}

interface OverlayApi {
  cursor(x: number, y: number): void;
  moveTo(x: number, y: number, endAt: number): void;
  ripple(x: number, y: number): void;
  ring(box: Box, holdMs: number): void;
  ringsGone(): Promise<void>;
  flash(minMs: number): Promise<number>;
}
declare global {
  interface Window {
    __scenecast: OverlayApi;
  }
}

/** High-resolution epoch milliseconds. The page's `performance.timeOrigin + performance.now()` is on the same clock. */
const epoch = () => performance.timeOrigin + performance.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const sleepUntil = (epochMs: number) => sleep(epochMs - epoch());
const round = (n: number) => Math.round(n * 10) / 10;
const toBox = (b: { x: number; y: number; width: number; height: number }): Box => ({
  x: round(b.x),
  y: round(b.y),
  w: round(b.width),
  h: round(b.height),
});
const selectors = (step: Step): string[] => (step.sel === undefined ? [] : Array.isArray(step.sel) ? step.sel : [step.sel]);

/** First visible match of `sel` (never the overlay), waiting up to SELECTOR_TIMEOUT_MS. */
async function findVisible(page: Page, sceneId: string, index: number, sel: string): Promise<Locator> {
  const deadline = epoch() + SELECTOR_TIMEOUT_MS;
  const loc = page.locator(sel);
  let cause: unknown;
  do {
    try {
      const n = await loc.count();
      for (let i = 0; i < n; i++) {
        const el = loc.nth(i);
        if ((await el.isVisible()) && !(await el.evaluate((e) => !!e.closest('[data-scenecast-overlay]')))) return el;
      }
    } catch (err) {
      cause = err; // a navigation in flight, or a bad selector: keep trying until the deadline
    }
    await sleep(50);
  } while (epoch() < deadline);
  throw new Error(`scene "${sceneId}" step ${index} selector "${sel}" not found`, { cause });
}

interface Measured {
  els: Locator[];
  first: Box;
  union: Box;
}

/** Boxes of already-resolved elements: the first one's, and the union of all. */
async function boxesOf(els: Locator[], sels: string[], sceneId: string, index: number): Promise<Measured> {
  const boxes: Box[] = [];
  for (const [i, el] of els.entries()) {
    const b = await el.boundingBox();
    if (!b) throw new Error(`scene "${sceneId}" step ${index} selector "${sels[i]}" not found`);
    boxes.push(toBox(b));
  }
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map((b) => b.x + b.w));
  const btm = Math.max(...boxes.map((b) => b.y + b.h));
  return { els, first: boxes[0]!, union: { x, y, w: round(r - x), h: round(btm - y) } };
}

/** Resolve every selector, scroll the first into view, and measure. */
async function measure(page: Page, sceneId: string, index: number, sels: string[]): Promise<Measured> {
  const els: Locator[] = [];
  for (const sel of sels) els.push(await findVisible(page, sceneId, index, sel));
  await els[0]!.scrollIntoViewIfNeeded().catch(() => {});
  return boxesOf(els, sels, sceneId, index);
}

const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
/** The box the cursor graphic covers with its tip at `p`. */
const cursorBox = (p: Point): Box => ({ x: round(p.x - CURSOR_TIP.x), y: round(p.y - CURSOR_TIP.y), w: CURSOR_PX, h: CURSOR_PX });

/**
 * Re-measure the target just before the pointer lands and check the element at its centre is the
 * target (or inside it). If not, scroll it into view and try once more; still covered is an error.
 */
async function aim(m: Measured, sels: string[], sceneId: string, index: number): Promise<Measured> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const now = await boxesOf(m.els, sels, sceneId, index);
    const c = centre(now.first);
    const onTarget = await m.els[0]!
      .evaluate((e, [x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return !!hit && (hit === e || e.contains(hit));
      }, [c.x, c.y] as const)
      .catch(() => false);
    if (onTarget) return now;
    if (attempt === 0) await m.els[0]!.scrollIntoViewIfNeeded().catch(() => {});
  }
  throw new Error(`scene "${sceneId}" step ${index} selector "${sels[0]}" is covered by another element at its centre`);
}

/**
 * Page epoch minus Node epoch, in ms: the fastest of CLOCK_SAMPLES `evaluate` round trips, assuming
 * the page read its clock halfway through.
 */
async function clockOffset(page: Page): Promise<number> {
  let best = Infinity;
  let offset = 0;
  for (let i = 0; i < CLOCK_SAMPLES; i++) {
    const t0 = epoch();
    const pageNow = await page.evaluate(() => performance.timeOrigin + performance.now());
    const t1 = epoch();
    if (t1 - t0 < best) {
      best = t1 - t0;
      offset = pageNow - (t0 + t1) / 2;
    }
  }
  return offset;
}

const padBox = (b: Box, pad = 0): Box => ({ x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad });

/**
 * Open panels (elements matching `panelSel`) and loading state, ignoring the overlay. Retries once if a
 * navigation destroys the page context.
 */
async function snapshot(page: Page, panelSel: string): Promise<{ panels: Box[]; loading: boolean }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await page.evaluate(
        ([panelSel, loadingSel]) => {
          const visible = (el: Element) => {
            if (el.closest('[data-scenecast-overlay]')) return null;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return null;
            return el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) ? r : null;
          };
          const panels: { x: number; y: number; width: number; height: number }[] = [];
          for (const el of document.querySelectorAll(panelSel)) {
            const r = visible(el);
            if (r) panels.push({ x: r.x, y: r.y, width: r.width, height: r.height });
          }
          const loading = [...document.querySelectorAll(loadingSel)].some((el) => visible(el) !== null);
          return { panels, loading };
        },
        [panelSel, LOADING_SELECTOR] as const,
      ).then((s) => ({ panels: s.panels.map(toBox), loading: s.loading }));
    } catch {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }
  }
  return { panels: [], loading: true };
}

/**
 * Each `app.panels` item must be a valid CSS selector. They are joined into one list for `snapshot`, where one
 * bad item would fail every query (and read as a page that is always loading), so name it up front.
 */
async function checkPanels(page: Page, app: AppConn): Promise<void> {
  for (const sel of app.panels ?? []) {
    const ok = await page.evaluate((s) => {
      try {
        document.querySelector(s);
        return true;
      } catch {
        return false;
      }
    }, sel);
    if (!ok) throw new Error(`app.panels: invalid selector "${sel}"`);
  }
}

/** Wait for a smooth scroll to come to rest (two equal scroll positions 100 ms apart, at most 1.5 s). */
async function scrollRest(page: Page): Promise<void> {
  let last = '';
  for (let i = 0; i < 15; i++) {
    await sleep(100);
    const pos = await page.evaluate(() => `${scrollX},${scrollY}`).catch(() => last);
    if (pos === last) return;
    last = pos;
  }
}

/** Sign-in state for the run: `storageState`, else the `login` steps once, else the `loginHook` once. */
const sessions = new Map<string, Promise<string | undefined>>();
function sessionState(browser: Browser, app: AppConn, out: string): Promise<string | undefined> {
  if (app.storageState) return Promise.resolve(app.storageState);
  if (!app.login?.length && !app.loginHook) return Promise.resolve(undefined);
  const file = path.join(path.resolve(out), '.session.json');
  const key = `${app.baseUrl}\n${file}`;
  let p = sessions.get(key);
  if (!p) {
    p = signIn(browser, app, file);
    sessions.set(key, p);
    p.catch(() => sessions.delete(key)); // a failed sign-in is retried by the next scene
  }
  return p;
}

async function signIn(browser: Browser, app: AppConn, file: string): Promise<string> {
  const ctx = await browser.newContext();
  try {
    await applyAppContext(ctx, app);
    const page = await ctx.newPage();
    trackNetwork(page);
    if (app.login?.length) {
      if (app.login[0]!.do !== 'goto') await page.goto(app.baseUrl);
      for (const [i, step] of app.login.entries()) await loginStep(page, app, step, i);
      await page.waitForLoadState('load').catch(() => {});
      await settle(page);
    } else {
      const mod = (await import(pathToFileURL(path.resolve(app.loginHook!)).href)) as {
        default: (page: Page, context: BrowserContext) => Promise<void>;
      };
      await mod.default(page, ctx);
    }
    await ctx.storageState({ path: file });
    await captureSessionStorage(page, file, app.baseUrl);
    return file;
  } finally {
    await ctx.close();
  }
}

/** Login steps run as fast as possible, untimed and unrecorded. */
async function loginStep(page: Page, app: AppConn, step: Step, i: number): Promise<void> {
  const sel = selectors(step)[0];
  const el = sel === undefined ? undefined : await findVisible(page, 'login', i, sel);
  switch (step.do) {
    case 'goto':
      await page.goto(new URL(step.text ?? sel ?? '/', app.baseUrl).href);
      break;
    case 'click':
      await el?.click();
      break;
    case 'hover':
      await el?.hover();
      break;
    case 'type':
      if (el) await el.fill(step.text ?? '');
      else await page.keyboard.type(step.text ?? '');
      break;
    case 'press':
      await page.keyboard.press(step.text ?? 'Enter');
      break;
    case 'wait':
      await sleep(step.ms ?? 0);
      break;
    default:
      break; // zoom, ring and scroll only matter on camera
  }
}

/**
 * Record one scene as one take: open the route, settle, place the cursor, flash, then run each
 * scheduled step at its time (relative to the flash), logging where everything was. Writes
 * `<out>/<scene>.webm` and `<out>/<scene>.boxes.json`. `opts.cursor.start` is where the cursor starts when the
 * scene sets no `cursor` and no step is pre-positioned.
 */
export async function recordScene(
  scene: Scene,
  scheduled: ScheduledStep[],
  app: AppConn,
  out: string,
  opts: { cursor?: CursorCfg } = {},
): Promise<Take> {
  for (const { index, step } of scheduled)
    if ((onTarget(step.do) || step.do === 'ring' || step.do === 'zoom') && selectors(step).length === 0)
      throw new Error(`scene "${scene.id}" step ${index}: ${step.do} needs sel`);
  fs.mkdirSync(out, { recursive: true });
  const phone = scene.viewport === 'phone';
  const viewport = phone
    ? { width: DEFAULTS.phone.width, height: DEFAULTS.phone.height }
    : { width: DEFAULTS.video.width, height: DEFAULTS.video.height };
  const videoDir = fs.mkdtempSync(path.join(out, `.rec-${scene.id}-`));
  const browser = await chromium.launch();
  try {
    const storageState = scene.signedOut ? undefined : await sessionState(browser, app, out);
    // The video is recorded at the viewport size, so CSS px == take px and boxes need no scaling.
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: phone ? 2 : 1,
      isMobile: phone,
      storageState,
      recordVideo: { dir: videoDir, size: viewport },
    });
    await applyAppContext(context, app, { sessionFile: storageState });
    await context.addInitScript({ content: OVERLAY_JS });
    let take: Omit<Take, 'file'>;
    let page: Page | undefined;
    try {
      page = await context.newPage();
      const videoStart = epoch();
      const start = spotPoint(scene.cursor ?? opts.cursor?.start ?? DEFAULTS.cursor.start, viewport);
      take = await runTake(page, scene, scheduled, app, videoStart, start);
    } finally {
      await context.close(); // finishes the video file
    }
    const file = path.join(out, `${scene.id}.webm`);
    fs.renameSync(await page!.video()!.path(), file);
    const result: Take = {
      file,
      flashAt: take.flashAt,
      ...(phone ? { viewport: 'phone' as const } : {}),
      ...(take.navs ? { navs: take.navs } : {}),
      events: take.events,
    };
    fs.writeFileSync(path.join(out, `${scene.id}.boxes.json`), JSON.stringify(result, null, 2) + '\n');
    return result;
  } finally {
    await browser.close();
    fs.rmSync(videoDir, { recursive: true, force: true });
  }
}

async function runTake(
  page: Page,
  scene: Scene,
  scheduled: ScheduledStep[],
  app: AppConn,
  videoStart: number,
  start: Point,
): Promise<Omit<Take, 'file'>> {
  const url = (p: string) => new URL(p, app.baseUrl).href;
  await checkPanels(page, app);
  const panelSel = panelSelector(app);
  trackNetwork(page);
  // Per-take settle budget: after one settle runs out its full cap, the rest get a short one.
  let capped = false;
  const settleTake = async (): Promise<boolean> => {
    const ok = await settle(page, capped ? { maxMs: SHORT_SETTLE_MS } : {});
    if (!ok) capped = true;
    return ok;
  };
  for (const route of scene.prewarm ?? []) {
    await page.goto(url(route));
    await settleTake();
  }
  await page.goto(url(scene.route ?? '/'));
  await settleTake();
  const navs = await navBoxes(page, app);

  const steps = [...scheduled].sort((a, b) => a.index - b.index);
  // The start spot, unless a pre-positioned step needs the cursor already on its target.
  let cursor: Point = { ...start };
  const ready = steps.find((s) => s.prePosition && onTarget(s.step.do) && selectors(s.step).length > 0);
  // Measured before the flash and reused at its cue, so the little time between the flash and an early cue isn't
  // spent finding the target again (the aim check still re-measures it just before the action).
  const readyM = ready && (await measure(page, scene.id, ready.index, selectors(ready.step)));
  if (readyM) cursor = centre(readyM.first);
  await page.evaluate(([x, y]) => window.__scenecast.cursor(x, y), [cursor.x, cursor.y] as const);

  // t = 0 is the flash's first painted frame. The page stamps it on its own epoch clock; we convert it
  // to Node's epoch clock through a measured offset, and from then on Node's monotonic high-resolution
  // clock times every event (the page clock restarts on each navigation; Node's doesn't).
  const offset = await clockOffset(page);
  const flashEpoch = (await page.evaluate((ms) => window.__scenecast.flash(ms), FLASH_MIN_MS)) - offset;
  const sinceFlash = () => Math.round((epoch() - flashEpoch) * 10) / 10000; // seconds, 0.1 ms resolution
  const events: TakeEvent[] = [];
  const quiet = (p: Promise<unknown>) => void p.catch(() => {});

  let holdUntil = 0;
  /** When the latest ring is removed (Node epoch ms); a later step first waits for the page to show it gone. */
  let ringGoneAt = 0;
  const peakMeasures: Promise<void>[] = [];
  /** Park glides in flight: each is fired at its time without holding up the steps in between. */
  const parks: Promise<void>[] = [];
  for (const [k, { index, step, startAt, travel, park }] of steps.entries()) {
    const sels = selectors(step);
    const due = flashEpoch + startAt * 1000;
    const ev: Partial<TakeEvent> & { index: number; kind: Step['do'] } = { index, kind: step.do };
    // The pre-positioned first step was found on a settled page just before the flash: settling again would
    // only spend the short time before its early cue.
    const prePlaced = k === 0 && readyM !== undefined && index === ready?.index;
    if (step.settle !== false && !prePlaced && !(await settleTake())) ev.settleTimedOut = true;
    // A ring that ends before this step must be off screen in the take before it goes ahead. (One that
    // ends just before the step needs no wait: the step's own glide or ring repaints the page anyway.)
    if (ringGoneAt && ringGoneAt + RINGS_GONE_MARGIN_MS <= due) {
      await ringsGone(page);
      ringGoneAt = 0;
    }

    if (onTarget(step.do)) {
      let m = readyM && index === ready?.index ? readyM : await measure(page, scene.id, index, sels);
      // Each step glides for its own travel. With none (pre-positioned) the cursor is already on the
      // target: no glide and no lead, and the action fires at `due`.
      let arrive = due;
      if (travel > 0) {
        await sleepUntil(due);
        arrive = Math.max(epoch(), due) + travel * 1000;
        cursor = centre(m.first);
        const glide = [cursor.x, cursor.y, arrive - GLIDE_LEAD_MS + offset] as const;
        quiet(page.evaluate(([x, y, end]) => window.__scenecast.moveTo(x, y, end), glide));
      }
      await sleepUntil(arrive - AIM_CHECK_MS);
      m = await aim(m, sels, scene.id, index);
      ev.loadingBefore = (await snapshot(page, panelSel)).loading;
      const aimed = centre(m.first);
      await page.mouse.move(aimed.x, aimed.y); // the real pointer moves ahead so the action itself is one press
      await sleepUntil(arrive);
      ev.at = sinceFlash();
      if (Math.abs(aimed.x - cursor.x) > 1 || Math.abs(aimed.y - cursor.y) > 1) {
        cursor = aimed; // the target moved during travel: snap onto it
        quiet(page.evaluate(([x, y]) => window.__scenecast.cursor(x, y), [cursor.x, cursor.y] as const));
      }
      ev.target = m.union;
      ev.cursorTo = cursorBox(cursor);
      if (step.do === 'click' || step.do === 'type') {
        quiet(page.evaluate(([x, y]) => window.__scenecast.ripple(x, y), [cursor.x, cursor.y] as const));
        await page.mouse.down();
        await page.mouse.up();
        if (step.do === 'type' && step.text) {
          await page.keyboard.type(step.text, { delay: TYPE_DELAY_MS });
          ev.busyUntil = sinceFlash();
        }
      }
    } else if (step.do === 'ring' || step.do === 'zoom') {
      const m = await measure(page, scene.id, index, sels);
      const box = padBox(m.union, step.pad);
      ev.loadingBefore = (await snapshot(page, panelSel)).loading;
      await sleepUntil(due);
      ev.at = sinceFlash();
      if (step.do === 'ring') {
        const hold = step.ms ?? RING_HOLD_MS;
        quiet(page.evaluate(([b, ms]) => window.__scenecast.ring(b, ms), [box, hold] as const));
        ev.busyUntil = ev.at + (hold + 2 * RING_FADE_MS) / 1000;
        holdUntil = Math.max(holdUntil, epoch() + hold + 2 * RING_FADE_MS);
        ringGoneAt = Math.max(ringGoneAt, epoch() + hold + 2 * RING_FADE_MS + 50);
        ev.ringBox = box;
        // The element as it is when the ring peaks, measured without holding up the next step.
        const peakAt = epoch() + ringPeakSec(hold) * 1000;
        peakMeasures.push(
          sleepUntil(peakAt)
            .then(() => boxesOf(m.els, sels, scene.id, index))
            .then((now) => void (ev.target = now.union))
            .catch(() => void delete ev.target), // gone by the peak: the audit fails the ring for it
        );
      } else ev.target = box;
    } else {
      const el = sels.length ? await findVisible(page, scene.id, index, sels[0]!) : undefined;
      ev.loadingBefore = (await snapshot(page, panelSel)).loading;
      await sleepUntil(due);
      ev.at = sinceFlash();
      switch (step.do) {
        case 'scroll':
          if (el) await el.evaluate((e) => e.scrollIntoView({ behavior: 'smooth', block: 'center' }));
          else await page.evaluate(() => window.scrollBy({ top: innerHeight * 0.8, behavior: 'smooth' }));
          await scrollRest(page);
          break;
        case 'press':
          await page.keyboard.press(step.text ?? 'Enter');
          break;
        case 'goto':
          await page.goto(url(step.text ?? sels[0] ?? '/'), { waitUntil: 'domcontentloaded' });
          break;
        default:
          break; // wait: the schedule already spaced it
      }
      if (sels.length && step.do !== 'goto') ev.target = (await measure(page, scene.id, index, sels)).union;
    }

    Object.assign(ev, await snapshot(page, panelSel));
    // A step held with `ms` is busy until the hold ends.
    if (step.ms && ev.at !== undefined) ev.busyUntil = Math.max(ev.busyUntil ?? ev.at, ev.at + step.ms / 1000);
    if (park && onTarget(step.do) && ev.at !== undefined) {
      // Glide off to the park spot once the action is over and the park time has come. Skipped when the glide
      // would still be running as the next pointer step sets off (two glides would fight over the cursor).
      // The park delay counts from the action as it happened, so a late action still rests before the cursor leaves.
      const delaySec = park.at - (startAt + travel);
      const setOff = flashEpoch + 1000 * Math.max(park.at, ev.at + delaySec, ev.busyUntil ?? ev.at, sinceFlash());
      const next = steps.slice(k + 1).find((s) => POINTER.has(s.step.do));
      if (!next || setOff + PARK_GLIDE_MS <= flashEpoch + next.startAt * 1000) {
        ev.parkTo = cursorBox(park.to);
        ev.parkedAt = Math.round((setOff - flashEpoch) * 10) / 10000;
        ev.busyUntil = ev.parkedAt + PARK_GLIDE_MS / 1000;
        holdUntil = Math.max(holdUntil, setOff + PARK_GLIDE_MS);
        const to = park.to;
        parks.push(
          sleepUntil(setOff).then(() => {
            cursor = { ...to };
            const glide = [to.x, to.y, setOff + PARK_GLIDE_MS + offset] as const;
            quiet(page.evaluate(([x, y, end]) => window.__scenecast.moveTo(x, y, end), glide));
          }),
        );
      }
    }
    events.push(ev as TakeEvent);
    holdUntil = Math.max(holdUntil, due + (step.ms ?? 0));
  }
  await Promise.all(parks);
  await sleepUntil(Math.max(holdUntil, epoch()));
  if (ringGoneAt) await ringsGone(page);
  await sleepUntil(epoch() + TAIL_SEC * 1000);
  await Promise.all(peakMeasures);
  return { flashAt: Math.round(flashEpoch - videoStart) / 1000, ...(navs.length ? { navs } : {}), events };
}

/** Boxes of the declared navs that are visible now (first visible match of each selector). */
async function navBoxes(page: Page, app: AppConn): Promise<NonNullable<Take['navs']>> {
  const out: NonNullable<Take['navs']> = [];
  for (const nav of app.nav ?? []) {
    const loc = page.locator(nav.selector);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const b = await el.boundingBox().catch(() => null);
      if (b) out.push({ edge: nav.edge, box: toBox(b) });
      break;
    }
  }
  return out;
}
