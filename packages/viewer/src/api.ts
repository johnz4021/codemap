// Talking to the local illuminate server. The token comes from the link illuminate printed (`?t=…`) and goes on every call.
import type { Answer, CheckReport, CodeMap, MapMeta, Selection, ServerEvent } from './types';

function readToken(): string {
  const fromUrl = new URLSearchParams(location.search).get('t');
  try {
    if (fromUrl) sessionStorage.setItem('illuminate-token', fromUrl);
    return fromUrl ?? sessionStorage.getItem('illuminate-token') ?? '';
  } catch {
    return fromUrl ?? '';
  }
}

export const token = readToken();
export const pageUrl = (mapId?: string) => `/${mapId ? `m/${encodeURIComponent(mapId)}` : ''}?t=${encodeURIComponent(token)}`;

/** Where a confirmed screen's picture is served. <img> can't send the token header, so it goes in the URL. */
export const screenUrl = (show: { kind: 'capture'; capture: string } | { kind: 'image'; file: string }) =>
  show.kind === 'capture'
    ? `/api/screens/${encodeURIComponent(show.capture)}.png?t=${encodeURIComponent(token)}`
    : `/api/repo-image?file=${encodeURIComponent(show.file)}&t=${encodeURIComponent(token)}`;

export class ApiError extends Error {
  constructor(message: string, readonly problems: string[] = []) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'x-illuminate-token': token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; problems?: string[] };
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, data.problems ?? []);
  return data as T;
}

export type JobInfo = { kind: 'make' | 'ask'; question: string; progress: string[] };
export type MapPayload = {
  meta: MapMeta | null;
  map: CodeMap | null;
  report: CheckReport | null;
  job: JobInfo | null;
  failure: { question: string; error: string } | null;
  answers: Answer[];
  /** Fixes that are waiting for approval or applied; any other fix was rejected. */
  fixes?: Record<string, { status: 'proposed' | 'applied'; edgeId?: string | null; closed?: string[]; undoable?: boolean }>;
};

export const api = {
  list: () => call<{ repo: string; maps: MapMeta[]; making: { id: string; question: string }[] }>('GET', '/api/maps'),
  get: (id: string) => call<MapPayload>('GET', `/api/maps/${encodeURIComponent(id)}`),
  /** `parent`: the map whose question this new map grew out of. */
  make: (question: string, parent?: string) => call<{ id: string }>('POST', '/api/maps', { question, parent }),
  /** Their choice for a question about a different part of the app: a new map, or an answer in words. */
  offer: (id: string, answerId: string, choice: 'map' | 'words') =>
    call<{ id?: string; ok: true }>('POST', `/api/maps/${encodeURIComponent(id)}/answers/${encodeURIComponent(answerId)}/offer`, { choice }),
  ask: (id: string, question: string, selection: Selection) => call<{ ok: true }>('POST', `/api/maps/${encodeURIComponent(id)}/ask`, { question, selection }),
  approve: (id: string, fixId: string) =>
    call<{ edgeId: string | null; closed: string[]; files: string[] }>('POST', `/api/maps/${encodeURIComponent(id)}/fixes/${encodeURIComponent(fixId)}/approve`),
  reject: (id: string, fixId: string) => call<{ ok: true }>('POST', `/api/maps/${encodeURIComponent(id)}/fixes/${encodeURIComponent(fixId)}/reject`),
  undo: (id: string, fixId: string) => call<{ ok: true }>('POST', `/api/maps/${encodeURIComponent(id)}/fixes/${encodeURIComponent(fixId)}/undo`),
  /** Stop the local illuminate server. Refused while Claude is working on a map. */
  stop: () => call<{ ok: true }>('POST', '/api/stop'),
};

/** The close code the server sends when it stops on purpose (STOPPED_CLOSE_CODE in the server). */
const STOPPED_CLOSE_CODE = 4000;

/**
 * Live events from the server. Reconnects after a drop, except when illuminate stopped on purpose (`onStopped`). An open
 * connection is also what tells the server a tab is still open. Returns a function that stops listening.
 */
export function connect(onEvent: (e: ServerEvent) => void, onStatus: (connected: boolean) => void, onStopped: () => void): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const open = () => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?t=${encodeURIComponent(token)}`);
    ws.onopen = () => onStatus(true);
    ws.onmessage = (m) => {
      try {
        onEvent(JSON.parse(String(m.data)) as ServerEvent);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = (e) => {
      onStatus(false);
      if (e.code === STOPPED_CLOSE_CODE) {
        stopped = true;
        onStopped();
      } else if (!stopped) retry = setTimeout(open, 1000);
    };
  };
  open();
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}
