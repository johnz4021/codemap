// The checker against the care-app fixture: a patient converts, the app announces it, and nothing listens, so the
// automation rules (and the welcome email) only run from a nightly job. The hand-written map in fixtures/ is the
// same map the design walks through.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { check } from '../src/check';
import { parseMap, type CodeMap } from '../src/format';

const APP = fileURLToPath(new URL('./fixtures/care-app', import.meta.url));
const MAP_JSON = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/care-app.map.json', import.meta.url)), 'utf8'));

const load = (json: unknown = MAP_JSON): CodeMap => {
  const parsed = parseMap(json);
  if (!parsed.ok) throw new Error(parsed.problems.join('\n'));
  return parsed.map;
};
/** A deep copy of the fixture map, changed by `edit`. */
const variant = (edit: (m: any) => void): CodeMap => {
  const m = structuredClone(MAP_JSON);
  edit(m);
  return load(m);
};

const tmp: string[] = [];
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const copyApp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'codemap-care-'));
  tmp.push(dir);
  cpSync(APP, dir, { recursive: true });
  return dir;
};

describe('the hand-written care-app map', () => {
  const report = check(load(), APP);

  it('is confirmed claim by claim: 8 boxes, 6 arrows, 1 missing connection', () => {
    expect(report.summary).toEqual({ claims: 15, confirmed: 15, unconfirmed: 0 });
  });

  it('proves boxes with symbols, and arrows with call and request facts, not just line text', () => {
    expect(Object.values(report.nodes).map((c) => c.proof)).toEqual(Array(8).fill('fact'));
    expect(report.edges.e12!.proof).toBe('fact'); // the button's fetch matches the route handled by convertPatient
    expect(report.edges.e23!.proof).toBe('fact');
    expect(report.edges.ej!.proof).toBe('fact');
    expect(report.edges.e34!.proof).toBe('text'); // "announces": events aren't facts yet, so the cited line is the proof
  });

  it('proves the missing listener by re-running its search: zero subscribers to patient.converted', () => {
    expect(report.absences.miss).toEqual({ status: 'confirmed', found: 0, locations: [], reasons: [] });
  });

  it('marks every tour stop as backed by confirmed claims', () => {
    expect(report.tour).toEqual({ t1: { status: 'ok', unconfirmed: [] }, t5: { status: 'ok', unconfirmed: [] } });
  });
});

describe('claims the code does not back', () => {
  it('a call that does not exist fails on the facts even when the cited line is real', () => {
    // evaluateRules calls queueEmail, not sendEmail; the cited line exists, the claimed call doesn't.
    const map = variant((m) => { m.edges.find((e: any) => e.id === 'eu12').to = 'u3'; });
    const r = check(map, APP).edges.eu12!;
    expect(r.status).toBe('unconfirmed');
    expect(r.evidence[0]!.ok).toBe(true);
    expect(r.reasons).toEqual(['the code has no call from src/automations/evaluate.ts#evaluateRules to src/email/send.ts#sendEmail']);
  });

  it('a request that matches no route fails', () => {
    const map = variant((m) => { m.edges.find((e: any) => e.id === 'e12').to = 's3'; });
    expect(check(map, APP).edges.e12!.reasons).toEqual(['no request from src/ui/PatientHeader.tsx#PatientHeader matches a route handled by src/patients/service.ts#markConverted']);
  });

  it('cited text that is not in the file fails; text a few lines away still counts and reports where it is', () => {
    const missing = variant((m) => { m.nodes.find((n: any) => n.id === 'u3').evidence[0].text = 'sendSms('; });
    expect(check(missing, APP).nodes.u3!.reasons).toEqual(['src/email/send.ts:1: "sendSms(" isn\'t on line 1 or near it']);
    const moved = variant((m) => { m.edges.find((e: any) => e.id === 'ej').evidence[0].line = 8; });
    expect(check(moved, APP).edges.ej!.evidence[0]).toMatchObject({ ok: true, foundAt: 10 });
  });

  it('follows code that moved far, as long as the cited text is on exactly one line of the file', () => {
    const repo = copyApp();
    const file = join(repo, 'src/patients/service.ts');
    writeFileSync(file, `${'// padding\n'.repeat(20)}${readFileSync(file, 'utf8')}`);
    expect(check(load(), repo).nodes.s4!.evidence[0]).toMatchObject({ ok: true, foundAt: 26 });
    const ambiguous = variant((m) => { m.edges.find((e: any) => e.id === 'e23').evidence[0] = { file: 'src/server/routes.ts', line: 1, text: 'convertPatient' }; });
    expect(check(ambiguous, APP).edges.e23!.reasons).toEqual(['src/server/routes.ts:1: "convertPatient" isn\'t on line 1 or near it, and appears 2 times elsewhere in the file']);
  });

  it('a symbol that does not exist fails', () => {
    const map = variant((m) => { m.nodes.find((n: any) => n.id === 'u2').symbol = 'src/jobs/queue.ts#enqueue'; });
    expect(check(map, APP).nodes.u2!.reasons).toEqual(['the code has no symbol src/jobs/queue.ts#enqueue']);
  });

  it('a wrong "nothing does X" claim fails and says where the matches are', () => {
    const map = variant((m) => { m.absences.push({ id: 'none', claim: 'Nothing calls sendEmail', search: { pattern: 'sendEmail(' }, matches: 0 }); });
    const r = check(map, APP).absences.none!;
    expect(r).toMatchObject({ status: 'unconfirmed', found: 2, reasons: ['the search finds 2 matches; the map says 0'] });
    expect(r.locations).toEqual([{ file: 'src/email/send.ts', line: 1 }, { file: 'src/jobs/queue.ts', line: 4 }]);
  });

  it('flags tour stops that point at unconfirmed claims', () => {
    const map = variant((m) => { m.nodes.find((n: any) => n.id === 'u1').evidence[0].text = 'export function evaluate('; });
    expect(check(map, APP).tour.t5).toEqual({ status: 'mentions-unconfirmed', unconfirmed: ['u1'] });
  });
});

