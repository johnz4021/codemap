// Test helpers: a scripted stand-in for Claude, and throwaway copies of the care-app fixture.
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Agent, AgentRequest, AgentResponse } from '../src/agent';

export const CARE_APP = fileURLToPath(new URL('../../core/test/fixtures/care-app', import.meta.url));
export const CARE_MAP: Record<string, any> = JSON.parse(readFileSync(fileURLToPath(new URL('../../core/test/fixtures/care-app.map.json', import.meta.url)), 'utf8'));

const dirs: string[] = [];
export function copyCareApp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codemap-server-'));
  dirs.push(dir);
  cpSync(CARE_APP, dir, { recursive: true });
  return dir;
}
export function cleanup() {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** A fake agent that replies from a script, in order, and records every request. */
export function scriptedAgent(replies: ((req: AgentRequest) => unknown)[]): Agent & { calls: AgentRequest[] } {
  const calls: AgentRequest[] = [];
  const agent = (async (req: AgentRequest): Promise<AgentResponse> => {
    calls.push(req);
    const reply = replies[calls.length - 1];
    if (!reply) throw new Error(`no scripted reply for call ${calls.length}`);
    req.onProgress?.({ kind: 'read', text: 'Reading src/patients/service.ts' });
    return { output: reply(req), sessionId: `session-${calls.length}`, cost: 0.01 };
  }) as Agent & { calls: AgentRequest[] };
  agent.calls = calls;
  return agent;
}

/** The fix Claude would propose for "make the welcome email go out right away". */
export const LISTENER_FIX = {
  summary: 'Run the automation rules as soon as a patient converts, by listening for the announcement.',
  edits: [],
  creates: [{
    file: 'src/automations/listeners.ts',
    content: "import { bus } from '../events/bus';\nimport { evaluateRules } from './evaluate';\n\nbus.on('patient.converted', ({ patientId }) => evaluateRules({ patientId }));\n",
  }],
  connects: { from: 's4', to: 'u1', label: 'now listens', evidenceFile: 'src/automations/listeners.ts', evidenceText: "bus.on('patient.converted'" },
};

export async function waitFor<T>(fn: () => Promise<T | null | undefined> | T | null | undefined, ms = 5000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}
