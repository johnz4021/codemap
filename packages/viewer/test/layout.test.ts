// ELK layout of the care-app map: steps stack down inside their area, areas run left to right along the arrows, every
// box stays inside its area, and arrows attach to the sides that face each other.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseMap } from '@illuminate/core';
import { layoutKey, layoutMap, sides } from '../src/layout';

const map = (() => {
  const r = parseMap(JSON.parse(readFileSync(fileURLToPath(new URL('../../core/test/fixtures/care-app.map.json', import.meta.url)), 'utf8')));
  if (!r.ok) throw new Error(r.problems.join('\n'));
  return r.map;
})();

describe('layoutMap', () => {
  it('places every box inside its area, and every area', async () => {
    const l = await layoutMap(map);
    expect(Object.keys(l.areas).sort()).toEqual(['automations', 'events', 'jobs', 'patients']);
    for (const n of map.nodes) {
      const box = l.nodes[n.id]!;
      const area = l.areas[n.area]!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.w).toBeLessThanOrEqual(area.w);
      expect(box.y + box.h).toBeLessThanOrEqual(area.h);
    }
  });

  it('stacks steps down inside an area, and runs areas left to right along the path', async () => {
    const l = await layoutMap(map);
    expect(l.nodes.s1!.y).toBeLessThan(l.nodes.s2!.y);
    expect(l.nodes.s2!.y).toBeLessThan(l.nodes.s3!.y);
    expect(l.nodes.u1!.y).toBeLessThan(l.nodes.u3!.y);
    expect(l.areas.patients!.x).toBeLessThan(l.areas.events!.x);
    expect(l.areas.events!.x).toBeLessThan(l.areas.automations!.x); // the missing connection still pulls Automations right
    expect(l.areas.jobs!.x).toBeLessThan(l.areas.automations!.x);
  });

  it('attaches arrows to facing sides: down within an area, across between areas', async () => {
    const l = await layoutMap(map);
    expect(sides(map, l, 's1', 's2')).toEqual(['b', 't']);
    expect(sides(map, l, 's3', 's4')).toEqual(['r', 'l']);
    expect(sides(map, l, 'j1', 'u1')).toEqual(['r', 'l']);
  });

  it('keeps the original boxes in place when answers add to the map', async () => {
    const grown = {
      ...map,
      areas: [...map.areas, { id: 'mail', label: 'Email' }],
      nodes: [...map.nodes, { ...map.nodes.find((n) => n.area === 'jobs')!, id: 'n9' }, { ...map.nodes[0]!, id: 'n10', area: 'mail' }],
      edges: [...map.edges, { ...map.edges[0]!, id: 'e9', from: 'j1', to: 'n9' }, { ...map.edges[0]!, id: 'e10', from: 'n9', to: 'n10' }],
    };
    const before = await layoutMap(map);
    const after = await layoutMap(grown, [], new Set(['mail', 'n9', 'n10', 'e9', 'e10']));
    for (const n of map.nodes) expect(after.nodes[n.id]).toEqual(before.nodes[n.id]); // same place inside its area
    for (const a of map.areas) {
      expect(after.areas[a.id]!.x).toBe(before.areas[a.id]!.x);
      expect(after.areas[a.id]!.y).toBeGreaterThanOrEqual(before.areas[a.id]!.y); // only ever slides down
    }
    const jobs = after.areas.jobs!;
    expect(after.nodes.n9!.y + after.nodes.n9!.h).toBeLessThanOrEqual(jobs.h); // inside the area, which grew
    expect(after.areas.mail!.x).toBeGreaterThan(Math.max(...map.areas.map((a) => before.areas[a.id]!.x + before.areas[a.id]!.w)));
    const boxes = Object.values(after.areas);
    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
    }
  });

  it('changes its key only when the structure changes', () => {
    const renamed = { ...map, nodes: map.nodes.map((n) => (n.id === 's1' ? { ...n, name: 'Different words' } : n)) };
    expect(layoutKey(renamed)).toBe(layoutKey(map));
    expect(layoutKey(map, [{ id: 'fix-1', from: 's4', to: 'u1' }])).not.toBe(layoutKey(map));
  });
});
