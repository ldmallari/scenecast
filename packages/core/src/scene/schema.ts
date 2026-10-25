import { z } from 'zod';

export const DEFAULTS = {
  voice: { name: 'af_heart', lang: 'en-us', speed: 0.9, phraseGapSec: 0.2 },
  video: {
    width: 1920,
    height: 1080,
    fps: 30,
    dissolveSec: 0.35,
    breathSec: 0.45,
    leadSec: 0.3,
    zoomEaseSec: 0.7,
  },
  captions: { maxLines: 2, charsPerLine: 42, bottomZone: 0.25 },
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
  phone: { width: 390, height: 844 },
  audit: { syncMaxSec: 0.3, zoomPadPx: 24 },
} as const;

const StepSchema = z.object({
  cue: z.string().min(1).optional(),
  occ: z.number().int().min(1).optional(),
  offset: z.number().optional(),
  do: z.enum(['click', 'type', 'hover', 'scroll', 'press', 'zoom', 'ring', 'wait', 'goto']),
  sel: z.union([z.string(), z.array(z.string())]).optional(),
  text: z.string().optional(),
  ms: z.number().nonnegative().optional(),
  pad: z.number().nonnegative().optional(),
  settle: z.boolean().optional(),
  ring: z.boolean().optional(),
});

const BrandSchema = z.object({
  primary: z.string(),
  accent: z.string(),
  font: z.string(),
  logo: z.string().optional(),
  introTitle: z.string(),
  introSubtitle: z.string().optional(),
  /** A user-supplied music track replaces the synthesised bed; its licence is copied to the audit. */
  music: z
    .object({
      file: z.string().min(1),
      licence: z.string().trim().min(1, 'brand.music.licence is required for a user-supplied track'),
    })
    .optional(),
});

const AppConnSchema = z.object({
  baseUrl: z.string(),
  storageState: z.string().optional(),
  login: z.array(StepSchema).optional(),
  loginHook: z.string().optional(),
  seed: z.string().optional(),
});

const VoiceSchema = z.object({
  name: z.string().default(DEFAULTS.voice.name),
  lang: z.string().default(DEFAULTS.voice.lang),
  speed: z.number().positive().default(DEFAULTS.voice.speed),
  phraseGapSec: z.number().nonnegative().default(DEFAULTS.voice.phraseGapSec),
});

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
  page: z.string().optional(),
  seconds: z.number().positive().optional(),
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Number of case-insensitive, whole-word occurrences of `cue` in `narration`. */
export function countCue(narration: string, cue: string): number {
  const words = cue.trim().split(/\s+/).map(escapeRegExp).join('\\s+');
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${words}(?![\\p{L}\\p{N}_])`, 'giu');
  return [...narration.matchAll(re)].length;
}

export const VideoSpecSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    output: z.string(),
    brand: BrandSchema,
    app: AppConnSchema,
    voice: VoiceSchema.default({}),
    scenes: z.array(SceneSchema).min(1),
    /** Names and words speech recognition may spell differently without a narration WARN. */
    audit: z.object({ allowList: z.array(z.string().trim().min(1)).default([]) }).optional(),
  })
  .superRefine((spec, ctx) => {
    spec.scenes.forEach((scene, si) => {
      if (scene.kind === 'title') {
        for (const key of ['page', 'seconds'] as const) {
          if (scene[key] === undefined) {
            ctx.addIssue({
              code: 'custom',
              path: ['scenes', si, key],
              message: `scene "${scene.id}": title scene requires ${key}`,
            });
          }
        }
      }
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

export type VideoSpec = z.infer<typeof VideoSpecSchema>;
export type Scene = VideoSpec['scenes'][number];
export type Step = z.infer<typeof StepSchema>;
export type Brand = z.infer<typeof BrandSchema>;
export type AppConn = z.infer<typeof AppConnSchema>;
export type VoiceCfg = z.infer<typeof VoiceSchema>;
