// The map screen's state: loading, live events, selection, the walkthrough, back/forward, answers and fixes.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { check, parseMap } from '@illuminate/core';
import { addedIds, currentView, initialState, layersOf, reducer, stopView, visibleMap, type State } from '../src/state';
import type { Answer, FixProposal } from '../src/types';

const APP = fileURLToPath(new URL('../../core/test/fixtures/care-app', import.meta.url));
const map = (() => {
  const r = parseMap(JSON.parse(readFileSync(fileURLToPath(new URL('../../core/test/fixtures/care-app.map.json', import.meta.url)), 'utf8')));
  if (!r.ok) throw new Error(r.problems.join('\n'));
  return r.map;
})();
const report = check(map, APP);
const meta = { id: 'patient-converts', question: map.question, createdAt: '', updatedAt: '', commit: null, makerSession: null, explainerSession: null, cost: 0 };

const ready = (): State => reducer(initialState('patient-converts'), { type: 'loaded', payload: { meta, map, report, job: null, failure: null, answers: [] } });

const fix: FixProposal = {
  id: 'fix-1', summary: 'Listen for it', edits: [], creates: [], files: [], diff: '',
  connects: { from: 's4', to: 'u1', label: 'now listens', evidenceFile: 'x.ts', evidenceText: 'bus.on' },
};
const answer = (over: Partial<Answer> = {}): Answer => ({
  id: 'a1', question: 'q', selection: {}, concept: 'c', refs: [],
  moves: { focus: 's4', highlight: ['s4', 'miss'] }, added: [], problems: [], fix: null, source: 'code', cost: 0, ...over,
});

