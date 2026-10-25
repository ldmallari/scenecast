/** @jsxImportSource @revideo/2d/lib */
// Intro, outro and chapter cards in the brand colours: a flat primary background, an accent
// bar, the title and an optional subtitle that settle in over half a second.
import { Img, Node, Rect, Txt } from '@revideo/2d';
import type { ResolvedPlan } from '../plan.js';
import { easeInOutCubic, sceneOpacity } from '../timing.js';
import { fontStack } from './app.js';

type Scene = ResolvedPlan['scenes'][number];

const ENTER_SEC = 0.5;
const RISE_PX = 14;

/** Relative luminance of a #rgb / #rrggbb colour (WCAG). */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255).map((c) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** White text on dark brand colours, near-black on light ones. */
export const inkOn = (bg: string) => (luminance(bg) > 0.4 ? '#14161B' : '#FFFFFF');

export function cardScene(scene: Scene, plan: ResolvedPlan, time: () => number): Node {
  const card = scene.card!;
  const { brand } = plan;
  const title = card.title ?? (card.variant === 'intro' ? brand.introTitle : '');
  const subtitle = card.subtitle ?? (card.variant === 'intro' ? brand.introSubtitle : undefined);
  const ink = inkOn(brand.primary);
  const font = fontStack(brand.font);
  const local = () => Math.max(0, time() - scene.start);
  const enter = (delay: number) => () => easeInOutCubic((local() - delay) / ENTER_SEC);

  const big = card.variant === 'chapter' ? 76 : 88;
  const hasLogo = !!plan.logoUrl && card.variant !== 'chapter';
  const top = hasLogo ? -40 : -20;

  return (
    <Node opacity={() => sceneOpacity(scene, time())}>
      <Rect width={plan.width} height={plan.height} fill={brand.primary} />
      {hasLogo ? <Img src={plan.logoUrl!} height={96} y={-250} opacity={enter(0)} /> : null}
      <Rect width={88} height={8} radius={4} fill={brand.accent} y={() => top - big - 10 + RISE_PX * (1 - enter(0)())} opacity={enter(0)} />
      <Txt
        text={title}
        y={() => top + RISE_PX * (1 - enter(0.05)())}
        opacity={enter(0.05)}
        fill={ink}
        fontFamily={font}
        fontSize={big}
        fontWeight={700}
        letterSpacing={-1}
        textAlign={'center'}
        width={1500}
        textWrap={true}
      />
      {subtitle ? (
        <Txt
          text={subtitle}
          y={() => top + big + 10 + RISE_PX * (1 - enter(0.15)())}
          opacity={() => 0.82 * enter(0.15)()}
          fill={ink}
          fontFamily={font}
          fontSize={40}
          fontWeight={400}
          textAlign={'center'}
          width={1400}
          textWrap={true}
        />
      ) : null}
    </Node>
  ) as Node;
}
