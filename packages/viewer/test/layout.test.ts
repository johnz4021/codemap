// ELK layout of the care-app map: steps stack down inside their area, areas run left to right along the arrows, every
// box stays inside its area, and arrows attach to the sides that face each other.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseMap } from '@codemap/core';
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

  it('changes its key only when the structure changes', () => {
    const renamed = { ...map, nodes: map.nodes.map((n) => (n.id === 's1' ? { ...n, name: 'Different words' } : n)) };
    expect(layoutKey(renamed)).toBe(layoutKey(map));
    expect(layoutKey(map, [{ id: 'fix-1', from: 's4', to: 'u1' }])).not.toBe(layoutKey(map));
  });
});
