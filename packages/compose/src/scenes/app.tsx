/** @jsxImportSource @revideo/2d/lib */
// An app scene: the retimed take (clips and frozen holds), eased zooms, highlight rings,
// captions and, for phone takes, the CSS-drawn phone outline. Every property is a function
// of the global time, so the scene is the same however the player seeks.
import { Node, Rect, Txt, Video } from '@revideo/2d';
import type { Box, Cue } from '@scenecast/core';
import type { ResolvedPlan } from '../plan.js';
import { inkOver, ringAlpha, sceneOpacity, srcTimeAt, zoomBoxAt } from '../timing.js';
import { backgroundNode } from './card.js';

type Scene = ResolvedPlan['scenes'][number];

const CAPTION = { fontPx: 44, lineHeight: 1.3, padX: 28, padY: 18, radius: 14, fill: 'rgba(20,20,30,0.82)', fade: 0.1 };
const RING = { color: '#F5C518', width: 3, radius: 10 };
const PHONE = { bezel: 14, radius: 58, body: '#16181D', edge: 'rgba(255,255,255,0.16)', screenRadius: 44 };

export const SYSTEM_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif';
export const fontStack = (font: string) => `"${font.replace(/"/g, '')}", ${SYSTEM_SANS}`;

/** Centre of a top-left frame-px box in Revideo's centred coordinates. */
export const centre = (b: Box, plan: Pick<ResolvedPlan, 'width' | 'height'>) => ({
  x: b.x + b.w / 2 - plan.width / 2,
  y: b.y + b.h / 2 - plan.height / 2,
});

/**
 * One caption cue, shown from `cue.start` to `cue.end` scene time: a rounded plate with its lines centred. A cue
 * beside the phone is set straight on the stage instead, aligned to its edge facing the phone (left of the column
 * right of the phone, right of the column left of it), when the stage gives its ink 4.5:1 or more everywhere under
 * it; otherwise (a photo, a gradient too busy for one ink) it keeps the plate, with its lines aligned the same way.
 */
export function caption(cue: Cue, plan: ResolvedPlan, local: () => number) {
  const c = centre(cue.box, plan);
  const alpha = () => {
    const t = local();
    if (t < cue.start || t >= cue.end) return 0;
    return Math.min(1, (t - cue.start) / CAPTION.fade, (cue.end - t) / CAPTION.fade);
  };
  const lh = CAPTION.fontPx * CAPTION.lineHeight;
  const top = -cue.box.h / 2 + CAPTION.padY + lh / 2;
  const beside = cue.side === 'beside';
  // Beside the phone: the column is right of the frame's centre when the phone is on the left.
  const align = beside ? (c.x > 0 ? -1 : 1) : 0;
  const ink = beside ? inkOver(plan.background, cue.box, plan.width, plan.height) : null;
  const lineX = align * (cue.box.w / 2 - CAPTION.padX);
  return (
    <Rect x={c.x} y={c.y} width={cue.box.w} height={cue.box.h} radius={CAPTION.radius} fill={ink ? null : CAPTION.fill} opacity={alpha}>
      {cue.lines.map((line, i) => (
        <Txt
          text={line}
          x={lineX}
          offsetX={align}
          y={top + i * lh}
          fill={ink ?? '#FFFFFF'}
          fontFamily={fontStack(plan.brand.font)}
          fontSize={CAPTION.fontPx}
          lineHeight={lh}
          fontWeight={500}
        />
      ))}
    </Rect>
  );
}

export function appScene(scene: Scene, plan: ResolvedPlan, time: () => number): Node {
  const local = () => Math.max(0, time() - scene.start);
  const segments = scene.segments ?? [];
  const full = { x: 0, y: 0, w: plan.width, h: plan.height };
  const zooms = scene.zooms ?? [];
  const zoom = () => zoomBoxAt(zooms, local(), full, plan.zoomEaseSec);
  const zoomScale = () => plan.width / zoom().w;
  const zoomPos = () => {
    const z = zoom();
    const s = plan.width / z.w;
    const c = centre(z, plan);
    return { x: -s * c.x, y: -s * c.y };
  };

  const screen = scene.phone ? plan.phoneRect : full;
  const screenCentre = centre(screen, plan);
  const sources = [...new Set(segments.map((s) => s.src))];
  const videos = sources.map((src) => (
    <Video
      src={src}
      decoder={'web'}
      x={screenCentre.x}
      y={screenCentre.y}
      width={screen.w}
      height={screen.h}
      radius={scene.phone ? PHONE.screenRadius : 0}
      clip={!!scene.phone}
      time={() => srcTimeAt(segments, local())?.time ?? 0}
      opacity={() => (srcTimeAt(segments, local())?.src === src ? 1 : 0)}
    />
  ));

  const phoneBody = scene.phone ? (
    <Rect
      x={screenCentre.x}
      y={screenCentre.y}
      width={screen.w + 2 * PHONE.bezel}
      height={screen.h + 2 * PHONE.bezel}
      radius={PHONE.radius}
      fill={PHONE.body}
      stroke={PHONE.edge}
      lineWidth={2}
      shadowColor={'rgba(0,0,0,0.45)'}
      shadowBlur={60}
      shadowOffsetY={18}
    />
  ) : null;

  const rings = (scene.rings ?? []).map((r) => {
    const c = centre(r.box, plan);
    return (
      <Rect
        x={c.x}
        y={c.y}
        width={r.box.w}
        height={r.box.h}
        radius={RING.radius}
        stroke={RING.color}
        lineWidth={RING.width}
        opacity={() => ringAlpha(r, local())}
      />
    );
  });

  return (
    <Node opacity={() => sceneOpacity(scene, time())}>
      {scene.phone ? backgroundNode(plan.background, plan.width, plan.height) : null}
      <Node scale={zoomScale} position={zoomPos}>
        {phoneBody}
        {videos}
        {rings}
      </Node>
      {(scene.cues ?? []).map((cue) => caption(cue, plan, local))}
    </Node>
  ) as Node;
}
