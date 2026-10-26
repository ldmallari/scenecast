import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  PANEL_SELECTOR,
  appFiles,
  applyAppContext,
  captureSessionStorage,
  panelSelector,
  restoreScript,
  sessionStoragePath,
} from '../src/record/context.js';
import type { AppConn } from '../src/scene/schema.js';

const fx = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

declare global {
  interface Window {
    __scInit?: number;
    __fromFile?: number;
  }
}

/** Every path is the same small page, so navigations stay on one origin. */
function servePages(): Promise<http.Server> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>page</title><p>page</p>');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let server: http.Server;
let origin: string;
let browser: Browser;
let ctx: BrowserContext;
let page: Page;
let work: string;

beforeAll(async () => {
  server = await servePages();
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'scenecast-ctx-'));
});
afterAll(async () => {
  await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(work, { recursive: true, force: true });
});
beforeEach(async () => {
  ctx = await browser.newContext();
});
afterEach(async () => {
  await ctx.close();
});

describe('applyAppContext', () => {
  it('routes match an API on another origin', async () => {
    await applyAppContext(ctx, { baseUrl: origin, routes: [{ url: '**/v1/me', json: { name: 'Sam' } }] });
    page = await ctx.newPage();
    await page.goto(`${origin}/`);
    expect(await page.evaluate(() => fetch('http://api.example.invalid/v1/me').then((r) => r.json()))).toEqual({ name: 'Sam' });
    // A request that needs a CORS preflight is answered too.
    const put = await page.evaluate(() =>
      fetch('http://api.example.invalid/v1/me', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-app': '1' }, body: '{}' }).then((r) =>
        r.json(),
      ),
    );
    expect(put).toEqual({ name: 'Sam' });
  });

  it('routes answer with status, body and headers, or a module', async () => {
    await applyAppContext(ctx, {
      baseUrl: origin,
      routes: [
        { url: '**/a', status: 418, body: 'tea', headers: { 'x-k': 'v' } },
        { url: '**/b', module: fx('route.mjs') },
      ],
    });
    page = await ctx.newPage();
    await page.goto(`${origin}/`);
    const a = await page.evaluate(() => fetch('/a').then(async (r) => ({ status: r.status, text: await r.text(), k: r.headers.get('x-k') })));
    expect(a).toEqual({ status: 418, text: 'tea', k: 'v' });
    expect(await page.evaluate(() => fetch('/b').then((r) => r.json()))).toEqual({ via: 'module' });
  });

  it('init scripts run in every page before the app', async () => {
    await applyAppContext(ctx, { baseUrl: origin, initScript: ['window.__scInit = (window.__scInit ?? 0) + 1;', fx('init.js')] });
    page = await ctx.newPage();
    await page.goto(`${origin}/login`);
    expect(await page.evaluate(() => window.__scInit)).toBe(1);
    await page.goto(`${origin}/dashboard`);
    expect(await page.evaluate(() => window.__scInit)).toBe(1);
    expect(await page.evaluate(() => window.__fromFile)).toBe(1);
  });

  it('accepts a single init script string, as parseScene leaves it', async () => {
    await applyAppContext(ctx, { baseUrl: origin, initScript: 'window.__scInit = 7;' });
    page = await ctx.newPage();
    await page.goto(`${origin}/`);
    expect(await page.evaluate(() => window.__scInit)).toBe(7);
  });

  it('restored sessionStorage is not re-applied after the app clears it', async () => {
    const session = path.join(work, 'restore.json');
    fs.writeFileSync(session, '{"cookies":[],"origins":[]}');
    fs.writeFileSync(sessionStoragePath(session), JSON.stringify({ [origin]: { token: 't1' } }));
    await applyAppContext(ctx, { baseUrl: origin }, { sessionFile: session });
    page = await ctx.newPage();
    await page.goto(`${origin}/`);
    expect(await page.evaluate(() => sessionStorage.getItem('token'))).toBe('t1');
    // The app changes it: a reload keeps the app's value.
    await page.evaluate(() => sessionStorage.setItem('token', 't2'));
    await page.reload();
    expect(await page.evaluate(() => sessionStorage.getItem('token'))).toBe('t2');
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(`${origin}/dashboard`);
    expect(await page.evaluate(() => sessionStorage.getItem('token'))).toBeNull();
  });

  it('a session with no sibling file restores nothing', async () => {
    const session = path.join(work, 'plain.json');
    fs.writeFileSync(session, '{"cookies":[],"origins":[]}');
    await applyAppContext(ctx, { baseUrl: origin }, { sessionFile: session });
    page = await ctx.newPage();
    await page.goto(`${origin}/`);
    expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
  });
});

describe('captureSessionStorage', () => {
  it("saves the baseUrl origin's sessionStorage next to the session file", async () => {
    page = await ctx.newPage();
    await page.goto(`${origin}/`);
    await page.evaluate(() => sessionStorage.setItem('token', 'abc'));
    const session = path.join(work, 'cap.json');
    await captureSessionStorage(page, session, origin);
    expect(JSON.parse(fs.readFileSync(sessionStoragePath(session), 'utf8'))).toEqual({ [origin]: { token: 'abc' } });
  });

  it('writes no file, and removes a stale one, when there is nothing to save', async () => {
    page = await ctx.newPage();
    await page.goto(`${origin}/`);
    const session = path.join(work, 'empty.json');
    fs.writeFileSync(sessionStoragePath(session), '{"x":{"old":"1"}}');
    await captureSessionStorage(page, session, origin);
    expect(fs.existsSync(sessionStoragePath(session))).toBe(false);
    await page.evaluate(() => sessionStorage.setItem('k', 'v'));
    await captureSessionStorage(page, session, 'http://other.example.invalid');
    expect(fs.existsSync(sessionStoragePath(session))).toBe(false);
  });
});

describe('helpers', () => {
  it('sessionStoragePath strips .json and appends .session-storage.json', () => {
    expect(sessionStoragePath('/w/.session.json')).toBe('/w/.session.session-storage.json');
    expect(sessionStoragePath('/w/state')).toBe('/w/state.session-storage.json');
  });

  it('panelSelector adds app.panels to the built-in list', () => {
    expect(panelSelector({ baseUrl: 'x' })).toBe(PANEL_SELECTOR);
    expect(panelSelector({ baseUrl: 'x', panels: ['.filters-pop', '.drawer'] })).toBe(`${PANEL_SELECTOR},.filters-pop,.drawer`);
  });

  it('restoreScript embeds the entries as data', () => {
    const js = restoreScript({ 'http://a': { k: '</script>"' } });
    expect(js).toContain(JSON.stringify({ 'http://a': { k: '</script>"' } }));
    expect(js).toContain('window.name');
  });

  it('appFiles lists the existing files the recording depends on', () => {
    const state = path.join(work, 'files-state.json');
    fs.writeFileSync(state, '{}');
    fs.writeFileSync(sessionStoragePath(state), '{}');
    const app: AppConn = {
      baseUrl: 'x',
      storageState: state,
      loginHook: fx('route.mjs'),
      initScript: [fx('init.js'), 'window.x = 1;', path.join(work, 'missing.js')],
      routes: [{ url: '**/b', module: fx('route.mjs') }, { url: '**/c', json: {} }],
    };
    expect(appFiles(app).sort()).toEqual([fx('init.js'), fx('route.mjs'), state, sessionStoragePath(state)].sort());
    expect(appFiles({ baseUrl: 'x', initScript: fx('init.js') })).toEqual([fx('init.js')]);
  });
});
