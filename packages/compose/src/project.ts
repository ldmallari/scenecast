// The Revideo project: one Revideo scene that lays out every plan scene on a shared clock
// (dissolves overlap neighbouring scenes, which separate Revideo scenes cannot do).
// The resolved plan is injected at build time as __SCENECAST_PLAN__ (see render.ts).
import { makeScene2D } from '@revideo/2d';
import { makeProject, useThread, waitFor } from '@revideo/core';
import { loadFonts } from './fonts.js';
import type { ResolvedPlan } from './plan.js';
import { appScene } from './scenes/app.js';
import { cardScene } from './scenes/card.js';

declare const __SCENECAST_PLAN__: ResolvedPlan;
const plan = __SCENECAST_PLAN__;

const main = makeScene2D('scenecast', function* (view) {
  const time = useThread().time;
  // Fonts first: every caption and card is set in them, and a missing one fails the render here.
  yield loadFonts(plan.fonts);
  for (const scene of plan.scenes) {
    const node = scene.kind === 'card' ? cardScene(scene, plan, time) : appScene(scene, plan, time);
    view.add(node);
    // Wait for the node's async resources (video metadata and the first decoded frame) before
    // frame 0; reading them earlier is what Revideo warns about and can leave frame 0 blank.
    yield node;
  }
  // Revideo renders floor(wait × fps) + 1 frames; half a frame short gives exactly total × fps.
  yield* waitFor(plan.total - 0.5 / plan.fps);
});

export default makeProject({
  scenes: [main],
  settings: {
    shared: { size: { x: plan.width, y: plan.height }, background: '#000000' },
    rendering: { fps: plan.fps },
    preview: { fps: plan.fps, resolutionScale: 0.5 },
  },
});
