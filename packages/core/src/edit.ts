// Changing a map after it's made: what the explainer finds is added, a fix's new connection is drawn, a missing
// connection that a fix closed is dropped, and a repair round's changes are patched in. Every change goes back through
// `parseMap`, so ids stay unique and references stay valid.
import { parseMap, type CodeMap, type ParseResult } from './format';

/** New areas, boxes, arrows and missing connections, as the model wrote them (validated on merge). */
export type MapAdditions = { areas?: unknown[]; nodes?: unknown[]; edges?: unknown[]; absences?: unknown[] };

export function addToMap(map: CodeMap, add: MapAdditions): ParseResult {
  return parseMap({
    ...map,
    areas: [...map.areas, ...(add.areas ?? [])],
    nodes: [...map.nodes, ...(add.nodes ?? [])],
    edges: [...map.edges, ...(add.edges ?? [])],
    absences: [...map.absences, ...(add.absences ?? [])],
  });
}

/** The map without the given ids, and without arrows, missing connections or tour mentions that point at removed boxes. */
export function removeFromMap(map: CodeMap, ids: ReadonlySet<string>): CodeMap {
  if (!ids.size) return map;
  const nodes = map.nodes.filter((n) => !ids.has(n.id));
  const kept = new Set(nodes.map((n) => n.id));
  const edges = map.edges.filter((e) => !ids.has(e.id) && kept.has(e.from) && kept.has(e.to));
  const absences = map.absences.filter((a) => !ids.has(a.id) && (!a.between || (kept.has(a.between.from) && kept.has(a.between.to))));
  const areas = map.areas.filter((a) => !ids.has(a.id) || nodes.some((n) => n.area === a.id));
  const live = new Set([...nodes, ...edges, ...absences, ...areas].map((x) => x.id));
  const tour = map.tour.map((t) => ({
    ...t,
    focus: Object.fromEntries(Object.entries(t.focus).map(([k, v]) => [k, (v as string[]).filter((id) => live.has(id))])),
  }));
  const parsed = parseMap({ ...map, areas, nodes, edges, absences, tour });
  return parsed.ok ? parsed.map : map;
}

/**
 * Changes to a map, as a model returns them when fixing a few claims: items whose id already exists replace it, new ids
 * are added, and `remove` drops ids (with what points at them). Everything not mentioned stays as it was.
 */
export type MapPatch = { areas?: unknown[]; nodes?: unknown[]; edges?: unknown[]; absences?: unknown[]; remove?: readonly string[] };

export function patchMap(map: CodeMap, patch: MapPatch): ParseResult {
  const base = removeFromMap(map, new Set(patch.remove ?? []));
  const upsert = (list: readonly { id: string }[], items: readonly unknown[] = []) => {
    const out: unknown[] = [...list];
    for (const item of items) {
      const id = item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined;
      const at = typeof id === 'string' ? out.findIndex((x) => (x as { id: string }).id === id) : -1;
      if (at >= 0) out[at] = item;
      else out.push(item);
    }
    return out;
  };
  return parseMap({
    ...base,
    areas: upsert(base.areas, patch.areas),
    nodes: upsert(base.nodes, patch.nodes),
    edges: upsert(base.edges, patch.edges),
    absences: upsert(base.absences, patch.absences),
  });
}

export function removeAbsences(map: CodeMap, ids: readonly string[]): CodeMap {
  const drop = new Set(ids);
  return {
    ...map,
    absences: map.absences.filter((a) => !drop.has(a.id)),
    tour: map.tour.map((t) => (t.focus.absences ? { ...t, focus: { ...t.focus, absences: t.focus.absences.filter((id) => !drop.has(id)) } } : t)),
  };
}

/** Ids of everything in the map, for picking new ones. */
export function mapIds(map: CodeMap): Set<string> {
  return new Set([...map.areas, ...map.nodes, ...map.edges, ...map.absences, ...map.tour].map((x) => x.id));
}

export function freshId(map: CodeMap, prefix: string): string {
  const taken = mapIds(map);
  for (let i = 1; ; i++) if (!taken.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

/** A short, file-safe id for a map from its question. */
export function slugify(question: string): string {
  const slug = question
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter((w) => !['what', 'happens', 'when', 'the', 'a', 'an', 'does', 'do', 'how', 'is', 'are', 'it', 'go', 'out'].includes(w))
    .slice(0, 6)
    .join('-');
  return slug || 'map';
}
