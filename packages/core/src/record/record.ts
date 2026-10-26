import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { DEFAULTS, type AppConn, type CursorCfg, type Scene, type Step } from '../scene/schema.js';
import { actionAt, DEFAULT_TRAVEL_SEC, POINTER, PROTECT_MARGIN_SEC, spotPoint, type Point, type ScheduledStep } from '../schedule.js';
import { VideoClock } from './clock.js';
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
/** The touch indicator's colour when the caller gives none (the highlight ring's yellow). */
const DEFAULT_TOUCH_COLOUR = '#F5C518';
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * The touch indicator's colour as a #rrggbb hex: a #rgb/#rrggbb accent as is, any other CSS colour (`gold`,
 * `rgb(…)`, `#RRGGBBAA`, `hsl(…)`) as the browser computes it (alpha dropped). Something that is not a colour
 * warns and falls back to the default yellow, so a v1 scene file still renders.
 */
export async function resolveTouchColour(browser: Browser, colour: string, sceneId: string): Promise<string> {
  if (HEX.test(colour)) return colour;
  const page = await browser.newPage();
  try {
    const rgb = await page.evaluate((c) => {
      const probe = document.createElement('div');
      probe.style.color = c;
      if (!probe.style.color) return null;
      document.body.appendChild(probe);
      const m = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(getComputedStyle(probe).color);
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    }, colour);
    if (rgb) return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
  } finally {
    await page.close();
  }
  console.warn(`scenecast: scene "${sceneId}": brand.accent ${JSON.stringify(colour)} is not a CSS colour; the touch indicator uses ${DEFAULT_TOUCH_COLOUR}`);
  return DEFAULT_TOUCH_COLOUR;
}
/** Phone takes show taps with a touch indicator of this size (see overlay.js), centred on the tap. */
const TOUCH_PX = DEFAULTS.phone.touchPx;
/** The flash stays up this long: 2 frames of a 25 fps webm plus a vsync. */
const FLASH_MIN_MS = 100;
/** How often the recorder notes where the video's clock is (see VideoClock). */
const CLOCK_SAMPLE_MS = 20;
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
/** After a check step's click, the element has this long to show as checked (an app may re-render it). */
const CHECKED_WAIT_MS = 1000;
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
  /**
   * Seconds after the flash marker when the action fired (pointer steps: when the cursor arrived), on the video's
   * clock: where the action shows in the take.
   */
  at: number;
  /**
   * Box of the step's `sel` (union of all selectors). Zoom: `pad` added. Ring: the element's own box
   * (no pad), re-measured at the ring's peak, so it can be checked against `ringBox`.
   */
  target?: Box;
  /**
   * Ring steps, and pointer steps with `ringSel`: the box the ring was drawn around at the cue (the element plus
   * `pad`; for `ringSel`, the union of its elements plus `pad`).
   */
  ringBox?: Box;
  /** Pointer steps with `ringSel`: the union of the `ringSel` elements' own boxes (no pad), re-measured at the ring's peak. */
  ringTarget?: Box;
  /** Box covered by the cursor graphic at its destination. */
  cursorTo?: Box;
  /** Seconds after the flash when the cursor set off to park, after this pointer step (see `ScheduledStep.park`). */
  parkedAt?: number;
  /** Box covered by the cursor graphic where it parked (tip-anchored, like `cursorTo`). */
  parkTo?: Box;
  /** Check steps: whether the step clicked (false when the element was already checked). */
  clicked?: boolean;
  /** Scroll steps: the page's `scrollY` once the scroll came to rest. */
  scrollY?: number;
  /** Open panels right after the action. */
  panels: Box[];
  /** A loading indicator was visible right after the action. */
  loading: boolean;
  /** A loading indicator was visible just before the action fired (after the settle and pre-position). */
  loadingBefore?: boolean;
  /** The settle before this step gave up (its cap ran out); the step ran anyway. */
  settleTimedOut?: boolean;
  /**
   * Seconds the video's clock had moved from the recorder's by `at` (the system stepped its wall clock, which the
   * video runs on, during the take): the action fired on its schedule at `at - clockShift`. Absent when none.
   */
  clockShift?: number;
  /**
   * Seconds after the flash until the action itself is over: typing finished, the recorder's ring faded out,
   * or the step's `ms` hold ended. Absent when the action is instant. Retime never cuts inside it. Zoom and
   * unzoom events never set it: the composer draws the zoom, so its hold may be trimmed.
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
  /** The scene's `zoom.sel` (union of all selectors) measured before the flash, plus its `pad`: the scene starts zoomed on it. */
  initialZoom?: Box;
  events: TakeEvent[];
}

