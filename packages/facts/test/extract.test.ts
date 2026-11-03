// Fact extraction for TS/JS: symbols, calls, routes and entries, write adapters, large and broken files, symbol diffs.
// Ported from the hackathon harness with its domain-map and edit-gate cases removed.
import { describe, expect, it } from 'vitest';
import { diffSymbols } from '../src/facts/diff';
import { extractFacts, settleCalls, type ExtractContext } from '../src/facts/extract';
import { moduleRecord } from '../src/facts/record';
import { normalizeRoutePath } from '../src/facts/routes';

// The fixture's custom router (`req.method === "POST" && req.url === "/runs"`), confirmed the way `cartography.routes` would be.
const ROUTE_PATTERN = { file: 'src/channels/routes.ts', pattern: 'req\\.method === "(?<method>[A-Z]+)" && req\\.url === "(?<path>[^"]+)"' };

const files: Record<string, string> = {
  'src/lib/a.ts': 'export function a() {}\nexport default function main() {}\n',
  'src/lib/index.ts': 'export { a as alpha } from "./a";\nexport * from "./b";\nexport * as ns from "./a";\n',
  'src/lib/b.ts': 'export const b = () => 1;\n',
};
const resolve = (from: string, spec: string): string | null => {
  if (!spec.startsWith('.')) return `vendor:${spec.split('/')[0]}`;
  const dir = from.split('/').slice(0, -1);
  for (const seg of spec.split('/')) seg === '..' ? dir.pop() : seg !== '.' && dir.push(seg);
  const base = dir.join('/');
  return [base, `${base}.ts`, `${base}/index.ts`].find((p) => p in files || p === 'src/x.ts') ?? null;
};
const ctx: ExtractContext = { recordOf: (f) => (files[f] === undefined ? null : moduleRecord(f, files[f]!)) };
const facts = (src: string, path = 'src/x.ts', c: ExtractContext = ctx) => extractFacts(path, src, resolve, c);

