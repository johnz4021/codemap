// Laying the map out with ELK, in two passes: each area's steps stack top to bottom in the order the arrows go, then
// the areas themselves run left to right along the arrows that cross between them. Missing connections and proposed
// fixes take part like arrows do. Arrows attach to the sides of the boxes that face each other.
// What answers added is laid out around the map as it was first drawn, so the boxes someone already knows never move:
// additions to an existing area go in rows below its steps, new areas go to the right.
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { CodeMap } from './types';

export const NODE_W = 232;
export const NODE_H = 96;
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

type Engine = Awaited<ReturnType<typeof getElk>>;
const PAD = { top: 52, side: 26, bottom: 26 };
const ROW_GAP = 64;
const COL_GAP = 44;
const AREA_GAP = 56;
const COLUMN_GAP = 140;

/** Pass 1 for one area: its steps top to bottom, with room between rows for arrow labels. */
async function layoutArea(engine: Engine, areaId: string, members: readonly { id: string }[], inside: readonly { id: string; from: string; to: string }[]) {
  const out = await engine.layout({
    id: areaId,
    layoutOptions: {
      ...LAYERED,
      'elk.direction': 'DOWN',
      'elk.padding': `[top=${PAD.top},left=${PAD.side},bottom=${PAD.bottom},right=${PAD.side}]`,
      'elk.layered.spacing.nodeNodeBetweenLayers': String(ROW_GAP),
      'elk.spacing.nodeNode': String(COL_GAP),
    },
    children: members.map((n) => ({ id: n.id, width: NODE_W, height: NODE_H })),
    edges: inside.map((l): ElkExtendedEdge => ({ id: l.id, sources: [l.from], targets: [l.to] })),
  });
  const nodes: Record<string, Box> = {};
  for (const c of out.children ?? []) nodes[c.id] = { x: c.x ?? 0, y: c.y ?? 0, w: NODE_W, h: NODE_H };
  return { nodes, size: { w: out.width ?? NODE_W + 2 * PAD.side, h: out.height ?? NODE_H + PAD.top + PAD.bottom } };
}

/** The map without the given ids, and without arrows and gaps that lose an end. */
function withoutIds(map: CodeMap, ids: ReadonlySet<string>): CodeMap {
  const nodes = map.nodes.filter((n) => !ids.has(n.id));
  const kept = new Set(nodes.map((n) => n.id));
  return {
    ...map,
    areas: map.areas.filter((a) => !ids.has(a.id)),
    nodes,
    edges: map.edges.filter((e) => !ids.has(e.id) && kept.has(e.from) && kept.has(e.to)),
    absences: map.absences.filter((a) => !ids.has(a.id) && (!a.between || (kept.has(a.between.from) && kept.has(a.between.to)))),
  };
}

/**
 * Lay the map out. `added` names what answers added since it was first drawn: the rest is laid out exactly as it would
 * be without them, and the additions are fitted around it.
 */
