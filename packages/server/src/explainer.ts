// Answering a question about a map, in up to two steps. First Claude answers from the map and the code around its
// citations, with no tools: quick, and enough for many questions. If that isn't enough, Claude explores the repo. Anything
// it adds must pass the checker or it isn't drawn; a requested change comes back as a validated fix proposal, never an edit.
import * as crypto from 'node:crypto';
import { addToMap, check, createRepoReader, mapIds, parseMap, removeFromMap, type CheckReport, type CodeMap } from '@illuminate/core';
import type { Agent, Progress } from './agent';
import { proposeFix, type FixProposal } from './fixes';
import { explainerPrompt, quickAnswerPrompt, type EarlierTurn, type SelectionLine } from './prompts';
import { ANSWER_SCHEMA, QUICK_ANSWER_SCHEMA, RawAnswer, RawQuickAnswer } from './schemas';

export type Selection = { nodes?: string[]; edges?: string[]; absences?: string[] };
export type RefStatus = { id: string; status: 'confirmed' | 'unconfirmed' | 'unknown' };
export type Answer = {
  id: string;
  question: string;
  selection: Selection;
  /** The answer, in a few plain sentences. (Answers saved before replies were trimmed may also carry `how` and `code`.) */
  concept: string;
  refs: RefStatus[];
  moves: { focus: string | null; highlight: string[] };
  /** Ids drawn on the map because of this answer (all confirmed). */
  added: string[];
  /** Boxes whose picture of the screen this answer set (all confirmed). Missing on answers saved before screens existed. */
  screens?: string[];
  /** What was found but not drawn, and why; problems with a proposed fix. */
  problems: string[];
  fix: FixProposal | null;
  /** `map`: answered from the map alone. `code`: Claude looked in the code. */
  source: 'map' | 'code';
  /**
   * Set when the question is about a different part of the app than this map covers: there's no answer yet, only the
   * offer of a new map (or an existing one), or an answer in words. Missing on answers saved before offers existed.
   */
  offer?: Offer | null;
  cost: number;
};
export type Offer = {
  /** The question as a new map would ask it. */
  question: string;
  /** A saved map that already covers it. */
  existing: { id: string; question: string } | null;
  status: 'pending' | 'mapped' | 'answered';
  /** The map made for it, once they said yes. */
  mapId: string | null;
};
export type AnswerOptions = {
  root: string;
  map: CodeMap;
  selection: Selection;
  question: string;
  agent: Agent;
  session: string | null;
  model?: string;
  /** The last few questions on this map, so a map-only answer can follow on from them. */
  /** The conversation so far on this map, oldest first. */
  earlier?: readonly EarlierTurn[];
  /** Try answering from the map alone first (default true). */
  quick?: boolean;
  /** Other maps saved in this repo, so the first try can point at one that already covers the question. */
  otherMaps?: readonly { id: string; question: string }[];
  /** Answer in words from the code, drawing nothing: for a question about a different part of the app. */
  wordsOnly?: boolean;
  onProgress?: (p: Progress | { kind: 'status'; text: string }) => void;
  signal?: AbortSignal;
};

const EXCERPT_RADIUS = 4;
const MAX_EXCERPTS = 40;
const MAX_EXCERPT_CHARS = 30_000;

/**
 * The code around each line the map cites, read through the secret-refusing reader: what the selection cites first,
 * then the rest of the map, until the budget runs out. Plain code, no model.
 */
