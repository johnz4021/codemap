// Screens on boxes: the checker shows a screenshot, an image or a sketch only when it can tie it to the repo.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { check } from '../src/check';
import { parseMap, type CodeMap } from '../src/format';
import { capturePaths, type Capture } from '../src/screens';

const APP = fileURLToPath(new URL('./fixtures/care-app', import.meta.url));
const MAP_JSON = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/care-app.map.json', import.meta.url)), 'utf8'));
const tmp: string[] = [];
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const copyApp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'illuminate-screens-'));
  tmp.push(dir);
  cpSync(APP, dir, { recursive: true });
  return dir;
};
/** The fixture map with `screen` on its first box (the Convert button, cited in src/ui/PatientHeader.tsx). */
const withScreen = (screen: unknown): CodeMap => {
  const m = structuredClone(MAP_JSON);
  m.nodes[0].screen = screen;
  const parsed = parseMap(m);
  if (!parsed.ok) throw new Error(parsed.problems.join('\n'));
  return parsed.map;
};
const BOX = MAP_JSON.nodes[0].id as string;
const PNG = Buffer.from('not really a png, but the checker only hashes it');
const saveCapture = (root: string, over: Partial<Capture> = {}) => {
  const record: Capture = {
    id: 'scr-test1', source: { kind: 'page', url: 'http://localhost:3000/patients' }, title: 'Patients', width: 1000, height: 500,
    sha256: createHash('sha256').update(PNG).digest('hex'), takenAt: '2026-11-12T00:00:00.000Z',
    elements: [{ tag: 'a', text: 'Care journeys', x: 0, y: 0, w: 200, h: 40 }, { tag: 'button', text: 'Mark as converted', x: 500, y: 100, w: 100, h: 50 }],
    ...over,
  };
  const p = capturePaths(root, record.id);
  mkdirSync(dirname(p.image), { recursive: true });
  writeFileSync(p.image, PNG);
  writeFileSync(p.record, JSON.stringify(record));
};

describe('the format', () => {
  it('reads maps with and without screens, and says what a screen is missing', () => {
    expect(parseMap(MAP_JSON).ok).toBe(true);
    const bad = structuredClone(MAP_JSON);
    bad.nodes[0].screen = { kind: 'capture' };
    bad.nodes[1].screen = { kind: 'sketch', file: '../outside.tsx' };
    const parsed = parseMap(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join('\n')).toMatch(/needs the `capture` id[\s\S]*needs `file`, a path inside the repo/);
  });
});

describe('a screenshot', () => {
  it('is shown, with the highlighted label marked, when the label is on the screen and in the cited code', () => {
    const root = copyApp();
    saveCapture(root);
    const report = check(withScreen({ kind: 'capture', capture: 'scr-test1', highlight: 'Mark as converted' }), root);
    expect(report.screens[BOX]).toMatchObject({
      status: 'confirmed',
      show: { kind: 'capture', capture: 'scr-test1', from: 'http://localhost:3000/patients', box: { x: 0.5, y: 0.2, w: 0.1, h: 0.1 } },
    });
    // Screens aren't claims: the count is the map's own.
    expect(report.summary).toEqual({ claims: 15, confirmed: 15, unconfirmed: 0 });
  });

  it('is left out when illuminate took no such capture, or its image was swapped', () => {
    const root = copyApp();
    expect(check(withScreen({ kind: 'capture', capture: 'scr-none' }), root).screens[BOX]).toMatchObject({ status: 'unconfirmed', show: null });
    saveCapture(root);
    writeFileSync(capturePaths(root, 'scr-test1').image, 'a picture Claude drew');
    const swapped = check(withScreen({ kind: 'capture', capture: 'scr-test1' }), root).screens[BOX]!;
    expect(swapped.status).toBe('unconfirmed');
    expect(swapped.reasons[0]).toContain("isn't the one illuminate took");
  });

  it('is left out when the highlight is not on the screen, or not in the code the box cites', () => {
    const root = copyApp();
    saveCapture(root);
    expect(check(withScreen({ kind: 'capture', capture: 'scr-test1', highlight: 'Delete patient' }), root).screens[BOX]!.reasons[0]).toContain("isn't on the captured screen");
    // "Care journeys" is on the screen, but the box's code (the header component) never says it.
    expect(check(withScreen({ kind: 'capture', capture: 'scr-test1', highlight: 'Care journeys' }), root).screens[BOX]!.reasons[0]).toContain("isn't in the code this box cites");
  });
});

describe('a sketch', () => {
  it('is shown when every element is in the markup file, and left out when one is invented', () => {
    const file = 'src/ui/PatientHeader.tsx';
    const ok = check(withScreen({ kind: 'sketch', file, elements: [{ kind: 'button', text: 'Mark as converted' }], highlight: 'Mark as converted' }), APP);
    expect(ok.screens[BOX]).toMatchObject({ status: 'confirmed', show: { kind: 'sketch', file, highlight: 'Mark as converted' } });
    const invented = check(withScreen({ kind: 'sketch', file, elements: [{ kind: 'button', text: 'Mark as converted' }, { kind: 'button', text: 'Archive' }] }), APP);
    expect(invented.screens[BOX]).toMatchObject({ status: 'unconfirmed', reasons: [`"Archive" isn't in ${file}`] });
  });
});

describe('an image file', () => {
  it('is shown when the cited code names it, and never when it is outside the repo, a secret or not an image', () => {
    const root = copyApp();
    writeFileSync(join(root, 'src/ui/convert.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(check(withScreen({ kind: 'image', file: 'src/ui/convert.svg' }), root).screens[BOX]!.reasons[0]).toContain("doesn't mention convert.svg");
    const header = join(root, 'src/ui/PatientHeader.tsx');
    writeFileSync(header, `${readFileSync(header, 'utf8')}\nexport const icon = './convert.svg';\n`);
    expect(check(withScreen({ kind: 'image', file: 'src/ui/convert.svg' }), root).screens[BOX]).toMatchObject({ status: 'confirmed', show: { kind: 'image', file: 'src/ui/convert.svg' } });
    expect(check(withScreen({ kind: 'image', file: '.env' }), root).screens[BOX]!.status).toBe('unconfirmed');
    expect(check(withScreen({ kind: 'image', file: 'src/ui/PatientHeader.tsx' }), root).screens[BOX]!.reasons[0]).toContain('not an image file');
  });
});
