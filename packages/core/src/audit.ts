import fs from 'node:fs';
import path from 'node:path';
import type { Cue } from './captions.js';
import { clampZoom, phoneFrame, phoneToFrame, type NavBox } from './frame.js';
import { RING_FADE_MS, RING_HOLD_MS, ringPeakSec, type Box, type Take } from './record/record.js';
import { outputTimeOf, type Segment } from './retime.js';
import { DEFAULTS, type Brand, type Scene } from './scene/schema.js';
import { actionAt, cueWordIndex, type ScheduledStep } from './schedule.js';
import { ensureToolchain, runPy } from './toolchain.js';
import type { SceneVoice } from './voice.js';

/** A zoom or ring of the plan: scene seconds, and a box in frame px (take px on phone scenes). */
export interface AuditTimed {
  start: number;
  end: number;
  box: Box;
}

/** The parts of a compose plan scene the audit reads (a `PlanScene` from @scenecast/compose fits). */
export interface AuditPlanScene {
  kind: 'app' | 'card';
  duration: number;
  segments?: Segment[];
  cues?: Cue[];
  zooms?: AuditTimed[];
  rings?: AuditTimed[];
  phone?: boolean;
  navBox?: Box;
  navs?: NavBox[];
}

/** The parts of a `ComposePlan` the audit reads. */
export interface AuditPlan {
  brand: Brand;
  scenes: AuditPlanScene[];
}

/**
 * One scene and where the plan shows it. An app scene (recorded) needs `scheduled`, `take` and
 * `flashTime`; a title scene (a narrated card) has none of them and gets the narration check only.
 */
export interface AuditScene {
  scene: Scene;
  /** Index of the scene in `plan.scenes`. */
  planIndex: number;
  scheduled?: ScheduledStep[];
  take?: Take;
  /** The flash time retime used (from `scanFlash`), so event times map exactly as the segments do. */
  flashTime?: number;
  /** The scene's voice timeline: its phrase windows bound where the transcript may place a word. */
  voice?: SceneVoice;
}

export interface HeardWord {
  w: string;
  start: number;
  end: number;
}

export interface AuditOpts {
  /** The final mixed MP4. */
  video: string;
  plan: AuditPlan;
  scenes: AuditScene[];
  /** What `mix()` measured. */
  loudness: { lufs: number; truePeak: number };
  /** The video's work dir (work/<id>); the audit goes to `<workDir>/audit`. */
  workDir: string;
  /** The scene file's audit settings: `audit.allowList` is read from here. */
  spec?: { audit?: { allowList: string[] } };
  /** Overrides the scene file's allow-list (names speech recognition may spell differently without a WARN). */
  allowList?: string[];
  /** A transcript of the final mix (seconds on the video clock). Without it faster-whisper makes one. */
  words?: HeardWord[];
}

export interface AuditCounts {
  pass: number;
  warn: number;
  fail: number;
}

export interface AuditResult {
  pass: boolean;
  counts: AuditCounts;
  dir: string;
  /** Non-zero when any check FAILs (WARN never fails). */
  exitCode: number;
}

/** A plan zoom or ring belongs to a step when it starts this close to the step's action. */
const MATCH_SEC = 0.5;
/** The composer's ring fades in over the same 150 ms as the recorder's (compose/src/timing.ts). */
const RING_FADE_SEC = RING_FADE_MS / 1000;

const selectors = (s: ScheduledStep) => (s.step.sel === undefined ? [] : Array.isArray(s.step.sel) ? s.step.sel : [s.step.sel]);

function nearest(items: AuditTimed[], t: number): AuditTimed | undefined {
  let best: AuditTimed | undefined;
  for (const it of items) if (Math.abs(it.start - t) <= MATCH_SEC && (!best || Math.abs(it.start - t) < Math.abs(best.start - t))) best = it;
  return best;
}

