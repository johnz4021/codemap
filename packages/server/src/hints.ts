// The explorer's head start: what a quick deterministic scan already knows (ways in, routes, which requests hit which
// routes, which tables are written), so Claude spends its reading on the question instead of on finding the edges.
import * as fs from 'node:fs';
import { findFetchSites, initTreeSitter, matchRoute, scanRepoFacts, type RepoScan } from '@codemap/facts';

const MAX_LINES = 40;
const section = (title: string, lines: string[]) =>
  lines.length ? [`${title}:`, ...lines.slice(0, MAX_LINES), ...(lines.length > MAX_LINES ? [`  …and ${lines.length - MAX_LINES} more`] : []), ''] : [];

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
  ].join('\n');
  return { text: text || '(The automatic scan found no entry points; explore the repo directly.)', scan };
}
