// What the model must return, as JSON Schema for structured output. Derived from the map format's zod schemas, so the
// two can't drift. Output is still validated with zod (and the map with `parseMap`) after it comes back.
import { z } from 'zod';
import { Absence, Area, CodeMap, Edge, Node, Screen } from '@illuminate/core';

/** Keywords some structured-output validators reject; zod and `parseMap` enforce them after the fact anyway. */
const STRIP = new Set(['$schema', '$id', 'pattern', 'default', 'format']);

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (!STRIP.has(k)) out[k] = sanitize(v);
  return out;
}

export function toSchema(schema: z.ZodType): Record<string, unknown> {
  return sanitize(z.toJSONSchema(schema, { io: 'input' })) as Record<string, unknown>;
}

export const RawFix = z.object({
  summary: z.string().min(1).max(600),
  /** Exact-text replacements: `find` is copied from the file and occurs exactly once. */
  edits: z.array(z.object({ file: z.string().min(1), find: z.string().min(1), replace: z.string() })).max(12).default([]),
  creates: z.array(z.object({ file: z.string().min(1), content: z.string() })).max(6).default([]),
  /** The connection the fix creates between two boxes; `evidenceText` must appear in the new code. */
  connects: z
    .object({ from: z.string(), to: z.string(), label: z.string().min(1).max(60), evidenceFile: z.string().min(1), evidenceText: z.string().min(1).max(200) })
    .optional(),
});

/**
 * A box as Claude writes it: the map format's node, but only the plain explanation. The format still allows `how` and
 * `code` (older maps have them), but the map shows the code itself, so Claude isn't asked for them.
 */
const WrittenNode = Node.extend({ explain: z.object({ concept: z.string() }).partial().optional() });

/** The map as Claude writes it (see `WrittenNode`); read back with `parseMap` against the full format. */
const WrittenMap = CodeMap.extend({ nodes: z.array(WrittenNode).min(1) });

export const RawAnswer = z.object({
  /** The answer, as short Markdown shaped to the question (see `ANSWER_STYLE`). The map does the explaining; this says what's lit. */
  concept: z.string().min(1),
  /** Ids of the boxes, arrows and missing connections the answer relies on. */
  refs: z.array(z.string()).default([]),
  /** New things found while exploring, with evidence, same rules as the map. */
  add: z
    .object({ areas: z.array(Area).optional(), nodes: z.array(WrittenNode).optional(), edges: z.array(Edge).optional(), absences: z.array(Absence).optional() })
    .optional(),
  moves: z.object({ focus: z.string().optional(), highlight: z.array(z.string()).optional() }).optional(),
  /** Pictures of the screen for boxes on the map (existing ones, or ones in `add`), when the question is about what the person sees. */
  screens: z.array(z.object({ node: z.string(), screen: Screen })).max(4).optional(),
  fix: RawFix.optional(),
});

/** The first try, from the map alone (no tools): answer it, send it on to Claude with the code, or say it's elsewhere. */
export const RawQuickAnswer = RawAnswer.pick({ refs: true, moves: true }).extend({
  /**
   * `answer`: the map and the excerpts fully answer it. `code`: about this map, but needs code it doesn't show.
   * `elsewhere`: about a different part of the app than this map covers.
   */
  route: z.enum(['answer', 'code', 'elsewhere']),
  /** For `code`: what Claude would need to look at, which guides the search that follows. */
  missing: z.string().default(''),
  /** For `elsewhere`: the question as a new map would ask it. */
  newQuestion: z.string().default(''),
  /** For `elsewhere`: the id of a saved map that already covers it, if one does. */
  existingMap: z.string().default(''),
  concept: z.string().default(''),
});

/** A repair round's changes: corrected or new items (complete, keyed by id) and ids to drop. Applied with `patchMap`. */
export const RawMapPatch = z.object({
  areas: z.array(Area).default([]),
  nodes: z.array(WrittenNode).default([]),
  edges: z.array(Edge).default([]),
  absences: z.array(Absence).default([]),
  remove: z.array(z.string()).default([]),
});

export type RawFix = z.output<typeof RawFix>;
export type RawAnswer = z.output<typeof RawAnswer>;
export type RawQuickAnswer = z.output<typeof RawQuickAnswer>;

export const MAP_SCHEMA = toSchema(WrittenMap);
export const MAP_PATCH_SCHEMA = toSchema(RawMapPatch);
export const ANSWER_SCHEMA = toSchema(RawAnswer);
export const QUICK_ANSWER_SCHEMA = toSchema(RawQuickAnswer);

/** The zod schema behind each output schema, to validate output that didn't come through structured output (the channel). */
const VALIDATORS = new Map<Record<string, unknown>, z.ZodType>([
  [MAP_SCHEMA, WrittenMap],
  [MAP_PATCH_SCHEMA, RawMapPatch],
  [ANSWER_SCHEMA, RawAnswer],
  [QUICK_ANSWER_SCHEMA, RawQuickAnswer],
]);
export const validatorFor = (schema: Record<string, unknown>): z.ZodType | null => VALIDATORS.get(schema) ?? null;
