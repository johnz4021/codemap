// Taking screens for a map: what this repo can show (`listScreens`) and a screenshot of one page (`capture`).
// Captures come from the person's installed Chrome, headless, in a throwaway profile (so no logins), and only from
// this machine: a page already served on localhost, or an HTML file in the repo. illuminate never starts the app.
// Each capture is saved under `.illuminate/screens/` with a record of what was visible, which the checker reads.
import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { IMAGE_TYPES, SCREENS_DIR, capturePaths, isSafeRelativePath, isSecretPath, type Capture, type CapturedElement } from '@illuminate/core';
import { DEFAULT_IGNORE, listRepoFiles } from '@illuminate/facts';

export const CAPTURE_WIDTH = 1280;
export const CAPTURE_HEIGHT = 800;
const COMMON_PORTS = [3000, 3001, 4200, 4321, 5000, 5173, 5174, 8000, 8080, 8888];

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

/** The Chrome (or Chromium, Edge, Brave) already on this machine; `ILLUMINATE_CHROME` overrides. */
export function findChrome(): string | null {
  const given = process.env.ILLUMINATE_CHROME;
  if (given) return fs.existsSync(given) ? given : null;
  return CHROME_PATHS.find((p) => fs.existsSync(p)) ?? null;
}

export type CaptureTarget = { url: string } | { file: string };
export type CaptureResult = { capture: Capture; png: Buffer; text: string };
/** Opens a page and reports what's on it. Swapped out in tests, which have no browser. */
export type Shooter = (url: string) => Promise<{ png: Buffer; title: string; text: string; elements: CapturedElement[] }>;

/** The URL a target stands for, or why it can't be captured. */
export function resolveTarget(root: string, target: CaptureTarget): { ok: true; url: string; source: Capture['source'] } | { ok: false; reason: string } {
  if ('url' in target) {
    let u: URL;
    try {
      u = new URL(target.url);
    } catch {
      return { ok: false, reason: `"${target.url}" is not a URL.` };
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (!local || !/^https?:$/.test(u.protocol)) return { ok: false, reason: 'Only pages served on this machine (http://localhost:…) can be captured.' };
    return { ok: true, url: u.href, source: { kind: 'page', url: u.href } };
  }
  const rel = target.file;
  if (!isSafeRelativePath(rel) || isSecretPath(rel) || !/\.html?$/i.test(rel)) return { ok: false, reason: '`file` must be an .html file inside the repo.' };
  const realRoot = fs.realpathSync(root);
  let real: string;
  try {
    real = fs.realpathSync(path.join(realRoot, rel));
  } catch {
    return { ok: false, reason: `${rel} doesn't exist.` };
  }
  if (!real.startsWith(realRoot + path.sep)) return { ok: false, reason: '`file` must be inside the repo.' };
  return { ok: true, url: pathToFileURL(real).href, source: { kind: 'file', file: rel } };
}

/** Screenshot a target and save it with its record. The text is what a reader of the page would see, for judging it. */
export async function capture(root: string, target: CaptureTarget, shoot: Shooter = shootWithChrome): Promise<{ ok: true; result: CaptureResult } | { ok: false; reason: string }> {
  const resolved = resolveTarget(root, target);
  if (!resolved.ok) return resolved;
  let shot: Awaited<ReturnType<Shooter>>;
  try {
    shot = await shoot(resolved.url);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const id = `scr-${crypto.randomBytes(4).toString('hex')}`;
  const record: Capture = {
    id,
    source: resolved.source,
    title: shot.title.slice(0, 200),
    width: CAPTURE_WIDTH,
    height: CAPTURE_HEIGHT,
    sha256: crypto.createHash('sha256').update(shot.png).digest('hex'),
    takenAt: new Date().toISOString(),
    elements: shot.elements,
  };
  const p = capturePaths(fs.realpathSync(root), id);
  fs.mkdirSync(path.dirname(p.image), { recursive: true });
  fs.writeFileSync(p.image, shot.png);
  fs.writeFileSync(p.record, `${JSON.stringify(record, null, 2)}\n`);
  return { ok: true, result: { capture: record, png: shot.png, text: shot.text } };
}

/** Runs in the page: the visible, labelled things in the viewport, and the page's text. */
const READ_PAGE = `(() => {
  const squash = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('button, a, input, select, textarea, h1, h2, h3, h4, label, summary, [role=button], [role=tab], [role=link], img[alt]')) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    const text = squash(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('alt')).slice(0, 80);
    if (!text) continue;
    const key = el.tagName + '|' + text + '|' + Math.round(r.x) + '|' + Math.round(r.y);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tag: el.tagName.toLowerCase(), text, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
    if (out.length >= 150) break;
  }
  return JSON.stringify({ title: document.title, text: squash(document.body ? document.body.innerText : '').slice(0, 1500), elements: out });
})()`;

/** One page in headless Chrome over the DevTools protocol: open, wait for load, read, screenshot, close. */
export const shootWithChrome: Shooter = async (url) => {
  const chrome = findChrome();
  if (!chrome) throw new Error('No Chrome, Chromium, Edge or Brave was found on this machine, so no screen can be captured. Use an image file or a sketch instead.');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'illuminate-chrome-'));
  let child: ChildProcess | null = null;
  let ws: WebSocket | null = null;
  try {
    child = spawn(chrome, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--hide-scrollbars', '--mute-audio', `--window-size=${CAPTURE_WIDTH},${CAPTURE_HEIGHT}`, 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const endpoint = await new Promise<string>((resolve, reject) => {
      let err = '';
      const timer = setTimeout(() => reject(new Error('The browser took too long to start.')), 15_000);
      child!.stderr!.on('data', (d: Buffer) => {
        err += d.toString();
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]!);
        }
      });
      child!.on('exit', () => {
        clearTimeout(timer);
        reject(new Error('The browser closed before it could open the page.'));
      });
      child!.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    const socket = new WebSocket(endpoint);
    ws = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    let n = 0;
    const waiting = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
    const events = new Map<string, () => void>();
    socket.on('message', (data) => {
      const m = JSON.parse(String(data)) as { id?: number; method?: string; result?: Record<string, unknown>; error?: { message: string } };
      if (m.id !== undefined) {
        const w = waiting.get(m.id);
        waiting.delete(m.id);
        if (m.error) w?.reject(new Error(m.error.message));
        else w?.resolve(m.result ?? {});
      } else if (m.method) events.get(m.method)?.();
    });
    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = ++n;
        waiting.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = (await send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
    await send('Page.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT, deviceScaleFactor: 1, mobile: false }, sessionId);
    const loaded = new Promise<void>((resolve) => {
      events.set('Page.loadEventFired', resolve);
      setTimeout(resolve, 15_000);
    });
    const nav = await send('Page.navigate', { url }, sessionId);
    if (typeof nav.errorText === 'string' && nav.errorText) throw new Error(`The page couldn't be opened (${nav.errorText}). Is it running?`);
    await loaded;
    // Client-rendered apps draw after load.
    await new Promise((r) => setTimeout(r, 700));
    const read = (await send('Runtime.evaluate', { expression: READ_PAGE, returnByValue: true }, sessionId)) as { result?: { value?: string } };
    const page = JSON.parse(read.result?.value ?? '{}') as { title?: string; text?: string; elements?: CapturedElement[] };
    const shot = (await send('Page.captureScreenshot', { format: 'png' }, sessionId)) as { data: string };
    return { png: Buffer.from(shot.data, 'base64'), title: page.title ?? '', text: page.text ?? '', elements: page.elements ?? [] };
  } finally {
    ws?.close();
    child?.kill('SIGKILL');
    // Chrome may still be letting go of the profile; a leftover temp folder is harmless.
    setTimeout(() => fs.rm(profile, { recursive: true, force: true }, () => {}), 500).unref?.();
  }
};