export function citedExcerpts(root: string, map: CodeMap, selection: Selection): string {
  const repo = createRepoReader(root);
  const picked = new Set([...(selection.nodes ?? []), ...(selection.edges ?? [])]);
  const items = [...map.nodes.map((n) => ({ id: n.id, evidence: n.evidence })), ...map.edges.map((e) => ({ id: e.id, evidence: e.evidence }))];
  items.sort((a, b) => Number(picked.has(b.id)) - Number(picked.has(a.id)));
  const seen = new Set<string>();
  const out: string[] = [];
  let size = 0;
  for (const item of items) {
    for (const e of item.evidence) {
      const key = `${e.file}:${e.line}`;
      if (seen.has(key) || out.length >= MAX_EXCERPTS) continue;
      seen.add(key);
      const read = repo.read(e.file);
      if (!read.ok) continue;
      const lines = read.text.split('\n');
      const from = Math.max(1, e.line - EXCERPT_RADIUS);
      const to = Math.min(lines.length, e.line + EXCERPT_RADIUS);
      const body = lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(5)} | ${l}`).join('\n');
      const block = `${e.file}:${from}-${to} (cited by ${item.id})\n${body}`;
      if (size + block.length > MAX_EXCERPT_CHARS) return out.join('\n\n');
      out.push(block);
      size += block.length;
    }
  }
  return out.join('\n\n');
}

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

function statusOf(report: CheckReport, id: string): RefStatus['status'] {
  const c = report.nodes[id] ?? report.edges[id] ?? report.absences[id];
  return c ? c.status : 'unknown';
}

export async function answer(o: AnswerOptions): Promise<{ answer: Answer; map: CodeMap; report: CheckReport; sessionId: string | null }> {
  const before = check(o.map, o.root);
  const selection = selectionLines(o.map, o.selection);
  const status = (text: string) => o.onProgress?.({ kind: 'status', text });
  const live0 = mapIds(o.map);
  const selected = (o.selection.nodes?.length ?? 0) + (o.selection.edges?.length ?? 0) + (o.selection.absences?.length ?? 0) > 0;
  let cost = 0;
  let missing = '';

  if (o.quick !== false && !o.wordsOnly) {
    status('Answering from the map');
    try {
      const res = await o.agent({
        prompt: quickAnswerPrompt(o.map, before, selection, o.question, citedExcerpts(o.root, o.map, o.selection), o.earlier ?? [], o.otherMaps ?? []),
        label: `Answering "${o.question}" from the map`,
        schema: QUICK_ANSWER_SCHEMA,
        cwd: o.root,
        tools: [],
        resume: null,
        model: o.model,
        maxTurns: 3,
        signal: o.signal,
      });
      cost += res.cost ?? 0;
      const quick = RawQuickAnswer.safeParse(res.output);
      // Something selected on this map means the question is about this map, whatever the first try thought.
      if (quick.success && quick.data.route === 'elsewhere' && !selected) {
        const existing = (o.otherMaps ?? []).find((m) => m.id === quick.data.existingMap) ?? null;
        const result: Answer = {
          id: `ans-${crypto.randomBytes(4).toString('hex')}`,
          question: o.question,
          selection: o.selection,
          concept: '',
          refs: [],
          moves: { focus: null, highlight: [] },
          added: [],
          problems: [],
          fix: null,
          source: 'map',
          offer: { question: quick.data.newQuestion.trim() || o.question, existing, status: 'pending', mapId: null },
          cost,
        };
        return { answer: result, map: o.map, report: before, sessionId: o.session };
      }
      if (quick.success && quick.data.route === 'answer' && quick.data.concept.trim()) {
        const q = quick.data;
        const result: Answer = {
          id: `ans-${crypto.randomBytes(4).toString('hex')}`,
          question: o.question,
          selection: o.selection,
          concept: q.concept,
          refs: [...new Set(q.refs)].map((id) => ({ id, status: statusOf(before, id) })),
          moves: {
            focus: q.moves?.focus && live0.has(q.moves.focus) ? q.moves.focus : null,
            highlight: (q.moves?.highlight ?? []).filter((id) => live0.has(id)),
          },
          added: [],
          problems: [],
          fix: null,
          source: 'map',
          offer: null,
          cost,
        };
        // The map didn't change, and the explainer session (what Claude has read in the code) carries on as it was.
        return { answer: result, map: o.map, report: before, sessionId: o.session };
      }
      if (quick.success) missing = quick.data.missing;
    } catch (err) {
      // Stopped, or no one is there to answer (bridge.ts): asking again from the code would only wait as long again.
      if (o.signal?.aborted || (err as { unheard?: boolean }).unheard) throw err;
      // A failed quick try isn't the end: Claude with the code still gets the question.
      cost += (err as { cost?: number }).cost ?? 0;
    }
    status('Looking in the code');
  }

  const res = await o.agent({
    prompt: explainerPrompt(o.map, before, selection, o.question, missing, o.wordsOnly, o.earlier ?? []),
    label: `Answering "${o.question}" from the code`,
    schema: ANSWER_SCHEMA,
    cwd: o.root,
    resume: o.session,
    model: o.model,
    onProgress: o.onProgress,
    signal: o.signal,
  });
  const parsed = RawAnswer.safeParse(res.output);
  if (!parsed.success) throw new Error(`Claude's answer couldn't be read: ${parsed.error.issues.slice(0, 3).map((i) => i.message).join('; ')}`);
  // An answer in words draws nothing and proposes nothing, whatever came back.
  const raw = o.wordsOnly ? { ...parsed.data, add: undefined, fix: undefined, screens: undefined } : parsed.data;

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

  // Screens the answer puts on boxes, old or new. One the checker can't confirm is taken back off (the box keeps
  // whatever screen it had), and the answer says so.
  const wanted = (raw.screens ?? []).filter((s) => {
    if (map.nodes.some((n) => n.id === s.node)) return true;
    problems.push(`No screen shown: there is no box "${s.node}"`);
    return false;
  });
  const screenOn = (m: CodeMap, id: string, screen: (typeof wanted)[number]['screen'] | undefined): CodeMap =>
    ({ ...m, nodes: m.nodes.map((n) => (n.id === id ? { ...n, screen } : n)) });
  const screened: string[] = [];
  for (const s of wanted) {
    const withIt = parseMap(screenOn(map, s.node, s.screen));
    const c = withIt.ok ? check(withIt.map, o.root).screens[s.node] : null;
    if (withIt.ok && c?.status === 'confirmed') {
      map = withIt.map;
      screened.push(s.node);
    } else {
      const why = withIt.ok ? c?.reasons.join('; ') ?? 'unknown' : withIt.problems.join('; ');
      problems.push(`No screen shown for "${map.nodes.find((n) => n.id === s.node)?.name ?? s.node}": ${why}`);
    }
  }
  // A new box may have come with its own screen; if that one didn't check out, say so (the box is still drawn).
  let report = check(map, o.root);
  for (const id of added) {
    const c = report.screens[id];
    if (c && c.status !== 'confirmed') problems.push(`No screen shown for "${map.nodes.find((n) => n.id === id)?.name ?? id}": ${c.reasons.join('; ')}`);
  }
  const failed = added.filter((id) => statusOf(report, id) === 'unconfirmed');
  if (failed.length) {
    for (const id of failed) {
      const c = report.nodes[id] ?? report.edges[id] ?? report.absences[id];
      problems.push(`Not drawn, couldn't confirm ${id}: ${c?.reasons.join('; ') ?? 'unknown'}`);
    }
    map = removeFromMap(map, new Set(failed));
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
    refs: [...new Set(raw.refs)].map((id) => ({ id, status: statusOf(report, id) })),
    moves: {
      focus: raw.moves?.focus && live.has(raw.moves.focus) ? raw.moves.focus : null,
      highlight: (raw.moves?.highlight ?? []).filter((id) => live.has(id)),
    },
    added,
    screens: screened.filter((id) => live.has(id)),
    problems,
    fix,
    source: 'code',
    offer: null,
    cost: cost + (res.cost ?? 0),
  };
  return { answer: result, map, report, sessionId: res.sessionId };
}
