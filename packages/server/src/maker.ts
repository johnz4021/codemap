// Making a map: a head start from the code facts, Claude explores and drafts, the checker re-reads the code, and Claude
// gets up to `repairs` chances to fix what didn't check out. The best attempt wins; nothing unconfirmed is hidden.
import { check, parseMap, type CheckReport, type CodeMap } from '@codemap/core';
import type { Agent, Progress } from './agent';
import { headStart } from './hints';
import { evidenceRepairPrompt, makerPrompt, shapeRepairPrompt } from './prompts';
import { MAP_SCHEMA } from './schemas';

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

export async function makeMap(o: MakeOptions): Promise<MakeResult> {
  const status = (text: string) => o.onProgress?.({ kind: 'status', text });
  status('Scanning the code for ways in, routes and tables');
  const hints = await headStart(o.root);
  status('Claude is exploring the code');
  const run = (prompt: string, resume: string | null) =>
    o.agent({ prompt, schema: MAP_SCHEMA, cwd: o.root, resume, model: o.model, onProgress: o.onProgress, signal: o.signal });

  let res = await run(makerPrompt(o.question, hints.text), null);
  let cost = res.cost ?? 0;
  let rounds = 1;
  let best: { map: CodeMap; report: CheckReport } | null = null;
  let lastProblems: string[] = [];

  for (let attempt = 0; ; attempt++) {
    const parsed = parseMap(withQuestion(res.output, o.question));
    let repair: string | null = null;
    if (!parsed.ok) {
      lastProblems = parsed.problems;
      repair = shapeRepairPrompt(parsed.problems);
    } else {
      status('Checking every claim against the code');
      const report = check(parsed.map, o.root);
      if (!best || report.summary.unconfirmed < best.report.summary.unconfirmed) best = { map: parsed.map, report };
      status(`${report.summary.confirmed} of ${report.summary.claims} claims confirmed`);
      if (report.summary.unconfirmed > 0) repair = evidenceRepairPrompt(report);
    }
    if (!repair || attempt >= (o.repairs ?? 2)) break;
    status(parsed.ok ? 'Asking Claude to fix the claims that didn\'t check out' : 'Asking Claude to fix the map\'s structure');
    res = await run(repair, res.sessionId);
    cost += res.cost ?? 0;
    rounds++;
  }
  if (!best) throw new Error(`Claude's map couldn't be read: ${lastProblems.slice(0, 5).join('; ')}`);
  return { ...best, sessionId: res.sessionId, cost, rounds };
}