describe('extractFacts: symbols', () => {
  it('names functions, classes, methods, exported consts and object-literal members; ids carry no line numbers', () => {
    const f = facts([
      'import type { Tool } from "./types";',
      'export function run(a: number): number { return a; }',
      'function helper() {}',
      'export class Store extends Base { constructor() { super(); } get size() { return 1; } static make() {} private go = () => 1; }',
      'export const tool: Tool = { name: "t", run: async () => 1, nested: { deep() {} } };',
      'const local = { run() {} };',
      'export const LIMIT = 3, chat = run;',
      'export interface Shape { run(x: number): void; size: number }',
      'function dup() {}',
      'function dup() {}',
      'export { helper };',
    ].join('\n'));
    expect(f.symbols.map((s) => `${s.name}:${s.kind}${s.exported ? '*' : ''}${s.parent ? `<${s.parent.split('#')[1]}` : ''}`)).toEqual([
      'run:function*', 'helper:function*', 'Store:class*', 'Store.constructor:method<Store', 'Store.size:method<Store', 'Store.make:method<Store',
      'Store.go:method<Store', 'tool:const*', 'tool.run:method<tool', 'tool.nested.deep:method<tool', 'local:const', 'local.run:method<local', 'LIMIT:const*', 'chat:function*',
      'Shape:type*', 'Shape.run:method<Shape', 'Shape.size:property<Shape', 'dup:function', 'dup~2:function',
    ]);
    expect(f.symbols.every((s) => /^src\/x\.ts#[^\d:]/.test(s.id) && s.span.end > s.span.start)).toBe(true);
  });

  it('gives top-level anonymous callbacks <cbN> symbols and folds callbacks inside a symbol into it', () => {
    const f = facts('describe("x", () => { go(); });\nexport function go() { [1].map((x) => x + 1).forEach(() => go()); }\nsetTimeout(function () {}, 1);\n');
    expect(f.symbols.map((s) => s.name)).toEqual(['<cb1>', 'go', '<cb2>']);
    expect(f.calls).toEqual([{ from: 'src/x.ts#<cb1>', to: 'src/x.ts#go', confidence: 'syntactic', count: 1 }]);
  });

  it('marks components in .tsx files', () => {
    const f = facts('export function Page() { return <div/>; }\nexport const Row = () => <span/>;\nexport const useThing = () => 1;\n', 'src/ui/Page.tsx');
    expect(f.symbols.map((s) => `${s.name}:${s.kind}`)).toEqual(['Page:component', 'Row:component', 'useThing:function']);
  });

  it('hashes signatures and bodies apart, ignoring whitespace', () => {
    const [a] = facts('export function f(a: number) { return a + 1; }').symbols;
    const [b] = facts('export function f(a: number) {\n  return a  + 1;\n}').symbols;
    const [c] = facts('export function f(a: number) { return a + 2; }').symbols;
    const [d] = facts('export function f(a: string) { return a + 1; }').symbols;
    const [e] = facts('function f(a: number) { return a + 1; }').symbols;
    expect([b!.sigHash, b!.bodyHash]).toEqual([a!.sigHash, a!.bodyHash]);
    expect([c!.sigHash === a!.sigHash, c!.bodyHash === a!.bodyHash]).toEqual([true, false]);
    expect(d!.sigHash).not.toBe(a!.sigHash);
    expect(e!.sigHash).not.toBe(a!.sigHash); // export flag is part of the signature
  });
});

describe('extractFacts: syntactic calls', () => {
  it('links named, default, namespace, barrel and dynamic-import bindings; packages become vendor ids', () => {
    const f = facts([
      'import main, { a } from "./lib/a";',
      'import { alpha, b, ns } from "./lib";',
      'import * as lib from "./lib";',
      'import OpenAI from "openai";',
      'export async function go() {',
      '  a(); main(); alpha(); b(); ns.a(); lib.b(); lib.alpha();',
      '  new OpenAI().chat.completions.create({});',
      '  const { a: viaImport } = await import("./lib/a");',
      '  viaImport();',
      '}',
    ].join('\n'));
    expect(f.calls.map((c) => `${c.to} x${c.count}`).sort()).toEqual([
      'src/lib/a.ts#a x5', 'src/lib/a.ts#main x1', 'src/lib/b.ts#b x2', 'vendor:openai x1',
    ]);
  });

  it('links `this.m()` in classes and settles members to the deepest existing symbol', () => {
    const f = facts('import { db } from "./lib/b";\nexport class S { a() { this.b(); db.insert.x(); } b() {} }\n');
    expect(f.calls.map((c) => `${c.from.split('#')[1]} → ${c.to}`)).toEqual(['S.a → src/x.ts#S.b', 'S.a → src/lib/b.ts#db.insert.x']);
    const settled = settleCalls(f.calls, (file) => (file === 'src/lib/b.ts' ? new Set(['db', 'db.insert']) : null));
    expect(settled.map((c) => c.to)).toEqual(['src/x.ts#S.b', 'src/lib/b.ts#db.insert']);
    expect(settleCalls(f.calls, () => new Set()).map((c) => c.to)).toEqual(['src/lib/b.ts']); // a call into its own file with no symbol drops
  });
});

describe('extractFacts: routes and entries', () => {
  it('finds Express, Hono and Fastify routes only on instances of those frameworks', () => {
    const f = facts([
      'import express from "express";',
      'import Fastify from "fastify";',
      'import { list } from "./lib/a";',
      'const app = express();',
      'const router = express.Router();',
      'const fastify = Fastify();',
      'const cache = new Map();',
      'app.get("/runs", list);',
      'router.post(`/runs/:id/stop`, auth, (req, res) => res.end());',
      'fastify.route({ method: ["GET", "HEAD"], url: "/health", handler: async () => "ok" });',
      'cache.get("/not-a-route", 1);',
      'export function auth() {}',
    ].join('\n'));
    expect(f.routes.map((r) => `${r.id} → ${r.handler}`)).toEqual([
      'route:GET /runs → src/lib/a.ts#list',
      'route:POST /runs/{}/stop → src/x.ts#<cb1>',
      'route:GET /health → src/x.ts#<cb2>',
      'route:HEAD /health → src/x.ts#<cb2>',
    ]);
    expect(f.entries.map((e) => e.id)).toContain('entry:route:GET /runs');
  });

  it('reads Next.js app and pages routes from the file path and exports', () => {
    const r = facts('export async function GET() {}\nexport const POST = async () => {};\nexport function helper() {}\n', 'web/app/(shop)/api/runs/[id]/route.ts');
    expect(r.routes.map((x) => `${x.id} → ${x.handler}`)).toEqual([
      'route:GET /api/runs/{} → web/app/(shop)/api/runs/[id]/route.ts#GET',
      'route:POST /api/runs/{} → web/app/(shop)/api/runs/[id]/route.ts#POST',
    ]);
    expect(facts('export default function handler() {}', 'pages/api/users/index.ts').routes.map((x) => x.id)).toEqual(['route:ANY /api/users']);
    expect(facts('export default function Page() {}', 'src/app/runs/[id]/page.tsx').entries.map((e) => `${e.id} ${e.symbol}`)).toEqual([
      'entry:page:/runs/{} src/app/runs/[id]/page.tsx#Page',
    ]);
  });

  it('applies cartography.routes patterns, with the handler defined after the match', () => {
    const src = 'const routes = [\n  ["GET", /^\\/api\\/runs\\/([\\w-]+)$/, ([id]) => getRun(id)],\n  ["POST", /^\\/api\\/runs$/, async () => start()],\n];\n';
    const f = facts(src, 'src/channels/routes.ts', { routes: [{ file: 'src/channels/*.ts', pattern: '\\[\\s*"(?<method>[A-Z]+)",\\s*/\\^(?<path>(?:\\\\.|[^$])*)\\$/' }] });
    expect(f.routes.map((r) => `${r.id} → ${r.handler}`)).toEqual(['route:GET /api/runs/{} → src/channels/routes.ts#<cb1>', 'route:POST /api/runs → src/channels/routes.ts#<cb2>']);
  });

  it('normalizes route params', () => {
    expect(['/a/:id', '/a/{id}/b', '/a/[id]', '/a/[...slug]', '^\\/a\\/([\\w-]+)$', '/a/*', 'a/'].map(normalizeRoutePath)).toEqual(['/a/{}', '/a/{}/b', '/a/{}', '/a/{}', '/a/{}', '/a/{}', '/a']);
  });

  it('turns package.json entries into bin, script and cli entries', () => {
    const e = (src: string) => facts(src, 'src/x.ts', { entries: [{ kind: 'script', label: 'dev' }, { kind: 'bin', label: 'x' }] }).entries.map((x) => x.id);
    expect(e('main(process.argv.slice(2));')).toEqual(['entry:cli:dev', 'entry:bin:x']);
    expect(e('if (import.meta.url === process.argv[1]) start();')).toEqual(['entry:script:dev', 'entry:bin:x']);
  });
});

describe('write adapters', () => {
  const tables = (src: string) => facts(src).writes.map((w) => `${w.via}:${w.table}`);
  it('finds Prisma, Drizzle, Knex, Kysely and raw SQL writes, but not reads or prose', () => {
    expect(tables([
      'await prisma.user.create({ data });',
      'await tx.post.updateMany({});',
      'await db.insert(users).values({ id });',
      'await db.update(orders).set({ paid: true }).where(eq(orders.id, id));',
      'await knex("audit").where({ id }).update({ seen: true });',
      'await trx.table("events").insert(rows);',
      'await db.insertInto("person").values(v).execute();',
      'await sql`INSERT INTO runs (id) VALUES (${id})`;',
      'await pool.query("UPDATE contacts SET name = $1", [n]);',
      'await pool.query("DELETE FROM notes WHERE id = 1");',
      'await prisma.user.findMany(); await knex("audit").select("*"); await db.select().from(users);',
      'const label = "Delete from cart"; const t = "UPDATE your profile";',
      '// db.insert("runs", r);',
    ].join('\n'))).toEqual([
      'prisma:user', 'prisma:post', 'drizzle:users', 'drizzle:orders', 'knex:audit', 'knex:events', 'kysely:person', 'sql:runs', 'sql:contacts', 'sql:notes',
    ]);
  });
});

describe('large and broken files', () => {
  it('records only imports and writes for files over ~500 KB or minified', () => {
    const big = `import { a } from "./lib/a";\nexport const blob = "${'A'.repeat(600_000)}";\nexport function f() { a(); }\ndb.insert("runs", r);\n`;
    const f = facts(big);
    expect(f.imports).toEqual([{ to: 'src/lib/a.ts', typeOnly: false }]);
    expect(f.writes.map((w) => w.table)).toEqual(['runs']);
    expect(f.symbols).toEqual([]);
  });

  it('falls back to the regex parser for source with syntax errors', () => {
    const f = facts('import { a } from "./lib/a";\nexport function broken( {\ndb.insert("runs", r);\n');
    expect(f.imports.map((i) => i.to)).toEqual(['src/lib/a.ts']);
    expect(f.writes.map((w) => w.table)).toEqual(['runs']);
  });
});

describe('diffSymbols', () => {
  const sym = (name: string, sig: string, body: string, kind: 'function' | 'const' = 'function') => ({
    id: `f.ts#${name}`, file: 'f.ts', name, kind, exported: true, parent: null, span: { start: 0, end: 1 }, sigHash: sig, bodyHash: body,
  });
  it('classifies added, removed, signature, body and renamed symbols', () => {
    const before = [sym('a', 's1', 'b1'), sym('b', 's2', 'b2'), sym('c', 's3', 'b3'), sym('old', 's4', 'b4'), sym('gone', 's5', 'b5')];
    const after = [sym('a', 's1', 'b1'), sym('b', 's2x', 'b2'), sym('c', 's3', 'b3x'), sym('new', 's4', 'b4'), sym('fresh', 's6', 'b6')];
    expect(diffSymbols(before, after)).toEqual({ added: ['f.ts#fresh'], removed: ['f.ts#gone'], sig: ['f.ts#b'], body: ['f.ts#c'], renamed: [['f.ts#old', 'f.ts#new']] });
  });

  it('works on extracted facts: a rename keeps the body hash', () => {
    const a = facts('export function plan(x: number) { return x * 2; }\nexport function keep() {}');
    const b = facts('export function schedule(x: number) { return x * 2; }\nexport function keep() { return 1; }');
    expect(diffSymbols(a.symbols, b.symbols)).toEqual({ added: [], removed: [], sig: [], body: ['src/x.ts#keep'], renamed: [['src/x.ts#plan', 'src/x.ts#schedule']] });
  });
});
