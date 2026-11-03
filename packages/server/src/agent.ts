// The one place codemap talks to a model: a read-only Claude Agent SDK session that returns structured output.
// Read, Grep and Glob only; secret files are refused and left out of searches. Tests swap in a fake `Agent`.
import * as path from 'node:path';
import { query, type HookCallback, type PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { isSecretPath } from '@codemap/core';

export type Progress = { kind: 'read' | 'search' | 'list'; text: string };

export type AgentRequest = {
  prompt: string;
  schema: Record<string, unknown>;
  cwd: string;
  /** Continue an earlier session (follow-up questions keep what was already read). */
  resume?: string | null;
  model?: string;
  maxTurns?: number;
  onProgress?: (p: Progress) => void;
  signal?: AbortSignal;
};
export type AgentResponse = { output: unknown; sessionId: string | null; cost: number | null };
export type Agent = (req: AgentRequest) => Promise<AgentResponse>;

export const DEFAULT_MODEL = process.env.CODEMAP_MODEL ?? 'claude-opus-5-5';
const READ_ONLY = ['Read', 'Grep', 'Glob'];
/** ripgrep glob that leaves secret files out of a search the model didn't scope itself. */
const NOT_SECRETS = '!**/{.env,.env.*,*.pem,*.key,*.p12,id_rsa*,id_ed25519*,.npmrc,.netrc}';

/** A plain-English progress line for a tool call, with paths relative to the repo. */
export function progressOf(name: string, input: Record<string, unknown>, cwd: string): Progress | null {
  const rel = (p: unknown) => (typeof p === 'string' ? path.relative(cwd, path.resolve(cwd, p)) || '.' : '');
  if (name === 'Read') return { kind: 'read', text: `Reading ${rel(input.file_path)}` };
  if (name === 'Grep') return { kind: 'search', text: `Searching for "${String(input.pattern ?? '')}"${input.path ? ` in ${rel(input.path)}` : ''}` };
  if (name === 'Glob') return { kind: 'list', text: `Looking for files matching ${String(input.pattern ?? '')}` };
  return null;
}

/** Refuse secret files, and keep repo-wide searches away from them. */
export function secretGuard(cwd: string): HookCallback {
  return async (input) => {
    const i = input as PreToolUseHookInput;
    const ti = (i.tool_input ?? {}) as Record<string, unknown>;
    const target = typeof ti.file_path === 'string' ? ti.file_path : typeof ti.path === 'string' ? ti.path : null;
    const rel = target ? path.relative(cwd, path.resolve(cwd, target)) : null;
    if (rel && (rel.startsWith('..') || path.isAbsolute(rel))) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Only files inside this repo can be read.' } };
    }
    if (rel && isSecretPath(rel)) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Secret files are never read.' } };
    }
    if (i.tool_name === 'Grep' && ti.glob === undefined && ti.type === undefined) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...ti, glob: NOT_SECRETS } } };
    }
    return {};
  };
}

export const sdkAgent: Agent = async (req) => {
  const abortController = new AbortController();
  req.signal?.addEventListener('abort', () => abortController.abort(), { once: true });
  const q = query({
    prompt: req.prompt,
    options: {
      cwd: req.cwd,
      model: req.model ?? DEFAULT_MODEL,
      tools: READ_ONLY,
      allowedTools: READ_ONLY,
      permissionMode: 'dontAsk',
      settingSources: [],
      strictMcpConfig: true,
      outputFormat: { type: 'json_schema', schema: req.schema },
      maxTurns: req.maxTurns ?? 60,
      abortController,
      hooks: { PreToolUse: [{ matcher: 'Read|Grep|Glob', hooks: [secretGuard(req.cwd)] }] },
      ...(req.resume ? { resume: req.resume } : {}),
    },
  });
  let sessionId: string | null = null;
  for await (const m of q) {
    if ('session_id' in m && typeof m.session_id === 'string') sessionId = m.session_id;
    if (m.type === 'assistant' && !m.parent_tool_use_id) {
      for (const block of m.message.content) {
        if (block.type !== 'tool_use') continue;
        const p = progressOf(block.name, (block.input ?? {}) as Record<string, unknown>, req.cwd);
        if (p) req.onProgress?.(p);
      }
    }
    if (m.type === 'result') {
      if (m.subtype !== 'success' || m.structured_output === undefined) {
        throw Object.assign(new Error(`Claude stopped before answering (${m.subtype}).`), { cost: m.total_cost_usd });
      }
      return { output: m.structured_output, sessionId, cost: m.total_cost_usd };
    }
  }
  throw new Error('Claude returned no result.');
};