/** A local port that answers with a web page, and its title. */
async function probe(port: number): Promise<{ url: string; title: string } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500), redirect: 'manual' });
    if (!(res.headers.get('content-type') ?? '').includes('text/html')) return null;
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec((await res.text()).slice(0, 20_000))?.[1]?.trim() ?? '';
    return { url: `http://localhost:${port}/`, title };
  } catch {
    return null;
  }
}

/** What this repo can show, in words for Claude: running local pages, HTML files, preview setups, image files. */
export async function listScreens(root: string, o: { skipPorts?: readonly number[]; ports?: readonly number[] } = {}): Promise<string> {
  const files = listRepoFiles(root, [...DEFAULT_IGNORE]).filter((f) => !isSecretPath(f));
  const html = files.filter((f) => /\.html?$/i.test(f));
  const images = files.filter((f) => IMAGE_TYPES[path.extname(f).toLowerCase()]);
  const stories = files.filter((f) => /\.stories\.[jt]sx?$|\.stories\.mdx$/.test(f));
  const scenes = files.filter((f) => /\.(tscn|unity|prefab)$/.test(f));
  const ports = (o.ports ?? COMMON_PORTS).filter((p) => !(o.skipPorts ?? []).includes(p));
  const pages = (await Promise.all(ports.map(probe))).filter((p): p is { url: string; title: string } => !!p);
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    // No package.json, or not readable: nothing to say about scripts.
  }
  const few = (list: string[], max: number) => [...list.slice(0, max).map((f) => `  - ${f}`), ...(list.length > max ? [`  - …and ${list.length - max} more`] : [])];
  const chrome = findChrome();
  return [
    chrome ? 'A browser is available, so illuminate_capture can take screenshots.' : 'No Chrome-like browser was found, so illuminate_capture can\'t take screenshots here. Image files and sketches still work.',
    '',
    pages.length ? 'Pages being served on this machine right now (check the title is this app before using one):' : 'No local web page is being served on the usual ports. illuminate never starts the app itself.',
    ...pages.map((p) => `  - ${p.url}${p.title ? `  "${p.title}"` : ''}`),
    ...(!pages.length && (scripts.dev || scripts.start) ? [`  (The person could start it with \`npm run ${scripts.dev ? 'dev' : 'start'}\`; mention that only if a real screen would clearly help.)`] : []),
    '',
    html.length ? 'HTML files in the repo (capture with `file`):' : 'No HTML files in the repo.',
    ...few(html, 15),
    '',
    stories.length ? `Storybook stories: ${stories.length} (not rendered by illuminate yet; if Storybook is running it shows up as a page above).` : '',
    scenes.length ? `Game scene files: ${scenes.length} (not rendered by illuminate; their sprites can be shown as image files).` : '',
    images.length ? `Image files in the repo (${images.length}); one can be a box's screen when its cited code names it:` : 'No image files in the repo.',
    ...few(images, 15),
    '',
    `Captures are saved under ${SCREENS_DIR}/.`,
  ].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n');
}
