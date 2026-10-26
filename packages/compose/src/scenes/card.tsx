/** @jsxImportSource @revideo/2d/lib */
// Intro, outro and chapter cards: the brand background (colour, gradient or image), then either a rendered
// card page (full-frame image) or the drawn card: logo, accent bar, title, subtitle and the outro's next line
// in the card font, each brought in by the card entrance (see entranceAt).
import { Gradient, Img, Node, Rect, Txt } from '@revideo/2d';
import type { ResolvedBackground, ResolvedPlan } from '../plan.js';
import { channels, DARK_INK, entranceAt, gradientLine, LIGHT_INK, luminanceOf, sceneOpacity, type CardPart } from '../timing.js';
import { caption, fontStack } from './app.js';

type Scene = ResolvedPlan['scenes'][number];



const luminance = (hex: string) => luminanceOf(channels(hex));


/** White text on dark brand colours, near-black on light ones. */
export const inkOn = (bg: string) => (luminance(bg) > 0.4 ? DARK_INK : LIGHT_INK);

/**
 * The text colour for a background. A gradient is judged by its colour at the middle of the frame, where the text
 * sits (the gradient line's midpoint is the frame centre); an image gets white over its dim and the text scrim.
 */
export function inkFor(bg: ResolvedBackground): string {
  if (bg.kind === 'color') return inkOn(bg.color);
  if (bg.kind === 'gradient') {
    const [a, b] = [channels(bg.from), channels(bg.to)];
    const mid = a.map((c, i) => (c + b[i]!) / 2) as [number, number, number];
    return luminanceOf(mid) > 0.4 ? DARK_INK : LIGHT_INK;
  }
  return LIGHT_INK;
}


/**
 * Behind the text on an image background: a soft elliptical shade of black over the text block, fading out beyond
 * it. `keep` is the most of a white photo the dim and the scrim together let through: white text over 255 × 0.45
 * grey is 4.74:1, so with the lines in white at full opacity any photo keeps 4.5:1 or more.
 */
const SCRIM = { keep: 0.45, halfW: 1250, halfH: 400, plateau: 0.66 };

/** The scrim's alpha over an image dimmed by `dim`: (1 − dim)(1 − alpha) = keep (0.55 at dim 0, 0.31 at 0.35, 0 from 0.55). */
export const scrimAlpha = (dim: number) => (dim >= 1 ? 0 : Math.max(0, 1 - SCRIM.keep / (1 - dim)));

function textScrim(alpha: number, centreY: number, width: number, height: number): Node {
  // A radial gradient is a circle: draw it in a box stretched vertically by 1/k and squash the box by k.
  const k = SCRIM.halfH / SCRIM.halfW;
  const fill = new Gradient({
    type: 'radial',
    from: { x: 0, y: 0 },
    to: { x: 0, y: 0 },
    fromRadius: 0,
    toRadius: SCRIM.halfW,
    stops: [
      { offset: 0, color: `rgba(0,0,0,${alpha})` },
      { offset: SCRIM.plateau, color: `rgba(0,0,0,${alpha})` },
      { offset: 1, color: 'rgba(0,0,0,0)' },
    ],
  });
  return (<Rect width={width} height={height / k} y={centreY} scaleY={k} fill={fill} />) as Node;
}

/** The card background, full-frame. Also the phone stage's backdrop. */
export function backgroundNode(bg: ResolvedBackground, width: number, height: number): Node {
  if (bg.kind === 'color') return (<Rect width={width} height={height} fill={bg.color} />) as Node;
  if (bg.kind === 'gradient') {
    const { from, to } = gradientLine(bg.angle, width, height);
    const fill = new Gradient({ type: 'linear', from, to, stops: [{ offset: 0, color: bg.from }, { offset: 1, color: bg.to }] });
    return (<Rect width={width} height={height} fill={fill} />) as Node;
  }
  // The image was scaled and cropped to cover the frame when the plan was resolved.
  return (
    <Node>
      <Img src={bg.url} width={width} height={height} />
      {bg.dim > 0 ? <Rect width={width} height={height} fill={'#000000'} opacity={bg.dim} /> : null}
    </Node>
  ) as Node;
}

