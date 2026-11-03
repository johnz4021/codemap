// Changing a map after it's made: additions are validated like a new map; closed gaps drop out of the tour too.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { addToMap, freshId, removeAbsences, slugify } from '../src/edit';
import { parseMap, type CodeMap } from '../src/format';

const MAP = (() => {
  const r = parseMap(JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/care-app.map.json', import.meta.url)), 'utf8')));
  if (!r.ok) throw new Error(r.problems.join('\n'));
  return r.map;
})();

describe('addToMap', () => {
  it('adds an area, a box and an arrow found while answering', () => {
    const r = addToMap(MAP, {
      nodes: [{ id: 'n9', area: 'jobs', name: 'Filter to yesterday', evidence: [{ file: 'src/jobs/nightly.ts', line: 9, text: 'createdAfter' }] }],
      edges: [{ id: 'e9', from: 'j1', to: 'n9', label: 'then', evidence: [{ file: 'src/jobs/nightly.ts', line: 9, text: 'db.where' }] }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.map.nodes.map((n) => n.id)).toContain('n9');
  });

  it('rejects additions that clash with existing ids or point at nothing', () => {
    const r = addToMap(MAP, {
      nodes: [{ id: 's1', area: 'patients', name: 'Again', evidence: [{ file: 'a.ts', line: 1, text: 'x' }] }],
      edges: [{ id: 'e10', from: 'u1', to: 'ghost', label: 'calls', evidence: [{ file: 'a.ts', line: 1, text: 'x' }] }],
    });
    expect(r).toEqual({ ok: false, problems: ['node id "s1" is used twice', 'edge "e10": unknown node "ghost"'] });
  });
});

describe('removeAbsences', () => {
  it('drops a closed gap from the map and from tour stops that pointed at it', () => {
    const m: CodeMap = removeAbsences(MAP, ['miss']);
    expect(m.absences).toEqual([]);
    expect(m.tour.find((t) => t.id === 't5')!.focus.absences).toEqual([]);
    expect(parseMap(m).ok).toBe(true);
  });
});

describe('ids', () => {
  it('picks the next free id and slugs questions', () => {
    expect(freshId(MAP, 'e')).toBe('e1');
    expect(freshId(MAP, 's')).toBe('s5');
    expect(slugify('What happens when a patient converts? Does the welcome email go out?')).toBe('patient-converts-welcome-email');
    expect(slugify('???')).toBe('map');
  });
});
