// The server stops itself when nobody is looking (no tab open, Claude not working) and from the page's Stop button.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent } from '../src/agent';
import { STOPPED_CLOSE_CODE, startServer, type IlluminateServer, type ServerOptions } from '../src/server';
import { CARE_MAP, cleanup, copyCareApp, waitFor } from './helpers';

const servers: IlluminateServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  cleanup();
});

/** A Claude stand-in that returns the care-app map only when `release()` is called. */
function heldAgent() {
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  const agent: Agent = async () => {
    await held;
    return { output: CARE_MAP, sessionId: 'held', cost: 0 };
  };
  return { agent, release: () => release() };
}

async function start(o: Partial<ServerOptions> = {}) {
  const root = copyCareApp();
  const stops: string[] = [];
  const server = await startServer({ root, port: 0, viewerDir: join(root, 'no-viewer'), onStop: (r) => stops.push(r), ...o });
  servers.push(server);
  return { server, root, stops };
}

function tab(server: IlluminateServer) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?t=${server.token}`);
  const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
  return { ws, closed, open: new Promise((r) => ws.once('open', r)) };
}

const stopRequest = (server: IlluminateServer) =>
  fetch(`${server.url}/api/stop`, { method: 'POST', headers: { 'x-illuminate-token': server.token } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('stopping illuminate', () => {
  it('stays up while a tab is open, and stops a little after the last one closes', async () => {
    const { server, stops } = await start({ autoStop: { afterLastTabMs: 50, beforeFirstTabMs: 10_000 } });
    const t = tab(server);
    await t.open;
    await sleep(150);
    expect(stops).toEqual([]);
    t.ws.close();
    await waitFor(() => stops.length > 0);
    expect(stops).toEqual(['idle']);
    await expect(fetch(server.url)).rejects.toThrow();
  });

  it('keeps going while a reloaded tab reconnects within the grace period', async () => {
    const { server, stops } = await start({ autoStop: { afterLastTabMs: 150, beforeFirstTabMs: 10_000 } });
    const first = tab(server);
    await first.open;
    first.ws.close();
    await first.closed;
    const second = tab(server);
    await second.open;
    await sleep(300);
    expect(stops).toEqual([]);
  });

  it('never stops while Claude is working, even with no tab open', async () => {
    const { agent, release } = heldAgent();
    const { server, root, stops } = await start({ agent, autoStop: { afterLastTabMs: 20, beforeFirstTabMs: 20 } });
    const id = server.startMap('What happens when a patient converts?');
    await sleep(150);
    expect(stops).toEqual([]);
    release();
    await waitFor(() => stops.length > 0);
    expect(stops).toEqual(['idle']);
    expect(existsSync(join(root, `.illuminate/maps/${id}.json`))).toBe(true); // the map was saved before stopping
  });

  it('does nothing on its own without autoStop', async () => {
    const { server, stops } = await start();
    const t = tab(server);
    await t.open;
    t.ws.close();
    await sleep(100);
    expect(stops).toEqual([]);
    expect((await fetch(server.url)).status).toBe(200);
  });

  it('stops from the page, refusing while Claude works, and tells open tabs it stopped', async () => {
    const { agent, release } = heldAgent();
    const { server, stops } = await start({ agent });
    server.startMap('What happens when a patient converts?');
    const busy = await stopRequest(server);
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: string }).error).toMatch(/still working/);

    release();
    await waitFor(async () => (await stopRequest(server).then((r) => r.status === 200 ? 'stopping' : null)));
    await waitFor(() => stops.length > 0);
    expect(stops).toEqual(['requested']);
  });

  it('sends open tabs the "stopped" close code', async () => {
    const { server } = await start();
    const t = tab(server);
    await t.open;
    expect((await stopRequest(server)).status).toBe(200);
    expect(await t.closed).toBe(STOPPED_CLOSE_CODE);
  });

  it('needs the token to stop', async () => {
    const { server, stops } = await start();
    expect((await fetch(`${server.url}/api/stop`, { method: 'POST' })).status).toBe(401);
    expect(stops).toEqual([]);
  });
});
