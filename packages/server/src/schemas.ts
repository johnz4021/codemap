// What the model must return, as JSON Schema for structured output. Derived from the map format's zod schemas, so the
// two can't drift. Output is still validated with zod (and the map with `parseMap`) after it comes back.
import { z } from 'zod';
import { Absence, Area, CodeMap, Edge, Node } from '@codemap/core';

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

export const RawAnswer = z.object({
  concept: z.string().min(1),
  how: z.string().default(''),
  code: z.string().default(''),
  /** Ids of the boxes, arrows and missing connections the answer relies on. */
  refs: z.array(z.string()).default([]),
  /** New things found while exploring, with evidence, same rules as the map. */
  add: z
    .object({ areas: z.array(Area).optional(), nodes: z.array(Node).optional(), edges: z.array(Edge).optional(), absences: z.array(Absence).optional() })
    .optional(),
  moves: z.object({ focus: z.string().optional(), highlight: z.array(z.string()).optional() }).optional(),
  followUps: z.array(z.string()).max(3).default([]),
  fix: RawFix.optional(),
});

export type RawFix = z.output<typeof RawFix>;
export type RawAnswer = z.output<typeof RawAnswer>;

export const MAP_SCHEMA = toSchema(CodeMap);
export const ANSWER_SCHEMA = toSchema(RawAnswer);
