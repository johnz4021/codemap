// Everything the map screen shows, as a pure reducer over server payloads, live events and clicks.
import type { MapPayload } from './api';
import type { Answer, CheckReport, CodeMap, FixProposal, MapMeta, Selection, ServerEvent } from './types';

export type Sel = { nodes: string[]; edges: string[]; absences: string[] };
export const emptySel = (): Sel => ({ nodes: [], edges: [], absences: [] });
export const selSize = (s: Sel) => s.nodes.length + s.edges.length + s.absences.length;

/** Where the map is looking: one item in focus, and what's lit up (everything else dims). */
export type View = { focus: string | null; highlight: string[] };
export type FixState = {
  proposal: FixProposal;
  answerId: string;
  status: 'proposed' | 'applying' | 'applied' | 'rejected' | 'undone' | 'failed';
  problems: string[];
  edgeId: string | null;
  closed: string[];
  /** Undo needs the files as they were, which only the server that applied the fix has. */
  undoable: boolean;
};

export type State = {
  mapId: string;
  phase: 'loading' | 'making' | 'ready' | 'failed' | 'missing';
  meta: MapMeta | null;
  map: CodeMap | null;
  report: CheckReport | null;
  job: { kind: 'make' | 'ask'; question: string; progress: string[] } | null;
  error: string | null;
  answers: Answer[];
  /** The answer shown in the panel. */
  shown: string | null;
  selection: Sel;
  /** Walkthrough stop, while touring. */
  tour: number | null;
  views: View[];
  viewIndex: number;
  fixes: Record<string, FixState>;
  /** Added to the map by the latest answer (drawn with a NEW badge). */
  fresh: string[];
  /** Answers whose additions are hidden, so the map looks more like it did when it was first drawn. */
  hidden: string[];
  connected: boolean;
};

export type Action =
  | { type: 'loaded'; payload: MapPayload }
  | { type: 'missing' }
  | { type: 'event'; event: ServerEvent }
  | { type: 'connected'; value: boolean }
  | { type: 'select'; kind: keyof Sel; id: string; additive: boolean }
  | { type: 'selectMany'; selection: Sel }
  | { type: 'clearSelection' }
  | { type: 'tour'; stop: number | null }
  | { type: 'focus'; id: string }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'show'; answerId: string | null }
  /** Back to the whole map: close the answer, leave the walkthrough, clear the selection and highlighting. */
  | { type: 'overview' }
  | { type: 'layer'; answerId: string; visible: boolean }
  | { type: 'allLayers'; visible: boolean }
  | { type: 'fixStatus'; fixId: string; status: FixState['status']; problems?: string[] }
  | { type: 'error'; message: string | null };

export const initialState = (mapId: string): State => ({
  mapId,
  phase: 'loading',
  meta: null,
  map: null,
  report: null,
  job: null,
  error: null,
  answers: [],
  shown: null,
  selection: emptySel(),
  tour: null,
  views: [],
  viewIndex: -1,
  fixes: {},
  fresh: [],
  hidden: [],
  connected: false,
});

export const currentView = (s: State): View | null => s.views[s.viewIndex] ?? null;

/** What each answer added that is still on the map: the layers someone can show or hide. */
export function layersOf(s: State): { answerId: string; question: string; ids: string[]; visible: boolean }[] {
  if (!s.map) return [];
  const live = new Set([...s.map.areas, ...s.map.nodes, ...s.map.edges, ...s.map.absences].map((x) => x.id));
  return s.answers.flatMap((a) => {
    const ids = a.added.filter((id) => live.has(id));
    return ids.length ? [{ answerId: a.id, question: a.question, ids, visible: !s.hidden.includes(a.id) }] : [];
  });
}

/** Everything answers added (shown or not): the layout keeps the original map's boxes in place around these. */
export const addedIds = (s: State): string[] => layersOf(s).flatMap((l) => l.ids);

/** The map as drawn: without hidden layers, or arrows and gaps that lost an end. */
export function visibleMap(s: State): CodeMap | null {
  if (!s.map) return null;
  const hide = new Set(layersOf(s).filter((l) => !l.visible).flatMap((l) => l.ids));
  if (!hide.size) return s.map;
  const nodes = s.map.nodes.filter((n) => !hide.has(n.id));
  const kept = new Set(nodes.map((n) => n.id));
  return {
    ...s.map,
    areas: s.map.areas.filter((a) => !hide.has(a.id)),
    nodes,
    edges: s.map.edges.filter((e) => !hide.has(e.id) && kept.has(e.from) && kept.has(e.to)),
    absences: s.map.absences.filter((a) => !hide.has(a.id) && (!a.between || (kept.has(a.between.from) && kept.has(a.between.to)))),
  };
}

