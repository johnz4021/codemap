// Screens: what the person sees at a box. A screen is shown only if the checker can tie it to the repo:
// - a capture must be one illuminate saved under `.illuminate/screens/` (its record and image still matching), and a
//   highlighted label must be both on the captured screen and in the code the box cites;
// - an image must be a file in the repo that the cited code names;
// - a sketch's elements must each appear in the markup file it was drawn from.
// No model calls, and nothing is written here: captures are taken and saved by the server (`screens.ts` there).
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { isSafeRelativePath, type MapNode, type Screen } from './format';
import { isSecretPath, type RepoReader } from './repo';

export const SCREENS_DIR = '.illuminate/screens';
export const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
};
export const MAX_IMAGE_BYTES = 5_000_000;
const CAPTURE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Something visible on a captured screen: its text and where it is, in CSS pixels of the capture. */
export const CapturedElement = z.object({ tag: z.string(), text: z.string(), x: z.number(), y: z.number(), w: z.number(), h: z.number() });
/** The record saved beside a capture's image. `sha256` is of the image file. */
export const Capture = z.object({
  id: z.string().regex(CAPTURE_ID),
  /** A page on this machine, or an HTML file in the repo. */
  source: z.union([z.object({ kind: z.literal('page'), url: z.string() }), z.object({ kind: z.literal('file'), file: z.string() })]),
  title: z.string(),
  width: z.number().positive(),
  height: z.number().positive(),
  sha256: z.string(),
  takenAt: z.string(),
  elements: z.array(CapturedElement),
});
export type Capture = z.output<typeof Capture>;
export type CapturedElement = z.output<typeof CapturedElement>;

/** A box on the capture, as fractions of its width and height. */
export type ScreenBox = { x: number; y: number; w: number; h: number };
export type ScreenShow =
  | { kind: 'capture'; capture: string; title: string; width: number; height: number; from: string; box: ScreenBox | null }
  | { kind: 'image'; file: string }
  | { kind: 'sketch'; file: string; elements: NonNullable<Screen['elements']>; highlight: string | null };
export type ScreenCheck = { status: 'confirmed' | 'unconfirmed'; reasons: string[]; show: ScreenShow | null };

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

export const capturePaths = (root: string, id: string) => ({
  record: path.join(root, SCREENS_DIR, `${id}.json`),
  image: path.join(root, SCREENS_DIR, `${id}.png`),
});

/** A saved capture whose image is still the one that was taken, or why it can't be used. */
export function readCapture(root: string, id: string): { ok: true; capture: Capture } | { ok: false; reason: string } {
  if (!CAPTURE_ID.test(id)) return { ok: false, reason: `"${id}" is not a capture id` };
  const p = capturePaths(root, id);
  let capture: Capture;
  try {
    const parsed = Capture.safeParse(JSON.parse(fs.readFileSync(p.record, 'utf8')));
    if (!parsed.success || parsed.data.id !== id) return { ok: false, reason: `the record of capture ${id} can't be read` };
    capture = parsed.data;
  } catch {
    return { ok: false, reason: `there is no capture ${id}; take one with illuminate_capture` };
  }
  let image: Buffer;
  try {
    image = fs.readFileSync(p.image);
  } catch {
    return { ok: false, reason: `the image of capture ${id} is missing` };
  }
  if (crypto.createHash('sha256').update(image).digest('hex') !== capture.sha256) return { ok: false, reason: `the image of capture ${id} isn't the one illuminate took` };
  return { ok: true, capture };
}

/** An image file inside the repo that may be shown, as its real path, or why not. */
export function repoImage(root: string, rel: string): { ok: true; path: string; type: string } | { ok: false; reason: string } {
  if (!isSafeRelativePath(rel)) return { ok: false, reason: `${rel} is outside the repo` };
  if (isSecretPath(rel)) return { ok: false, reason: 'secret files are never shown' };
  const type = IMAGE_TYPES[path.extname(rel).toLowerCase()];
  if (!type) return { ok: false, reason: `${rel} is not an image file` };
  const realRoot = fs.realpathSync(root);
  let real: string;
  try {
    real = fs.realpathSync(path.join(realRoot, rel));
  } catch {
    return { ok: false, reason: `${rel} doesn't exist` };
  }
  if (!real.startsWith(realRoot + path.sep)) return { ok: false, reason: `${rel} is outside the repo` };
  const stat = fs.statSync(real);
  if (!stat.isFile()) return { ok: false, reason: `${rel} is not a file` };
  if (stat.size > MAX_IMAGE_BYTES) return { ok: false, reason: `${rel} is too large to show` };
  return { ok: true, path: real, type };
}

/** The element on a capture that a label points at: the one whose text is the label, else the smallest that contains it. */
export function findOnCapture(capture: Capture, label: string): CapturedElement | null {
  const want = norm(label);
  const exact = capture.elements.find((e) => norm(e.text) === want);
  if (exact) return exact;
  const holding = capture.elements.filter((e) => norm(e.text).includes(want)).sort((a, b) => a.w * a.h - b.w * b.h);
  return holding[0] ?? null;
}

export function checkScreen(n: MapNode, repo: RepoReader): ScreenCheck | null {
  const sc = n.screen;
  if (!sc) return null;
  const fail = (...reasons: string[]): ScreenCheck => ({ status: 'unconfirmed', reasons, show: null });
  const cited = [...new Set(n.evidence.map((e) => e.file))];
  const inCitedCode = (text: string) => cited.some((f) => norm(repo.text(f) ?? '').includes(norm(text)));

  if (sc.kind === 'capture') {
    const got = readCapture(repo.root, sc.capture ?? '');
    if (!got.ok) return fail(got.reason);
    const c = got.capture;
    let box: ScreenBox | null = null;
    if (sc.highlight) {
      const el = findOnCapture(c, sc.highlight);
      if (!el) return fail(`"${sc.highlight}" isn't on the captured screen`);
      if (!inCitedCode(sc.highlight)) return fail(`"${sc.highlight}" isn't in the code this box cites (${cited.join(', ')})`);
      box = { x: el.x / c.width, y: el.y / c.height, w: el.w / c.width, h: el.h / c.height };
    }
    const from = c.source.kind === 'page' ? c.source.url : c.source.file;
    return { status: 'confirmed', reasons: [], show: { kind: 'capture', capture: c.id, title: c.title, width: c.width, height: c.height, from, box } };
  }

  const file = sc.file ?? '';
  if (sc.kind === 'image') {
    const img = repoImage(repo.root, file);
    if (!img.ok) return fail(img.reason);
    if (!inCitedCode(path.basename(file))) return fail(`the code this box cites (${cited.join(', ')}) doesn't mention ${path.basename(file)}`);
    return { status: 'confirmed', reasons: [], show: { kind: 'image', file } };
  }

  const read = repo.read(file);
  if (!read.ok) return fail(`${file}: ${read.reason}`);
  const text = norm(read.text);
  const elements = sc.elements ?? [];
  const missing = elements.filter((e) => !text.includes(norm(e.text)));
  if (missing.length) return fail(...missing.map((e) => `"${e.text}" isn't in ${file}`));
  if (sc.highlight && !elements.some((e) => norm(e.text) === norm(sc.highlight!))) return fail(`the highlight "${sc.highlight}" isn't one of the sketch's elements`);
  return { status: 'confirmed', reasons: [], show: { kind: 'sketch', file, elements, highlight: sc.highlight ?? null } };
}
