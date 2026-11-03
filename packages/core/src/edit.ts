// Changing a map after it's made: what the explainer finds is added, a fix's new connection is drawn, a missing
// connection that a fix closed is dropped. Every change goes back through `parseMap`, so ids stay unique and references
// stay valid.
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
