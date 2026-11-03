// Talking to the local codemap server. The token comes from the link codemap printed (`?t=…`) and goes on every call.
import type { Answer, CheckReport, CodeMap, MapMeta, Selection, ServerEvent } from './types';

function readToken(): string {
  const fromUrl = new URLSearchParams(location.search).get('t');
  try {
    if (fromUrl) sessionStorage.setItem('codemap-token', fromUrl);
    return fromUrl ?? sessionStorage.getItem('codemap-token') ?? '';
  } catch {
    return fromUrl ?? '';
  }
}

export const token = readToken();
export const pageUrl = (mapId?: string) => `/${mapId ? `m/${encodeURIComponent(mapId)}` : ''}?t=${encodeURIComponent(token)}`;

export class ApiError extends Error {
  constructor(message: string, readonly problems: string[] = []) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'x-codemap-token': token, 'content-type': 'application/json' },
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
  fixes?: Record<string, { status: 'proposed' | 'applied'; edgeId?: string | null; closed?: string[] }>;
};

export const api = {
  list: () => call<{ repo: string; maps: MapMeta[]; making: { id: string; question: string }[] }>('GET', '/api/maps'),
  get: (id: string) => call<MapPayload>('GET', `/api/maps/${encodeURIComponent(id)}`),
  make: (question: string) => call<{ id: string }>('POST', '/api/maps', { question }),
  ask: (id: string, question: string, selection: Selection) => call<{ ok: true }>('POST', `/api/maps/${encodeURIComponent(id)}/ask`, { question, selection }),
  approve: (id: string, fixId: string) =>
    call<{ edgeId: string | null; closed: string[]; files: string[] }>('POST', `/api/maps/${encodeURIComponent(id)}/fixes/${encodeURIComponent(fixId)}/approve`),
  reject: (id: string, fixId: string) => call<{ ok: true }>('POST', `/api/maps/${encodeURIComponent(id)}/fixes/${encodeURIComponent(fixId)}/reject`),
  undo: (id: string, fixId: string) => call<{ ok: true }>('POST', `/api/maps/${encodeURIComponent(id)}/fixes/${encodeURIComponent(fixId)}/undo`),
};

/** Live events from the server. Reconnects after a drop; returns a function that stops listening. */
export function connect(onEvent: (e: ServerEvent) => void, onStatus: (connected: boolean) => void): () => void {
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
    ws.onclose = () => {
      onStatus(false);
      if (!stopped) retry = setTimeout(open, 1000);
    };
  };
  open();
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}
