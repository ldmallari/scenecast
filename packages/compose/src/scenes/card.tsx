/** @jsxImportSource @revideo/2d/lib */
// Intro, outro and chapter cards: the brand background (colour, gradient or image), then either a rendered
// card page (full-frame image) or the drawn card: logo, accent bar, title, subtitle and the outro's next line
// in the card font, each brought in by the card entrance (see entranceAt).
import { Gradient, Img, Node, Rect, Txt } from '@revideo/2d';
import type { ResolvedBackground, ResolvedPlan } from '../plan.js';
import { entranceAt, gradientLine, sceneOpacity, type CardPart } from '../timing.js';
import { caption, fontStack } from './app.js';

type Scene = ResolvedPlan['scenes'][number];

/** Relative luminance of a #rgb / #rrggbb colour (WCAG). */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255).map((c) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const DARK_INK = '#14161B';
const LIGHT_INK = '#FFFFFF';

/** White text on dark brand colours, near-black on light ones. */
export const inkOn = (bg: string) => (luminance(bg) > 0.4 ? DARK_INK : LIGHT_INK);

/** The text colour for a background: a gradient is judged by its middle, an image (under its dim) gets white. */
export function inkFor(bg: ResolvedBackground): string {
  if (bg.kind === 'color') return inkOn(bg.color);
  if (bg.kind === 'gradient') return (luminance(bg.from) + luminance(bg.to)) / 2 > 0.4 ? DARK_INK : LIGHT_INK;
  return LIGHT_INK;
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
  // Over a photo, a soft shadow keeps the text legible whatever is behind it.
  const shadow = plan.background.kind === 'image' ? { shadowColor: 'rgba(0,0,0,0.45)', shadowBlur: 24 } : {};

  const big = LAYOUT.titlePx[card.variant];
  const hasLogo = !!plan.logoUrl && card.variant !== 'chapter';
  const top = hasLogo ? -40 : -20;
  const subtitleY = top + big + 10;
  const nextY = subtitle ? subtitleY + LAYOUT.subtitlePx + 24 : top + big + 8;

  const logo = look('logo');
  const bar = look('bar');
  const titleLook = look('title');
  const subLook = look('subtitle');
  const nextLook = look('next');

  return (
    <Node opacity={() => sceneOpacity(scene, time())}>
      {background}
      {hasLogo ? (
        <Img src={plan.logoUrl!} height={LAYOUT.logoH} y={() => LAYOUT.logoY + logo().dy} opacity={() => logo().opacity} scale={() => logo().scale} />
      ) : null}
      <Rect
        width={() => bar().barW}
        height={LAYOUT.barH}
        radius={LAYOUT.barH / 2}
        fill={brand.accent}
        y={() => top - big - 10 + bar().dy}
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
          opacity={() => LAYOUT.subtitleOpacity * subLook().opacity}
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
          opacity={() => LAYOUT.nextOpacity * nextLook().opacity}
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
