// UI → API links: fetch call sites (direct, wrappers, axios/ky) and matching them to route facts.
import { describe, expect, it } from 'vitest';
import { findFetchSites, matchRoute, urlPath, type FetchSite } from '../src/journeys/fetches';
import type { RouteFact } from '../src/contracts/facts';

const route = (method: string, path: string): RouteFact => ({ id: `route:${method} ${path}`, method, path, file: 'src/server.ts', handler: null });
const sitesOf = (files: Record<string, string>) => findFetchSites(Object.entries(files).map(([path, source]) => ({ path, source, symbols: [] })));

describe('findFetchSites', () => {
  it('finds direct fetches with literal and template URLs, axios/ky calls, and the method from the init or the client', () => {
    const sites = sitesOf({
      'web/a.ts': [
        'fetch("/api/runs");',
        'fetch(`/api/runs/${id}?full=1`, { method: "DELETE" });',
        "await fetch('https://example.com/api/x#frag', { headers: {}, method: 'put' });",
        'axios.post("/api/notes", body);',
        'ky.get(`/api/usage`);',
        'fetch(url);', // not a literal and not inside a named function: ignored
        'fetch(`${BASE}/api/runs`);', // dynamic origin: not a path
        'const s = "fetch(\\"/api/nope\\")";',
      ].join('\n'),
    });
    expect(sites.map((s) => `${s.method} ${s.url} ${s.exact} ${s.via}`)).toEqual([
      'GET /api/runs true null',
      'DELETE /api/runs/{} false null',
      'PUT /api/x true null',
      'POST /api/notes true axios.post',
      'GET /api/usage true ky.get',
    ]);
  });

  it('finds wrappers (fetch of a parameter, or `/api${path}`) and their literal call sites, in any file', () => {
    const sites = sitesOf({
      'web/api.ts': [
        'export async function request<T>(path: string, init?: RequestInit): Promise<T> {',
        '  const res = await fetch(path, { ...init });',
        '  return res.json();',
        '}',
        'export function apiGet(path: string) { return fetch(`/api${path}`); }',
        'export const api = { runs: () => request<{ runs: string[] }>("/api/runs?limit=25"), start: (b: unknown) => request("/api/runs", { method: "POST", body: JSON.stringify(b) }) };',
      ].join('\n'),
      'web/page.tsx': 'import { apiGet } from "./api";\nexport function Usage() { apiGet(`/usage/${month}`); return null; }\n',
    });
    expect(sites.map((s) => `${s.file} ${s.method} ${s.url} ${s.exact} ${s.via}`)).toEqual([
      'web/api.ts GET /api/runs true request',
      'web/api.ts POST /api/runs true request',
      'web/page.tsx GET /api/usage/{} false apiGet',
    ]);
  });

  it('names the innermost enclosing symbol from spans', () => {
    const source = 'export function A() {\n  return fetch("/api/a");\n}\n';
    const sym = (name: string, start: number, end: number) => ({ id: `w.ts#${name}`, file: 'w.ts', name, kind: 'function' as const, exported: true, parent: null, span: { start, end }, sigHash: '', bodyHash: '' });
    const [site] = findFetchSites([{ path: 'w.ts', source, symbols: [sym('A', 0, source.length), sym('Outer', 0, source.length + 10)] }]);
    expect(site!.from).toBe('w.ts#A');
    expect(urlPath('https://x.io')).toBeNull();
    expect(urlPath('/a//b/?q')).toBe('/a/b');
  });
});

describe('matchRoute', () => {
  const routes = [route('GET', '/api/runs'), route('POST', '/api/runs'), route('GET', '/api/runs/{}'), route('GET', '/api/runs/latest'), route('ANY', '/api/hook'), route('GET', '/api/accounts/{}/notes')];
  const site = (method: string, url: string, exact = true): Pick<FetchSite, 'method' | 'url' | 'exact'> => ({ method, url, exact });
  it('matches by method and segments, preferring the fewest wildcards', () => {
    expect(matchRoute(site('POST', '/api/runs'), routes)).toEqual({ route: routes[1], confidence: 'syntactic' });
    expect(matchRoute(site('GET', '/api/runs/latest'), routes)).toEqual({ route: routes[3], confidence: 'syntactic' });
    expect(matchRoute(site('GET', '/api/runs/r-1'), routes)).toEqual({ route: routes[2], confidence: 'syntactic' });
    expect(matchRoute(site('GET', '/api/runs/{}', false), routes)).toEqual({ route: routes[2], confidence: 'inferred' });
    expect(matchRoute(site('GET', '/api/accounts/{}/notes', false), routes)?.route.id).toBe('route:GET /api/accounts/{}/notes');
    expect(matchRoute(site('PATCH', '/api/hook'), routes)).toEqual({ route: routes[4], confidence: 'inferred' });
    expect(matchRoute(site('DELETE', '/api/runs'), routes)).toBeNull();
    expect(matchRoute(site('GET', '/api'), routes)).toBeNull();
  });
});

