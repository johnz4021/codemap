// The checker: decides which claims in a map the code actually backs. It reads the repo and never writes. One function,
// used everywhere a map reaches a person: when it's published, on every answer, when a saved map is reopened, after a fix.
// No model calls. Python and Go facts need `initTreeSitter()` to have been awaited once; TS/JS needs nothing.
import {
  DEFAULT_IGNORE,
  createFactsIndex,
  fileExistsIn,
  findFetchSites,
  listRepoFiles,
  matchRoute,
  matchesAny,
  settleCalls,
  squash,
  symbolNames,
  type CallFact,
  type FileFacts,
} from '@illuminate/facts';
import type { CodeMap, Evidence, MapAbsence, MapEdge, MapNode } from './format';
import { createRepoReader, isSecretPath, type RepoReader } from './repo';
import { checkScreen, type ScreenCheck } from './screens';

export type Status = 'confirmed' | 'unconfirmed';
/** `fact`: the extracted code facts back the claim. `text`: the cited lines say what the claim says. */
export type Proof = 'fact' | 'text';
export type EvidenceCheck = { file: string; line: number; ok: boolean; foundAt: number | null; reason: string | null };
export type ClaimCheck = { status: Status; proof: Proof | null; evidence: EvidenceCheck[]; reasons: string[] };
export type AbsenceCheck = { status: Status; found: number; locations: { file: string; line: number }[]; reasons: string[] };
export type TourCheck = { status: 'ok' | 'mentions-unconfirmed'; unconfirmed: string[] };
export type CheckReport = {
  nodes: Record<string, ClaimCheck>;
  edges: Record<string, ClaimCheck>;
  absences: Record<string, AbsenceCheck>;
  tour: Record<string, TourCheck>;
  /** By box id, for boxes that carry a screen. Not counted as claims: a screen that fails is simply not shown. */
  screens: Record<string, ScreenCheck>;
  summary: { claims: number; confirmed: number; unconfirmed: number };
};
export type CheckOptions = {
  /** Extra globs to leave out of searches (build output and `.illuminate/` are always left out). */
  ignore?: readonly string[];
  /** How far a cited line may have moved and still count (default 3). */
  lineWindow?: number;
};

const MAX_LOCATIONS = 20;
const fileOf = (symbol: string) => symbol.slice(0, symbol.indexOf('#'));
const within = (from: string, symbol: string) => from === symbol || from.startsWith(`${symbol}.`);
const short = (text: string) => (text.length > 60 ? `${text.slice(0, 57)}…` : text);

export function check(map: CodeMap, root: string, options: CheckOptions = {}): CheckReport {
  const repo = createRepoReader(root);
  const window = options.lineWindow ?? 3;
  const facts = factsFor(repo);
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  let repoFiles: string[] | null = null;
  const files = () => (repoFiles ??= listRepoFiles(repo.root, [...DEFAULT_IGNORE, ...(options.ignore ?? [])]).filter((f) => !isSecretPath(f)));

  const nodes: Record<string, ClaimCheck> = {};
  for (const n of map.nodes) nodes[n.id] = checkNode(n, repo, facts, window);
  const edges: Record<string, ClaimCheck> = {};
  for (const e of map.edges) edges[e.id] = checkEdge(e, byId, repo, facts, window);
  const absences: Record<string, AbsenceCheck> = {};
  for (const a of map.absences) absences[a.id] = checkAbsence(a, repo, files());

  const screens: Record<string, ScreenCheck> = {};
  for (const n of map.nodes) {
    const sc = checkScreen(n, repo);
    if (sc) screens[n.id] = sc;
  }

  const tour: Record<string, TourCheck> = {};
  for (const t of map.tour) {
    const unconfirmed = [
      ...(t.focus.nodes ?? []).filter((id) => nodes[id]?.status !== 'confirmed'),
      ...(t.focus.edges ?? []).filter((id) => edges[id]?.status !== 'confirmed'),
      ...(t.focus.absences ?? []).filter((id) => absences[id]?.status !== 'confirmed'),
    ];
    tour[t.id] = { status: unconfirmed.length ? 'mentions-unconfirmed' : 'ok', unconfirmed };
  }

  const all = [...Object.values(nodes), ...Object.values(edges), ...Object.values(absences)];
  const confirmed = all.filter((c) => c.status === 'confirmed').length;
  return { nodes, edges, absences, tour, screens, summary: { claims: all.length, confirmed, unconfirmed: all.length - confirmed } };
}

/** Facts per file, extracted on demand and cached for one check. */
function factsFor(repo: RepoReader) {
  const index = createFactsIndex(repo.root, fileExistsIn(repo.root), repo.text);
  const cache = new Map<string, FileFacts | null>();
  const get = (file: string): FileFacts | null => {
    if (!cache.has(file)) {
      const text = repo.text(file);
      cache.set(file, text === null ? null : index.extract(file, text).facts);
    }
    return cache.get(file) ?? null;
  };
  return {
    get,
    /** Calls made in `file`, settled against the symbols of `file` and `others`. */
    calls(file: string, others: readonly string[]): CallFact[] {
      const own = get(file);
      if (!own) return [];
      const known: Record<string, FileFacts> = {};
      for (const p of [file, ...others]) {
        const f = get(p);
        if (f) known[p] = f;
      }
      return settleCalls(own.calls, symbolNames(known));
    },
  };
}
type Facts = ReturnType<typeof factsFor>;

