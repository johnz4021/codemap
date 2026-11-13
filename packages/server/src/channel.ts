// illuminate as a Claude Code channel: an MCP server Claude Code starts over stdio, so the person's own Claude Code
// session does the reading and writing (on their own sign-in) instead of a separate Agent SDK session with its own key.
//
// The local illuminate server runs inside this process with a bridge `Agent` (bridge.ts). Work reaches Claude in tool
// results, so no channel flag is needed:
// - `illuminate_map` and `illuminate_submit` wait for the next request, so making a map (draft, check, repair) runs
//   within one turn;
// - between turns Claude keeps one `illuminate_listen` call open. Claude Code moves a call that runs past two minutes
//   to the background and gives the person their terminal back; when they ask on the map, the call returns with the
//   request and Claude Code wakes the session with it. Claude Code drops a call that has been quiet for 30 minutes,
//   even one sending progress notifications (seen in a live session: dropped after 1841 s), so a listening call
//   returns on its own before then and Claude starts another; after about two hours with no questions it stops.
// A session started with `--dangerously-load-development-channels server:illuminate` also gets a channel message when
// work arrives and nothing is listening (then Claude calls `illuminate_next`).
// Only the person's browser can start work, and the page needs illuminate's token.
// Channels: https://code.claude.com/docs/en/channels-reference · long-running MCP calls: https://code.claude.com/docs/en/mcp
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import { createBridge, type Bridge, type BridgeRequest } from './bridge';
import { openBrowser } from './browser';
import { capture, listScreens, type Shooter } from './screens';
import { startServer, type IlluminateServer, type ServerEvent } from './server';
import { createStore } from './store';

export type ChannelOptions = {
  /** The repo maps are about unless a tool call names another (Claude Code passes CLAUDE_PROJECT_DIR). */
  root: string;
  /** How a link is opened in the browser (tests pass a no-op). */
  open?: (url: string) => void;
  /** How long `illuminate_map` and `illuminate_submit` wait for what comes next before handing the turn back (default 90 s). */
  waitMs?: number;
  /** How a page is screenshotted (tests pass a stand-in for the browser). */
  shoot?: Shooter;
  /** How often a waiting call sends progress (default 30 s). */
  heartbeatMs?: number;
  /** How long one `illuminate_listen` call waits before returning so Claude can start another (default 25 min). */
  listenMs?: number;
  /** How many quiet listening calls in a row before illuminate stops listening (default 5, about two hours). */
  quietListens?: number;
  /** How long after the last illuminate tab closes the page's server stops (default 5 s, enough for a reload). */
  afterLastTabMs?: number;
  /** Port for the local server (default 4317, or the next free one). */
  port?: number;
};

export const CHANNEL_INSTRUCTIONS = [
  'illuminate draws checked, interactive maps of how this codebase works, in the person\'s browser. You do the reading and writing; illuminate checks every claim against the code before it shows anything.',
  '- When the person asks how something works across files ("what happens when…", "how does X reach Y", "what did this change do") or asks for a map, diagram or walkthrough, call illuminate_map with their question in their own words.',
  '- illuminate gives you work as requests in tool results. Each request says what to do and the JSON to return. Explore the code with Read, Grep and Glob, then call illuminate_submit with the request_id and your output. If the result holds another request, do that one too. If you can\'t finish one, call illuminate_fail.',
  '- Once a map is ready or an answer is shown, call illuminate_listen and leave it running. It moves to the background, so the person keeps their terminal. When they ask something on the map it returns with a request: do it, submit it, then call illuminate_listen again. If it returns saying nothing was asked yet, call it again without telling the person. Only one is needed at a time.',
  '- A picture of the screen can ground a map for people who don\'t read code. Use your judgement: when a flow starts from something the person sees (a button, a form, a page) a screen on that box helps; for backend-only questions leave screens out. illuminate_screens lists what this repo can show; illuminate_capture screenshots a page already running on this machine, or an HTML file in the repo, and shows you the result. Look at it before using it: if it shows a login page, an error or the wrong state, don\'t use it. Never start the app yourself to get a screenshot.',
  '- If an illuminate channel message arrives instead, call illuminate_next to get the request.',
  '- While working on an illuminate request, don\'t edit files or run commands that change anything, and never read secret files (.env, keys). A fix is only proposed; illuminate applies it after the person approves it on the map.',
  '- Answers are shown on the map. In the terminal, say at most a sentence or two.',
].join('\n');