const LAYOUT = {
  logoY: -250,
  logoH: 96,
  barH: 8,
  titlePx: { intro: 88, outro: 88, chapter: 76 },
  subtitlePx: 40,
  nextPx: 34,
  nextOpacity: 0.75,
  subtitleOpacity: 0.82,
};

export function cardScene(scene: Scene, plan: ResolvedPlan, time: () => number): Node {
  const card = scene.card!;
  const { brand } = plan;
  const local = () => Math.max(0, time() - scene.start);
  const look = (part: CardPart) => () => entranceAt(plan.entrance, part, local());
  const captions = (scene.cues ?? []).map((cue) => caption(cue, plan, local));
  const background = backgroundNode(plan.background, plan.width, plan.height);

  if (card.image) {
    // A rendered card page: a still image, shown as it is (no entrance), under the card's captions.
    return (
      <Node opacity={() => sceneOpacity(scene, time())}>
        {background}
        <Img src={card.image} width={plan.width} height={plan.height} />
        {captions}
      </Node>
    ) as Node;
  }

  const title = card.title ?? (card.variant === 'intro' ? brand.introTitle : '');
  const subtitle = card.subtitle ?? (card.variant === 'intro' ? brand.introSubtitle : undefined);
  const ink = inkFor(plan.background);
  const font = fontStack(plan.cardFont);
  // Over a photo the text gets a scrim, a soft shadow, and the subtitle and next line at full strength.
  const onImage = plan.background.kind === 'image';
  const shadow = onImage ? { shadowColor: 'rgba(0,0,0,0.45)', shadowBlur: 24 } : {};
  const subtitleOpacity = onImage ? 1 : LAYOUT.subtitleOpacity;
  const nextOpacity = onImage ? 1 : LAYOUT.nextOpacity;

  const big = LAYOUT.titlePx[card.variant];
  const hasLogo = !!plan.logoUrl && card.variant !== 'chapter';
  const top = hasLogo ? -40 : -20;
  const subtitleY = top + big + 10;
  const nextY = subtitle ? subtitleY + LAYOUT.subtitlePx + 24 : top + big + 8;
  const barY = top - big - 10;
  const lastY = card.next ? nextY : subtitle ? subtitleY : top;

  const logo = look('logo');
  const bar = look('bar');
  const titleLook = look('title');
  const subLook = look('subtitle');
  const nextLook = look('next');

  return (
    <Node opacity={() => sceneOpacity(scene, time())}>
      {background}
      {plan.background.kind === 'image' && scrimAlpha(plan.background.dim) > 0
        ? textScrim(scrimAlpha(plan.background.dim), (barY + lastY) / 2, plan.width, plan.height)
        : null}
      {hasLogo ? (
        <Img src={plan.logoUrl!} height={LAYOUT.logoH} y={() => LAYOUT.logoY + logo().dy} opacity={() => logo().opacity} scale={() => logo().scale} />
      ) : null}
      <Rect
        width={() => bar().barW}
        height={LAYOUT.barH}
        radius={LAYOUT.barH / 2}
        fill={brand.accent}
        y={() => barY + bar().dy}
        opacity={() => bar().opacity}
      />
      <Txt
        text={title}
        y={() => top + titleLook().dy}
        opacity={() => titleLook().opacity}
        fill={ink}
        fontFamily={font}
        fontSize={big}
        fontWeight={700}
        letterSpacing={-1}
        textAlign={'center'}
        width={1500}
        textWrap={true}
        {...shadow}
      />
      {subtitle ? (
        <Txt
          text={subtitle}
          y={() => subtitleY + subLook().dy}
          opacity={() => subtitleOpacity * subLook().opacity}
          fill={ink}
          fontFamily={font}
          fontSize={LAYOUT.subtitlePx}
          fontWeight={400}
          textAlign={'center'}
          width={1400}
          textWrap={true}
          {...shadow}
        />
      ) : null}
      {card.next ? (
        <Txt
          text={card.next}
          y={() => nextY + nextLook().dy}
          opacity={() => nextOpacity * nextLook().opacity}
          fill={ink}
          fontFamily={font}
          fontSize={LAYOUT.nextPx}
          fontWeight={500}
          textAlign={'center'}
          width={1400}
          textWrap={true}
          {...shadow}
        />
      ) : null}
      {captions}
    </Node>
  ) as Node;
}
