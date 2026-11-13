// The big picture: the same map one level up. Each area becomes one box, and the arrows that cross between areas
// become one numbered arrow per pair, in the order the flow goes. Built from the checked map alone (no model), so it
// says nothing the map doesn't: a box or arrow here is confirmed only if everything inside it is.
import type { CheckReport, CodeMap, MapNode } from './types';

const AREA = 'ov.';
/** The overview's id for an area, and for the arrow or gap between two areas. */
export const areaBox = (areaId: string) => `${AREA}${areaId}`;
const pairId = (kind: 'e' | 'a', from: string, to: string) => `ov${kind}.${from}.${to}`;

export type Overview = {
  map: CodeMap;
  report: CheckReport | null;
  /** Overview id → the ids of the real boxes, arrows and gaps it stands for. */
  inside: Record<string, string[]>;
  /** Real id → the overview id that stands for it (arrows inside one area map to that area's box). */
  standsFor: Record<string, string>;
};

/** What kind of box an area is: where things start if any step does, otherwise what all its steps are. */
function kindOf(nodes: readonly MapNode[]): MapNode['kind'] {
  if (nodes.some((n) => n.kind === 'entry')) return 'entry';
  for (const k of ['external', 'store', 'job'] as const) if (nodes.length && nodes.every((n) => n.kind === k)) return k;
  return 'step';
}

const joined = (labels: string[]) => {
  const unique = [...new Set(labels)];
  const text = unique.slice(0, 2).join(', ') + (unique.length > 2 ? ` +${unique.length - 2}` : '');
  return text.length > 52 ? `${text.slice(0, 51)}…` : text;
};

export function overviewOf(map: CodeMap, report: CheckReport | null): Overview {
  const areaOf = new Map(map.nodes.map((n) => [n.id, n.area]));
  const inside: Record<string, string[]> = {};
  const standsFor: Record<string, string> = {};
  const put = (ovId: string, realId: string) => {
    (inside[ovId] ??= []).push(realId);
    standsFor[realId] = ovId;
  };
  for (const n of map.nodes) put(areaBox(n.area), n.id);

  // The order the flow goes: arrows as the walkthrough visits them, then the rest as the map lists them.
  const toured = map.tour.flatMap((t) => t.focus.edges ?? []);
  const rank = new Map<string, number>();
  for (const id of [...toured, ...map.edges.map((e) => e.id)]) if (!rank.has(id)) rank.set(id, rank.size);
  const ordered = [...map.edges].sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);

  const pairs = new Map<string, { from: string; to: string; labels: string[] }>();
  for (const e of ordered) {
    const from = areaOf.get(e.from);
    const to = areaOf.get(e.to);
    if (!from || !to) continue;
    if (from === to) {
      put(areaBox(from), e.id);
      continue;
    }
    const id = pairId('e', from, to);
    if (!pairs.has(id)) pairs.set(id, { from, to, labels: [] });
    pairs.get(id)!.labels.push(e.label);
    put(id, e.id);
  }

  const used = map.areas.filter((a) => inside[areaBox(a.id)]?.length);
  const nodes: MapNode[] = used.map((a) => {
    const members = map.nodes.filter((n) => n.area === a.id);
    return {
      id: areaBox(a.id),
      area: areaBox(a.id),
      kind: kindOf(members),
      name: a.label,
      // Shown under the name where a step shows its function.
      symbol: `overview#${members.length} ${members.length === 1 ? 'step' : 'steps'}`,
      explain: { concept: members.map((n) => n.name).join(' → ') },
      evidence: members.flatMap((n) => n.evidence),
    };
  });
  const edges = [...pairs].map(([id, p], i) => ({
    id, from: areaBox(p.from), to: areaBox(p.to), kind: 'then' as const, label: `${i + 1} · ${joined(p.labels)}`, evidence: [],
  }));
  const absences = map.absences.flatMap((a) => {
    const from = a.between && areaOf.get(a.between.from);
    const to = a.between && areaOf.get(a.between.to);
    if (!from || !to) return [];
    if (from === to) {
      put(areaBox(from), a.id);
      return [];
    }
    const id = pairId('a', from, to);
    put(id, a.id);
    return inside[id]!.length > 1 ? [] : [{ ...a, id, between: { from: areaBox(from), to: areaBox(to) } }];
  });

  const ok = (id: string) => (report?.nodes[id] ?? report?.edges[id] ?? report?.absences[id])?.status === 'confirmed';
  const status = (ovId: string) => ((inside[ovId] ?? []).every(ok) ? 'confirmed' as const : 'unconfirmed' as const);
  const claim = (ovId: string) => ({ status: status(ovId), proof: null, evidence: [], reasons: [] });
  const ovReport: CheckReport | null = report && {
    nodes: Object.fromEntries(nodes.map((n) => [n.id, claim(n.id)])),
    edges: Object.fromEntries(edges.map((e) => [e.id, claim(e.id)])),
    absences: Object.fromEntries(absences.map((a) => [a.id, { ...report.absences[inside[a.id]![0]!]!, status: status(a.id) }])),
    tour: {},
    // An area shows the first confirmed screen among its steps.
    screens: Object.fromEntries(nodes.flatMap((n) => {
      const sc = (inside[n.id] ?? []).map((id) => report.screens?.[id]).find((c) => c?.status === 'confirmed');
      return sc ? [[n.id, sc]] : [];
    })),
    summary: report.summary,
  };

  return {
    map: { ...map, areas: used.map((a) => ({ id: areaBox(a.id), label: '' })), nodes, edges, absences, tour: [] },
    report: ovReport,
    inside,
    standsFor,
  };
}

/** Real ids (what a walkthrough stop or an answer lights) as the overview ids that stand for them. */
export function inOverview(o: Overview, ids: readonly string[]): string[] {
  return [...new Set(ids.flatMap((id) => (o.standsFor[id] ? [o.standsFor[id]!] : [])))];
}