describe('reducer', () => {
  it('shows a map being made, its progress, then the map', () => {
    let s = reducer(initialState('patient-converts'), { type: 'loaded', payload: { meta: null, map: null, report: null, job: { kind: 'make', question: 'q', progress: [] }, failure: null, answers: [] } });
    expect(s.phase).toBe('making');
    s = reducer(s, { type: 'event', event: { type: 'progress', mapId: 'patient-converts', job: 'make', kind: 'read', text: 'Reading a.ts' } });
    expect(s.job?.progress).toEqual(['Reading a.ts']);
    s = reducer(s, { type: 'event', event: { type: 'map', mapId: 'patient-converts', meta, map, report } });
    s = reducer(s, { type: 'event', event: { type: 'job', mapId: 'patient-converts', job: 'make', status: 'done', question: 'q' } });
    expect(s.phase).toBe('ready');
    expect(s.job).toBeNull();
  });

  it('ignores events for other maps', () => {
    const s = ready();
    expect(reducer(s, { type: 'event', event: { type: 'progress', mapId: 'other', job: 'ask', kind: 'read', text: 'x' } })).toBe(s);
  });

  it('selects one thing, or several with shift', () => {
    let s = reducer(ready(), { type: 'select', kind: 'nodes', id: 's1', additive: false });
    s = reducer(s, { type: 'select', kind: 'edges', id: 'e12', additive: true });
    expect(s.selection).toEqual({ nodes: ['s1'], edges: ['e12'], absences: [] });
    s = reducer(s, { type: 'select', kind: 'absences', id: 'miss', additive: false });
    expect(s.selection).toEqual({ nodes: [], edges: [], absences: ['miss'] });
  });

  it('walks the tour: each stop lights up what it is about, and back/forward retraces it', () => {
    let s = reducer(ready(), { type: 'tour', stop: 0 });
    expect(currentView(s)!.highlight).toEqual(expect.arrayContaining(['s1', 's2', 's3', 's4', 'u1', 'u2', 'u3', 'e12', 'e23']));
    s = reducer(s, { type: 'tour', stop: 1 });
    expect(currentView(s)).toEqual({ focus: 's4', highlight: ['s4', 'u1', 'miss'] });
    s = reducer(s, { type: 'back' });
    expect(currentView(s)!.focus).toBeNull();
    s = reducer(s, { type: 'forward' });
    expect(currentView(s)!.focus).toBe('s4');
    s = reducer(s, { type: 'tour', stop: 99 });
    expect(s.tour).toBe(1); // clamped to the last stop
  });

  it('an answer leaves the tour, shows itself, and moves the map to what it is about', () => {
    let s = reducer(ready(), { type: 'tour', stop: 0 });
    s = reducer(s, { type: 'event', event: { type: 'answer', mapId: 'patient-converts', answer: answer({ added: ['n9'] }) } });
    expect(s.tour).toBeNull();
    expect(s.shown).toBe('a1');
    expect(s.fresh).toEqual(['n9']);
    expect(currentView(s)).toEqual({ focus: 's4', highlight: ['s4', 'miss', 'n9'] });
  });

  it('closing an answer goes back to the whole map, with the walkthrough on offer again', () => {
    let s = reducer(ready(), { type: 'event', event: { type: 'answer', mapId: 'patient-converts', answer: answer({ added: ['n9'] }) } });
    s = reducer(s, { type: 'select', kind: 'nodes', id: 's1', additive: false });
    s = reducer(s, { type: 'overview' });
    expect(s).toMatchObject({ shown: null, tour: null, fresh: [], selection: { nodes: [], edges: [], absences: [] } });
    expect(currentView(s)).toEqual({ focus: null, highlight: [] });
    expect(s.answers).toHaveLength(1); // still there to reopen
  });

  it('going back to an earlier reply lights up what it was about again', () => {
    let s = reducer(ready(), { type: 'event', event: { type: 'answer', mapId: 'patient-converts', answer: answer({ id: 'a1' }) } });
    s = reducer(s, { type: 'overview' });
    expect(currentView(s)).toEqual({ focus: null, highlight: [] });
    s = reducer(s, { type: 'show', answerId: 'a1' });
    expect(s.shown).toBe('a1');
    expect(currentView(s)).toEqual({ focus: 's4', highlight: ['s4', 'miss'] });
  });

  it('updates an answer in place when its offer of a new map is taken up', () => {
    const offer = { question: 'How do invoices get sent?', existing: null, status: 'pending' as const, mapId: null };
    let s = reducer(ready(), { type: 'event', event: { type: 'answer', mapId: 'patient-converts', answer: answer({ id: 'a1', concept: '', offer }) } });
    s = reducer(s, { type: 'event', event: { type: 'answerUpdate', mapId: 'patient-converts', answer: answer({ id: 'a1', concept: '', offer: { ...offer, status: 'mapped', mapId: 'invoices' } }) } });
    expect(s.answers).toHaveLength(1);
    expect(s.answers[0]!.offer).toMatchObject({ status: 'mapped', mapId: 'invoices' });
    expect(s.shown).toBe('a1');
  });

  it('a reopened map starts at its overview, not at the last answer', () => {
    const s = reducer(initialState('patient-converts'), { type: 'loaded', payload: { meta, map, report, job: null, failure: null, answers: [answer()] } });
    expect(s.shown).toBeNull();
    expect(s.answers).toHaveLength(1);
  });

  it('shows or hides what each answer added, back to the original map', () => {
    const grown = {
      ...map,
      nodes: [...map.nodes, { ...map.nodes[0]!, id: 'n9' }],
      edges: [...map.edges, { ...map.edges[0]!, id: 'e9', from: 's4', to: 'n9' }],
    };
    let s = reducer(initialState('patient-converts'), { type: 'loaded', payload: { meta, map: grown, report, job: null, failure: null, answers: [answer({ id: 'a1', question: 'Where?', added: ['n9', 'e9', 'gone'] }), answer({ id: 'a2' })] } });
    expect(layersOf(s)).toEqual([{ answerId: 'a1', question: 'Where?', ids: ['n9', 'e9'], visible: true }]); // only what's still on the map
    expect(addedIds(s)).toEqual(['n9', 'e9']);
    expect(visibleMap(s)).toBe(s.map);

    s = reducer(s, { type: 'select', kind: 'nodes', id: 'n9', additive: false });
    s = reducer(s, { type: 'layer', answerId: 'a1', visible: false });
    expect(visibleMap(s)!.nodes.map((n) => n.id)).toEqual(map.nodes.map((n) => n.id));
    expect(visibleMap(s)!.edges.map((e) => e.id)).toEqual(map.edges.map((e) => e.id));
    expect(s.selection.nodes).toEqual([]); // a hidden box can't stay selected
    expect(addedIds(s)).toEqual(['n9', 'e9']); // the layout still knows what was added

    s = reducer(s, { type: 'allLayers', visible: true });
    expect(visibleMap(s)!.nodes).toHaveLength(map.nodes.length + 1);
  });

  it('tracks a fix from proposal to applied, and focuses the new connection', () => {
    let s = reducer(ready(), { type: 'event', event: { type: 'answer', mapId: 'patient-converts', answer: answer({ fix }) } });
    expect(s.fixes['fix-1']!.status).toBe('proposed');
    s = reducer(s, { type: 'fixStatus', fixId: 'fix-1', status: 'applying' });
    s = reducer(s, { type: 'event', event: { type: 'fix', mapId: 'patient-converts', fixId: 'fix-1', status: 'applied', edgeId: 'fx1', closed: ['miss'] } });
    expect(s.fixes['fix-1']).toMatchObject({ status: 'applied', edgeId: 'fx1', closed: ['miss'], undoable: true });
    expect(currentView(s)).toEqual({ focus: 'fx1', highlight: ['fx1', 's4', 'u1'] });
  });

  it('after a reload, shows each fix as the server has it: waiting, applied (with its new connection), or rejected', () => {
    const answers = [answer({ id: 'a1', fix }), answer({ id: 'a2', fix: { ...fix, id: 'fix-2' } }), answer({ id: 'a3', fix: { ...fix, id: 'fix-3' } })];
    const s = reducer(initialState('patient-converts'), {
      type: 'loaded',
      payload: { meta, map, report, job: null, failure: null, answers, fixes: { 'fix-1': { status: 'applied', edgeId: 'fx1', closed: ['miss'], undoable: false }, 'fix-2': { status: 'proposed' } } },
    });
    expect(s.fixes['fix-1']).toMatchObject({ status: 'applied', edgeId: 'fx1', closed: ['miss'], undoable: false }); // applied before a restart
    expect(s.fixes['fix-2']!.status).toBe('proposed');
    expect(s.fixes['fix-3']!.status).toBe('rejected');
  });

  it('drops selected things that disappear from the map', () => {
    let s = reducer(ready(), { type: 'select', kind: 'absences', id: 'miss', additive: false });
    s = reducer(s, { type: 'event', event: { type: 'map', mapId: 'patient-converts', meta, map: { ...map, absences: [] }, report } });
    expect(s.selection.absences).toEqual([]);
  });

  it('focuses one thing by id, selecting it', () => {
    const s = reducer(ready(), { type: 'focus', id: 'e23' });
    expect(s.selection.edges).toEqual(['e23']);
    expect(currentView(s)).toEqual({ focus: 'e23', highlight: ['e23'] });
  });
});

describe('stopView', () => {
  it('lights up the arrows inside a stop that names only boxes or areas', () => {
    expect(stopView(map, 0)!.highlight).toEqual(expect.arrayContaining(['e12', 'e23', 'e34', 'eu12', 'eu23']));
  });
});
