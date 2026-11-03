// The map format: shape validation, defaults, and references between areas, boxes, arrows, absences and tour stops.
import { describe, expect, it } from 'vitest';
import { isSafeRelativePath, parseMap } from '../src/format';

const minimal = () => ({
  version: 1,
  question: 'What happens when staff convert a patient?',
  areas: [{ id: 'patients', label: 'Patients' }],
  nodes: [
    { id: 'a', area: 'patients', name: 'Click', evidence: [{ file: 'src/ui.tsx', line: 3, text: 'onClick' }] },
    { id: 'b', area: 'patients', name: 'Save', evidence: [{ file: 'src/save.ts', line: 1, text: 'save(' }] },
  ],
});

describe('parseMap', () => {
  it('accepts a minimal map and fills defaults', () => {
    const r = parseMap(minimal());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.map.nodes[0]!.kind).toBe('step');
    expect(r.map).toMatchObject({ edges: [], absences: [], tour: [] });
  });

  it('reports shape problems with their paths', () => {
    const m: any = minimal();
    m.version = 2;
    m.nodes[0].evidence = [];
    m.nodes[1].symbol = 'no-hash';
    const r = parseMap(m);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems).toEqual(expect.arrayContaining([
      expect.stringMatching(/^version: /),
      expect.stringMatching(/^nodes\.0\.evidence: /),
      'nodes.1.symbol: symbol is <file>#<name>',
    ]));
  });

  it('reports broken references and duplicate ids', () => {
    const m: any = minimal();
    m.nodes.push({ id: 'a', area: 'billing', name: 'Dup', evidence: [{ file: 'x.ts', line: 1, text: 'x' }] });
    m.edges = [{ id: 'e1', from: 'a', to: 'zzz', label: 'calls', evidence: [{ file: 'x.ts', line: 1, text: 'x' }] }];
    m.absences = [{ id: 'g', claim: 'none', between: { from: 'b', to: 'nope' }, search: { pattern: 'x' }, matches: 0 }];
    m.tour = [{ id: 't', title: 'Start', text: 'Hi', focus: { edges: ['e9'], areas: ['patients'] } }];
    const r = parseMap(m);
    expect(r).toEqual({
      ok: false,
      problems: [
        'node id "a" is used twice',
        'node "a": unknown area "billing"',
        'edge "e1": unknown node "zzz"',
        'absence "g": unknown node "nope"',
        'tour stop "t": unknown edge "e9"',
      ],
    });
  });
});

describe('isSafeRelativePath', () => {
  it('allows repo-relative paths and rejects anything that could leave the repo', () => {
    expect(['src/a.ts', 'a.ts', '.github/workflows/ci.yml'].every(isSafeRelativePath)).toBe(true);
    expect(['/etc/passwd', '../x.ts', 'src/../../x', 'C:/x', 'src\\x.ts', 'src//x.ts', ''].some(isSafeRelativePath)).toBe(false);
  });
});