interface OverlayApi {
  mode(m: 'mouse' | 'touch'): void;
  touch(x: number, y: number, endAt: number, press?: boolean): void;
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
    /** Set by an init script before the overlay runs: phone takes start in touch mode. */
    __scenecastInitMode?: 'touch';
    /** The touch indicator's colour (the brand accent), set in the same init script. */
    __scenecastTouchColour?: string;
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
const asList = (sel: string | string[] | undefined): string[] => (sel === undefined ? [] : Array.isArray(sel) ? sel : [sel]);
const selectors = (step: Step): string[] => asList(step.sel);
/** What a selector belongs to, for error messages: a step's index, or the scene's initial zoom. */
type SelOwner = number | 'zoom';
const ownerName = (at: SelOwner) => (at === 'zoom' ? 'zoom' : `step ${at}`);

/** First visible match of `sel` (never the overlay), waiting up to SELECTOR_TIMEOUT_MS. */
async function findVisible(page: Page, sceneId: string, index: SelOwner, sel: string): Promise<Locator> {
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
  throw new Error(`scene "${sceneId}" ${ownerName(index)} selector "${sel}" not found`, { cause });
}

interface Measured {
  els: Locator[];
  first: Box;
  union: Box;
}

/** Boxes of already-resolved elements: the first one's, and the union of all. */
async function boxesOf(els: Locator[], sels: string[], sceneId: string, index: SelOwner): Promise<Measured> {
  const boxes: Box[] = [];
  for (const [i, el] of els.entries()) {
    const b = await el.boundingBox();
    if (!b) throw new Error(`scene "${sceneId}" ${ownerName(index)} selector "${sels[i]}" not found`);
    boxes.push(toBox(b));
  }
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map((b) => b.x + b.w));
  const btm = Math.max(...boxes.map((b) => b.y + b.h));
  return { els, first: boxes[0]!, union: { x, y, w: round(r - x), h: round(btm - y) } };
}

/** Resolve every selector, scroll the first into view, and measure. */
async function measure(page: Page, sceneId: string, index: SelOwner, sels: string[]): Promise<Measured> {
  const els: Locator[] = [];
  for (const sel of sels) els.push(await findVisible(page, sceneId, index, sel));
  await els[0]!.scrollIntoViewIfNeeded().catch(() => {});
  return boxesOf(els, sels, sceneId, index);
}

const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
/** The box the cursor graphic covers with its tip at `p`. */
const cursorBox = (p: Point): Box => ({ x: round(p.x - CURSOR_TIP.x), y: round(p.y - CURSOR_TIP.y), w: CURSOR_PX, h: CURSOR_PX });
/** The box the touch indicator covers, centred on the tap at `p`. */
const touchBox = (p: Point): Box => ({ x: round(p.x - TOUCH_PX / 2), y: round(p.y - TOUCH_PX / 2), w: TOUCH_PX, h: TOUCH_PX });

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

/** Whether a checkbox or switch shows as checked: `:checked`, or `aria-checked="true"`. */
const isChecked = (el: Locator): Promise<boolean> =>
  el.evaluate((e) => e.matches(':checked') || e.getAttribute('aria-checked') === 'true');

/** Waits up to CHECKED_WAIT_MS for the element to show as checked. */
async function becomesChecked(el: Locator): Promise<boolean> {
  const deadline = epoch() + CHECKED_WAIT_MS;
  for (;;) {
    if (await isChecked(el).catch(() => false)) return true;
    if (epoch() >= deadline) return false;
    await sleep(50);
  }
}

/** True when `b` lies wholly inside the viewport. */
const inViewport = (b: Box, vp: { width: number; height: number }) =>
  b.x >= -0.5 && b.y >= -0.5 && b.x + b.w <= vp.width + 0.5 && b.y + b.h <= vp.height + 0.5;

