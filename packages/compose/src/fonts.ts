// Fonts the Revideo page draws with. The bundled ones (packages/compose/fonts, e.g. Inter) are loaded with
// FontFace before the first frame; any other named font must be installed where the render runs. A font that
// is not there fails the render, naming it: captions and cards never fall back to another typeface silently.
// Runs in the page (browser APIs only, no Node imports).

/** A bundled font face the page loads (url is served next to the media). */
export interface BundledFont {
  family: string;
  url: string;
  /** CSS weight range of the (variable) face, e.g. "100 900". */
  weight: string;
}

/** Families a page draws with and the faces it brings along. */
export interface PageFonts {
  bundled: BundledFont[];
  /** Every family the plan names (`brand.font`, the card font). */
  required: string[];
}

const PROBE = 'mmmmmmmmmmlli WQ@#0123456789';
const GENERIC = ['monospace', 'serif', 'sans-serif'] as const;

/** Whether `family` is installed: text set in it measures differently from each generic fallback. */
function installed(family: string): boolean {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return false;
  const width = (font: string) => {
    ctx.font = font;
    return ctx.measureText(PROBE).width;
  };
  const name = `"${family.replace(/"/g, '')}"`;
  return GENERIC.some((g) => width(`500 44px ${name}, ${g}`) !== width(`500 44px ${g}`));
}

/** The families in `fonts.required` that the page cannot draw with. */
export function missingFonts(fonts: PageFonts): string[] {
  const bundled = new Set(fonts.bundled.map((f) => f.family.toLowerCase()));
  return [...new Set(fonts.required)].filter((family) =>
    bundled.has(family.toLowerCase()) ? !document.fonts.check(`500 44px "${family.replace(/"/g, '')}"`) : !installed(family),
  );
}

/** Loads the bundled faces, then fails when a required family is still missing. */
export async function loadFonts(fonts: PageFonts): Promise<void> {
  for (const f of fonts.bundled) {
    const face = new FontFace(f.family, `url("${f.url}")`, { weight: f.weight });
    document.fonts.add(face);
    await face.load();
  }
  await document.fonts.ready;
  const missing = missingFonts(fonts);
  // One line in the render log saying which families were checked and found (tests read it).
  const ok = [...new Set(fonts.required)].filter((f) => !missing.includes(f));
  console.info(`scenecast fonts: ${ok.map((f) => `"${f}" ok`).join(', ') || 'none'}${missing.length ? `; missing ${missing.join(', ')}` : ''}`);
  if (missing.length)
    throw new Error(
      `scenecast: font ${missing.map((m) => `"${m}"`).join(', ')} is not available to the renderer. ` +
        'Install it where the render runs, or use a bundled font (Inter) in brand.font / brand.cardFont.',
    );
}
