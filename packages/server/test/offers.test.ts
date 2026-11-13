// A question about a different part of the app, over HTTP: the offer, a new map linked back to this one, or an answer
// in words that draws nothing here.
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANSWER_SCHEMA } from '../src/schemas';
import { startServer, type IlluminateServer, type ServerEvent } from '../src/server';
import { CARE_MAP, cleanup, copyCareApp, scriptedAgent, waitFor } from './helpers';

const elsewhere = () => ({ route: 'elsewhere', newQuestion: 'How do invoices get sent?' });
const agent = scriptedAgent([
  () => CARE_MAP, // the first map
  elsewhere, // "and invoices?" on it
  () => CARE_MAP, // the new map they said yes to
  elsewhere, // asked again
  () => ({ concept: 'Nothing in this app sends invoices.' }), // …and this time answered in words
]);

let server: IlluminateServer;
let ws: WebSocket;
const events: ServerEvent[] = [];
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { 'x-illuminate-token': server.token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};
const answers = () => events.filter((e): e is Extract<ServerEvent, { type: 'answer' }> => e.type === 'answer');
const made = (id: string) => waitFor(() => events.find((e) => e.type === 'job' && e.job === 'make' && e.mapId === id && e.status === 'done'));

beforeAll(async () => {
  const root = copyCareApp();
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

describe('a question about a different part of the app', () => {
  let mapId = '';

  it('offers a new map instead of answering, and makes one linked back when they say yes', async () => {
    mapId = (await api('POST', '/api/maps', { question: 'What happens when a patient converts?' })).body.id;
    await made(mapId);
    await api('POST', `/api/maps/${mapId}/ask`, { question: 'and invoices?', selection: {} });
    const offered = (await waitFor(() => answers()[0])).answer;
    expect(offered.offer).toEqual({ question: 'How do invoices get sent?', existing: null, status: 'pending', mapId: null });

    expect((await api('POST', `/api/maps/${mapId}/answers/${offered.id}/offer`, { choice: 'maybe' })).status).toBe(400);
    const yes = await api('POST', `/api/maps/${mapId}/answers/${offered.id}/offer`, { choice: 'map' });
    expect(yes.status).toBe(200);
    const newId = yes.body.id as string;
    await made(newId);
    const child = await api('GET', `/api/maps/${newId}`);
    expect(child.body.meta.question).toBe('How do invoices get sent?');
    expect(child.body.meta.parent).toEqual({ mapId, question: 'What happens when a patient converts?' });

    const parent = await api('GET', `/api/maps/${mapId}`);
    expect(parent.body.answers[0].offer).toMatchObject({ status: 'mapped', mapId: newId }); // saved, so a reload shows it
    expect(events).toContainEqual(expect.objectContaining({ type: 'answerUpdate', mapId, answer: expect.objectContaining({ id: offered.id }) }));
    expect((await api('POST', `/api/maps/${mapId}/answers/${offered.id}/offer`, { choice: 'map' })).status).toBe(404); // only once
  });

  it('answers in words from the code when they say no, drawing nothing on this map', async () => {
    const before = (await api('GET', `/api/maps/${mapId}`)).body.map;
    await api('POST', `/api/maps/${mapId}/ask`, { question: 'and invoices?', selection: {} });
    const offered = (await waitFor(() => answers()[1])).answer;
    expect((await api('POST', `/api/maps/${mapId}/answers/${offered.id}/offer`, { choice: 'words' })).status).toBe(200);
    const words = (await waitFor(() => answers()[2])).answer;
    expect(words).toMatchObject({ question: 'and invoices?', source: 'code', concept: 'Nothing in this app sends invoices.', added: [], offer: null });
    expect(agent.calls.at(-1)!.schema).toBe(ANSWER_SCHEMA);
    expect(agent.calls.at(-1)!.prompt).toContain('different part of the app');

    const after = await api('GET', `/api/maps/${mapId}`);
    expect(after.body.map).toEqual(before);
    expect(after.body.answers.map((a: any) => a.offer?.status ?? null)).toEqual(['mapped', 'answered', null]);
  });
});
