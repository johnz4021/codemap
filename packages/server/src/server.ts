// The local codemap server: stores maps, runs the map maker and the explainer, applies approved fixes, serves the viewer,
// and streams progress over a WebSocket. Binds to 127.0.0.1 only. Every API call needs the random token from the page
// URL, and requests whose Host or Origin isn't this server are refused (so other sites in the browser can't drive it).
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { check, type CheckReport, type CodeMap } from '@codemap/core';
import { sdkAgent, type Agent, type Progress } from './agent';
import { answer, type Answer, type Selection } from './explainer';
import { applyFix, connectAfterFix, undoFix, type AppliedFix, type FixProposal } from './fixes';
import { headCommit } from './git';
import { makeMap, type Status } from './maker';
import { createStore, type MapMeta, type StoredMap } from './store';

export type JobKind = 'make' | 'ask';
export type JobState = { kind: JobKind; question: string; progress: string[] };
export type ServerEvent =
  | { type: 'job'; mapId: string; job: JobKind; status: 'started' | 'done' | 'failed'; question: string; error?: string }
  | { type: 'progress'; mapId: string; job: JobKind; kind: string; text: string }
  | { type: 'map'; mapId: string; meta: MapMeta; map: CodeMap; report: CheckReport }
  | { type: 'answer'; mapId: string; answer: Answer }
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
};
export type CodemapServer = {
  url: string;
  port: number;
  token: string;
  pageUrl(mapId?: string): string;
  startMap(question: string): string;
  close(): Promise<void>;
};

