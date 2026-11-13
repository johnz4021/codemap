// Read-only access to the repo for the checker: paths can't leave the repo (symlinks included), secrets are never read,
// and big or binary files are skipped.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { matchesAny } from '@illuminate/facts';
import { isSafeRelativePath } from './format';

/** Never read, never searched, never sent anywhere. */
export const SECRET_GLOBS = ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/id_rsa*', '**/id_ed25519*', '**/.npmrc', '**/.netrc'];

export const MAX_FILE_BYTES = 2_000_000;

export type ReadResult = { ok: true; text: string } | { ok: false; reason: string };

export function isSecretPath(rel: string): boolean {
  return matchesAny(SECRET_GLOBS, rel) || matchesAny(SECRET_GLOBS, `/${rel}`);
}

export function createRepoReader(root: string) {
  const realRoot = fs.realpathSync(root);
  const cache = new Map<string, ReadResult>();

  const read = (rel: string): ReadResult => {
    const hit = cache.get(rel);
    if (hit) return hit;
    const result = readUncached(rel);
    cache.set(rel, result);
    return result;
  };

  const readUncached = (rel: string): ReadResult => {
    if (!isSafeRelativePath(rel)) return { ok: false, reason: 'path is outside the repo' };
    if (isSecretPath(rel)) return { ok: false, reason: 'secret files are never read' };
    let real: string;
    try {
      real = fs.realpathSync(path.join(realRoot, rel));
    } catch {
      return { ok: false, reason: 'file not found' };
    }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return { ok: false, reason: 'path is outside the repo' };
    const stat = fs.statSync(real);
    if (!stat.isFile()) return { ok: false, reason: 'not a file' };
    if (stat.size > MAX_FILE_BYTES) return { ok: false, reason: 'file is too large to check' };
    const text = fs.readFileSync(real, 'utf8');
    if (text.slice(0, 8000).includes('\u0000')) return { ok: false, reason: 'binary file' };
    return { ok: true, text };
  };

  return { root: realRoot, read, text: (rel: string) => { const r = read(rel); return r.ok ? r.text : null; } };
}

export type RepoReader = ReturnType<typeof createRepoReader>;