/** The JSON the Python audit reads: every time on the final video's clock, every box in frame px. */
export function buildAuditInput(
  opts: AuditOpts,
  tools: { outDir: string; ffmpeg: string | null; whisperModel: string | null },
): Record<string, unknown> {
  const { width, height, zoomEaseSec } = DEFAULTS.video;
  const frame: Box = { x: 0, y: 0, w: width, h: height };
  const starts: number[] = [];
  opts.plan.scenes.reduce((t, s) => (starts.push(t), t + s.duration), 0); // compose timeline(): scene k starts at the sum before it
  const round = (t: number) => Math.round(t * 1000) / 1000;

  const scenes = opts.scenes.map(({ scene, planIndex, scheduled, take, flashTime, voice }) => {
    const ps = opts.plan.scenes[planIndex];
    const start = starts[planIndex]!;
    // Phrase windows on the video clock, with how many narration words each holds (whitespace split).
    const phrases = (voice?.phrases ?? []).map((p) => ({
      start: round(start + p.start),
      end: round(start + p.end),
      words: p.text.trim().split(/\s+/).length,
    }));
    const cues = (ps?.cues ?? []).map((c) => ({
      start: round(start + c.start),
      end: round(start + c.end),
      side: c.side,
      box: c.box,
      text: c.lines.join(' '),
      ...(c.reason ? { reason: c.reason } : {}),
    }));
    if (scene.kind === 'title') {
      if (!ps || ps.kind !== 'card') throw new Error(`audit: title scene "${scene.id}" has no card at plan index ${planIndex}`);
      const base = { id: scene.id, kind: 'title', start: round(start), end: round(start + ps.duration), narration: scene.narration, cues, phrases };
      return { ...base, zooms: [], navBox: null, navs: [], events: [], moments: [] };
    }
    if (!ps || ps.kind !== 'app') throw new Error(`audit: scene "${scene.id}" has no app scene at plan index ${planIndex}`);
    if (!scheduled || !take || flashTime === undefined) throw new Error(`audit: app scene "${scene.id}" needs scheduled, take and flashTime`);
    const phone = take.viewport === 'phone';
    if (phone !== !!ps.phone) throw new Error(`audit: scene "${scene.id}": the take and the plan disagree on the phone viewport`);
    // Take and plan boxes are in take px on phone scenes; map them once, as captions.ts and the composer do.
    const toFrame = (b: Box): Box => (phone ? phoneToFrame(b) : b);
    const segments = ps.segments ?? [];
    const navBox = ps.navBox && toFrame(ps.navBox);
    const navs = (ps.navs ?? []).map((n) => ({ ...n, box: toFrame(n.box) }));
    const zooms = (ps.zooms ?? []).map((z) => ({
      start: z.start,
      end: z.end,
      box: clampZoom(toFrame(z.box), frame, DEFAULTS.audit.zoomPadPx, navBox, phone ? phoneFrame().x : 0, navs),
    }));
    const rings = (ps.rings ?? []).map((r) => ({ ...r, box: toFrame(r.box) }));
    const sceneTimeOf = (at: number) => outputTimeOf(segments, flashTime + at);
    const global = (t: number | null) => (t === null ? null : round(start + t));
    // Counted like the voice timeline's words (the narration split on whitespace), as the scheduler does.
    const narrationWords = scene.narration.trim().split(/\s+/);

    const events = take.events.map((e) => ({
      index: e.index,
      time: global(sceneTimeOf(e.at)),
      boxes: [
        ...(e.target ? [{ kind: 'target', box: toFrame(e.target) }] : []),
        ...(e.ringBox ? [{ kind: 'ring', box: toFrame(e.ringBox) }] : []),
        ...(e.cursorTo ? [{ kind: 'cursor', box: toFrame(e.cursorTo) }] : []),
        ...e.panels.map((p) => ({ kind: 'panel', box: toFrame(p) })),
      ],
    }));

    const moments = scheduled
      .filter((s) => s.step.cue !== undefined)
      .map((s) => {
        const ev = take.events.find((e) => e.index === s.index);
        if (!ev) throw new Error(`audit: scene "${scene.id}" step ${s.index} has no take event`);
        const mapped = sceneTimeOf(ev.at);
        const ref = mapped ?? actionAt(s);
        const problems: string[] = [];
        let actionTime = mapped;
        let zoom = null;
        let ring = null;
        let target = ev.target;
        if (s.step.do === 'zoom') {
          // The zoom is the composer's: it starts when the plan says.
          const z = nearest(zooms, ref);
          if (z) {
            actionTime = z.start;
            // Held once eased in; a zoom shorter than the ease is caught at its end, before it eases out.
            const hold = Math.min(z.start + zoomEaseSec, z.end);
            zoom = { box: z.box, start: round(start + z.start), end: round(start + z.end), hold: round(start + hold) };
          } else problems.push(`no zoom in the plan within ${MATCH_SEC} s of the action`);
        }
        // A `ringSel` ring is the recorder's too: drawn at the action, its target is the ringed element, not the pointer's.
        const ringSel = s.step.do !== 'ring' && s.step.ringSel !== undefined;
        if (ringSel) target = ev.ringTarget;
        if (s.step.do === 'ring' || ringSel) {
          // The ring drawn at the cue, checked against the element as it was at the ring's peak.
          const hold = (ringSel ? s.step.ringMs : s.step.ms) ?? RING_HOLD_MS;
          if (!ev.ringBox) problems.push(`no ring box was logged for this ${ringSel ? 'ringSel ring' : 'ring step'}`);
          else if (mapped !== null) ring = { box: toFrame(ev.ringBox), peak: round(start + mapped + ringPeakSec(hold)), by: 'recorder' };
        } else {
          const r = nearest(rings, ref);
          if (r) ring = { box: r.box, peak: round(start + Math.min(r.start + RING_FADE_SEC, (r.start + r.end) / 2)), by: 'composer' };
        }
        return {
          index: s.index,
          cue: s.step.cue!,
          occ: s.step.occ ?? 1,
          offset: s.step.offset ?? 0,
          kind: s.step.do,
          label: selectors(s).join(', '),
          actionTime: global(actionTime),
          planWordTime: round(start + (s.cueTime ?? 0)),
          cueWord: cueWordIndex(narrationWords, s.step.cue!, s.step.occ ?? 1),
          target: target ? toFrame(target) : null,
          // A spinner the action itself brings up is its result; only one up before it counts.
          loading: ev.loadingBefore ?? ev.loading,
          settleTimedOut: !!ev.settleTimedOut,
          ring,
          zoom,
          problems,
        };
      });

    // The app's screen in the frame: the whole frame, or the phone screen (the blank-frame check looks only here).
    const pf = phoneFrame();
    const screen = phone ? { x: pf.x, y: pf.y, w: pf.w, h: pf.h } : frame;
    return {
      id: scene.id,
      kind: 'app',
      screen,
      start: round(start),
      end: round(start + ps.duration),
      narration: scene.narration,
      cues,
      phrases,
      zooms: zooms.map((z) => ({ ...z, start: round(start + z.start), end: round(start + z.end) })),
      navBox: navBox ?? null,
      navs,
      events,
      moments,
    };
  });

  const L = DEFAULTS.loudness;
  return {
    video: opts.video,
    ffmpeg: tools.ffmpeg,
    whisperModel: tools.whisperModel,
    words: opts.words ?? null,
    outDir: tools.outDir,
    rules: {
      width,
      height,
      syncMaxSec: DEFAULTS.audit.syncMaxSec,
      zoomPadPx: DEFAULTS.audit.zoomPadPx,
      voiceLufs: L.voiceLufs,
      toleranceLu: L.toleranceLu,
      truePeakDb: L.truePeakDb,
      zoomEaseSec,
      blank: { ...DEFAULTS.blank },
      dissolveSec: DEFAULTS.video.dissolveSec,
    },
    loudness: opts.loudness,
    music: opts.plan.brand.music ? { licence: opts.plan.brand.music.licence } : null,
    allowList: opts.allowList ?? opts.spec?.audit?.allowList ?? [],
    scenes,
  };
}

