import { DEFAULTS } from './scene/schema.js';
import type { Box } from './record/record.js';

/** Share of the frame height a phone take fills in the composed frame. */
export const PHONE_HEIGHT_SHARE = 0.8;

/** Where the phone take sits in the frame: scaled to 80% of frame height, centred both ways. */
export function phoneFrame(): { x: number; y: number; w: number; h: number; scale: number } {
  const { width: fw, height: fh } = DEFAULTS.video;
  const { width: pw, height: ph } = DEFAULTS.phone;
  const h = fh * PHONE_HEIGHT_SHARE;
  const scale = h / ph;
  const w = pw * scale;
  return { x: (fw - w) / 2, y: (fh - h) / 2, w, h, scale };
}

/** Maps a box in the 390×844 phone take's pixels into 1920×1080 frame pixels. */
export function phoneToFrame(box: Box): Box {
  const f = phoneFrame();
  return { x: f.x + box.x * f.scale, y: f.y + box.y * f.scale, w: box.w * f.scale, h: box.h * f.scale };
}
