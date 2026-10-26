// Card pages: an HTML file rendered once, at 1920×1080, as the image a card shows (`scene.page` on title scenes,
// `cards.introPage` / `cards.outroPage`). The page gets the brand as CSS variables. It is a still: the capture
// happens once, so CSS animations and transitions do not play in the video (finite ones are shown at their end
// state). Card pages are not the app: no routes, init scripts or session apply to them.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { DEFAULTS } from '../scene/schema.js';

export interface CardPageVars {
  primary: string;
  accent: string;
  /** The caption font (`brand.font`). */
  font: string;
  /** The card font (`brand.cardFont`, else `brand.font`). */
  cardFont: string;
}

/** Time for layout and images to finish after fonts are ready. */
const SETTLE_MS = 250;

/**
 * Renders `file` to a PNG at `out` (returned). `:root` gets `--sc-primary`, `--sc-accent`, `--sc-font` and
 * `--sc-card-font` (as inline styles, so they win over the page's own `:root` fallbacks) before the capture,
 * which waits for `document.fonts.ready` and a short settle.
 */
export async function renderCardPage(file: string, out: string, vars: CardPageVars): Promise<string> {
  if (!fs.existsSync(file)) throw new Error(`card page not found: ${file}`);
  const { width, height } = DEFAULTS.video;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    // Set the variables before any of the page's own scripts or styles run, so the first layout already uses them.
    await page.addInitScript((v: Record<string, string>) => {
      const apply = () => {
        for (const [k, val] of Object.entries(v)) document.documentElement.style.setProperty(k, val);
      };
      if (document.documentElement) return apply();
      // Init scripts run before <html> exists: apply as soon as the parser creates it (before any page script).
      const watch = new MutationObserver(() => {
        if (!document.documentElement) return;
        watch.disconnect();
        apply();
      });
      watch.observe(document, { childList: true });
    }, cssVars(vars));
    await page.goto(pathToFileURL(path.resolve(file)).href, { waitUntil: 'load' });
    await page.evaluate((v: Record<string, string>) => {
      for (const [k, val] of Object.entries(v)) document.documentElement.style.setProperty(k, val);
    }, cssVars(vars));
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.waitForTimeout(SETTLE_MS);
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    await page.screenshot({ path: out, type: 'png', animations: 'disabled', fullPage: false });
    return out;
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Brand values as the CSS variables a card page reads. Font names are quoted for use in `font-family`. */
function cssVars(v: CardPageVars): Record<string, string> {
  const quote = (f: string) => `"${f.replace(/"/g, '')}"`;
  return {
    '--sc-primary': v.primary,
    '--sc-accent': v.accent,
    '--sc-font': quote(v.font),
    '--sc-card-font': quote(v.cardFont),
  };
}
