// An `Agent` that is the person's own Claude Code session, reached through a channel. Each call becomes a request that
// waits until Claude Code submits output for it (or gives up). The maker, explainer and checker don't know the
// difference: they get output back exactly as from `sdkAgent`, and everything still goes through `check()`.
//
// A request reaches Claude Code one of two ways: handed to a tool call that is waiting for the next piece of work (so
// Claude carries straight on within one turn), or, when none is waiting, announced so the channel can push a message
// into the session.
//
// A request can go unheard: no `illuminate_listen` call is open (the session closed, or Claude stopped listening) and
// the session wasn't started with channels, so the announcement is dropped and nothing tells us. So a request no one has
// picked up says so on the map after `nudgeMs`, and gives up after `giveUpMs` rather than wait forever.
import type { Agent, AgentRequest, AgentResponse } from './agent';
import { validatorFor } from './schemas';

export type BridgeRequest = {
  id: string;
  label: string;
  prompt: string;
  schema: Record<string, unknown>;
  /** Tools the request may use; `[]` means answer from the request alone, without reading the code. */
  tools: readonly string[];
  /** It follows on from earlier work in the same conversation (a repair round, a follow-up question). */
  continues: boolean;
};

type Entry = BridgeRequest & { handed: boolean; claimed: () => void; timers: ReturnType<typeof setTimeout>[]; resolve: (r: AgentResponse) => void; reject: (e: Error) => void };
export type SubmitResult = { ok: true } | { ok: false; problems: string[] };

export type Bridge = {
  agent: Agent;
  /** The oldest request Claude hasn't been handed yet, or else the oldest still waiting for output. Marks it handed. */
  next(): BridgeRequest | null;
  /** The next request to hand over: now if one is waiting, else the next one made, or null when `signal` aborts. */
  waitForNext(signal: AbortSignal): Promise<BridgeRequest | null>;
  submit(id: string, output: unknown): SubmitResult;
  fail(id: string, reason: string): boolean;
  /** Requests still waiting for output. */
  outstanding(): BridgeRequest[];
};

export const CLAUDE_CODE_SESSION = 'claude-code';

export const NOT_PICKED_UP =
  'Claude Code isn\'t listening to the map right now. In your Claude Code session, say "listen to illuminate", and it will pick this up.';
export const NEVER_PICKED_UP =
  'Claude Code never picked this up, so nothing was answered. Its session may have closed. In Claude Code, say "listen to illuminate", then ask again.';

const view = (e: Entry): BridgeRequest => ({ id: e.id, label: e.label, prompt: e.prompt, schema: e.schema, tools: e.tools, continues: e.continues });

export function createBridge(o: {
  announce: (r: BridgeRequest) => void;
  /** After this long unclaimed, say so on the map (default 30 s). */
  nudgeMs?: number;
  /** After this long unclaimed, give up with an error (default 5 min). */
  giveUpMs?: number;
}): Bridge {
  const nudgeMs = o.nudgeMs ?? 30_000;
  const giveUpMs = o.giveUpMs ?? 5 * 60_000;
  const entries: Entry[] = [];
  const waiters: ((r: Entry) => void)[] = [];
  let n = 0;

  const agent: Agent = (req: AgentRequest) =>
    new Promise<AgentResponse>((resolve, reject) => {
      if (req.signal?.aborted) return reject(new Error('Stopped.'));
      const entry: Entry = {
        id: `r${++n}`,
        label: req.label ?? 'Work for illuminate',
        prompt: req.prompt,
        schema: req.schema,
        tools: req.tools ?? ['Read', 'Grep', 'Glob'],
        continues: !!req.resume,
        handed: false,
        claimed: () => req.onProgress?.({ kind: 'status', text: 'Claude Code is working on this in your terminal' }),
        timers: [],
        resolve: (r) => {
          settle(entry);
          resolve(r);
        },
        reject: (e) => {
          settle(entry);
          reject(e);
        },
      };
      entries.push(entry);
      req.signal?.addEventListener('abort', () => entry.reject(new Error('Stopped.')), { once: true });
      // The newest waiting call: one Claude has open right now (making a map, handing in) beats an older listener left
      // running in the background, which keeps waiting for the next request.
      const waiter = waiters.pop();
      if (waiter) {
        entry.handed = true;
        entry.claimed();
        waiter(entry);
        return;
      }
      req.onProgress?.({ kind: 'status', text: 'Waiting for Claude Code to pick this up' });
      const later = (ms: number, f: () => void) => {
        const t = setTimeout(() => {
          if (!entry.handed && entries.includes(entry)) f();
        }, ms);
        t.unref?.();
        entry.timers.push(t);
      };
      later(nudgeMs, () => req.onProgress?.({ kind: 'status', text: NOT_PICKED_UP }));
      later(giveUpMs, () => entry.reject(Object.assign(new Error(NEVER_PICKED_UP), { unheard: true })));
      o.announce(view(entry));
    });

  /** Off the list, timers stopped. Safe to call twice. */
  function settle(e: Entry) {
    const i = entries.indexOf(e);
    if (i >= 0) entries.splice(i, 1);
    for (const t of e.timers) clearTimeout(t);
    e.timers = [];
  }

  const take = (): Entry | null => {
    const e = entries.find((x) => !x.handed) ?? null;
    if (e) {
      e.handed = true;
      e.claimed();
    }
    return e;
  };

  return {
    agent,
    next() {
      const e = take() ?? entries[0] ?? null;
      return e ? view(e) : null;
    },
    waitForNext(signal) {
      const now = take();
      if (now) return Promise.resolve(view(now));
      if (signal.aborted) return Promise.resolve(null);
      return new Promise((resolve) => {
        const waiter = (e: Entry) => {
          signal.removeEventListener('abort', onAbort);
          resolve(view(e));
        };
        const onAbort = () => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          resolve(null);
        };
        waiters.push(waiter);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    },
    submit(id, output) {
      const e = entries.find((x) => x.id === id);
      if (!e) return { ok: false, problems: [`No request "${id}" is waiting. It may have been answered already, or stopped.`] };
      let value = output;
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value);
        } catch {
          return { ok: false, problems: ['`output` must be a JSON object matching the schema, not text.'] };
        }
      }
      const validator = validatorFor(e.schema);
      if (validator) {
        const parsed = validator.safeParse(value);
        if (!parsed.success) {
          return { ok: false, problems: parsed.error.issues.slice(0, 12).map((i) => `${i.path.join('.') || '(output)'}: ${i.message}`) };
        }
      } else if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, problems: ['`output` must be a JSON object matching the schema.'] };
      }
      // The raw value, not zod's output: callers parse it themselves, exactly as they do structured output.
      e.resolve({ output: value, sessionId: CLAUDE_CODE_SESSION, cost: null });
      return { ok: true };
    },
    fail(id, reason) {
      const e = entries.find((x) => x.id === id);
      if (!e) return false;
      e.reject(new Error(`Claude Code couldn't finish this: ${reason}`));
      return true;
    },
    outstanding: () => entries.map(view),
  };
}
