// Answering a question about a map. Claude starts from the map and explores the repo when it isn't enough. Anything it
// adds must pass the checker or it isn't drawn; a requested change comes back as a validated fix proposal, never an edit.
import * as crypto from 'node:crypto';
import { addToMap, check, mapIds, parseMap, type CheckReport, type CodeMap } from '@codemap/core';
import type { Agent, Progress } from './agent';
import { proposeFix, type FixProposal } from './fixes';
import { explainerPrompt, type SelectionLine } from './prompts';
import { ANSWER_SCHEMA, RawAnswer } from './schemas';

export type Selection = { nodes?: string[]; edges?: string[]; absences?: string[] };
export type RefStatus = { id: string; status: 'confirmed' | 'unconfirmed' | 'unknown' };
export type Answer = {
  id: string;
  question: string;
  selection: Selection;
  concept: string;
  how: string;
  code: string;
  refs: RefStatus[];
  followUps: string[];
  moves: { focus: string | null; highlight: string[] };
  /** Ids drawn on the map because of this answer (all confirmed). */
  added: string[];
  /** What was found but not drawn, and why; problems with a proposed fix. */
  problems: string[];
  fix: FixProposal | null;
  cost: number;
};
export type AnswerOptions = {
  root: string;
  map: CodeMap;
  selection: Selection;
  question: string;
  agent: Agent;
  session: string | null;
  model?: string;
  onProgress?: (p: Progress) => void;
  signal?: AbortSignal;
};

function selectionLines(map: CodeMap, s: Selection): SelectionLine[] {
  const nodes = new Map(map.nodes.map((n) => [n.id, n]));
  const label = (id: string) => nodes.get(id)?.name ?? id;
  return [
    ...(s.nodes ?? []).filter((id) => nodes.has(id)).map((id) => ({ id, label: `box "${label(id)}"` })),
    ...(s.edges ?? []).flatMap((id) => {
      const e = map.edges.find((x) => x.id === id);
      return e ? [{ id, label: `arrow "${e.label}" from "${label(e.from)}" to "${label(e.to)}"` }] : [];
    }),
    ...(s.absences ?? []).flatMap((id) => {
      const a = map.absences.find((x) => x.id === id);
      return a ? [{ id, label: `missing connection: ${a.claim}` }] : [];
    }),
  ];
}

/** The map without the given ids (and without arrows or tour mentions that point at removed boxes). */
function without(map: CodeMap, ids: ReadonlySet<string>): CodeMap {
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

function statusOf(report: CheckReport, id: string): RefStatus['status'] {
  const c = report.nodes[id] ?? report.edges[id] ?? report.absences[id];
  return c ? c.status : 'unknown';
}

export async function answer(o: AnswerOptions): Promise<{ answer: Answer; map: CodeMap; report: CheckReport; sessionId: string | null }> {
  const before = check(o.map, o.root);
  const res = await o.agent({
    prompt: explainerPrompt(o.map, before, selectionLines(o.map, o.selection), o.question),
    schema: ANSWER_SCHEMA,
    cwd: o.root,
    resume: o.session,
    model: o.model,
    onProgress: o.onProgress,
    signal: o.signal,
  });
  const parsed = RawAnswer.safeParse(res.output);
  if (!parsed.success) throw new Error(`Claude's answer couldn't be read: ${parsed.error.issues.slice(0, 3).map((i) => i.message).join('; ')}`);
  const raw = parsed.data;

  const problems: string[] = [];
  let map = o.map;
  let added: string[] = [];
  if (raw.add) {
    const merged = addToMap(o.map, raw.add);
    if (merged.ok) {
      const old = mapIds(o.map);
      added = [...mapIds(merged.map)].filter((id) => !old.has(id));
      map = merged.map;
    } else {
      problems.push(...merged.problems.map((p) => `Not added to the map: ${p}`));
    }
  }

  let report = check(map, o.root);
  const failed = added.filter((id) => statusOf(report, id) === 'unconfirmed');
  if (failed.length) {
    for (const id of failed) {
      const c = report.nodes[id] ?? report.edges[id] ?? report.absences[id];
      problems.push(`Not drawn, couldn't confirm ${id}: ${c?.reasons.join('; ') ?? 'unknown'}`);
    }
    map = without(map, new Set(failed));
    report = check(map, o.root);
    const live = mapIds(map);
    added = added.filter((id) => live.has(id));
  }

  let fix: FixProposal | null = null;
  if (raw.fix) {
    const proposed = proposeFix(o.root, map, raw.fix);
    if (proposed.ok) fix = proposed.proposal;
    else problems.push(...proposed.problems.map((p) => `The proposed fix can't be applied: ${p}`));
  }

  const live = mapIds(map);
  const result: Answer = {
    id: `ans-${crypto.randomBytes(4).toString('hex')}`,
    question: o.question,
    selection: o.selection,
    concept: raw.concept,
    how: raw.how,
    code: raw.code,
    refs: [...new Set(raw.refs)].map((id) => ({ id, status: statusOf(report, id) })),
    followUps: raw.followUps,
    moves: {
      focus: raw.moves?.focus && live.has(raw.moves.focus) ? raw.moves.focus : null,
      highlight: (raw.moves?.highlight ?? []).filter((id) => live.has(id)),
    },
    added,
    problems,
    fix,
    cost: res.cost ?? 0,
  };
  return { answer: result, map, report, sessionId: res.sessionId };
}
