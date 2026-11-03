// Maps on disk, in the target repo: `.codemap/maps/<id>.json`. Commit them to share; teammates re-check them against
// their own copy of the code when they open them.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseMap, slugify, type CodeMap } from '@codemap/core';

export type MapMeta = {
  id: string;
  question: string;
  createdAt: string;
  updatedAt: string;
  commit: string | null;
  makerSession: string | null;
  explainerSession: string | null;
  cost: number;
};
export type StoredMap = { meta: MapMeta; map: CodeMap };

const ID = /^[a-z0-9-]{1,80}$/;

export function createStore(root: string) {
  const base = path.join(root, '.codemap');
  const dir = path.join(base, 'maps');

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
      let raw: { meta?: MapMeta; map?: unknown };
      try {
        raw = JSON.parse(fs.readFileSync(file(id), 'utf8'));
      } catch {
        return null;
      }
      const parsed = parseMap(raw.map);
      return parsed.ok && raw.meta ? { meta: raw.meta, map: parsed.map } : null;
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
