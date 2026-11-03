// Laying the map out with ELK, in two passes: each area's steps stack top to bottom in the order the arrows go, then
// the areas themselves run left to right along the arrows that cross between them. Missing connections and proposed
// fixes take part like arrows do. Arrows attach to the sides of the boxes that face each other.
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { CodeMap } from './types';

export const NODE_W = 210;
export const NODE_H = 66;
export type Box = { x: number; y: number; w: number; h: number };
/** Area boxes are absolute; node boxes are relative to their area. */
export type Layout = { areas: Record<string, Box>; nodes: Record<string, Box>; width: number; height: number };
export type ExtraEdge = { id: string; from: string; to: string };
export type Side = 't' | 'r' | 'b' | 'l';

// ELK is most of the bundle; load it on first layout so the page shell shows up first.
let elk: Promise<{ layout(graph: ElkNode): Promise<ElkNode> }> | null = null;
const getElk = () => (elk ??= import('elkjs/lib/elk.bundled.js').then((m) => new m.default()));

const LAYERED = {
  'elk.algorithm': 'layered',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
};

/** Every connection on the map, as from → to pairs between boxes. */
function links(map: CodeMap, extra: readonly ExtraEdge[]): { id: string; from: string; to: string }[] {
  const ids = new Set(map.nodes.map((n) => n.id));
  return [
    ...map.edges.map((e) => ({ id: `e:${e.id}`, from: e.from, to: e.to })),
    ...map.absences.flatMap((a) => (a.between ? [{ id: `a:${a.id}`, from: a.between.from, to: a.between.to }] : [])),
    ...extra.map((x) => ({ id: `x:${x.id}`, from: x.from, to: x.to })),
  ].filter((l) => ids.has(l.from) && ids.has(l.to) && l.from !== l.to);
}

export async function layoutMap(map: CodeMap, extra: readonly ExtraEdge[] = []): Promise<Layout> {
  const engine = await getElk();
  const areaOf = new Map(map.nodes.map((n) => [n.id, n.area]));
  const all = links(map, extra);

  // Pass 1: each area on its own, top to bottom, with room between rows for arrow labels.
  const nodes: Record<string, Box> = {};
  const sizes: Record<string, { w: number; h: number }> = {};
  for (const area of map.areas) {
    const members = map.nodes.filter((n) => n.area === area.id);
    if (!members.length) continue;
    const inside = all.filter((l) => areaOf.get(l.from) === area.id && areaOf.get(l.to) === area.id);
    const out = await engine.layout({
      id: area.id,
      layoutOptions: {
        ...LAYERED,
        'elk.direction': 'DOWN',
        'elk.padding': '[top=46,left=22,bottom=22,right=22]',
        'elk.layered.spacing.nodeNodeBetweenLayers': '56',
        'elk.spacing.nodeNode': '36',
      },
      children: members.map((n) => ({ id: n.id, width: NODE_W, height: NODE_H })),
      edges: inside.map((l): ElkExtendedEdge => ({ id: l.id, sources: [l.from], targets: [l.to] })),
    });
    for (const c of out.children ?? []) nodes[c.id] = { x: c.x ?? 0, y: c.y ?? 0, w: NODE_W, h: NODE_H };
    sizes[area.id] = { w: out.width ?? NODE_W + 44, h: out.height ?? NODE_H + 68 };
  }

  // Pass 2: the areas, left to right, joined by the arrows that cross between them (one per pair is enough).
  const pairs = new Map<string, { from: string; to: string }>();
  for (const l of all) {
    const from = areaOf.get(l.from)!;
    const to = areaOf.get(l.to)!;
    if (from !== to && sizes[from] && sizes[to]) pairs.set(`${from}>${to}`, { from, to });
  }
  const out = await engine.layout({
    id: 'root',
    layoutOptions: { ...LAYERED, 'elk.direction': 'RIGHT', 'elk.layered.spacing.nodeNodeBetweenLayers': '120', 'elk.spacing.nodeNode': '48', 'elk.spacing.componentComponent': '64' },
    children: map.areas.filter((a) => sizes[a.id]).map((a) => ({ id: a.id, width: sizes[a.id]!.w, height: sizes[a.id]!.h })),
    edges: [...pairs.values()].map((p, i): ElkExtendedEdge => ({ id: `p${i}`, sources: [p.from], targets: [p.to] })),
  });
  const areas: Record<string, Box> = {};
  for (const c of out.children ?? []) areas[c.id] = { x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? 0 };
  return { areas, nodes, width: out.width ?? 0, height: out.height ?? 0 };
}

/** Which sides an arrow leaves and enters by: down within an area, across between areas side by side. */
export function sides(map: CodeMap, layout: Layout, from: string, to: string): [Side, Side] {
  const areaOf = (id: string) => map.nodes.find((n) => n.id === id)?.area ?? '';
  const abs = (id: string) => {
    const a = layout.areas[areaOf(id)];
    const n = layout.nodes[id];
    return a && n ? { x: a.x + n.x + n.w / 2, y: a.y + n.y + n.h / 2 } : { x: 0, y: 0 };
  };
  const p = abs(from);
  const q = abs(to);
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  if (areaOf(from) === areaOf(to) || Math.abs(dx) < NODE_W * 0.75) return dy >= 0 ? ['b', 't'] : ['t', 'b'];
  return dx >= 0 ? ['r', 'l'] : ['l', 'r'];
}

/** A key that changes only when the layout would: which boxes exist, where they live, and what connects them. */
export function layoutKey(map: CodeMap, extra: readonly ExtraEdge[] = []): string {
  return JSON.stringify([
    map.areas.map((a) => a.id),
    map.nodes.map((n) => `${n.id}@${n.area}`),
    map.edges.map((e) => `${e.from}>${e.to}`),
    map.absences.map((a) => (a.between ? `${a.between.from}~${a.between.to}` : '')),
    extra.map((x) => `${x.from}+${x.to}`),
  ]);
}
