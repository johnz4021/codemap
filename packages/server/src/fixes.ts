// Fixing from the map. Claude proposes; this module validates the proposal, and after the person approves it writes
// exactly the reviewed change: only if the files haven't changed since, never to secrets or outside the repo, with
// the originals kept for undo. Then the map gets the new connection and drops the gap it closed.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRepoReader, freshId, isSafeRelativePath, isSecretPath, parseMap, removeAbsences, type CodeMap } from '@illuminate/core';
import { hasUncommittedChanges } from './git';
import type { RawFix } from './schemas';

export type FixFile = { file: string; change: 'edit' | 'create'; hash: string | null; uncommitted: boolean };
export type FixProposal = {
  id: string;
  summary: string;
  edits: RawFix['edits'];
  creates: RawFix['creates'];
  connects: NonNullable<RawFix['connects']> | null;
  files: FixFile[];
  /** A readable before/after of every change, for the person approving it. */
  diff: string;
};
export type AppliedFix = {
  proposal: FixProposal;
  originals: { file: string; content: string | null }[];
  written: { file: string; hash: string }[];
};
export type Problems = { ok: false; problems: string[] };

const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const occurrences = (text: string, find: string) => text.split(find).length - 1;
const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

function allowed(file: string): string | null {
  if (!isSafeRelativePath(file)) return `${file}: must be a path inside the repo`;
  if (isSecretPath(file) || file === '.illuminate' || file.startsWith('.illuminate/')) return `${file}: illuminate never changes this file`;
  return null;
}

export function proposeFix(root: string, map: CodeMap, raw: RawFix): { ok: true; proposal: FixProposal } | Problems {
  const repo = createRepoReader(root);
  const problems: string[] = [];
  const after = new Map<string, string>();
  const before = new Map<string, string>();
  const diff: string[] = [];

  if (!raw.edits.length && !raw.creates.length) problems.push('the fix changes nothing');
  for (const e of raw.edits) {
    const bad = allowed(e.file);
    if (bad) { problems.push(bad); continue; }
    if (!before.has(e.file)) {
      const read = repo.read(e.file);
      if (!read.ok) { problems.push(`${e.file}: ${read.reason}`); continue; }
      before.set(e.file, read.text);
      after.set(e.file, read.text);
    }
    const current = after.get(e.file)!;
    const n = occurrences(current, e.find);
    if (n !== 1) { problems.push(`${e.file}: the text to replace appears ${n} times (it must appear exactly once)`); continue; }
    const at = current.indexOf(e.find);
    diff.push(`${e.file} · line ${lineOf(current, at)}`, ...e.find.split('\n').map((l) => `- ${l}`), ...e.replace.split('\n').map((l) => `+ ${l}`), '');
    after.set(e.file, current.slice(0, at) + e.replace + current.slice(at + e.find.length));
  }
  for (const c of raw.creates) {
    const bad = allowed(c.file);
    if (bad) { problems.push(bad); continue; }
    if (fs.existsSync(path.join(root, c.file)) || after.has(c.file)) { problems.push(`${c.file}: already exists`); continue; }
    after.set(c.file, c.content);
    diff.push(`${c.file} · new file`, ...c.content.replace(/\n$/, '').split('\n').map((l) => `+ ${l}`), '');
  }

  const connects = raw.connects ?? null;
  if (connects) {
    const ids = new Set(map.nodes.map((n) => n.id));
    if (!ids.has(connects.from) || !ids.has(connects.to)) problems.push(`the new connection must join two boxes on the map (${connects.from} → ${connects.to})`);
    if (!(after.get(connects.evidenceFile) ?? '').includes(connects.evidenceText)) {
      problems.push(`the new connection's evidence ("${connects.evidenceText}") isn't in the changed ${connects.evidenceFile}`);
    }
  }
  if (problems.length) return { ok: false, problems };

  const files: FixFile[] = [...after.keys()].map((file) => ({
    file,
    change: before.has(file) ? 'edit' : 'create',
    hash: before.has(file) ? sha(before.get(file)!) : null,
    uncommitted: before.has(file) && hasUncommittedChanges(root, file),
  }));
  const proposal: FixProposal = {
    id: `fix-${crypto.randomBytes(4).toString('hex')}`,
    summary: raw.summary,
    edits: raw.edits,
    creates: raw.creates,
    connects,
    files,
    diff: diff.join('\n').trimEnd(),
  };
  return { ok: true, proposal };
}