/** The selection, minus anything not drawn. */
function keepDrawn(selection: Sel, map: CodeMap | null): Sel {
  if (!map) return selection;
  const on = (ids: string[], list: readonly { id: string }[]) => ids.filter((id) => list.some((x) => x.id === id));
  return { nodes: on(selection.nodes, map.nodes), edges: on(selection.edges, map.edges), absences: on(selection.absences, map.absences) };
}

/** What a tour stop lights up: its boxes, arrows and gaps, and every box in the areas it names. */
export function stopView(map: CodeMap, stop: number): View | null {
  const t = map.tour[stop];
  if (!t) return null;
  const inAreas = map.nodes.filter((n) => t.focus.areas?.includes(n.area)).map((n) => n.id);
  const highlight = [...(t.focus.nodes ?? []), ...(t.focus.edges ?? []), ...(t.focus.absences ?? []), ...inAreas];
  const between = (t.focus.edges ?? []).length || (t.focus.absences ?? []).length ? [] : edgesWithin(map, new Set(highlight));
  return { focus: t.focus.nodes?.[0] ?? t.focus.edges?.[0] ?? t.focus.absences?.[0] ?? null, highlight: [...new Set([...highlight, ...between])] };
}

/** Arrows whose both ends are in `ids` (so a highlighted path shows its arrows too). */
export function edgesWithin(map: CodeMap, ids: ReadonlySet<string>): string[] {
  return map.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => e.id);
}

/** What a reply is about on the map: its path and what it added (with the arrows between them), or nothing to move to. */
function answerView(map: CodeMap | null, answer: Answer): View | null {
  const ids = [...answer.moves.highlight, ...answer.added];
  const highlight = map ? [...new Set([...ids, ...edgesWithin(map, new Set(ids))])] : ids;
  return highlight.length || answer.moves.focus ? { focus: answer.moves.focus ?? highlight[0] ?? null, highlight } : null;
}

function pushView(s: State, view: View | null): State {
  if (!view) return s;
  const views = [...s.views.slice(0, s.viewIndex + 1), view].slice(-50);
  return { ...s, views, viewIndex: views.length - 1 };
}

