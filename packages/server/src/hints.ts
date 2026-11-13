// The explorer's head start: what a quick deterministic scan already knows (ways in, routes, which requests hit which
// routes, which tables are written), so Claude spends its reading on the question instead of on finding the edges.
import * as fs from 'node:fs';
import { findFetchSites, initTreeSitter, matchRoute, scanRepoFacts, type RepoScan } from '@illuminate/facts';

const MAX_LINES = 40;
/** The function index can be longer: it's what keeps citations exact, and input is cheap next to output. */
const MAX_SYMBOL_FILES = 150;
const MAX_SYMBOLS_PER_FILE = 40;
const CITABLE = new Set(['function', 'method', 'component', 'class']);
const TEST_FILE = /(^|\/)(test|tests|__tests__|fixtures?)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const section = (title: string, lines: string[], max = MAX_LINES) =>
  lines.length ? [`${title}:`, ...lines.slice(0, max), ...(lines.length > max ? [`  …and ${lines.length - max} more`] : []), ''] : [];

/**
 * Every function a box can name as its `symbol`, by file, exactly as the checker knows them (`startServer.startMap`
 * for a function inside `startServer`). Test files and anonymous callbacks are left out.
 */
export function symbolIndex(scan: RepoScan): string[] {
  return Object.values(scan.fileFacts)
    .filter((f) => !TEST_FILE.test(f.path))
    .map((f) => ({ path: f.path, names: f.symbols.filter((s) => CITABLE.has(s.kind) && !s.name.includes('<')).map((s) => s.name) }))
    .filter((f) => f.names.length)
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => `  - ${f.path}: ${f.names.slice(0, MAX_SYMBOLS_PER_FILE).join(', ')}${f.names.length > MAX_SYMBOLS_PER_FILE ? `, …and ${f.names.length - MAX_SYMBOLS_PER_FILE} more` : ''}`);
}

/** Function names by file, for suggesting the real name when a claim cites one the code doesn't have. */
export function symbolIndexOf(scan: RepoScan | null): (file: string) => readonly string[] {
  return (file) => scan?.fileFacts[file]?.symbols.filter((s) => CITABLE.has(s.kind) && !s.name.includes('<')).map((s) => s.name) ?? [];
}

export async function headStart(root: string): Promise<{ text: string; scan: RepoScan | null }> {
  await initTreeSitter();
  let scan: RepoScan;
  try {
    scan = scanRepoFacts(root);
  } catch {
    return { text: '(The automatic scan could not read this repo; explore it directly.)', scan: null };
  }
  const facts = Object.values(scan.fileFacts);

  const entries = facts.flatMap((f) => f.entries).map((e) => `  - ${e.kind} ${e.label}${e.symbol ? ` → ${e.symbol}` : ` (${e.file})`}`);
  const routes = facts.flatMap((f) => f.routes);
  const routeLines = routes.map((r) => `  - ${r.method} ${r.path} → ${r.handler ?? r.file}`);

  const fetchFiles = facts
    .filter((f) => /\.(tsx?|jsx?|mjs|cjs)$/.test(f.path))
    .flatMap((f) => {
      const source = fs.readFileSync(`${root}/${f.path}`, 'utf8');
      return /\bfetch\(|axios|ky\./.test(source) ? [{ path: f.path, source, symbols: f.symbols }] : [];
    });
  const requests = findFetchSites(fetchFiles).flatMap((site) => {
    const m = matchRoute(site, routes);
    return m ? [`  - ${site.from} sends ${site.method} ${site.url} → ${m.route.handler ?? m.route.file}`] : [];
  });

  const writers = new Map<string, Set<string>>();
  for (const f of facts) for (const w of f.writes) writers.set(w.table, (writers.get(w.table) ?? new Set()).add(w.symbol ?? f.path));
  const tables = [...writers].map(([t, by]) => `  - ${t} ← ${[...by].slice(0, 4).join(', ')}`);

  const folders = new Map<string, number>();
  for (const f of scan.files) {
    const top = f.includes('/') ? f.slice(0, f.indexOf('/')) : '(root)';
    folders.set(top, (folders.get(top) ?? 0) + 1);
  }
  const folderLines = [...folders].sort((a, b) => b[1] - a[1]).map(([d, n]) => `  - ${d}/ (${n} files)`);

  const text = [
    ...section('Ways in (entry points)', entries),
    ...section('Routes and their handlers', routeLines),
    ...section('Requests from the code that match a route', requests),
    ...section('Tables and what writes them', tables),
    ...section('Top-level folders', folderLines),
    ...section('Functions by file (use these exact names for `symbol`)', symbolIndex(scan), MAX_SYMBOL_FILES),
  ].join('\n');
  return { text: text || '(The automatic scan found no entry points; explore the repo directly.)', scan };
}
