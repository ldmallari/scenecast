#!/usr/bin/env node
// Runs the TypeScript sources directly on Node's built-in type stripping (Node 22.18+ / 24).
// The sources import each other as `./x.js` (NodeNext style); this hook maps such an import to the
// `.ts` file next to it when no `.js` file exists.
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.endsWith('.ts')) {
      const js = new URL(specifier, context.parentURL);
      const ts = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (!existsSync(fileURLToPath(js)) && existsSync(fileURLToPath(ts))) return nextResolve(ts.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { main } = await import('../src/index.ts');
try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  console.error(`scenecast: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 2;
}
