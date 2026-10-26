import { z } from 'zod';
import { cueWordIndex } from '../schedule.js';

export const DEFAULTS = {
  voice: { name: 'af_heart', lang: 'en-us', speed: 0.9, phraseGapSec: 0.2, clauseGapSec: 0.15 },
  video: {
    width: 1920,
    height: 1080,
    fps: 30,
    dissolveSec: 0.35,
    breathSec: 0.45,
    zoomEaseSec: 0.7,
    takeTailSec: 0.5,
  },
  captions: {
    maxLines: 2,
    charsPerLine: 42,
    bottomZone: 0.25,
    fullFrameShare: 0.9,
    /** The column beside an off-centre phone: shorter lines, and `gapPx` clear of the phone and of the frame edge. */
    beside: { charsPerLine: 30, maxLines: 3, gapPx: 120 },
  },
  loudness: {
    voiceLufs: -16,
    toleranceLu: 1,
    musicLufs: -29,
    duckDb: 6,
    truePeakDb: -1.5,
    /** What loudnorm aims for; the extra margin absorbs AAC overshoot so the file still passes truePeakDb. */
    truePeakTargetDb: -2,
    musicFadeSec: 4,
  },
  phone: { width: 390, height: 844, align: 'left', touchPx: 34, touchLeadSec: 0.25, centreShare: 0.3 },
  cards: { introSec: 3, outroSec: 3, entrance: 'reveal' },
  /** `brand.background`: a gradient's angle (CSS degrees: 0 points up, 135 runs top-left to bottom-right) and an image's black overlay. */
  background: { angle: 135, dim: 0.35 },
  cursor: { start: 'center', park: 'right', parkAfterSec: 2.5, parkDelaySec: 0.6, marginPx: 96, spotY: 0.45 },
  audit: { syncMaxSec: 0.3, zoomPadPx: 24 },
  /**
   * A near-uniform ("blank") frame: the frame shrunk to gridW×gridH grey cells (area average) has a luma
   * standard deviation at or below lumaStdMax (0–255). A real page measures about 9 or more; a white page
   * mid-navigation measures under 0.2. Retime freezes the last good frame over blank frames in a take, and
   * the audit FAILs any blank frame left in an app scene.
   */
  blank: { gridW: 128, gridH: 72, lumaStdMax: 2 },
} as const;

const CursorSpotSchema = z.union([
  z.enum(['center', 'left', 'right']),
  z.object({ x: z.number(), y: z.number() }).strict(),
]);
export type CursorSpot = z.infer<typeof CursorSpotSchema>;

const SelSchema = z.union([z.string(), z.array(z.string())]);

const RouteDeclSchema = z.object({
  url: z.string().min(1),
  status: z.number().int().optional(),
  json: z.unknown().optional(),
  body: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  module: z.string().optional(),
}).strict();
export type RouteDecl = z.infer<typeof RouteDeclSchema>;

const BackgroundSchema = z.union([
  z.string(),
  z.object({ from: z.string(), to: z.string(), angle: z.number().optional() }).strict(),
  z.object({ image: z.string().min(1), dim: z.number().min(0).max(1).optional() }).strict(),
]);
export type Background = z.infer<typeof BackgroundSchema>;

const cardSec = (key: 'introSec' | 'outroSec') =>
  z.number().refine((v) => v === 0 || v >= 1, { message: `cards.${key}: 0 (no card) or at least 1` });

const CardsSchema = z.object({
  introSec: cardSec('introSec').default(DEFAULTS.cards.introSec),
  outroSec: cardSec('outroSec').default(DEFAULTS.cards.outroSec),
  outroTitle: z.string().optional(),
  outroNext: z.string().optional(),
  entrance: z.enum(['reveal', 'rise', 'none']).default(DEFAULTS.cards.entrance),
  /**
   * HTML files rendered once (1920×1080, in Chromium) as the intro/outro card image, with the brand as the CSS
   * variables --sc-primary, --sc-accent, --sc-font and --sc-card-font. It is a still: CSS animations and
   * transitions are captured at their end state and do not play; the card's entrance does not apply to it.
   */
  introPage: z.string().optional(),
  outroPage: z.string().optional(),
}).strict();
export type CardsCfg = z.infer<typeof CardsSchema>;

