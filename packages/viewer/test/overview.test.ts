// The big picture is built from the checked map alone: one box per area, one numbered arrow per pair of areas.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { check, parseMap } from '@illuminate/core';
import { inOverview, overviewOf } from '../src/overview';

const APP = fileURLToPath(new URL('../../core/test/fixtures/care-app', import.meta.url));
const json = JSON.parse(readFileSync(fileURLToPath(new URL('../../core/test/fixtures/care-app.map.json', import.meta.url)), 'utf8'));
const parsed = parseMap(json);
if (!parsed.ok) throw new Error(parsed.problems.join('\n'));
const map = parsed.map;
const report = check(map, APP);

describe('the big picture', () => {
  const o = overviewOf(map, report);

  it('has one box per area, named after it, standing for the steps inside', () => {
    expect(o.map.nodes.map((n) => n.name)).toEqual(map.areas.map((a) => a.label));
    expect(o.map.nodes).toHaveLength(map.areas.length);
    const patients = o.map.nodes.find((n) => n.id === 'ov.patients')!;
    expect(patients.kind).toBe('entry');
    expect(o.inside['ov.patients']).toEqual(expect.arrayContaining(map.nodes.filter((n) => n.area === 'patients').map((n) => n.id)));
  });

  it('draws one numbered arrow per pair of areas, only where a real arrow crosses, and keeps the missing connection', () => {
    const areaOf = new Map(map.nodes.map((n) => [n.id, n.area]));
    const crossing = new Set(map.edges.filter((e) => areaOf.get(e.from) !== areaOf.get(e.to)).map((e) => `${areaOf.get(e.from)}>${areaOf.get(e.to)}`));
    expect(o.map.edges).toHaveLength(crossing.size);
    o.map.edges.forEach((e, i) => expect(e.label.startsWith(`${i + 1} · `)).toBe(true));
    expect(o.map.absences).toHaveLength(1);
    expect(o.map.absences[0]!.between).toEqual({ from: 'ov.events', to: 'ov.automations' });
  });

  it('is confirmed only where everything inside is, and lights the boxes that stand for what a stop lights', () => {
    expect(Object.values(o.report!.nodes).every((c) => c.status === 'confirmed')).toBe(true);
    const broken = structuredClone(report);
    broken.nodes[map.nodes[0]!.id]!.status = 'unconfirmed';
    expect(overviewOf(map, broken).report!.nodes[`ov.${map.nodes[0]!.area}`]!.status).toBe('unconfirmed');
    expect(inOverview(o, [map.nodes[0]!.id, 'miss', 'nope'])).toEqual([`ov.${map.nodes[0]!.area}`, o.map.absences[0]!.id]);
  });
});
