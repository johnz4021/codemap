// Maps on disk, in the target repo: `.illuminate/maps/<id>.json`. Commit them to share; teammates re-check them against
// their own copy of the code when they open them. Each file also keeps the questions asked on the map with their
// answers, and where each proposed fix stands, so a reopened map still has its conversation.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseMap, slugify, type CodeMap } from '@illuminate/core';
import type { Answer } from './explainer';

export type MapMeta = {
  id: string;
  question: string;
  createdAt: string;
  updatedAt: string;
  commit: string | null;
  makerSession: string | null;
  explainerSession: string | null;
  cost: number;
  /** The map this one was started from, when a question there turned out to be about something else. */
  parent?: { mapId: string; question: string } | null;
};
/** Where a proposed fix stands. Undo isn't saved: it needs the files as they were, which only the running server has. */
export type SavedFix = { status: 'proposed' | 'applied' | 'rejected'; edgeId?: string | null; closed?: string[] };
export type StoredMap = { meta: MapMeta; map: CodeMap; answers?: Answer[]; fixes?: Record<string, SavedFix> };

const ID = /^[a-z0-9-]{1,80}$/;

export function createStore(root: string) {
  const base = path.join(root, '.illuminate');
  const dir = path.join(base, 'maps');
  // This tool used to be called codemap and kept its folder at `.codemap/`. Move it over once, so saved maps carry on.
  const legacy = path.join(root, '.codemap');
  if (!fs.existsSync(base) && fs.existsSync(path.join(legacy, 'maps'))) fs.renameSync(legacy, base);

  const ensure = () => {
    fs.mkdirSync(dir, { recursive: true });
    const ignore = path.join(base, '.gitignore');
    // Maps are worth committing; scratch output is not.
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, 'fixes/\nws-modules/\n');
  };
  const file = (id: string) => {
    if (!ID.test(id)) throw new Error(`Not a map id: ${id}`);
    return path.join(dir, `${id}.json`);
  };

  return {
    dir,
    get(id: string): StoredMap | null {
      let raw: { meta?: MapMeta; map?: unknown; answers?: unknown; fixes?: unknown };
      try {
        raw = JSON.parse(fs.readFileSync(file(id), 'utf8'));
      } catch {
        return null;
      }
      const parsed = parseMap(raw.map);
      if (!parsed.ok || !raw.meta) return null;
      // Maps saved before answers were kept have neither; a hand-edited file loses only what doesn't look right.
      const answers = Array.isArray(raw.answers)
        ? (raw.answers as Answer[]).filter((a) => a && typeof a.id === 'string' && typeof a.question === 'string' && Array.isArray(a.added))
        : [];
      const fixes = raw.fixes && typeof raw.fixes === 'object' && !Array.isArray(raw.fixes) ? (raw.fixes as Record<string, SavedFix>) : {};
      return { meta: raw.meta, map: parsed.map, answers, fixes };
    },
    save(stored: StoredMap): void {
      ensure();
      const target = file(stored.meta.id);
      const tmp = `${target}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`);
      fs.renameSync(tmp, target);
    },
    list(): MapMeta[] {
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .flatMap((f) => {
          try {
            const meta = (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { meta?: MapMeta }).meta;
            return meta ? [meta] : [];
          } catch {
            return [];
          }
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    /** A new id for a question, unique among saved maps and ids already handed out. */
    newId(question: string, taken: ReadonlySet<string> = new Set()): string {
      const base = slugify(question);
      for (let i = 1; ; i++) {
        const id = i === 1 ? base : `${base}-${i}`;
        if (!taken.has(id) && !fs.existsSync(file(id))) return id;
      }
    },
  };
}

export type Store = ReturnType<typeof createStore>;