/**
 * Audits the finished video moment by moment and writes `<workDir>/audit/` (audit-table.md, audit.json,
 * frames/, contact-sheet.png). The word times come from faster-whisper on the final mix unless `words` is given.
 */
export async function audit(opts: AuditOpts): Promise<AuditResult> {
  if (!fs.existsSync(opts.video)) throw new Error(`audit: video not found: ${opts.video}`);
  const dir = path.join(opts.workDir, 'audit');
  fs.rmSync(dir, { recursive: true, force: true }); // no frames left over from an earlier run
  fs.mkdirSync(dir, { recursive: true });
  const tc = await ensureToolchain({ offline: true }).catch(() => ensureToolchain());
  const input = buildAuditInput(opts, { outDir: dir, ffmpeg: tc.ffmpeg, whisperModel: opts.words ? null : tc.models.whisper });
  const inputPath = path.join(dir, 'audit-input.json');
  fs.writeFileSync(inputPath, JSON.stringify(input, null, 2) + '\n');
  await runPy('scenecast_py.audit', ['--input', inputPath]);
  const verdict = JSON.parse(fs.readFileSync(path.join(dir, 'audit.json'), 'utf8')) as { pass: boolean; counts: AuditCounts };
  return { pass: verdict.pass, counts: verdict.counts, dir, exitCode: verdict.pass ? 0 : 1 };
}