const CursorSchema = z.object({
  start: CursorSpotSchema.default(DEFAULTS.cursor.start),
  park: z.union([CursorSpotSchema, z.literal('off')]).default(DEFAULTS.cursor.park),
  parkAfterSec: z.number().positive().default(DEFAULTS.cursor.parkAfterSec),
}).strict();
export type CursorCfg = z.infer<typeof CursorSchema>;

const PhoneSchema = z.object({
  align: z.enum(['left', 'center', 'right']).default(DEFAULTS.phone.align),
}).strict();
export type PhoneCfg = z.infer<typeof PhoneSchema>;
export type PhoneAlign = PhoneCfg['align'];

const StepSchema = z.object({
  cue: z.string().min(1).optional(),
  occ: z.number().int().min(1).optional(),
  offset: z.number().optional(),
  do: z.enum(['click', 'type', 'hover', 'scroll', 'press', 'zoom', 'ring', 'wait', 'goto', 'unzoom', 'park', 'check']),
  sel: z.union([z.string(), z.array(z.string())]).optional(),
  text: z.string().optional(),
  ms: z.number().nonnegative().optional(),
  pad: z.number().nonnegative().optional(),
  settle: z.boolean().optional(),
  ring: z.boolean().optional(),
  glideMs: z.number().positive().optional(),
  ringSel: SelSchema.optional(),
  ringMs: z.number().nonnegative().optional(),
  by: z.number().optional(),
  to: z.number().nonnegative().optional(),
  at: CursorSpotSchema.optional(),
}).strict();

const BrandSchema = z.object({
  primary: z.string(),
  accent: z.string(),
  font: z.string(),
  logo: z.string().optional(),
  introTitle: z.string(),
  introSubtitle: z.string().optional(),
  cardFont: z.string().optional(),
  background: BackgroundSchema.optional(),
  /** A user-supplied music track replaces the synthesised bed; its licence is copied to the audit. */
  music: z
    .object({
      file: z.string().min(1),
      licence: z.string().trim().min(1, 'brand.music.licence is required for a user-supplied track'),
    })
    .strict()
    .optional(),
}).strict();

const AppConnSchema = z.object({
  baseUrl: z.string(),
  storageState: z.string().optional(),
  login: z.array(StepSchema).optional(),
  loginHook: z.string().optional(),
  seed: z.string().optional(),
  initScript: z.union([z.string(), z.array(z.string())]).optional(),
  routes: z.array(RouteDeclSchema).optional(),
  panels: z.array(z.string()).optional(),
  /**
   * The app's navigation bars. A zoom never cuts one partly: it shows a nav whole or leaves it out.
   * `left` is a sidebar (checked across), `top` a bar along the top (checked down and across).
   */
  nav: z.array(z.object({ selector: z.string().min(1), edge: z.enum(['left', 'top']) }).strict()).optional(),
}).strict();

const VoiceSchema = z.object({
  name: z.string().default(DEFAULTS.voice.name),
  lang: z.string().default(DEFAULTS.voice.lang),
  speed: z.number().positive().default(DEFAULTS.voice.speed),
  phraseGapSec: z.number().nonnegative().default(DEFAULTS.voice.phraseGapSec),
  clauseGapSec: z.number().nonnegative().default(DEFAULTS.voice.clauseGapSec),
}).strict();

const SceneSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['app', 'title']),
  title: z.string().optional(),
  route: z.string().optional(),
  viewport: z.enum(['desktop', 'phone']).default('desktop'),
  signedOut: z.boolean().optional(),
  prewarm: z.array(z.string()).optional(),
  narration: z.string(),
  steps: z.array(StepSchema).default([]),
  /** Title scenes: an HTML file shown as the card, rendered once like `cards.introPage`. Ignored (with a warning) on app scenes. */
  page: z.string().optional(),
  zoom: z.object({ sel: SelSchema, pad: z.number().nonnegative().optional() }).strict().optional(),
  cursor: CursorSpotSchema.optional(),
  seconds: z.number().positive().optional(),
}).strict();

/**
 * Number of non-overlapping occurrences of `cue` in `narration`, counted exactly as the scheduler finds them:
 * over the narration's whitespace-separated words, case-insensitive, with punctuation trimmed from each word's
 * ends (so "in" does not match inside "sign-in", and "user" does not match "user's").
 */
export function countCue(narration: string, cue: string): number {
  const words = narration.trim().split(/\s+/);
  let n = 0;
  while (cueWordIndex(words, cue, n + 1) !== null) n++;
  return n;
}

