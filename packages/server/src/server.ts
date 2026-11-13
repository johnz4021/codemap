// The local illuminate server: stores maps, runs the map maker and the explainer, applies approved fixes, serves the viewer,
// and streams progress over a WebSocket. Binds to 127.0.0.1 only. Every API call needs the random token from the page
// URL, and requests whose Host or Origin isn't this server are refused (so other sites in the browser can't drive it).
// With `autoStop` it stops itself once no illuminate tab is open and Claude isn't working, so it doesn't linger.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { capturePaths, check, readCapture, repoImage, type CheckReport, type CodeMap } from '@illuminate/core';
import { sdkAgent, type Agent, type Progress } from './agent';
import { answer, type Answer, type Selection } from './explainer';
import { applyFix, connectAfterFix, undoFix, type AppliedFix, type FixProposal } from './fixes';
import { headCommit } from './git';
import { makeMap, type Status } from './maker';
import { createStore, type MapMeta, type SavedFix, type StoredMap } from './store';

export type JobKind = 'make' | 'ask';
export type JobState = { kind: JobKind; question: string; progress: string[] };
export type ServerEvent =
  | { type: 'job'; mapId: string; job: JobKind; status: 'started' | 'done' | 'failed'; question: string; error?: string }
  | { type: 'progress'; mapId: string; job: JobKind; kind: string; text: string }
  | { type: 'map'; mapId: string; meta: MapMeta; map: CodeMap; report: CheckReport }
  | { type: 'answer'; mapId: string; answer: Answer }
  /** An answer already sent changed: its offer of a new map was taken up or turned down. */
  | { type: 'answerUpdate'; mapId: string; answer: Answer }
  | { type: 'fix'; mapId: string; fixId: string; status: 'applied' | 'rejected' | 'undone' | 'failed'; problems?: string[]; edgeId?: string | null; closed?: string[] };

export type ServerOptions = {
  /** The repo to map. */
  root: string;
  /** 0 picks a free port. */
  port?: number;
  agent?: Agent;
  model?: string;
  token?: string;
  viewerDir?: string;
  /**
   * Stop on its own when nobody is looking: no illuminate tab open and no job running, for `afterLastTabMs` (default 30 s,
   * long enough for a reload) once a tab has connected, or `beforeFirstTabMs` (default 10 min) if none ever has.
   * Off unless set; the CLI turns it on.
   */
  autoStop?: { afterLastTabMs?: number; beforeFirstTabMs?: number };
  /** Called after the server stopped itself: `idle` (autoStop) or `requested` (the page's Stop button). */
  onStop?: (reason: 'idle' | 'requested') => void;
  /** Every event sent to the open tabs, also handed here (the Claude Code channel uses it to know when work is done). */
  onEvent?: (event: ServerEvent) => void;
};
export type IlluminateServer = {
  url: string;
  port: number;
  token: string;
  pageUrl(mapId?: string): string;
  startMap(question: string): string;
  close(): Promise<void>;
};