function checkEvidence(repo: RepoReader, e: Evidence, window: number): EvidenceCheck {
  const base = { file: e.file, line: e.line };
  const read = repo.read(e.file);
  if (!read.ok) return { ...base, ok: false, foundAt: null, reason: read.reason };
  const lines = read.text.split('\n');
  const want = squash(e.text);
  for (let d = 0; d <= window; d++) {
    for (const at of d === 0 ? [e.line] : [e.line - d, e.line + d]) {
      const line = lines[at - 1];
      if (line !== undefined && squash(line).includes(want)) return { ...base, ok: true, foundAt: at, reason: null };
    }
  }
  // Code moves (a fix above it, a new import). Text that appears on exactly one line of the file is still that line.
  const hits = lines.flatMap((line, i) => (squash(line).includes(want) ? [i + 1] : []));
  if (hits.length === 1) return { ...base, ok: true, foundAt: hits[0]!, reason: null };
  const reason =
    hits.length > 1
      ? `"${short(e.text)}" isn't on line ${e.line} or near it, and appears ${hits.length} times elsewhere in the file`
      : e.line > lines.length
        ? `the file has only ${lines.length} lines`
        : `"${short(e.text)}" isn't on line ${e.line} or near it`;
  return { ...base, ok: false, foundAt: null, reason };
}

function evidenceReasons(evidence: readonly EvidenceCheck[]): string[] {
  return evidence.filter((x) => !x.ok).map((x) => `${x.file}:${x.line}: ${x.reason}`);
}

function result(evidence: EvidenceCheck[], reasons: string[], proof: Proof): ClaimCheck {
  return reasons.length ? { status: 'unconfirmed', proof: null, evidence, reasons } : { status: 'confirmed', proof, evidence, reasons };
}

function checkNode(n: MapNode, repo: RepoReader, facts: Facts, window: number): ClaimCheck {
  const evidence = n.evidence.map((e) => checkEvidence(repo, e, window));
  const reasons = evidenceReasons(evidence);
  if (reasons.length || !n.symbol) return result(evidence, reasons, 'text');
  const found = facts.get(fileOf(n.symbol))?.symbols.some((s) => s.id === n.symbol);
  if (!found) reasons.push(`the code has no symbol ${n.symbol}`);
  return result(evidence, reasons, 'fact');
}

function checkEdge(e: MapEdge, byId: ReadonlyMap<string, MapNode>, repo: RepoReader, facts: Facts, window: number): ClaimCheck {
  const evidence = e.evidence.map((x) => checkEvidence(repo, x, window));
  const reasons = evidenceReasons(evidence);
  const from = byId.get(e.from);
  const to = byId.get(e.to);
  if (reasons.length || !from || !to || e.kind === 'then') return result(evidence, reasons, 'text');

  if (e.kind === 'calls') {
    if (!from.symbol || !to.symbol) return result(evidence, reasons, 'text');
    const calls = facts.calls(fileOf(from.symbol), [fileOf(to.symbol)]);
    if (!calls.some((c) => within(c.from, from.symbol!) && c.to === to.symbol)) reasons.push(`the code has no call from ${from.symbol} to ${to.symbol}`);
    return result(evidence, reasons, 'fact');
  }

  const fromFile = from.symbol ? fileOf(from.symbol) : from.evidence[0]!.file;
  const toFile = to.symbol ? fileOf(to.symbol) : to.evidence[0]!.file;
  const fromFacts = facts.get(fromFile);
  if (!fromFacts) {
    reasons.push(`${fromFile} can't be read`);
    return result(evidence, reasons, 'fact');
  }

  if (e.kind === 'imports') {
    if (!fromFacts.imports.some((i) => i.to === toFile)) reasons.push(`${fromFile} doesn't import ${toFile}`);
    return result(evidence, reasons, 'fact');
  }

  // request: a fetch in the `from` box (direct, or through a wrapper it imports) that matches a route in the `to` box.
  const neighbours = [fromFile, ...fromFacts.imports.filter((i) => !i.to.startsWith('vendor:')).map((i) => i.to)];
  const sources = neighbours.flatMap((path) => {
    const source = repo.text(path);
    const f = facts.get(path);
    return source !== null && f ? [{ path, source, symbols: f.symbols }] : [];
  });
  const routes = facts.get(toFile)?.routes ?? [];
  const matched = findFetchSites(sources).some((site) => {
    if (site.file !== fromFile || (from.symbol && !within(site.from, from.symbol))) return false;
    const m = matchRoute(site, routes);
    return !!m && (to.symbol ? m.route.handler === to.symbol : true);
  });
  if (!matched) reasons.push(`no request from ${from.symbol ?? fromFile} matches a route handled by ${to.symbol ?? toFile}`);
  return result(evidence, reasons, 'fact');
}

function checkAbsence(a: MapAbsence, repo: RepoReader, files: readonly string[]): AbsenceCheck {
  let pattern: RegExp;
  try {
    pattern = new RegExp(a.search.regex ? a.search.pattern : a.search.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  } catch {
    return { status: 'unconfirmed', found: 0, locations: [], reasons: ['the search pattern is not a valid regular expression'] };
  }
  let found = 0;
  const locations: { file: string; line: number }[] = [];
  for (const file of files) {
    if (a.search.paths && !matchesAny(a.search.paths, file)) continue;
    const text = repo.text(file);
    if (text === null) continue;
    text.split('\n').forEach((line, i) => {
      const n = line.match(pattern)?.length ?? 0;
      if (!n) return;
      found += n;
      if (locations.length < MAX_LOCATIONS) locations.push({ file, line: i + 1 });
    });
  }
  const reasons = found === a.matches ? [] : [`the search finds ${found} ${found === 1 ? 'match' : 'matches'}; the map says ${a.matches}`];
  return { status: reasons.length ? 'unconfirmed' : 'confirmed', found, locations, reasons };
}