export async function layoutMap(map: CodeMap, extra: readonly ExtraEdge[] = [], added: ReadonlySet<string> = new Set()): Promise<Layout> {
  const addedNodes = map.nodes.filter((n) => added.has(n.id));
  if (!addedNodes.length) return layoutWhole(map, extra);

  const base = withoutIds(map, added);
  const baseIds = new Set(base.nodes.map((n) => n.id));
  const l = await layoutWhole(base, extra.filter((x) => baseIds.has(x.from) && baseIds.has(x.to)));
  const engine = await getElk();
  const areas: Record<string, Box> = Object.fromEntries(Object.entries(l.areas).map(([id, b]) => [id, { ...b }]));
  const nodes: Record<string, Box> = { ...l.nodes };

  // Additions to areas that are already drawn: rows below the steps already there. The area grows downward.
  const growth: Record<string, number> = {};
  const fresh: Record<string, typeof addedNodes> = {};
  for (const n of addedNodes) (fresh[n.area] ??= []).push(n);
  for (const [areaId, members] of Object.entries(fresh)) {
    const box = areas[areaId];
    if (!box) continue;
    const perRow = Math.max(1, Math.floor((box.w - 2 * PAD.side + COL_GAP) / (NODE_W + COL_GAP)));
    const top = Math.max(PAD.top - ROW_GAP, ...base.nodes.filter((n) => n.area === areaId).map((n) => (nodes[n.id]?.y ?? 0) + NODE_H)) + ROW_GAP;
    members.forEach((n, i) => {
      nodes[n.id] = { x: PAD.side + (i % perRow) * (NODE_W + COL_GAP), y: top + Math.floor(i / perRow) * (NODE_H + ROW_GAP), w: NODE_W, h: NODE_H };
    });
    const h = Math.max(box.h, top + Math.ceil(members.length / perRow) * (NODE_H + ROW_GAP) - ROW_GAP + PAD.bottom);
    growth[areaId] = h - box.h;
    box.h = h;
  }

  // Areas below one that grew slide down by as much (and so on down the column). Nothing moves sideways.
  const original = Object.fromEntries(Object.entries(l.areas).map(([id, b]) => [id, b]));
  const order = Object.keys(original).sort((a, b) => original[a]!.y - original[b]!.y);
  const shift: Record<string, number> = {};
  for (const b of order) {
    const B = original[b]!;
    shift[b] = Math.max(0, ...order
      .filter((a) => a !== b && shift[a] !== undefined)
      .filter((a) => {
        const A = original[a]!;
        return A.y + A.h <= B.y + 1 && A.x < B.x + B.w && B.x < A.x + A.w;
      })
      .map((a) => shift[a]! + (growth[a] ?? 0)));
    areas[b]!.y += shift[b]!;
  }

  // New areas: each laid out on its own, stacked in a column to the right of everything.
  const all = links(map, extra);
  const areaOf = new Map(map.nodes.map((n) => [n.id, n.area]));
  const x = Math.max(0, ...Object.values(areas).map((b) => b.x + b.w)) + COLUMN_GAP;
  let y = 0;
  for (const area of map.areas) {
    if (areas[area.id]) continue;
    const members = map.nodes.filter((n) => n.area === area.id);
    if (!members.length) continue;
    const inside = all.filter((k) => areaOf.get(k.from) === area.id && areaOf.get(k.to) === area.id);
    const out = await layoutArea(engine, area.id, members, inside);
    Object.assign(nodes, out.nodes);
    areas[area.id] = { x, y, w: out.size.w, h: out.size.h };
    y += out.size.h + AREA_GAP;
  }

  const boxes = Object.values(areas);
  return { areas, nodes, width: Math.max(0, ...boxes.map((b) => b.x + b.w)), height: Math.max(0, ...boxes.map((b) => b.y + b.h)) };
}

async function layoutWhole(map: CodeMap, extra: readonly ExtraEdge[]): Promise<Layout> {
  const engine = await getElk();
  const areaOf = new Map(map.nodes.map((n) => [n.id, n.area]));
  const all = links(map, extra);

  // Pass 1: each area on its own.
  const nodes: Record<string, Box> = {};
  const sizes: Record<string, { w: number; h: number }> = {};
  for (const area of map.areas) {
    const members = map.nodes.filter((n) => n.area === area.id);
    if (!members.length) continue;
    const inside = all.filter((l) => areaOf.get(l.from) === area.id && areaOf.get(l.to) === area.id);
    const out = await layoutArea(engine, area.id, members, inside);
    Object.assign(nodes, out.nodes);
    sizes[area.id] = out.size;
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
export function layoutKey(map: CodeMap, extra: readonly ExtraEdge[] = [], added: readonly string[] = []): string {
  return JSON.stringify([
    [...added].sort(),
    map.areas.map((a) => a.id),
    map.nodes.map((n) => `${n.id}@${n.area}`),
    map.edges.map((e) => `${e.from}>${e.to}`),
    map.absences.map((a) => (a.between ? `${a.between.from}~${a.between.to}` : '')),
    extra.map((x) => `${x.from}+${x.to}`),
  ]);
}