/** Fix states for answers' proposals. `known` is the server's view (on load); new answers' fixes start as proposed. */
function fixesFrom(answers: Answer[], prev: Record<string, FixState>, known: MapPayload['fixes'] | undefined): Record<string, FixState> {
  const out = { ...prev };
  for (const a of answers) {
    if (!a.fix || (out[a.fix.id] && !known)) continue;
    const k = known ? known[a.fix.id] : { status: 'proposed' as const };
    out[a.fix.id] = { proposal: a.fix, answerId: a.id, status: k?.status ?? 'rejected', problems: [], edgeId: k?.edgeId ?? null, closed: k?.closed ?? [], undoable: k?.undoable ?? true };
  }
  return out;
}

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'loaded': {
      const p = a.payload;
      const phase = p.map ? 'ready' : p.job ? 'making' : p.failure ? 'failed' : 'missing';
      return {
        ...s,
        phase,
        meta: p.meta,
        map: p.map,
        report: p.report,
        job: p.job,
        error: p.failure?.error ?? null,
        answers: p.answers,
        // A reopened map starts at its overview (and walkthrough), not at the last answer.
        shown: null,
        fixes: fixesFrom(p.answers, s.fixes, p.fixes ?? {}),
      };
    }
    case 'missing':
      return { ...s, phase: 'missing' };
    case 'connected':
      return { ...s, connected: a.value };
    case 'event': {
      const e = a.event;
      if (e.mapId !== s.mapId) return s;
      if (e.type === 'job') {
        if (e.status === 'started') return { ...s, job: { kind: e.job, question: e.question, progress: [] }, error: null, phase: e.job === 'make' ? 'making' : s.phase };
        if (e.status === 'failed') return { ...s, job: null, error: e.error ?? 'Something went wrong.', phase: e.job === 'make' && !s.map ? 'failed' : s.phase };
        return { ...s, job: null };
      }
      if (e.type === 'progress') return s.job ? { ...s, job: { ...s.job, progress: [...s.job.progress, e.text].slice(-200) } } : s;
      if (e.type === 'map') {
        const keep = (ids: string[]) => ids.filter((id) => e.map.nodes.some((n) => n.id === id) || e.map.edges.some((x) => x.id === id) || e.map.absences.some((x) => x.id === id));
        const selection = { nodes: keep(s.selection.nodes), edges: keep(s.selection.edges), absences: keep(s.selection.absences) };
        return { ...s, phase: 'ready', meta: e.meta, map: e.map, report: e.report, selection };
      }
      if (e.type === 'answer') {
        const answers = [...s.answers, e.answer];
        const next: State = { ...s, answers, shown: e.answer.id, tour: null, fresh: e.answer.added, fixes: fixesFrom([e.answer], s.fixes, undefined) };
        return pushView(next, answerView(s.map, e.answer));
      }
      if (e.type === 'answerUpdate') return { ...s, answers: s.answers.map((x) => (x.id === e.answer.id ? e.answer : x)) };
      if (e.type === 'fix') {
        const f = s.fixes[e.fixId];
        if (!f) return s;
        const status: FixState['status'] = e.status;
        const fixes = { ...s.fixes, [e.fixId]: { ...f, status, problems: e.problems ?? [], edgeId: e.edgeId ?? f.edgeId, closed: e.closed ?? f.closed, undoable: e.status === 'applied' ? true : f.undoable } };
        const next = { ...s, fixes };
        if (e.status === 'applied' && e.edgeId) {
          const c = f.proposal.connects;
          return pushView(next, { focus: e.edgeId, highlight: [e.edgeId, ...(c ? [c.from, c.to] : [])] });
        }
        return next;
      }
      return s;
    }
    case 'select': {
      const list = s.selection[a.kind];
      const has = list.includes(a.id);
      const selection = a.additive
        ? { ...s.selection, [a.kind]: has ? list.filter((x) => x !== a.id) : [...list, a.id] }
        : { ...emptySel(), [a.kind]: has && selSize(s.selection) === 1 ? [] : [a.id] };
      return { ...s, selection };
    }
    case 'selectMany':
      return { ...s, selection: a.selection };
    case 'clearSelection':
      return { ...s, selection: emptySel() };
    case 'tour': {
      if (a.stop === null || !s.map) return { ...s, tour: null };
      const stop = Math.max(0, Math.min(a.stop, s.map.tour.length - 1));
      return pushView({ ...s, tour: stop, selection: emptySel() }, stopView(s.map, stop));
    }
    case 'focus': {
      if (!s.map) return s;
      const kind: keyof Sel | null = s.map.nodes.some((n) => n.id === a.id) ? 'nodes' : s.map.edges.some((e) => e.id === a.id) ? 'edges' : s.map.absences.some((x) => x.id === a.id) ? 'absences' : null;
      if (!kind) return s;
      return pushView({ ...s, tour: null, selection: { ...emptySel(), [kind]: [a.id] } }, { focus: a.id, highlight: [a.id] });
    }
    case 'back':
      return s.viewIndex > 0 ? { ...s, viewIndex: s.viewIndex - 1 } : s.viewIndex === 0 ? { ...s, viewIndex: -1 } : s;
    case 'forward':
      return s.viewIndex < s.views.length - 1 ? { ...s, viewIndex: s.viewIndex + 1 } : s;
    case 'show': {
      // Going back to an earlier reply lights up what it was about again.
      const answer = s.answers.find((x) => x.id === a.answerId);
      return pushView({ ...s, shown: a.answerId, tour: null }, answer ? answerView(s.map, answer) : null);
    }
    case 'overview':
      return pushView({ ...s, shown: null, tour: null, selection: emptySel(), fresh: [] }, { focus: null, highlight: [] });
    case 'layer':
    case 'allLayers': {
      const ids = a.type === 'layer' ? [a.answerId] : layersOf(s).map((l) => l.answerId);
      const hidden = a.visible ? s.hidden.filter((id) => !ids.includes(id)) : [...new Set([...s.hidden, ...ids])];
      const next = { ...s, hidden };
      return { ...next, selection: keepDrawn(s.selection, visibleMap(next)) };
    }
    case 'fixStatus': {
      const f = s.fixes[a.fixId];
      return f ? { ...s, fixes: { ...s.fixes, [a.fixId]: { ...f, status: a.status, problems: a.problems ?? f.problems } } } : s;
    }
    case 'error':
      return { ...s, error: a.message };
  }
}

/** The selection as the server wants it. */
export const toSelection = (s: Sel): Selection => ({ nodes: s.nodes, edges: s.edges, absences: s.absences });
