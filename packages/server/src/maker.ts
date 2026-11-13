// Making a map: a head start from the code facts, Claude explores and drafts, the checker re-reads the code, and Claude
// gets up to `repairs` chances to fix what didn't check out. A repair returns only the changes (`patchMap`), not the
// whole map again, since writing the map is most of the time a map takes. The best attempt wins; nothing unconfirmed
// is hidden.
import { check, parseMap, patchMap, type CheckReport, type CodeMap, type ParseResult } from '@illuminate/core';
import type { Agent, Progress } from './agent';
import { headStart, symbolIndexOf } from './hints';
import { evidenceRepairPrompt, makerPrompt, patchRepairPrompt, shapeRepairPrompt } from './prompts';
import { MAP_PATCH_SCHEMA, MAP_SCHEMA, RawMapPatch } from './schemas';

export type Status = { kind: 'status'; text: string };
export type MakeOptions = {
  root: string;
  question: string;
  agent: Agent;
  model?: string;
  repairs?: number;
  onProgress?: (p: Progress | Status) => void;
  signal?: AbortSignal;
};
export type MakeResult = { map: CodeMap; report: CheckReport; sessionId: string | null; cost: number; rounds: number };

const withQuestion = (output: unknown, question: string) =>
  output && typeof output === 'object' ? { ...(output as Record<string, unknown>), version: 1, question } : output;

/** Claude's changes applied to the map they're for, or what stops them from applying. */
function applyPatch(map: CodeMap, output: unknown): ParseResult {
  const raw = RawMapPatch.safeParse(output);
  if (!raw.success) return { ok: false, problems: raw.error.issues.map((i) => `${i.path.join('.') || '(changes)'}: ${i.message}`) };
  return patchMap(map, raw.data);
}

export async function makeMap(o: MakeOptions): Promise<MakeResult> {
  const status = (text: string) => o.onProgress?.({ kind: 'status', text });
  status('Scanning the code for ways in, routes and tables');
  const hints = await headStart(o.root);
  const symbolsIn = symbolIndexOf(hints.scan);
  status('Claude is exploring the code');
  const run = (prompt: string, resume: string | null, schema: Record<string, unknown>) =>
    o.agent({ prompt, label: `Making the map for "${o.question}"`, schema, cwd: o.root, resume, model: o.model, onProgress: o.onProgress, signal: o.signal });

  let res = await run(makerPrompt(o.question, hints.text), null, MAP_SCHEMA);
  let cost = res.cost ?? 0;
  let rounds = 1;
  let best: { map: CodeMap; report: CheckReport } | null = null;
  let lastProblems: string[] = [];
  /** What the last reply is: a whole map, or changes to `current`, the last map that could be read. */
  let reply: 'map' | 'patch' = 'map';
  let current: CodeMap | null = null;

  for (let attempt = 0; ; attempt++) {
    const parsed: ParseResult = reply === 'map' || !current ? parseMap(withQuestion(res.output, o.question)) : applyPatch(current, res.output);
    let repair: { prompt: string; reply: 'map' | 'patch' } | null = null;
    if (!parsed.ok) {
      lastProblems = parsed.problems;
      repair = current ? { prompt: patchRepairPrompt(parsed.problems), reply: 'patch' } : { prompt: shapeRepairPrompt(parsed.problems), reply: 'map' };
    } else {
      current = parsed.map;
      status('Checking every claim against the code');
      const report = check(parsed.map, o.root);
      if (!best || report.summary.unconfirmed < best.report.summary.unconfirmed) best = { map: parsed.map, report };
      status(`${report.summary.confirmed} of ${report.summary.claims} claims confirmed`);
      if (report.summary.unconfirmed > 0) repair = { prompt: evidenceRepairPrompt(report, symbolsIn), reply: 'patch' };
    }
    if (!repair || attempt >= (o.repairs ?? 2)) break;
    status(parsed.ok ? 'Asking Claude to fix the claims that didn\'t check out' : current ? 'Asking Claude to fix its changes' : 'Asking Claude to fix the map\'s structure');
    res = await run(repair.prompt, res.sessionId, repair.reply === 'map' ? MAP_SCHEMA : MAP_PATCH_SCHEMA);
    reply = repair.reply;
    cost += res.cost ?? 0;
    rounds++;
  }
  if (!best) throw new Error(`Claude's map couldn't be read: ${lastProblems.slice(0, 5).join('; ')}`);
  return { ...best, sessionId: res.sessionId, cost, rounds };
}