const DEFAULT_VIEWER = fileURLToPath(new URL('../../viewer/dist/', import.meta.url));
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json',
};
const MAX_BODY = 1_000_000;

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export async function startServer(o: ServerOptions): Promise<CodemapServer> {
  const root = fs.realpathSync(o.root);
  const agent = o.agent ?? sdkAgent;
  const token = o.token ?? crypto.randomBytes(18).toString('base64url');
  const viewerDir = o.viewerDir ?? DEFAULT_VIEWER;
  const store = createStore(root);
  const jobs = new Map<string, JobState>();
  const failures = new Map<string, { question: string; error: string }>();
  const answers = new Map<string, Answer[]>();
  const proposals = new Map<string, { mapId: string; proposal: FixProposal }>();
  const applied = new Map<string, { mapId: string; applied: AppliedFix; mapBefore: CodeMap; edgeId: string | null; closed: string[] }>();
  /** Where each fix on a map stands (fixes not listed were rejected), so a reloaded page shows Approve or Undo. */
  const fixStates = (mapId: string): Record<string, { status: 'proposed' | 'applied'; edgeId?: string | null; closed?: string[] }> => ({
    ...Object.fromEntries([...proposals].filter(([, p]) => p.mapId === mapId).map(([id]) => [id, { status: 'proposed' as const }])),
    ...Object.fromEntries([...applied].filter(([, a]) => a.mapId === mapId).map(([id, a]) => [id, { status: 'applied' as const, edgeId: a.edgeId, closed: a.closed }])),
  });
  const clients = new Set<WebSocket>();
  let port = 0;

  const broadcast = (event: ServerEvent) => {
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

  function startMap(question: string): string {
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
          meta: { id, question: q, createdAt: now, updatedAt: now, commit: headCommit(root), makerSession: r.sessionId, explainerSession: null, cost: r.cost },
          map: r.map,
        };
        store.save(stored);
        jobs.delete(id);
        publishMap(stored);
        broadcast({ type: 'job', mapId: id, job: 'make', status: 'done', question: q });
      } catch (err) {
        jobs.delete(id);
        failures.set(id, { question: q, error: errorText(err) });
        broadcast({ type: 'job', mapId: id, job: 'make', status: 'failed', question: q, error: errorText(err) });
      }
    })();
    return id;
  }

  function startAsk(mapId: string, question: string, selection: Selection) {
    const stored = store.get(mapId);
    if (!stored) throw new HttpError(404, 'No such map.');
    if (jobs.has(mapId)) throw new HttpError(409, 'Claude is still working on this map. Try again when it finishes.');
    const q = question.trim();
    if (!q) throw new HttpError(400, 'Ask a question.');
    jobs.set(mapId, { kind: 'ask', question: q, progress: [] });
    broadcast({ type: 'job', mapId, job: 'ask', status: 'started', question: q });
    void (async () => {
      try {
        const r = await answer({ root, map: stored.map, selection, question: q, agent, session: stored.meta.explainerSession, model: o.model, onProgress: progress(mapId, 'ask') });
        if (r.answer.fix) proposals.set(r.answer.fix.id, { mapId, proposal: r.answer.fix });
        const latest = store.get(mapId) ?? stored;
        const next: StoredMap = {
          meta: { ...latest.meta, explainerSession: r.sessionId, cost: latest.meta.cost + r.answer.cost, updatedAt: new Date().toISOString() },
          map: r.answer.added.length ? r.map : latest.map,
        };
        store.save(next);
        (answers.get(mapId) ?? answers.set(mapId, []).get(mapId)!).push(r.answer);
        jobs.delete(mapId);
        if (r.answer.added.length) publishMap(next);
        broadcast({ type: 'answer', mapId, answer: r.answer });
        broadcast({ type: 'job', mapId, job: 'ask', status: 'done', question: q });
      } catch (err) {
        jobs.delete(mapId);
        broadcast({ type: 'job', mapId, job: 'ask', status: 'failed', question: q, error: errorText(err) });
      }
    })();
  }

  function approveFix(mapId: string, fixId: string) {
    const p = proposals.get(fixId);
    if (!p || p.mapId !== mapId) throw new HttpError(404, 'No such fix waiting for approval.');
    if (jobs.has(mapId)) throw new HttpError(409, 'Claude is still working on this map. Try again when it finishes.');
    const stored = store.get(mapId);
    if (!stored) throw new HttpError(404, 'No such map.');
    const r = applyFix(root, p.proposal);
    if (!r.ok) {
      broadcast({ type: 'fix', mapId, fixId, status: 'failed', problems: r.problems });
      throw new HttpError(409, 'The fix could not be applied.', { problems: r.problems });
    }
    proposals.delete(fixId);
    const c = connectAfterFix(root, stored.map, p.proposal);
    applied.set(fixId, { mapId, applied: r.applied, mapBefore: stored.map, edgeId: c.edgeId, closed: c.closed });
    const next: StoredMap = { meta: { ...stored.meta, updatedAt: new Date().toISOString() }, map: c.map };
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
    proposals.set(fixId, { mapId, proposal: a.applied.proposal });
    const stored = store.get(mapId);
    if (stored) {
      const next: StoredMap = { meta: { ...stored.meta, updatedAt: new Date().toISOString() }, map: a.mapBefore };
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
    if (parts[0] !== 'maps') throw new HttpError(404, 'Not found.');
    const mapId = parts[1];
    if (!mapId) {
      if (m === 'GET') {
        const active = [...jobs].filter(([, j]) => j.kind === 'make').map(([id, j]) => ({ id, question: j.question }));
        return json(res, 200, { repo: path.basename(root), maps: store.list(), making: active });
      }
      if (m === 'POST') {
        const body = await readBody(req);
        return json(res, 202, { id: startMap(String(body.question ?? '')) });
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
      return json(res, 200, { ...stored, report: check(stored.map, root), job, failure: null, answers: answers.get(mapId) ?? [], fixes: fixStates(mapId) });
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
        if (proposals.get(fixId)?.mapId !== mapId) throw new HttpError(404, 'No such fix waiting for approval.');
        proposals.delete(fixId);
        broadcast({ type: 'fix', mapId, fixId, status: 'rejected' });
        return json(res, 200, { ok: true });
      }
    }
    throw new HttpError(404, 'Not found.');
  }

  function serveStatic(res: http.ServerResponse, pathname: string) {
    const index = path.join(viewerDir, 'index.html');
    if (!fs.existsSync(index)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><meta charset="utf-8"><title>codemap</title><p style="font:16px system-ui;margin:40px">The viewer isn\'t built yet. Run <code>npm run build</code> in the codemap repo, then reload.</p>');
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
          if (!tokenOk(req.headers['x-codemap-token'])) throw new HttpError(401, 'Missing or wrong token. Open codemap from the link it printed.');
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
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
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

  return {
    url,
    port,
    token,
    pageUrl: (mapId?: string) => `${url}/${mapId ? `m/${mapId}` : ''}?t=${token}`,
    startMap,
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of clients) ws.terminate();
        wss.close();
        server.close(() => resolve());
      }),
  };
}