describe('after a fix lands', () => {
  it('re-checking catches what changed: the listener now exists, so the "nothing listens" claim no longer holds', () => {
    const repo = copyApp();
    writeFileSync(join(repo, 'src/automations/listeners.ts'), [
      "import { bus } from '../events/bus';",
      "import { evaluateRules } from './evaluate';",
      '',
      "bus.on('patient.converted', ({ patientId }) => evaluateRules({ patientId }));",
      '',
    ].join('\n'));
    const r = check(load(), repo);
    expect(r.absences.miss).toMatchObject({ status: 'unconfirmed', found: 1, locations: [{ file: 'src/automations/listeners.ts', line: 4 }] });
    expect(r.tour.t5).toEqual({ status: 'mentions-unconfirmed', unconfirmed: ['miss'] });
    expect(r.summary.confirmed).toBe(14); // everything else still holds
  });

  it('a renamed function breaks the boxes and arrows that named it, and nothing else', () => {
    const repo = copyApp();
    const file = join(repo, 'src/jobs/queue.ts');
    writeFileSync(file, readFileSync(file, 'utf8').replace('queueEmail', 'enqueueEmail'));
    const r = check(load(), repo);
    const broken = [...Object.entries(r.nodes), ...Object.entries(r.edges)].filter(([, c]) => c.status === 'unconfirmed').map(([id]) => id);
    expect(broken.sort()).toEqual(['eu12', 'eu23', 'u2']); // the box, and the arrows into and out of it
  });
});

describe('safety', () => {
  it('never reads secrets or files outside the repo, even when a map points at them', () => {
    const map = variant((m) => {
      m.nodes.find((n: any) => n.id === 'u3').evidence[0] = { file: '.env', line: 1, text: 'EMAIL_API_KEY' };
    });
    expect(check(map, APP).nodes.u3!.reasons).toEqual(['.env:1: secret files are never read']);
    const bad = parseMap({ ...structuredClone(MAP_JSON), nodes: [{ ...MAP_JSON.nodes[0], evidence: [{ file: '../outside.ts', line: 1, text: 'x' }] }, ...MAP_JSON.nodes.slice(1)] });
    expect(bad).toEqual({ ok: false, problems: ['node "s1": evidence file "../outside.ts" must be a path inside the repo'] });
  });

  it('leaves secrets out of searches', () => {
    const map = variant((m) => { m.absences.push({ id: 'key', claim: 'No API keys in the repo', search: { pattern: 'EMAIL_API_KEY' }, matches: 0 }); });
    expect(check(map, APP).absences.key).toMatchObject({ status: 'confirmed', found: 0 });
  });
});