/** The built viewer: next to this file in the published package (`viewer/`), or the viewer workspace's `dist/` here. */
const DEFAULT_VIEWER = [new URL('../viewer/', import.meta.url), new URL('../../viewer/dist/', import.meta.url)]
  .map((u) => fileURLToPath(u))
  .find((dir) => fs.existsSync(path.join(dir, 'index.html'))) ?? fileURLToPath(new URL('../../viewer/dist/', import.meta.url));
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json',
};
const MAX_BODY = 1_000_000;
/** WebSocket close code that tells open tabs illuminate stopped on purpose, so they say so instead of reconnecting. */
export const STOPPED_CLOSE_CODE = 4000;

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export async function startServer(o: ServerOptions): Promise<IlluminateServer> {
  const root = fs.realpathSync(o.root);
  const agent = o.agent ?? sdkAgent;
  const token = o.token ?? crypto.randomBytes(18).toString('base64url');
  const viewerDir = o.viewerDir ?? DEFAULT_VIEWER;
  const store = createStore(root);
  const jobs = new Map<string, JobState>();
  const failures = new Map<string, { question: string; error: string }>();
  // Answers and where each fix stands are saved with the map. Only what Undo needs (the files as they were) stays in
  // memory, so after a restart an applied fix shows as applied, without Undo.
  const applied = new Map<string, { mapId: string; applied: AppliedFix; mapBefore: CodeMap }>();
  /** The proposal behind a fix that is still waiting for approval, or null. */
  const pending = (stored: StoredMap, fixId: string): FixProposal | null =>
    stored.fixes?.[fixId]?.status === 'proposed' ? (stored.answers ?? []).find((a) => a.fix?.id === fixId)?.fix ?? null : null;
  const withFix = (stored: StoredMap, fixId: string, state: SavedFix): Record<string, SavedFix> => ({ ...stored.fixes, [fixId]: state });
  /** Where each fix on a map stands (fixes not listed were rejected), so a reloaded page shows Approve or Undo. */
  type FixStatus = { status: 'proposed' | 'applied'; edgeId?: string | null; closed?: string[]; undoable?: boolean };
  const fixStates = (stored: StoredMap): Record<string, FixStatus> => {
    const out: Record<string, FixStatus> = {};
    for (const [id, f] of Object.entries(stored.fixes ?? {})) {
      if (f.status === 'proposed') out[id] = { status: 'proposed' };
      if (f.status === 'applied') out[id] = { status: 'applied', edgeId: f.edgeId ?? null, closed: f.closed ?? [], undoable: applied.get(id)?.mapId === stored.meta.id };
    }
    return out;
  };
  const clients = new Set<WebSocket>();
  let port = 0;

  // ---------------------------------------------------------------- stopping
  let closing: Promise<void> | null = null;
  let visited = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** (Re)start the countdown to stopping, if nothing is keeping the server busy. */
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (!o.autoStop || closing || clients.size || jobs.size) return;
    const ms = visited ? (o.autoStop.afterLastTabMs ?? 30_000) : (o.autoStop.beforeFirstTabMs ?? 600_000);
    idleTimer = setTimeout(() => {
      if (!clients.size && !jobs.size) void stopSelf('idle');
    }, ms);
  };
  const endJob = (mapId: string) => {
    jobs.delete(mapId);
    armIdle();
  };

  const broadcast = (event: ServerEvent) => {
    o.onEvent?.(event);
    const data = JSON.stringify(event);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
  };
  const progress = (mapId: string, job: JobKind) => (p: Progress | Status) => {
    jobs.get(mapId)?.progress.push(p.text);
    broadcast({ type: 'progress', mapId, job, kind: p.kind, text: p.text });
  };
  const publishMap = (stored: StoredMap) => {
    const report = check(stored.map, root);
    broadcast({ type: 'map', mapId: stored.meta.id, meta: stored.meta, map: stored.map, report });
    return report;
  };
  const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

  function startMap(question: string, parent: MapMeta['parent'] = null): string {
    const q = question.trim();
    if (!q) throw new HttpError(400, 'Ask a question to map.');
    const id = store.newId(q, new Set([...jobs.keys(), ...failures.keys()]));
    jobs.set(id, { kind: 'make', question: q, progress: [] });
    broadcast({ type: 'job', mapId: id, job: 'make', status: 'started', question: q });
    void (async () => {
      try {
        const r = await makeMap({ root, question: q, agent, model: o.model, onProgress: progress(id, 'make') });
        const now = new Date().toISOString();
        const stored: StoredMap = {
          meta: { id, question: q, createdAt: now, updatedAt: now, commit: headCommit(root), makerSession: r.sessionId, explainerSession: null, cost: r.cost, parent },
          map: r.map,
        };
        store.save(stored);
        endJob(id);
        publishMap(stored);
        broadcast({ type: 'job', mapId: id, job: 'make', status: 'done', question: q });
      } catch (err) {
        endJob(id);
        failures.set(id, { question: q, error: errorText(err) });
        broadcast({ type: 'job', mapId: id, job: 'make', status: 'failed', question: q, error: errorText(err) });
      }
    })();
    return id;
  }

  function startAsk(mapId: string, question: string, selection: Selection, opts: { wordsOnly?: boolean } = {}) {
    const stored = store.get(mapId);
    if (!stored) throw new HttpError(404, 'No such map.');
    if (jobs.has(mapId)) throw new HttpError(409, 'Claude is still working on this map. Try again when it finishes.');
    const q = question.trim();
    if (!q) throw new HttpError(400, 'Ask a question.');
    jobs.set(mapId, { kind: 'ask', question: q, progress: [] });
    broadcast({ type: 'job', mapId, job: 'ask', status: 'started', question: q });
    void (async () => {
      try {
        // The conversation so far (the last few turns), so a follow-up can lean on what was just said.
        const earlier = (stored.answers ?? [])
          .map((a) => ({ question: a.question, concept: a.concept || (a.offer ? `(A different part of the app: offered a map for "${a.offer.question}".)` : '') }))
          .filter((a) => a.concept)
          .slice(-6);
        const otherMaps = store.list().filter((m) => m.id !== mapId).slice(0, 30).map((m) => ({ id: m.id, question: m.question }));
        const r = await answer({
          root, map: stored.map, selection, question: q, agent, session: stored.meta.explainerSession, model: o.model,
          earlier, otherMaps, wordsOnly: opts.wordsOnly, onProgress: progress(mapId, 'ask'),
        });
        const latest = store.get(mapId) ?? stored;
        const next: StoredMap = {
          ...latest,
          meta: { ...latest.meta, explainerSession: r.sessionId, cost: latest.meta.cost + r.answer.cost, updatedAt: new Date().toISOString() },
          map: r.answer.added.length || r.answer.screens?.length ? r.map : latest.map,
          answers: [...(latest.answers ?? []), r.answer],
          fixes: r.answer.fix ? withFix(latest, r.answer.fix.id, { status: 'proposed' }) : latest.fixes,
        };
        store.save(next);
        endJob(mapId);
        if (r.answer.added.length || r.answer.screens?.length) publishMap(next);
        broadcast({ type: 'answer', mapId, answer: r.answer });
        broadcast({ type: 'job', mapId, job: 'ask', status: 'done', question: q });
      } catch (err) {
        endJob(mapId);
        broadcast({ type: 'job', mapId, job: 'ask', status: 'failed', question: q, error: errorText(err) });
      }
    })();
  }

  /**
   * Their answer to "this looks like a different part of the app": `map` starts a new map for the question (linked back
   * to this one), `words` answers it from the code without drawing anything here.
   */
  function takeOffer(mapId: string, answerId: string, choice: 'map' | 'words' | null): { id?: string; ok: true } {
    if (!choice) throw new HttpError(400, 'Choose a new map or an answer in words.');
    const stored = store.get(mapId);
    const a = stored?.answers?.find((x) => x.id === answerId);
    if (!stored || !a?.offer || a.offer.status !== 'pending') throw new HttpError(404, 'No such question waiting for a choice.');
    if (choice === 'words' && jobs.has(mapId)) throw new HttpError(409, 'Claude is still working on this map. Try again when it finishes.');
    const newId = choice === 'map' ? startMap(a.offer.question, { mapId, question: stored.map.question }) : null;
    const updated: Answer = { ...a, offer: { ...a.offer, status: choice === 'map' ? 'mapped' : 'answered', mapId: newId } };
    store.save({ ...stored, answers: (stored.answers ?? []).map((x) => (x.id === answerId ? updated : x)) });
    broadcast({ type: 'answerUpdate', mapId, answer: updated });
    if (choice === 'words') startAsk(mapId, a.question, {}, { wordsOnly: true });
    return newId ? { id: newId, ok: true } : { ok: true };
  }

  function approveFix(mapId: string, fixId: string) {
    const stored = store.get(mapId);
    const proposal = stored && pending(stored, fixId);
    if (!stored || !proposal) throw new HttpError(404, 'No such fix waiting for approval.');
    if (jobs.has(mapId)) throw new HttpError(409, 'Claude is still working on this map. Try again when it finishes.');
    const r = applyFix(root, proposal);
    if (!r.ok) {
      broadcast({ type: 'fix', mapId, fixId, status: 'failed', problems: r.problems });
      throw new HttpError(409, 'The fix could not be applied.', { problems: r.problems });
    }
    const c = connectAfterFix(root, stored.map, proposal);
    applied.set(fixId, { mapId, applied: r.applied, mapBefore: stored.map });
    const next: StoredMap = {
      ...stored,
      meta: { ...stored.meta, updatedAt: new Date().toISOString() },
      map: c.map,
      fixes: withFix(stored, fixId, { status: 'applied', edgeId: c.edgeId, closed: c.closed }),
    };
    store.save(next);
    const report = publishMap(next);
    broadcast({ type: 'fix', mapId, fixId, status: 'applied', edgeId: c.edgeId, closed: c.closed });
    return { edgeId: c.edgeId, closed: c.closed, files: r.applied.written.map((w) => w.file), summary: report.summary };
  }

  function undo(mapId: string, fixId: string) {
    const a = applied.get(fixId);
    if (!a || a.mapId !== mapId) throw new HttpError(404, 'No applied fix to undo.');
    const r = undoFix(root, a.applied);
    if (!r.ok) throw new HttpError(409, 'The fix could not be undone.', { problems: r.problems });
    applied.delete(fixId);
    const stored = store.get(mapId);
    if (stored) {
      const next: StoredMap = {
        ...stored,
        meta: { ...stored.meta, updatedAt: new Date().toISOString() },
        map: a.mapBefore,
        fixes: withFix(stored, fixId, { status: 'proposed' }),
      };
      store.save(next);
      publishMap(next);
    }
    broadcast({ type: 'fix', mapId, fixId, status: 'undone' });
  }

  // ---------------------------------------------------------------- HTTP

  const hosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const hostOk = (req: http.IncomingMessage) => hosts().has(req.headers.host ?? '');
  const originOk = (req: http.IncomingMessage) => !req.headers.origin || [...hosts()].some((h) => req.headers.origin === `http://${h}`);
  const tokenOk = (given: unknown) => typeof given === 'string' && given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: http.IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) reject(new HttpError(413, 'Request too large.'));
        else chunks.push(c);
      });
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {});
        } catch {
          reject(new HttpError(400, 'Request body must be JSON.'));
        }
      });
      req.on('error', reject);
    });
  const asSelection = (v: unknown): Selection => {
    const s = (v ?? {}) as Record<string, unknown>;
    const ids = (x: unknown) => (Array.isArray(x) ? x.filter((i): i is string => typeof i === 'string').slice(0, 30) : []);
    return { nodes: ids(s.nodes), edges: ids(s.edges), absences: ids(s.absences) };
  };

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // after "api"
    const m = req.method ?? 'GET';
    if (parts[0] === 'stop' && parts.length === 1 && m === 'POST') {
      if (jobs.size) throw new HttpError(409, 'Claude is still working on a map. Stop illuminate once it finishes, so the map gets saved.');
      res.on('finish', () => void stopSelf('requested'));
      return json(res, 200, { ok: true });
    }
    if (parts[0] === 'screens' && parts.length === 2 && m === 'GET') {
      const id = (parts[1] ?? '').replace(/\.png$/, '');
      const got = readCapture(root, id);
      if (!got.ok) throw new HttpError(404, 'No such capture.');
      return sendFile(res, capturePaths(root, id).image, 'image/png');
    }
    if (parts[0] === 'repo-image' && parts.length === 1 && m === 'GET') {
      const img = repoImage(root, url.searchParams.get('file') ?? '');
      if (!img.ok) throw new HttpError(404, 'No such image.');
      return sendFile(res, img.path, img.type);
    }
    if (parts[0] !== 'maps') throw new HttpError(404, 'Not found.');
    const mapId = parts[1];
    if (!mapId) {
      if (m === 'GET') {
        const active = [...jobs].filter(([, j]) => j.kind === 'make').map(([id, j]) => ({ id, question: j.question }));
        return json(res, 200, { repo: path.basename(root), maps: store.list(), making: active });
      }
      if (m === 'POST') {
        const body = await readBody(req);
        const from = typeof body.parent === 'string' && /^[a-z0-9-]{1,80}$/.test(body.parent) ? store.get(body.parent) : null;
        return json(res, 202, { id: startMap(String(body.question ?? ''), from ? { mapId: from.meta.id, question: from.map.question } : null) });
      }
    }
    if (mapId && !/^[a-z0-9-]{1,80}$/.test(mapId)) throw new HttpError(404, 'No such map.');
    if (mapId && parts.length === 2 && m === 'GET') {
      const stored = store.get(mapId);
      const job = jobs.get(mapId) ?? null;
      if (!stored) {
        if (job || failures.has(mapId)) return json(res, 200, { meta: null, map: null, report: null, job, failure: failures.get(mapId) ?? null, answers: [] });
        throw new HttpError(404, 'No such map.');
      }
      return json(res, 200, { ...stored, report: check(stored.map, root), job, failure: null, answers: stored.answers ?? [], fixes: fixStates(stored) });
    }
    if (mapId && parts[2] === 'answers' && parts[3] && parts[4] === 'offer' && m === 'POST') {
      const body = await readBody(req);
      return json(res, 200, takeOffer(mapId, parts[3], body.choice === 'map' ? 'map' : body.choice === 'words' ? 'words' : null));
    }
    if (mapId && parts[2] === 'ask' && m === 'POST') {
      const body = await readBody(req);
      startAsk(mapId, String(body.question ?? ''), asSelection(body.selection));
      return json(res, 202, { ok: true });
    }
    if (mapId && parts[2] === 'recheck' && m === 'POST') {
      const stored = store.get(mapId);
      if (!stored) throw new HttpError(404, 'No such map.');
      return json(res, 200, { report: publishMap(stored) });
    }
    if (mapId && parts[2] === 'fixes' && parts[3] && m === 'POST') {
      const fixId = parts[3];
      if (parts[4] === 'approve') return json(res, 200, approveFix(mapId, fixId));
      if (parts[4] === 'undo') { undo(mapId, fixId); return json(res, 200, { ok: true }); }
      if (parts[4] === 'reject') {
        const stored = store.get(mapId);
        if (!stored || !pending(stored, fixId)) throw new HttpError(404, 'No such fix waiting for approval.');
        store.save({ ...stored, fixes: withFix(stored, fixId, { status: 'rejected' }) });
        broadcast({ type: 'fix', mapId, fixId, status: 'rejected' });
        return json(res, 200, { ok: true });
      }
    }
    throw new HttpError(404, 'Not found.');
  }

  /** A picture from the repo. Never run as a page: no sniffing, and no scripts even if an SVG is opened directly. */
  function sendFile(res: http.ServerResponse, file: string, type: string) {
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
    fs.createReadStream(file).pipe(res);
  }

  function serveStatic(res: http.ServerResponse, pathname: string) {
    const index = path.join(viewerDir, 'index.html');
    if (!fs.existsSync(index)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><meta charset="utf-8"><title>illuminate</title><p style="font:16px system-ui;margin:40px">The viewer isn\'t built yet. Run <code>npm run build</code> in the illuminate repo, then reload.</p>');
    }
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.resolve(viewerDir, rel);
    const inside = file.startsWith(path.resolve(viewerDir) + path.sep);
    const target = inside && rel.startsWith('assets/') && fs.existsSync(file) && fs.statSync(file).isFile() ? file : index;
    res.writeHead(200, {
      'content-type': TYPES[path.extname(target)] ?? 'application/octet-stream',
      'cache-control': target === index ? 'no-store' : 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      ...(target === index ? { 'content-security-policy': "default-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'" } : {}),
    });
    fs.createReadStream(target).pipe(res);
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (!hostOk(req)) throw new HttpError(403, 'Wrong host.');
        if (url.pathname.startsWith('/api/')) {
          // Pictures are loaded by <img>, which can't send a header, so these two read-only routes also take the token in the URL.
          const picture = req.method === 'GET' && /^\/api\/(screens|repo-image)(\/|$)/.test(url.pathname) && tokenOk(url.searchParams.get('t'));
          if (!picture && !tokenOk(req.headers['x-illuminate-token'])) throw new HttpError(401, 'Missing or wrong token. Open illuminate from the link it printed.');
          if (req.method !== 'GET' && !originOk(req)) throw new HttpError(403, 'Wrong origin.');
          return await api(req, res, url);
        }
        if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
        return serveStatic(res, url.pathname);
      } catch (err) {
        if (err instanceof HttpError) return json(res, err.status, { error: err.message, ...err.extra });
        return json(res, 500, { error: errorText(err) });
      }
    })();
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws' || !hostOk(req) || !originOk(req) || !tokenOk(url.searchParams.get('t'))) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (closing) return ws.close(STOPPED_CLOSE_CODE, 'illuminate stopped');
      clients.add(ws);
      visited = true;
      armIdle();
      ws.on('close', () => {
        clients.delete(ws);
        armIdle();
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && o.port) {
        server.off('error', onError);
        server.listen(0, '127.0.0.1', () => resolve());
      } else reject(err);
    };
    server.on('error', onError);
    server.listen(o.port ?? 0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;

  /** Tell open tabs illuminate stopped (they show that instead of reconnecting), then shut down. Safe to call twice. */
  const close = () =>
    (closing ??= (async () => {
      if (idleTimer) clearTimeout(idleTimer);
      const goodbyes = [...clients].map((ws) => new Promise<void>((r) => {
        ws.once('close', () => r());
        ws.close(STOPPED_CLOSE_CODE, 'illuminate stopped');
      }));
      await Promise.race([Promise.all(goodbyes), new Promise((r) => setTimeout(r, 500))]);
      for (const ws of clients) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    })());
  async function stopSelf(reason: 'idle' | 'requested') {
    if (closing) return;
    await close();
    o.onStop?.(reason);
  }
  armIdle();

  return {
    url,
    port,
    token,
    pageUrl: (mapId?: string) => `${url}/${mapId ? `m/${mapId}` : ''}?t=${token}`,
    startMap,
    close,
  };
}