/** Resolves the ringSel elements (never scrolled to: the pointer target is what is in view) and measures them. */
async function findRing(page: Page, sceneId: string, index: number, sels: string[]): Promise<Measured> {
  const els: Locator[] = [];
  for (const sel of sels) els.push(await findVisible(page, sceneId, index, sel));
  return boxesOf(els, sels, sceneId, index);
}

/** Where a park step glides to: its `at`, else `cursor.park`, else (when parking is off) the right spot. */
function parkPoint(step: Step, where: { viewport: { width: number; height: number }; parkSpot: CursorCfg['park'] }): Point {
  return spotPoint(step.at ?? (where.parkSpot === 'off' ? 'right' : where.parkSpot), where.viewport);
}

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
 * scene sets no `cursor` and no step is pre-positioned. `opts.minTakeSec` keeps the take recording until at least
 * that long after the flash (the scene's voice plus its breath and a tail), so it never runs out before the narration.
 */
export async function recordScene(
  scene: Scene,
  scheduled: ScheduledStep[],
  app: AppConn,
  out: string,
  opts: {
    minTakeSec?: number;
    cursor?: CursorCfg;
    /** The touch indicator's colour on phone takes: the brand accent, any CSS colour (resolved to a hex). */
    touchColour?: string;
    /** The wall clock the browser stamps video frames with (default `Date.now`); tests replace it to step it. */
    wallClock?: () => number;
  } = {},
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
      hasTouch: phone,
      storageState,
      recordVideo: { dir: videoDir, size: viewport },
    });
    await applyAppContext(context, app, { sessionFile: storageState });
    // Phone takes tap: the overlay starts every document in touch mode (no arrow; a touch indicator per tap).
    if (phone) {
      const colour = await resolveTouchColour(browser, opts.touchColour ?? DEFAULT_TOUCH_COLOUR, scene.id);
      await context.addInitScript({ content: `window.__scenecastInitMode = 'touch'; window.__scenecastTouchColour = ${JSON.stringify(colour)};` });
    }
    await context.addInitScript({ content: OVERLAY_JS });
    let take: Omit<Take, 'file'>;
    let page: Page | undefined;
    try {
      page = await context.newPage();
      const videoStart = epoch();
      const start = spotPoint(scene.cursor ?? opts.cursor?.start ?? DEFAULTS.cursor.start, viewport);
      const parkSpot = opts.cursor?.park ?? DEFAULTS.cursor.park;
      take = await runTake(page, scene, scheduled, app, videoStart, start, { viewport, parkSpot, touch: phone }, {
        minTakeSec: opts.minTakeSec ?? 0,
        ...(opts.wallClock ? { wallClock: opts.wallClock } : {}),
      });
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
      ...(take.initialZoom ? { initialZoom: take.initialZoom } : {}),
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
  where: { viewport: { width: number; height: number }; parkSpot: CursorCfg['park']; touch: boolean },
  timing: { minTakeSec: number; wallClock?: () => number },
): Promise<Omit<Take, 'file'>> {
  const touch = where.touch;
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
  // The scene's initial zoom: its `zoom.sel` scrolled into view and measured (union of all), plus `pad`.
  const zoomSels = asList(scene.zoom?.sel);
  let zoomM = zoomSels.length ? await measure(page, scene.id, 'zoom', zoomSels) : undefined;

  const steps = [...scheduled].sort((a, b) => a.index - b.index);
  // The start spot, unless a pre-positioned step needs the cursor already on its target.
  let cursor: Point = { ...start };
  // Only the first pointer step can be pre-positioned (the scheduler's rule); a later one glides.
  const first = steps.find((s) => POINTER.has(s.step.do));
  const ready = first?.prePosition && onTarget(first.step.do) && selectors(first.step).length > 0 ? first : undefined;
  // Measured before the flash and reused at its cue, so the little time between the flash and an early cue isn't
  // spent finding the target again (the aim check still re-measures it just before the action).
  const readyM = ready && (await measure(page, scene.id, ready.index, selectors(ready.step)));
  if (readyM) cursor = centre(readyM.first);
  // The pre-positioned step's ringSel elements, found before the flash for the same reason.
  const readyRingSels = ready ? asList(ready.step.ringSel) : [];
  const readyRingM = readyRingSels.length ? await findRing(page, scene.id, ready!.index, readyRingSels) : undefined;
  if (zoomM && readyM) {
    // Scrolling the first target into view may have moved the zoomed element: measure it again where it is now.
    zoomM = await boxesOf(zoomM.els, zoomSels, scene.id, 'zoom');
    if (!inViewport(zoomM.union, where.viewport))
      throw new Error(
        `scene "${scene.id}" zoom selector "${zoomSels.join(', ')}" is out of view at the start ` +
          `(the first step's target "${selectors(ready!.step)[0]}" scrolled the page)`,
      );
  }
  const initialZoom = zoomM && padBox(zoomM.union, scene.zoom!.pad);
  // A pre-positioned park waits at its spot.
  if (first?.prePosition && first.step.do === 'park') cursor = parkPoint(first.step, where);
  await page.evaluate(([x, y]) => window.__scenecast.cursor(x, y), [cursor.x, cursor.y] as const);

  // t = 0 is the flash's first painted frame. The page stamps it on its own epoch clock; we convert it
  // to Node's epoch clock through a measured offset, and from then on Node's monotonic high-resolution
  // clock times every event (the page clock restarts on each navigation; Node's doesn't).
  let offset = await clockOffset(page);
  // A new document in a new renderer process (a cross-site navigation) takes its clock's offset from the wall clock
  // anew, so after a wall-clock step the offset above would be off by the step: measure it again after a navigation,
  // before the next glide is sent (glide ends are in the page's clock).
  let offsetStale = false;
  page.on('framenavigated', (f) => void (f === page.mainFrame() && (offsetStale = true)));
  // Steps are timed on the monotonic clock; what they log is on the video's clock (see VideoClock), which a wall-clock
  // step moves away from it. Without this, a step mid-take would put every later action off by its size in the video.
  // Its reference is taken just before the flash, so a step from the flash on is never missed; sampled every 20 ms so a
  // step back is measured from where the video had got to. (The sampling stops with the page.)
  const clock = new VideoClock(epoch, timing.wallClock);
  const sampler = setInterval(() => (page.isClosed() ? clearInterval(sampler) : clock.sample()), CLOCK_SAMPLE_MS);
  sampler.unref();
  const flashEpoch = (await page.evaluate((ms) => window.__scenecast.flash(ms), FLASH_MIN_MS)) - offset;
  const sinceFlash = () => Math.round((epoch() - flashEpoch) * 10) / 10000; // seconds, 0.1 ms resolution
  /** Now, in seconds after the flash on the video's clock: the time logged for an action. */
  const videoNow = () => Math.round((epoch() - flashEpoch + clock.shiftSec() * 1000) * 10) / 10000;
  /** The action's time to log as `at` (on the video's clock); notes how far that clock had moved by then. */
  const stamp = (ev: Partial<TakeEvent>): number => {
    const shift = clock.shiftSec();
    if (shift !== 0) ev.clockShift = shift;
    return Math.round((epoch() - flashEpoch + shift * 1000) * 10) / 10000;
  };
  const events: TakeEvent[] = [];
  const quiet = (p: Promise<unknown>) => void p.catch(() => {});

  let holdUntil = 0;
  /** When the latest ring is removed (Node epoch ms); a later step first waits for the page to show it gone. */
  let ringGoneAt = 0;
  const peakMeasures: Promise<void>[] = [];
  /** Park glides in flight: each is fired at its time without holding up the steps in between. */
  const parks: Promise<void>[] = [];

  /**
   * Sets the drawn cursor gliding to `p`, to arrive `travel` s after `due` (Node epoch ms), and returns the arrival.
   * Setting off late (the step's prep ran past `due`, e.g. a shortened glide right after the previous action)
   * compresses the glide, down to half its travel, so the action still lands on its cue.
   */
  const freshOffset = async () => {
    if (offsetStale) {
      offsetStale = false;
      offset = await clockOffset(page);
    }
  };
  const glideTo = async (p: Point, due: number, travel: number): Promise<number> => {
    await freshOffset();
    await sleepUntil(due);
    const arrive = Math.max(due + travel * 1000, epoch() + travel * 500);
    cursor = { ...p };
    // A short glide (a small glideMs, or one shortened to follow a close previous action) keeps most of its
    // time moving: the still lead before the action is at most 30% of it.
    const lead = Math.min(GLIDE_LEAD_MS, (arrive - epoch()) * 0.3);
    const glide = [p.x, p.y, arrive - lead + offset] as const;
    quiet(page.evaluate(([x, y, end]) => window.__scenecast.moveTo(x, y, end), glide));
    return arrive;
  };

  /**
   * Touch: no glide. The indicator fades in at `p` from `due` (Node epoch ms) and is full when the tap comes, `travel` s
   * later (the touch lead). Set off late, the fade is compressed the same way a glide is. Returns the tap time.
   */
  const touchAt = async (p: Point, due: number, travel: number, press = true): Promise<number> => {
    await freshOffset();
    await sleepUntil(due);
    const arrive = Math.max(due + travel * 1000, epoch() + travel * 500);
    cursor = { ...p };
    quiet(page.evaluate(([x, y, end, pr]) => window.__scenecast.touch(x, y, end, pr), [p.x, p.y, arrive + offset, press] as const));
    return arrive;
  };

  /**
   * Draws the recorder's ring around `box` now (the event's action time), held `hold` ms. The ringed elements
   * (`m`) are measured again at the ring's peak, without holding up the next step, and handed to `atPeak`
   * (undefined when they are gone by then).
   */
  const drawRing = (
    ev: Partial<TakeEvent>,
    r: { at: number; box: Box; hold: number; m: Measured; sels: string[]; index: number; atPeak: (b: Box | undefined) => void },
  ) => {
    const { at, box, hold, m, sels, index, atPeak } = r;
    quiet(page.evaluate(([b, ms]) => window.__scenecast.ring(b, ms), [box, hold] as const));
    const end = epoch() + hold + 2 * RING_FADE_MS;
    ev.ringBox = box;
    ev.busyUntil = Math.max(ev.busyUntil ?? at, at + (hold + 2 * RING_FADE_MS) / 1000);
    holdUntil = Math.max(holdUntil, end);
    ringGoneAt = Math.max(ringGoneAt, end + 50);
    const peakAt = epoch() + ringPeakSec(hold) * 1000;
    peakMeasures.push(
      sleepUntil(peakAt)
        .then(() => boxesOf(m.els, sels, scene.id, index))
        .then((now) => atPeak(now.union))
        .catch(() => atPeak(undefined)),
    );
  };

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
      // `ringSel`: the recorder rings these elements at the action. They are found before the glide, after the
      // pointer target was scrolled into view (the pre-positioned step's before the flash), and measured again
      // just before the action. They must be visible before the step (a hover can't reveal its own ringSel).
      const ringSels = asList(step.ringSel);
      let ringM = readyRingM && index === ready?.index ? readyRingM : ringSels.length ? await findRing(page, scene.id, index, ringSels) : undefined;
      // Each step glides for its own travel. With none (pre-positioned) the cursor is already on the
      // target: no glide and no lead, and the action fires at `due`.
      // On a phone the indicator fades in on the target instead (with no lead, a pre-positioned tap shows it at the tap).
      // A hover on a phone shows the finger resting on the target without a press.
      const press = step.do !== 'hover';
      const arrive = travel > 0 ? (touch ? await touchAt(centre(m.first), due, travel, press) : await glideTo(centre(m.first), due, travel)) : due;
      await sleepUntil(arrive - AIM_CHECK_MS);
      m = await aim(m, sels, scene.id, index);
      if (ringM) ringM = await boxesOf(ringM.els, ringSels, scene.id, index);
      // A check step presses only an element that isn't checked yet (seeded data may have it ticked already).
      const wasChecked = step.do === 'check' ? await isChecked(m.els[0]!) : undefined;
      ev.loadingBefore = (await snapshot(page, panelSel)).loading;
      const aimed = centre(m.first);
      // The real pointer moves ahead so the action itself is one press. A tap needs none (a hover still moves it).
      if (!touch || step.do === 'hover') await page.mouse.move(aimed.x, aimed.y);
      if (touch && (travel === 0 || Math.abs(aimed.x - cursor.x) > 1 || Math.abs(aimed.y - cursor.y) > 1)) {
        // The indicator on the target as it is now: moved there if the target moved, shown now if there was no lead.
        cursor = aimed;
        quiet(page.evaluate(([x, y, end, pr]) => window.__scenecast.touch(x, y, end, pr), [aimed.x, aimed.y, arrive + offset, press] as const));
      }
      await sleepUntil(arrive);
      ev.at = stamp(ev);
      if (!touch && (Math.abs(aimed.x - cursor.x) > 1 || Math.abs(aimed.y - cursor.y) > 1)) {
        cursor = aimed; // the target moved during travel: snap onto it
        quiet(page.evaluate(([x, y]) => window.__scenecast.cursor(x, y), [cursor.x, cursor.y] as const));
      }
      ev.target = m.union;
      ev.cursorTo = touch ? touchBox(cursor) : cursorBox(cursor);
      const at = ev.at;
      if (ringM) {
        const hold = step.ringMs ?? RING_HOLD_MS;
        drawRing(ev, { at, box: padBox(ringM.union, step.pad), hold, m: ringM, sels: ringSels, index, atPeak: (b) => void (b && (ev.ringTarget = b)) });
      }
      if (step.do === 'click' || step.do === 'type' || (step.do === 'check' && !wasChecked)) {
        // A phone taps (a check too, like any other press there); the indicator's press is its feedback.
        if (touch) await page.touchscreen.tap(cursor.x, cursor.y);
        else {
          quiet(page.evaluate(([x, y]) => window.__scenecast.ripple(x, y), [cursor.x, cursor.y] as const));
          await page.mouse.down();
          await page.mouse.up();
        }
        if (step.do === 'type' && step.text) {
          await page.keyboard.type(step.text, { delay: TYPE_DELAY_MS });
          ev.busyUntil = Math.max(ev.busyUntil ?? at, videoNow());
        }
      }
      if (step.do === 'check') {
        ev.clicked = !wasChecked;
        if (!(await becomesChecked(m.els[0]!)))
          throw new Error(`scene "${scene.id}" step ${index}: ${sels[0]} is not checked after the click`);
      }
    } else if (step.do === 'park' && touch) {
      // A phone has no cursor to park (the touch indicator fades out by itself): the step only logs its time.
      ev.loadingBefore = (await snapshot(page, panelSel)).loading;
      await sleepUntil(due + travel * 1000);
      ev.at = stamp(ev);
    } else if (step.do === 'park') {
      // Glides the drawn cursor to its spot, landing on the cue like any pointer step. (The real mouse stays,
      // as with the automatic park, so a hover menu stays open.)
      const to = parkPoint(step, where);
      ev.loadingBefore = (await snapshot(page, panelSel)).loading;
      const arrive = travel > 0 ? await glideTo(to, due, travel) : due;
      await sleepUntil(arrive);
      ev.at = stamp(ev);
      if (travel === 0 && (Math.abs(to.x - cursor.x) > 1 || Math.abs(to.y - cursor.y) > 1)) {
        cursor = { ...to }; // no time to glide: the cursor is placed on the spot
        quiet(page.evaluate(([x, y]) => window.__scenecast.cursor(x, y), [to.x, to.y] as const));
      }
      ev.cursorTo = cursorBox(to);
    } else if (step.do === 'ring' || step.do === 'zoom') {
      const m = await measure(page, scene.id, index, sels);
      const box = padBox(m.union, step.pad);
      ev.loadingBefore = (await snapshot(page, panelSel)).loading;
      await sleepUntil(due);
      ev.at = stamp(ev);
      if (step.do === 'ring') {
        // The element as it is when the ring peaks; gone by then, the audit fails the ring for it.
        const atPeak = (b: Box | undefined) => void (b ? (ev.target = b) : delete ev.target);
        drawRing(ev, { at: ev.at, box, hold: step.ms ?? RING_HOLD_MS, m, sels, index, atPeak });
      } else ev.target = box;
    } else {
      const el = sels.length ? await findVisible(page, scene.id, index, sels[0]!) : undefined;
      ev.loadingBefore = (await snapshot(page, panelSel)).loading;
      await sleepUntil(due);
      ev.at = stamp(ev);
      switch (step.do) {
        case 'scroll': {
          const before = await page.evaluate(() => scrollY).catch(() => undefined);
          if (el) await el.evaluate((e) => e.scrollIntoView({ behavior: 'smooth', block: 'center' }));
          else if (step.to !== undefined) await page.evaluate((top) => window.scrollTo({ top, behavior: 'smooth' }), step.to);
          else await page.evaluate((by) => window.scrollBy({ top: by ?? innerHeight * 0.8, behavior: 'smooth' }), step.by ?? null);
          await scrollRest(page);
          const y = await page.evaluate(() => scrollY).catch(() => undefined);
          if (y !== undefined) ev.scrollY = round(y);
          // `by`/`to` scroll the window. An app that scrolls inside a container leaves it where it was: say so
          // rather than record a scene where nothing moves.
          const asked = (step.by !== undefined && step.by !== 0) || (step.to !== undefined && before !== undefined && Math.abs(step.to - before) > 1);
          if (asked && y !== undefined && before !== undefined && Math.abs(y - before) < 1)
            throw new Error(
              `scene "${scene.id}" step ${index}: the page did not scroll (the window is not scrollable here; ` +
                `the app probably scrolls inside a container: use a scroll step with sel instead)`,
            );
          break;
        }
        case 'press':
          await page.keyboard.press(step.text ?? 'Enter');
          break;
        case 'goto':
          await page.goto(url(step.text ?? sels[0] ?? '/'), { waitUntil: 'domcontentloaded' });
          break;
        default:
          break; // wait, and unzoom (the composer eases the zoom out; the step logs its time only): the schedule spaced it
      }
      if (sels.length && step.do !== 'goto') ev.target = (await measure(page, scene.id, index, sels)).union;
    }

    Object.assign(ev, await snapshot(page, panelSel));
    // A step held with `ms` is busy until the hold ends. Not a zoom: the composer draws it, and retime may trim its hold.
    if (step.ms && ev.at !== undefined && step.do !== 'zoom' && step.do !== 'unzoom') ev.busyUntil = Math.max(ev.busyUntil ?? ev.at, ev.at + step.ms / 1000);
    if (park && !touch && onTarget(step.do) && ev.at !== undefined) {
      // Glide off to the park spot once the action is over and the park time has come. Skipped when the glide
      // would still be running as the next pointer step sets off (two glides would fight over the cursor).
      // The park delay counts from the action as it happened, so a late action still rests before the cursor leaves.
      const delaySec = park.at - (startAt + travel);
      // ev.at and busyUntil are on the video's clock: back to the monotonic one, which times the glide (each with the
      // shift it was logged with: `at` its own, busyUntil the current one, close enough for a cosmetic glide).
      const shift = clock.shiftSec();
      const firedAt = ev.at - (ev.clockShift ?? 0);
      const setOff = flashEpoch + 1000 * Math.max(park.at, firedAt + delaySec, (ev.busyUntil ?? ev.at) - shift, sinceFlash());
      const next = steps.slice(k + 1).find((s) => POINTER.has(s.step.do));
      // The margin keeps retime's protected stretch before the next action (its travel + 0.15 s) clear of the
      // park glide, so an early-arrival hold never freezes the cursor mid-park.
      if (!next || setOff + PARK_GLIDE_MS + PROTECT_MARGIN_SEC * 1000 <= flashEpoch + next.startAt * 1000) {
        ev.parkTo = cursorBox(park.to);
        ev.parkedAt = Math.round((setOff - flashEpoch + shift * 1000) * 10) / 10000;
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
  // Never shorter than the narration needs: retime would have nothing to show past the last frame. Retime lines the
  // take up on the actions, so past the last one it reads as far beyond `minTakeSec` as that action was late (on the
  // video's clock, so a wall-clock step counts too): keep recording that much longer.
  const lateBy = Math.max(0, ...events.map((e) => e.at - actionAt(scheduled.find((s) => s.index === e.index)!)));
  await sleepUntil(Math.max(epoch(), flashEpoch + (timing.minTakeSec + lateBy - clock.shiftSec()) * 1000));
  clearInterval(sampler);
  await sleepUntil(epoch() + TAIL_SEC * 1000);
  await Promise.all(peakMeasures);
  return {
    flashAt: Math.round(flashEpoch - videoStart) / 1000,
    ...(navs.length ? { navs } : {}),
    ...(initialZoom ? { initialZoom } : {}),
    events,
  };
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
