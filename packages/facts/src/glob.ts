// Glob matching for repo-relative paths. Compiled matchers are cached; dotfiles match.
import picomatch from 'picomatch';

const globCache = new Map<string, (path: string) => boolean>();

/** Compiled, cached picomatch matcher for a single glob (exact paths match themselves). */
export function globMatcher(glob: string): (path: string) => boolean {
  let m = globCache.get(glob);
  if (!m) {
    m = picomatch(glob, { dot: true });
    globCache.set(glob, m);
  }
  return m;
}

/** True if `path` matches any of `globs`. */
export function matchesAny(globs: readonly string[] | undefined, path: string): boolean {
  return !!globs && globs.some((g) => globMatcher(g)(path));
}
