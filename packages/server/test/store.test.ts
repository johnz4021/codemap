import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStore } from '../src/store';
import { cleanup, copyCareApp } from './helpers';

afterEach(cleanup);

describe('maps saved under the old name', () => {
  it('moves a .codemap folder to .illuminate, so its maps still open', () => {
    const root = copyCareApp();
    mkdirSync(join(root, '.codemap/maps'), { recursive: true });
    const meta = { id: 'old-map', question: 'Old?', createdAt: 'x', updatedAt: 'x', commit: null, makerSession: null, explainerSession: null, cost: 0 };
    writeFileSync(join(root, '.codemap/maps/old-map.json'), JSON.stringify({ meta, map: {} }));

    const store = createStore(root);
    expect(existsSync(join(root, '.codemap'))).toBe(false);
    expect(existsSync(join(root, '.illuminate/maps/old-map.json'))).toBe(true);
    expect(store.list().map((m) => m.id)).toEqual(['old-map']);
  });

  it('leaves .codemap alone when .illuminate already exists', () => {
    const root = copyCareApp();
    mkdirSync(join(root, '.codemap/maps'), { recursive: true });
    mkdirSync(join(root, '.illuminate/maps'), { recursive: true });
    createStore(root);
    expect(existsSync(join(root, '.codemap/maps'))).toBe(true);
  });
});
