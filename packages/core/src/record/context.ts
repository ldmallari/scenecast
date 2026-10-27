import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserContext, Frame, Page, Request, Route } from 'playwright';
import type { AppConn, RouteDecl, Step } from '../scene/schema.js';

/** Visible elements matching this are open panels (captions keep clear of them). `app.panels` adds to it. */
export const PANEL_SELECTOR = '[role=dialog],[role=menu],[role=listbox],[aria-modal=true],[data-scenecast-panel]';

/** The tag a restored tab carries in `window.name`, which survives navigations and the app clearing its storage. */
const RESTORED_TAG = '__scenecastRestored';

type RouteHandler = (route: Route, request: Request) => void | Promise<void>;

const initScripts = (app: AppConn): string[] =>
  app.initScript === undefined ? [] : Array.isArray(app.initScript) ? app.initScript : [app.initScript];

/** An init script item that is a file (the loader makes file items absolute); anything else is inline code. */
const isScriptFile = (item: string) => path.isAbsolute(item) && fs.existsSync(item);

/** `<stateFile minus .json>.session-storage.json`: where the sessionStorage saved with a session lives. */
export function sessionStoragePath(stateFile: string): string {
  return stateFile.replace(/\.json$/i, '') + '.session-storage.json';
}

/** The open-panel selector for this app: the built-in role-based list plus `app.panels`. */
export function panelSelector(app: AppConn): string {
  return [PANEL_SELECTOR, ...(app.panels ?? [])].join(',');
}

/**
 * An init script that writes the saved sessionStorage of the tab's origin once per tab (top frame only). The
 * "already restored" mark is kept in `window.name`, not in sessionStorage, so an app that clears its storage
 * (signs out, rotates a token) is not signed back in on its next navigation.
 */
export function restoreScript(entries: Record<string, Record<string, string>>): string {
  return `(() => {
  if (window !== window.top) return;
  const all = ${JSON.stringify(entries)};
  const mine = all[location.origin];
  const tag = ${JSON.stringify(RESTORED_TAG)};
  if (!mine || window.name.includes(tag)) return;
  for (const [k, v] of Object.entries(mine)) sessionStorage.setItem(k, v);
  window.name += tag;
})();`;
}

/** A frame's sessionStorage. Retries once if a navigation destroys the frame's context mid-read. */
async function readSessionStorage(frame: Frame): Promise<Record<string, string>> {
  const read = () =>
    frame.evaluate(() => {
      const out: Record<string, string> = {};
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k !== null) out[k] = sessionStorage.getItem(k) ?? '';
      }
      return out;
    });
  try {
    return await read();
  } catch {
    await frame.waitForLoadState('domcontentloaded').catch(() => {});
    return read().catch(() => ({}));
  }
}

/**
 * Saves the sessionStorage of the page's frames on `baseUrl`'s origin (the main frame's origin when no
 * `baseUrl` is given) to `sessionStoragePath(stateFile)`, as `{ "<origin>": { key: value } }`. With nothing to
 * save, no file is written and a stale one is removed.
 */
