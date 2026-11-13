// The local server end to end over HTTP and WebSocket, with a scripted Claude: make a map, ask, approve a fix, undo.
import * as http from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type IlluminateServer, type ServerEvent } from '../src/server';
import { CARE_MAP, LISTENER_FIX, cleanup, copyCareApp, scriptedAgent, waitFor } from './helpers';

let server: IlluminateServer;
let root: string;
const events: ServerEvent[] = [];
let ws: WebSocket;

const agent = scriptedAgent([
  () => CARE_MAP,
  // First question: the map-only try says it needs the code, then Claude answers with it.
  () => ({ route: 'code', missing: 'Who listens for the announcement.' }),
  () => ({ concept: 'Nothing listens for the announcement, so the rules never run from here.', refs: ['miss'], moves: { focus: 's4', highlight: ['s4', 'miss'] } }),
  // Second: a change request always needs the code.
  () => ({ route: 'code', missing: 'The change itself.' }),
  () => ({ concept: 'Add a listener.', refs: ['miss'], fix: LISTENER_FIX }),
]);

const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { 'x-illuminate-token': server.token, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

beforeAll(async () => {
  root = copyCareApp();
  server = await startServer({ root, port: 0, agent, viewerDir: join(root, 'no-viewer') });
  ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?t=${server.token}`);
  ws.on('message', (d) => events.push(JSON.parse(String(d))));
  await new Promise((r) => ws.once('open', r));
});
afterAll(async () => {
  ws.close();
  await server.close();
  cleanup();
});

describe('the illuminate server', () => {
  let mapId = '';

  it('makes a map from a question and streams progress', async () => {
    const r = await api('POST', '/api/maps', { question: 'What happens when a patient converts?' });
    expect(r).toEqual({ status: 202, body: { id: 'patient-converts' } });
    mapId = r.body.id;
    await waitFor(() => events.find((e) => e.type === 'job' && e.job === 'make' && e.status === 'done'));
    expect(events.filter((e) => e.type === 'progress').map((e) => (e as { text: string }).text)).toEqual(
      expect.arrayContaining(['Scanning the code for ways in, routes and tables', 'Reading src/patients/service.ts', '15 of 15 claims confirmed']),
    );
    const got = await api('GET', `/api/maps/${mapId}`);
    expect(got.body.report.summary).toEqual({ claims: 15, confirmed: 15, unconfirmed: 0 });
    expect(existsSync(join(root, '.illuminate/maps/patient-converts.json'))).toBe(true);
    expect((await api('GET', '/api/maps')).body.maps.map((m: any) => m.id)).toEqual(['patient-converts']);
  });

  it('answers a question about a selection', async () => {
    expect((await api('POST', `/api/maps/${mapId}/ask`, { question: 'What does this do?', selection: { nodes: ['s4'] } })).status).toBe(202);
    const a = await waitFor(() => events.find((e) => e.type === 'answer'));
    expect(a).toMatchObject({ mapId, answer: { refs: [{ id: 'miss', status: 'confirmed' }], moves: { focus: 's4' } } });
    expect(agent.calls[2]!.resume).toBeNull(); // the first question that needs the code starts the explainer session…
  });

  it('proposes a fix, applies it only on approval, re-checks the map, and undoes it', async () => {
    await api('POST', `/api/maps/${mapId}/ask`, { question: 'Make the email go out right away', selection: { absences: ['miss'] } });
    const a = await waitFor(() => events.filter((e) => e.type === 'answer')[1] as Extract<ServerEvent, { type: 'answer' }> | undefined);
    expect(agent.calls[4]!.resume).toBe('session-3'); // …and later ones continue it
    const fixId = a.answer.fix!.id;
    expect(existsSync(join(root, 'src/automations/listeners.ts'))).toBe(false);

    const ok = await api('POST', `/api/maps/${mapId}/fixes/${fixId}/approve`);
    expect(ok.body).toMatchObject({ edgeId: 'fx1', closed: ['miss'], files: ['src/automations/listeners.ts'], summary: { unconfirmed: 0 } });
    expect(existsSync(join(root, 'src/automations/listeners.ts'))).toBe(true);
    const after = await api('GET', `/api/maps/${mapId}`);
    expect(after.body.map.edges.map((e: any) => e.id)).toContain('fx1');
    expect(after.body.map.absences).toEqual([]);
    expect(after.body.fixes).toEqual({ [fixId]: { status: 'applied', edgeId: 'fx1', closed: ['miss'], undoable: true } }); // a reload can still offer Undo

    expect((await api('POST', `/api/maps/${mapId}/fixes/${fixId}/undo`)).status).toBe(200);
    expect(existsSync(join(root, 'src/automations/listeners.ts'))).toBe(false);
    const undone = await api('GET', `/api/maps/${mapId}`);
    expect(undone.body.map.absences.map((x: any) => x.id)).toEqual(['miss']);
    expect(undone.body.report.absences.miss.status).toBe('confirmed');
    expect(undone.body.fixes).toEqual({ [fixId]: { status: 'proposed' } }); // undone fixes can be approved again
  });

  it('keeps the questions, answers and fixes across a restart; Undo only lasts while the server runs', async () => {
    const again = await startServer({ root, port: 0, agent, viewerDir: join(root, 'no-viewer') });
    try {
      const get = async (s: IlluminateServer) => (await fetch(`${s.url}/api/maps/${mapId}`, { headers: { 'x-illuminate-token': s.token } })).json() as Promise<any>;
      const before = await get(again);
      expect(before.answers.map((a: any) => [a.question, a.source])).toEqual([['What does this do?', 'code'], ['Make the email go out right away', 'code']]);
      const fixId = before.answers[1].fix.id;
      expect(before.fixes).toEqual({ [fixId]: { status: 'proposed' } }); // it was undone before the restart, so it can be approved again
      const ok = await fetch(`${again.url}/api/maps/${mapId}/fixes/${fixId}/approve`, { method: 'POST', headers: { 'x-illuminate-token': again.token } });
      expect(ok.status).toBe(200);
      expect((await get(again)).fixes[fixId]).toMatchObject({ status: 'applied', undoable: true });
      await again.close();

      const third = await startServer({ root, port: 0, agent, viewerDir: join(root, 'no-viewer') });
      expect((await get(third)).fixes[fixId]).toMatchObject({ status: 'applied', undoable: false });
      await third.close();
    } finally {
      await again.close();
    }
  });

  it('refuses requests without the token, from other hosts or origins, and sockets without the token', async () => {
    expect((await fetch(`${server.url}/api/maps`)).status).toBe(401);
    expect((await api('POST', '/api/maps', { question: 'x' }, { origin: 'https://evil.example' })).status).toBe(403);
    const wrongHost = await new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port: server.port, path: '/api/maps', headers: { host: 'evil.example', 'x-illuminate-token': server.token } }, (res) => resolve(res.statusCode ?? 0));
    });
    expect(wrongHost).toBe(403);
    const refused = await new Promise<boolean>((resolve) => {
      const bad = new WebSocket(`ws://127.0.0.1:${server.port}/ws?t=wrong`);
      bad.on('open', () => resolve(false));
      bad.on('error', () => resolve(true));
    });
    expect(refused).toBe(true);
  });

  it('explains how to build the viewer when it is missing', async () => {
    const res = await fetch(`${server.url}/m/${mapId}?t=${server.token}`);
    expect(await res.text()).toContain('npm run build');
  });
});