export const VideoSpecSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    output: z.string(),
    brand: BrandSchema,
    app: AppConnSchema,
    voice: VoiceSchema.default({}),
    cards: CardsSchema.default({}),
    cursor: CursorSchema.default({}),
    phone: PhoneSchema.default({}),
    scenes: z.array(SceneSchema).min(1),
    /** Names and words speech recognition may spell differently without a narration WARN. */
    audit: z.object({ allowList: z.array(z.string().trim().min(1)).default([]) }).strict().optional(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    spec.app.routes?.forEach((r, k) => {
      const n = [r.json !== undefined, r.body !== undefined, r.module !== undefined].filter(Boolean).length;
      if (n > 1)
        ctx.addIssue({ code: 'custom', path: ['app', 'routes', k], message: `app.routes[${k}]: use one of json, body, module` });
    });
    spec.scenes.forEach((scene, si) => {
      if (scene.kind === 'title') {
        for (const key of ['seconds'] as const) {
          if (scene[key] === undefined) {
            ctx.addIssue({
              code: 'custom',
              path: ['scenes', si, key],
              message: `scene "${scene.id}": title scene requires ${key}`,
            });
          }
        }
      }
      checkStepFields(scene, si, ctx);
      scene.steps.forEach((step, i) => {
        if (step.cue === undefined) return;
        const n = countCue(scene.narration, step.cue);
        const where = `scene "${scene.id}" step ${i}`;
        let message: string | undefined;
        if (n === 0) message = `${where}: cue "${step.cue}" not in narration`;
        else if ((step.occ ?? 1) > n)
          message = `${where}: cue "${step.cue}" occurs ${n} time(s), occ ${step.occ} requested`;
        if (message) ctx.addIssue({ code: 'custom', path: ['scenes', si, 'steps', i, 'cue'], message });
      });
    });
  });

type SceneIn = z.infer<typeof SceneSchema>;

/** Per-step checks that need the step kind or the steps around it (unzoom pairing, field/kind fit). */
function checkStepFields(scene: SceneIn, si: number, ctx: z.RefinementCtx): void {
  let zoomed = scene.zoom !== undefined;
  let openZoom: number | undefined;
  scene.steps.forEach((step, i) => {
    const where = `scene "${scene.id}" step ${i}`;
    const path = ['scenes', si, 'steps', i];
    const bad = (message: string) => ctx.addIssue({ code: 'custom', path, message: `${where}: ${message}` });
    const pointer = ['click', 'type', 'hover', 'check'];
    if (step.glideMs !== undefined && ![...pointer, 'park'].includes(step.do))
      bad('glideMs is for click, type, hover, check and park steps');
    if ((step.ringSel !== undefined || step.ringMs !== undefined) && !pointer.includes(step.do))
      bad('ringSel and ringMs are for click, type, hover and check steps');
    if (step.at !== undefined && step.do !== 'park') bad('at is for park steps');
    if ((step.by !== undefined || step.to !== undefined) && step.do !== 'scroll')
      bad('by and to are for scroll steps');
    if (step.do === 'scroll' && [step.sel, step.by, step.to].filter((v) => v !== undefined).length > 1)
      bad('scroll takes one of sel, by, to');
    if (step.do === 'zoom') {
      zoomed = true;
      openZoom = i;
    } else if (step.do === 'unzoom') {
      if (!zoomed) bad('unzoom with no zoom before it');
      else if (openZoom !== undefined && scene.steps[openZoom]!.ms !== undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['scenes', si, 'steps', openZoom],
          message: `scene "${scene.id}" step ${openZoom}: zoom has ms and is ended by the unzoom at step ${i}; drop one`,
        });
      zoomed = false;
      openZoom = undefined;
    }
  });
}

/** Non-fatal notes about a valid scene file. */
export function sceneWarnings(spec: VideoSpec): string[] {
  const out: string[] = [];
  for (const scene of spec.scenes)
    if (scene.kind === 'app' && scene.page !== undefined)
      out.push(`scene "${scene.id}": page is used only on title scenes; ignored`);
  return out;
}

export type VideoSpec = z.infer<typeof VideoSpecSchema>;
export type Scene = VideoSpec['scenes'][number];
export type Step = z.infer<typeof StepSchema>;
export type Brand = z.infer<typeof BrandSchema>;
export type AppConn = z.infer<typeof AppConnSchema>;
export type NavDecl = NonNullable<AppConn['nav']>[number];
export type VoiceCfg = z.infer<typeof VoiceSchema>;