export async function captureSessionStorage(page: Page, stateFile: string, baseUrl?: string): Promise<void> {
  const originOf = (u: string) => {
    try {
      return new URL(u).origin;
    } catch {
      return 'null';
    }
  };
  const want = originOf(baseUrl ?? page.url());
  const entries: Record<string, Record<string, string>> = {};
  if (want !== 'null') {
    for (const frame of page.frames()) {
      if (originOf(frame.url()) !== want) continue;
      const items = await readSessionStorage(frame);
      if (Object.keys(items).length) entries[want] = { ...entries[want], ...items };
    }
  }
  const file = sessionStoragePath(stateFile);
  if (Object.keys(entries).length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(entries, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(file, 0o600); // `mode` only applies when the file is created
  } else fs.rmSync(file, { force: true });
}

/** CORS headers for a mocked answer, unless the route declares its own `access-control-allow-origin`. */
async function corsHeaders(request: Request, declared: Record<string, string>): Promise<Record<string, string>> {
  if (Object.keys(declared).some((k) => k.toLowerCase() === 'access-control-allow-origin')) return {};
  const origin = await request.headerValue('origin');
  return origin && origin !== 'null'
    ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin' }
    : { 'access-control-allow-origin': '*' };
}

/**
 * The handler for one declared route. CORS preflights are answered for every route. A `module` route answers
 * the request itself, so for an API on another origin its `route.fulfill` must set its own
 * `access-control-allow-origin` header.
 */
async function routeHandler(decl: RouteDecl): Promise<RouteHandler> {
  const declared = decl.headers ?? {};
  const mod = decl.module
    ? ((await import(pathToFileURL(path.resolve(decl.module)).href)) as { default?: RouteHandler }).default
    : undefined;
  if (decl.module && typeof mod !== 'function') throw new Error(`app.routes: ${decl.module} has no default export function`);
  return async (route, request) => {
    // A CORS preflight for a mocked API on another origin: allow it, so the real request reaches the mock.
    if (request.method() === 'OPTIONS' && (await request.headerValue('access-control-request-method'))) {
      const asked = await request.headerValue('access-control-request-headers');
      await route.fulfill({
        status: 204,
        headers: {
          ...(await corsHeaders(request, declared)),
          'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
          'access-control-allow-headers': asked ?? '*',
          'access-control-max-age': '600',
          ...declared,
        },
      });
      return;
    }
    if (mod) return mod(route, request);
    const headers = { ...(await corsHeaders(request, declared)), ...declared };
    const status = decl.status ?? 200;
    if (decl.json !== undefined) await route.fulfill({ status, json: decl.json, headers });
    else await route.fulfill({ status, body: decl.body ?? '', headers });
  };
}

/** The saved sessionStorage file. A bad file's error names only the path: the parser's message quotes the (secret) text. */
function readSaved(file: string): Record<string, Record<string, string>> {
  let entries: unknown;
  try {
    entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    entries = undefined;
  }
  const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const valid =
    isMap(entries) && Object.values(entries).every((m) => isMap(m) && Object.values(m).every((v) => typeof v === 'string'));
  if (!valid) throw new Error(`${file}: not a valid sessionStorage file (delete it and sign in again)`);
  return entries as Record<string, Record<string, string>>;
}

/**
 * Sets up a browser context for the app: `app.routes`, `app.initScript` (before the app's own scripts), and,
 * when `opts.sessionFile` has a saved sessionStorage file next to it, the script that restores it.
 */
export async function applyAppContext(context: BrowserContext, app: AppConn, opts: { sessionFile?: string } = {}): Promise<void> {
  for (const decl of app.routes ?? []) await context.route(decl.url, await routeHandler(decl));
  if (opts.sessionFile) {
    const saved = sessionStoragePath(opts.sessionFile);
    if (fs.existsSync(saved)) {
      await context.addInitScript({ content: restoreScript(readSaved(saved)) });
    }
  }
  for (const item of initScripts(app))
    await context.addInitScript(isScriptFile(item) ? { path: item } : { content: item });
}

/** The files the steps' uploads choose (absolute after loadScene). */
export function stepFiles(steps: Step[] | undefined): string[] {
  return (steps ?? []).flatMap((s) => (s.file === undefined ? [] : Array.isArray(s.file) ? s.file : [s.file]));
}

/**
 * The existing files a recording of this app depends on: init script files, route modules, the session and its
 * sessionStorage, the login hook, and the files login uploads choose.
 */
export function appFiles(app: AppConn): string[] {
  const files = [
    ...initScripts(app).filter(isScriptFile),
    ...(app.routes ?? []).flatMap((r) => (r.module ? [path.resolve(r.module)] : [])),
    ...(app.storageState ? [app.storageState, sessionStoragePath(app.storageState)] : []),
    ...(app.loginHook ? [app.loginHook] : []),
    ...stepFiles(app.login),
  ];
  return [...new Set(files)].filter((f) => fs.existsSync(f));
}