const TOOLS = [
  {
    name: 'illuminate_map',
    description: 'Make a checked map that answers a question about how this codebase works, and open it in the person\'s browser. Returns the first piece of work for you to do.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The person\'s question, in their own words.' },
        repo: { type: 'string', description: 'The repo root, if not the project Claude Code was started in.' },
      },
      required: ['question'],
    },
  },
  {
    name: 'illuminate_next',
    description: 'Get the next piece of work illuminate has for you (after an illuminate channel message).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'illuminate_submit',
    description: 'Hand in your output for an illuminate request. It is checked; if it can\'t be read you get the problems back to fix. Returns the next piece of work, if there is one.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        output: { type: 'object', description: 'JSON matching the request\'s schema.' },
      },
      required: ['request_id', 'output'],
    },
  },
  {
    name: 'illuminate_fail',
    description: 'Give up on an illuminate request, saying why in plain words. The person sees it on the map.',
    inputSchema: {
      type: 'object',
      properties: { request_id: { type: 'string' }, reason: { type: 'string' } },
      required: ['request_id', 'reason'],
    },
  },
  {
    name: 'illuminate_listen',
    description: 'Wait for the next question the person asks on the map (or a new map they start there). Keep one running whenever you have no illuminate work: it moves to the background, and returns with a request when they ask. Do the request, submit it, then call this again.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'illuminate_screens',
    description: 'List what this repo can show of its screens: local pages being served right now, HTML files, preview setups and image files. Costs nothing; call it when a picture of the screen might help a map or an answer.',
    inputSchema: { type: 'object', properties: { repo: { type: 'string' } } },
  },
  {
    name: 'illuminate_capture',
    description: 'Screenshot one page so it can be a box\'s `screen` on a map: a `url` served on this machine (http://localhost:…), or an HTML `file` in the repo. Returns the image for you to look at, the labelled things visible on it, and the capture id to put in the box\'s `screen`. Runs in a clean browser profile, so pages behind a login show their login page.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'A page on this machine, e.g. http://localhost:3000/patients' },
        file: { type: 'string', description: 'Or: a repo-relative .html file' },
        repo: { type: 'string' },
      },
    },
  },
  {
    name: 'illuminate_open',
    description: 'Open saved maps in the person\'s browser: one map, or the list of all of them. Returns the maps saved in the repo.',
    inputSchema: {
      type: 'object',
      properties: {
        map_id: { type: 'string', description: 'A saved map\'s id; leave out for the list.' },
        repo: { type: 'string' },
      },
    },
  },
] as const;

/** A request as Claude reads it: what it's for, how to answer, the prompt, and the output schema. */
export function requestText(r: BridgeRequest): string {
  return [
    `## illuminate request ${r.id}: ${r.label}`,
    '',
    `When you're done, call illuminate_submit with request_id "${r.id}" and \`output\`: a JSON object matching the schema at the end. Don't edit any files.`,
    r.tools.length ? '' : 'Answer from what is in this request alone. Don\'t read the code for this one.',
    r.continues ? 'This follows on from your earlier work for illuminate in this conversation.' : '',
    '',
    '---',
    r.prompt,
    '---',
    '',
    '## Output schema (JSON Schema)',
    JSON.stringify(r.schema),
  ].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n');
}

type Extra = { signal: AbortSignal; _meta?: { progressToken?: string | number }; sendNotification: (n: ServerNotification) => Promise<void> };
type Text = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean };
const text = (t: string, isError = false): Text => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

