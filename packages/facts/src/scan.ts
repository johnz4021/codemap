// Whole-repo scan: every non-ignored file, facts for code and `.sql` files, calls settled across the repo. Node-only.
// What to skip is a list of globs (plus node_modules and .git, always).
import * as fs from 'node:fs';
import type { FileFacts } from './contracts/facts';
import { attachResolver, attachRoot, carryResolver } from './facts/context';
import { packageEntries } from './facts/entries';
import { extract, settleCalls, type ExtractContext, type PackageEntry } from './facts/extract';
import { moduleRecord } from './facts/record';
import { createRepoResolver } from './facts/resolver';
import { diskLangContext, treeSitterLang, treeSitterReady } from './facts/treesitter';
import { matchesAny } from './glob';
import { normalizePath, resolveSpecifier } from './imports';

export type Exists = (path: string) => boolean;
export type ImportEdge = { from: string; to: string };
export type WriteFact = { file: string; table: string };
export type RoutePattern = { file: string; pattern: string };
export type ScanOptions = { ignore?: readonly string[]; routes?: readonly RoutePattern[] };
export type RepoScan = { files: string[]; fileFacts: Record<string, FileFacts>; imports: ImportEdge[]; writes: WriteFact[] };

export const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts'];

/** Never scanned: codemap's own output and common build output. */
export const DEFAULT_IGNORE = ['.codemap/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/.next/**'];

export function isCodeFile(path: string): boolean {
  return CODE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** A Python or Go file, once tree-sitter is loaded (`initTreeSitter`); before that they carry no facts. */
export const isTreeSitterFile = (path: string) => treeSitterLang(path) !== null && treeSitterReady();

/**
 * File-existence check against a repo root, cached. Call `clear()` after files are created or deleted.
 * It carries the repo's module resolver (tsconfig paths, package exports, workspaces) for `resolveImport`.
 */
export function fileExistsIn(root: string): Exists & { clear(): void } {
  const cache = new Map<string, boolean>();
  let resolver: ReturnType<typeof createRepoResolver> | null = null;
  const exists = (path: string) => {
    let hit = cache.get(path);
    if (hit === undefined) {
      try {
        hit = fs.statSync(`${root}/${path}`).isFile();
      } catch {
        hit = false;
      }
      cache.set(path, hit);
    }
    return hit;
  };
  attachResolver(exists, () => (resolver ??= createRepoResolver(root)));
  attachRoot(exists, root);
  return Object.assign(exists, {
    clear: () => {
      cache.clear();
      resolver?.clear();
    },
  });
}

/** `exists`, plus `paths` that will exist (e.g. files a proposed fix creates). Keeps `exists`'s resolver. */
export function withExtra(exists: Exists, paths: readonly string[]): Exists {
  const extra = new Set(paths.map((p) => normalizePath(p) ?? p));
  return carryResolver((path: string) => extra.has(path) || exists(path), exists);
}

/** Every non-ignored file under `root`, sorted. */
export function listRepoFiles(root: string, ignore: readonly string[] = DEFAULT_IGNORE): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir ? `${root}/${dir}` : root, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (matchesAny(ignore, path) || (entry.isDirectory() && matchesAny(ignore, `${path}/`))) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk('');
  return files.sort();
}

/** Extracts facts for one file at a time with the repo's resolver, package entries and language context. */
export function createFactsIndex(root: string, exists: Exists, read: (path: string) => string | null, routes: readonly RoutePattern[] = []) {
  const resolve = (from: string, spec: string) => resolveSpecifier(from, spec, exists);
  let entries: Map<string, PackageEntry[]> | null = null;
  const lang = { ...diskLangContext(root, exists), read: (p: string) => read(p) };
  const ctx = (path: string): ExtractContext => ({
    recordOf: (file) => {
      if (!isCodeFile(file)) return null;
      const text = read(file);
      return text === null ? null : moduleRecord(file, text);
    },
    entries: (entries ??= packageEntries(root, exists)).get(path) ?? [],
    routes,
    lang,
  });
  return {
    resolve,
    /** Facts for one file, calls not yet settled (see `settleCalls`). `parsed` is false for source with syntax errors. */
    extract: (path: string, source: string) => extract(path, source, resolve, ctx(path)),
  };
}

/** Symbol names per file, for `settleCalls` (memoized). */
export function symbolNames(facts: Readonly<Record<string, FileFacts>>): (file: string) => ReadonlySet<string> | null {
  const sets = new Map<string, ReadonlySet<string> | null>();
  return (file) => {
    if (!sets.has(file)) sets.set(file, facts[file] ? new Set(facts[file]!.symbols.map((s) => s.name)) : null);
    return sets.get(file)!;
  };
}

/** Facts for every code and `.sql` file in the repo, calls settled against the whole repo. */
export function scanRepoFacts(root: string, options: ScanOptions = {}): RepoScan {
  const files = listRepoFiles(root, [...DEFAULT_IGNORE, ...(options.ignore ?? [])]);
  const known = new Set(files);
  const onDisk = fileExistsIn(root);
  const exists = carryResolver((p: string) => known.has(p) || onDisk(p), onDisk);
  const texts = new Map<string, string>();
  const read = (p: string) => {
    let t = texts.get(p);
    if (t === undefined) {
      try {
        t = fs.readFileSync(`${root}/${p}`, 'utf8');
      } catch {
        return null;
      }
      texts.set(p, t);
    }
    return t;
  };
  const index = createFactsIndex(root, exists, read, options.routes);
  const fileFacts: Record<string, FileFacts> = {};
  for (const file of files) {
    if (!file.endsWith('.sql') && !isCodeFile(file) && !isTreeSitterFile(file)) continue;
    const source = read(file);
    if (source !== null) fileFacts[file] = index.extract(file, source).facts;
  }
  const names = symbolNames(fileFacts);
  for (const f of Object.values(fileFacts)) f.calls = settleCalls(f.calls, names);

  const imports: ImportEdge[] = [];
  const writes: WriteFact[] = [];
  for (const [file, f] of Object.entries(fileFacts)) {
    for (const i of f.imports) if (!i.to.startsWith('vendor:')) imports.push({ from: file, to: i.to });
    for (const w of f.writes) writes.push({ file, table: w.table });
  }
  return { files, fileFacts, imports, writes };
}