/** Writes the approved change. Refuses if any file changed since the proposal (someone, or your agent, edited it). */
export function applyFix(root: string, proposal: FixProposal): { ok: true; applied: AppliedFix } | Problems {
  const problems: string[] = [];
  const contents = new Map<string, string>();
  const originals: AppliedFix['originals'] = [];
  for (const f of proposal.files) {
    const abs = path.join(root, f.file);
    if (f.change === 'create') {
      if (fs.existsSync(abs)) problems.push(`${f.file} was created since this fix was proposed`);
      originals.push({ file: f.file, content: null });
      continue;
    }
    const text = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    if (text === null || sha(text) !== f.hash) { problems.push(`${f.file} changed since this fix was proposed; ask for the fix again`); continue; }
    contents.set(f.file, text);
    originals.push({ file: f.file, content: text });
  }
  if (problems.length) return { ok: false, problems };

  for (const e of proposal.edits) {
    const text = contents.get(e.file)!;
    contents.set(e.file, text.replace(e.find, () => e.replace));
  }
  for (const c of proposal.creates) contents.set(c.file, c.content);

  const backup = path.join(root, '.illuminate', 'fixes', proposal.id);
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(backup, 'originals.json'), JSON.stringify({ proposal, originals }, null, 2));
  const written: AppliedFix['written'] = [];
  for (const [file, text] of contents) {
    const abs = path.join(root, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    written.push({ file, hash: sha(text) });
  }
  return { ok: true, applied: { proposal, originals, written } };
}

/** Puts the files back, unless they were changed again after the fix (then undoing would lose that work). */
export function undoFix(root: string, applied: AppliedFix): { ok: true } | Problems {
  const problems: string[] = [];
  for (const w of applied.written) {
    const abs = path.join(root, w.file);
    const text = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    if (text === null || sha(text) !== w.hash) problems.push(`${w.file} changed after the fix; undo it by hand`);
  }
  if (problems.length) return { ok: false, problems };
  for (const o of applied.originals) {
    const abs = path.join(root, o.file);
    if (o.content === null) fs.rmSync(abs, { force: true });
    else fs.writeFileSync(abs, o.content);
  }
  return { ok: true };
}

/** After a fix lands: draw its new connection (evidence located in the new code), and drop the gap it closed. */
export function connectAfterFix(root: string, map: CodeMap, proposal: FixProposal): { map: CodeMap; edgeId: string | null; closed: string[] } {
  const c = proposal.connects;
  if (!c) return { map, edgeId: null, closed: [] };
  const text = createRepoReader(root).text(c.evidenceFile) ?? '';
  const index = text.indexOf(c.evidenceText);
  if (index < 0) return { map, edgeId: null, closed: [] };
  const id = freshId(map, 'fx');
  const parsed = parseMap({
    ...map,
    edges: [...map.edges, { id, from: c.from, to: c.to, kind: 'then', label: c.label, evidence: [{ file: c.evidenceFile, line: lineOf(text, index), text: c.evidenceText }] }],
  });
  if (!parsed.ok) return { map, edgeId: null, closed: [] };
  const closed = parsed.map.absences
    .filter((a) => a.between && ((a.between.from === c.from && a.between.to === c.to) || (a.between.from === c.to && a.between.to === c.from)))
    .map((a) => a.id);
  return { map: removeAbsences(parsed.map, closed), edgeId: id, closed };
}
