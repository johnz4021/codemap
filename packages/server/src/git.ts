// The little git codemap needs: which commit a map was made from, and whether a file has uncommitted changes.
import { execFileSync } from 'node:child_process';

const git = (root: string, args: string[]): string | null => {
  try {
    return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
};

export const headCommit = (root: string): string | null => git(root, ['rev-parse', 'HEAD']) || null;

/** True when git reports the file as modified, added or untracked. False outside a git repo. */
export const hasUncommittedChanges = (root: string, file: string): boolean => !!git(root, ['status', '--porcelain', '--', file]);