const CLOSED = 'The person closed illuminate, so there is nothing to listen to. Don\'t call illuminate_listen again unless they ask for a map or ask you to listen. Say nothing to the person about this.';

export function createChannel(o: ChannelOptions) {
  const open = o.open ?? openBrowser;
  const waitMs = o.waitMs ?? 90_000;
  const heartbeatMs = o.heartbeatMs ?? 30_000;
  const listenMs = o.listenMs ?? 25 * 60_000;
  const quietListens = o.quietListens ?? 5;
  /** Listening calls in a row that ended with no question. Any other illuminate call starts the count again. */
  let quiet = 0;
  const servers = new Map<string, Promise<IlluminateServer>>();
  /** Listening calls to end when the person closes illuminate (Stop, or the last tab). */
  const closedListeners = new Set<() => void>();
  /** Listeners for "something finished", so a waiting tool call can say so. */
  const finished = new Set<(message: string) => void>();
  const lastReport = new Map<string, { confirmed: number; claims: number; hidden: string[] }>();

  const mcp = new Server(
    { name: 'illuminate', version: '0.1.0' },
    { capabilities: { experimental: { 'claude/channel': {} }, tools: {} }, instructions: CHANNEL_INSTRUCTIONS },
  );

  const bridge: Bridge = createBridge({
    announce: (r) => {
      void mcp
        .notification({
          method: 'notifications/claude/channel',
          params: { content: `illuminate has work for you: ${r.label}. Call illuminate_next to get it.`, meta: { request_id: r.id } },
        } as unknown as ServerNotification)
        .catch(() => {});
    },
  });

  const rootOf = (repo: unknown): string => {
    const dir = path.resolve(o.root, typeof repo === 'string' && repo.trim() ? repo : '.');
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`No such folder: ${dir}`);
    return fs.realpathSync(dir);
  };

  const serverFor = (root: string): Promise<IlluminateServer> => {
    let s = servers.get(root);
    if (!s) {
      s = startServer({
        root,
        port: o.port ?? 4317,
        agent: bridge.agent,
        // Stop, or closing the last tab, stops the page's server and ends listening. The MCP server itself stays
        // connected, so the next illuminate tool call starts a new page server.
        autoStop: { afterLastTabMs: o.afterLastTabMs ?? 5_000 },
        onStop: () => {
          servers.delete(root);
          if (!servers.size) for (const l of [...closedListeners]) l();
        },
        onEvent: (e) => void onEvent(root, e),
      });
      s.catch(() => servers.delete(root));
      servers.set(root, s);
    }
    return s;
  };

  async function onEvent(root: string, e: ServerEvent) {
    if (e.type === 'map') lastReport.set(e.mapId, {
      confirmed: e.report.summary.confirmed,
      claims: e.report.summary.claims,
      hidden: Object.entries(e.report.screens ?? {}).filter(([, c]) => c.status !== 'confirmed').map(([id, c]) => `${id} (${c.reasons.join('; ')})`),
    });
    if (e.type !== 'job' || e.status === 'started') return;
    let message: string;
    if (e.status === 'failed') message = `illuminate couldn't finish "${e.question}": ${e.error ?? 'unknown error'}\nThen call illuminate_listen so questions they ask on the map reach you.`;
    else if (e.job === 'make') {
      const s = await servers.get(root);
      const r = lastReport.get(e.mapId);
      message = [
        `The map for "${e.question}" is ready${r ? `: ${r.confirmed} of ${r.claims} claims confirmed against the code` : ''}.`,
        r?.hidden.length ? `Screens left out because they didn't check out: ${r.hidden.join(', ')}.` : '',
        s ? `It's open in the browser: ${s.pageUrl(e.mapId)}` : '',
        'Tell the person in a sentence; the map does the explaining. They can take the walkthrough, or select any box and ask about it there.',
        'Then call illuminate_listen so questions they ask on the map reach you.',
      ].filter(Boolean).join('\n');
    } else message = `The answer to "${e.question}" is shown on the map. Call illuminate_listen again for their next question.`;
    for (const f of [...finished]) f(message);
  }

  /**
   * Progress notifications while a call waits. Claude Code's docs say they count as activity, but a backgrounded call
   * was still dropped after 30 quiet minutes, so `illuminate_listen` also returns on its own (see the top of the file). Only possible when
   * the call came with a progress token. Returns the function that stops them.
   */
  function keepAlive(extra: Extra): () => void {
    const token = extra._meta?.progressToken;
    if (token === undefined) return () => {};
    let progress = 0;
    const beat = setInterval(() => {
      void extra
        .sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++progress, message: 'Waiting for the map' } })
        .catch(() => {});
    }, heartbeatMs);
    beat.unref?.();
    return () => clearInterval(beat);
  }

  /** After handing something in: the next request, or what finished, or (after a while) that nothing is needed yet. */
  async function whatNext(extra: Extra): Promise<Text> {
    const ac = new AbortController();
    const stop = keepAlive(extra);
    const onAbort = () => ac.abort();
    extra.signal.addEventListener('abort', onAbort, { once: true });
    let onFinish: ((m: string) => void) | null = null;
    const done = new Promise<string>((resolve) => {
      onFinish = resolve;
      finished.add(resolve);
    });
    const timer = new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs).unref?.());
    try {
      const winner = await Promise.race([
        bridge.waitForNext(ac.signal).then((r) => (r ? { request: r } : null)),
        done.then((message) => ({ message })),
        timer,
      ]);
      if (winner && 'request' in winner) return text(requestText(winner.request));
      if (winner && 'message' in winner) return text(winner.message);
      return text('illuminate is still working on its side. Call illuminate_listen: it returns when there is something for you.');
    } finally {
      stop();
      extra.signal.removeEventListener('abort', onAbort);
      ac.abort();
      if (onFinish) finished.delete(onFinish);
    }
  }

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map((t) => ({ ...t })) as never }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<Text> => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (req.params.name !== 'illuminate_listen') quiet = 0;
    try {
      switch (req.params.name) {
        case 'illuminate_map': {
          const question = String(args.question ?? '').trim();
          if (!question) return text('Pass the person\'s question.', true);
          const server = await serverFor(rootOf(args.repo));
          const id = server.startMap(question);
          // The job runs asynchronously, so listening now misses neither the first request nor an early failure.
          const next = whatNext(extra);
          const url = server.pageUrl(id);
          open(url);
          const first = await next;
          return { ...first, content: [{ type: 'text', text: `The map is opening in the browser: ${url}\nTell the person, and give them the link in case the tab didn't appear.\n` }, ...first.content] };
        }
        case 'illuminate_listen': {
          if (!servers.size) return text(CLOSED);
          const stop = keepAlive(extra);
          let closed = false;
          const onClosed = () => {
            closed = true;
            ac.abort();
          };
          const ac = new AbortController();
          const onAbort = () => ac.abort();
          extra.signal.addEventListener('abort', onAbort, { once: true });
          const timer = setTimeout(() => ac.abort(), listenMs);
          closedListeners.add(onClosed);
          try {
            const r = await bridge.waitForNext(ac.signal);
            if (r) {
              quiet = 0;
              return text(`${requestText(r)}\n\nAfter illuminate_submit, call illuminate_listen again so questions on the map keep reaching you.`);
            }
            if (closed) return text(CLOSED);
            if (extra.signal.aborted) return text('Stopped listening. Questions asked on the map wait until you call illuminate_listen again.');
            quiet++;
            if (quiet >= quietListens) {
              // Claude is told not to listen again on its own; if the person asks it to, that call starts afresh.
              quiet = 0;
              return text('Nobody has asked on the map for about two hours, so illuminate stopped listening. Don\'t call illuminate_listen again unless the person asks you to listen, or asks for a map. Say nothing to the person about this.');
            }
            return text('Nothing was asked on the map yet. Call illuminate_listen again to keep listening, and say nothing to the person about it.');
          } finally {
            closedListeners.delete(onClosed);
            clearTimeout(timer);
            extra.signal.removeEventListener('abort', onAbort);
            stop();
          }
        }
        case 'illuminate_next': {
          const r = bridge.next();
          return text(r ? requestText(r) : 'Nothing is waiting right now.');
        }
        case 'illuminate_submit': {
          const id = String(args.request_id ?? '');
          // What follows (a repair round, the check's result) only happens once this handler yields to the event loop,
          // so listening right after submitting misses nothing.
          const r = bridge.submit(id, args.output);
          if (r.ok) return await whatNext(extra);
          return text(`That output for ${id} can't be used yet. Fix these and call illuminate_submit again:\n${r.problems.map((p) => `- ${p}`).join('\n')}`, true);
        }
        case 'illuminate_fail': {
          const ok = bridge.fail(String(args.request_id ?? ''), String(args.reason ?? 'no reason given'));
          return text(ok ? 'Told the person on the map.' : 'No such request is waiting.');
        }
        case 'illuminate_screens': {
          const root = rootOf(args.repo);
          const port = (await servers.get(root))?.port;
          return text(await listScreens(root, { skipPorts: port ? [port] : [] }));
        }
        case 'illuminate_capture': {
          const root = rootOf(args.repo);
          const target = typeof args.url === 'string' && args.url ? { url: args.url } : typeof args.file === 'string' && args.file ? { file: args.file } : null;
          if (!target) return text('Pass `url` (a page on this machine) or `file` (an .html file in the repo).', true);
          const stop = keepAlive(extra);
          try {
            const r = await capture(root, target, o.shoot);
            if (!r.ok) return text(r.reason, true);
            const c = r.result.capture;
            const labels = [...new Set(c.elements.map((e) => `${e.tag} "${e.text}"`))].slice(0, 40);
            return {
              content: [
                {
                  type: 'text',
                  text: [
                    `Captured as ${c.id}${c.title ? ` ("${c.title}")` : ''}. Look at the image below before using it.`,
                    `To show it on a box: "screen": { "kind": "capture", "capture": "${c.id}", "highlight": "<label of the thing this box is about>" }. A highlight must be one of the labels below and also appear in the code the box cites; leave it out if nothing fits.`,
                    '',
                    labels.length ? `Labelled things visible:\n${labels.map((l) => `  - ${l}`).join('\n')}` : 'Nothing labelled is visible on it.',
                    '',
                    `Text on the page: ${r.result.text || '(none)'}`,
                  ].join('\n'),
                },
                { type: 'image', data: r.result.png.toString('base64'), mimeType: 'image/png' },
              ],
            };
          } finally {
            stop();
          }
        }
        case 'illuminate_open': {
          const root = rootOf(args.repo);
          const server = await serverFor(root);
          const mapId = typeof args.map_id === 'string' && args.map_id ? args.map_id : undefined;
          const url = server.pageUrl(mapId);
          open(url);
          const maps = createStore(root).list();
          return text([`Opened ${url}`, 'Call illuminate_listen so questions asked on the map reach you.', '', maps.length ? 'Saved maps:' : 'No maps saved in this repo yet.', ...maps.map((m) => `${m.id}  ${m.question}`)].join('\n'));
        }
        default:
          return text(`Unknown tool: ${req.params.name}`, true);
      }
    } catch (err) {
      return text(err instanceof Error ? err.message : String(err), true);
    }
  });

  return {
    mcp,
    bridge,
    async close() {
      for (const s of servers.values()) await s.then((x) => x.close()).catch(() => {});
      servers.clear();
      await mcp.close();
    },
  };
}

/** `illume channel`: serve the channel over stdio until Claude Code closes it. stdout belongs to MCP, so logs go to stderr. */
export async function runChannel(o: Omit<ChannelOptions, 'root'> & { root?: string }) {
  console.log = console.error;
  console.info = console.error;
  const channel = createChannel({ ...o, root: o.root ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd() });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void channel.close().finally(() => process.exit(0));
  };
  channel.mcp.onclose = stop;
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await channel.mcp.connect(new StdioServerTransport());
}
