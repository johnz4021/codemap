// The two screens: the list of maps (with a box to ask a new question), and a map with its panel and input bar. Moving
// between them doesn't reload the page.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { ApiError, api, connect, pageUrl, token } from './api';
import { Composer } from './composer';
import { Dock } from './dock';
import { ConversationButton } from './history';
import { MapGraph } from './graph';
import { Home } from './home';
import { navigate, usePath } from './nav';
import { StopButton, Stopped } from './stop';
import { Panel } from './panel';
import { PanelResizer, usePanelWidth } from './resize';
import { TourBubble } from './tour';
import { inOverview, overviewOf } from './overview';
import { addedIds, currentView, initialState, reducer, selSize, visibleMap, type Sel } from './state';
import type { CheckReport } from './types';

export function App() {
  if (!token) {
    return (
      <main className="home">
        <h1>Open illuminate from its link</h1>
        <p className="muted lede">Use the link illuminate printed in your terminal (it ends in <code>?t=…</code>).</p>
      </main>
    );
  }
  return <Screens />;
}

function Screens() {
  const [stopped, setStopped] = useState(false);
  // Stopping closes the tab. Browsers only let a page close itself in some cases (a tab with one page of history), so
  // when that's refused the tab says illuminate stopped instead.
  const onStopped = useCallback(() => {
    window.close();
    setStopped(true);
  }, []);
  const path = usePath();
  if (stopped) return <Stopped />;
  const m = /^\/m\/([a-z0-9-]{1,80})\/?$/.exec(path);
  return m ? <MapScreen key={m[1]} mapId={m[1]!} onStopped={onStopped} /> : <Home onStopped={onStopped} />;
}

/** Every map in this repo, to jump between, with the current one showing. */
function MapSwitcher({ mapId, question }: { mapId: string; question: string }) {
  const [maps, setMaps] = useState<{ id: string; question: string; making?: boolean }[]>([]);
  useEffect(() => {
    api.list().then(
      (r) => setMaps([...r.making.map((x) => ({ ...x, making: true })), ...r.maps.map((x) => ({ id: x.id, question: x.question }))]),
      () => {},
    );
  }, [mapId]);
  const list = maps.some((x) => x.id === mapId) ? maps : [{ id: mapId, question }, ...maps];
  return (
    <select className="switcher" value={mapId} onChange={(e) => navigate(pageUrl(e.target.value))} aria-label="Switch to another map" title="Switch to another map in this repo">
      {list.map((x) => <option key={x.id} value={x.id}>{x.question || x.id}{x.making ? ' (being made)' : ''}</option>)}
    </select>
  );
}

/**
 * Whether the map still matches the code, in words. The checker re-tests every box, arrow and gap against the repo
 * each time the map is shown; when some fail, it's usually because the code changed after the map was made.
 */
function MapStatus({ report }: { report: CheckReport | null }) {
  if (!report) return null;
  const off = report.summary.unconfirmed;
  if (!off) {
    return <span className="map-status ok" title="Every box, arrow and gap on this map was just re-checked against the code, and all of it holds.">✓ Matches the code</span>;
  }
  return (
    <span
      className="map-status off"
      title="Every time the map is shown, illuminate re-checks it against the code. These parts no longer hold, usually because the code changed after the map was made. They're dashed and marked ? on the map; click one to see why."
    >
      {off === 1 ? '1 part of this map doesn’t match the code' : `${off} parts of this map don’t match the code`}
    </span>
  );
}

/** How much the map shows: every step, or each part of the app as one box. Remembered between maps. */
type Level = 'steps' | 'big';
const LEVEL_KEY = 'illuminate-level';
const readLevel = (): Level => {
  try {
    return localStorage.getItem(LEVEL_KEY) === 'big' ? 'big' : 'steps';
  } catch {
    return 'steps';
  }
};
const NO_SELECTION: Sel = { nodes: [], edges: [], absences: [] };
const NO_IDS: string[] = [];

function MapScreen({ mapId, onStopped }: { mapId: string; onStopped: () => void }) {
  const [s, dispatch] = useReducer(reducer, mapId, initialState);
  const [draft, setDraft] = useState('');
  const [panelWidth, setPanelWidth] = usePanelWidth();
  const wasConnected = useRef(false);
  const [level, setLevel] = useState<Level>(readLevel);
  const chooseLevel = useCallback((l: Level) => {
    setLevel(l);
    try {
      localStorage.setItem(LEVEL_KEY, l);
    } catch {
      // Private browsing: the choice just doesn't outlive the page.
    }
  }, []);

  const load = useCallback(() => {
    api.get(mapId).then(
      (payload) => dispatch({ type: 'loaded', payload }),
      (e: Error) => dispatch(e instanceof ApiError && /No such map/.test(e.message) ? { type: 'missing' } : { type: 'error', message: e.message }),
    );
  }, [mapId]);

  useEffect(load, [load]);
  useEffect(
    () =>
      connect(
        (event) => dispatch({ type: 'event', event }),
        (value) => {
          dispatch({ type: 'connected', value });
          if (value && wasConnected.current === false && s.phase !== 'loading') load(); // catch up after a reconnect
          wasConnected.current = value;
        },
        onStopped,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const ask = useCallback(
    (question: string) => {
      const q = question.trim();
      if (!q || s.job) return;
      api.ask(mapId, q, s.selection).then(() => setDraft(''), (e: Error) => dispatch({ type: 'error', message: e.message }));
    },
    [mapId, s.job, s.selection],
  );

  const onFix = (fixId: string, action: 'approve' | 'reject' | 'undo') => {
    if (action === 'approve') dispatch({ type: 'fixStatus', fixId, status: 'applying', problems: [] });
    api[action](mapId, fixId).catch((e: ApiError) => {
      if (action === 'approve') dispatch({ type: 'fixStatus', fixId, status: 'failed', problems: e.problems.length ? e.problems : [e.message] });
      else dispatch({ type: 'error', message: [e.message, ...e.problems].join(' ') });
    });
  };

  // A question about a different part of the app: make a new map for it (and go there), or answer it in words here.
  const onOffer = (answerId: string, choice: 'map' | 'words') => {
    api.offer(mapId, answerId, choice).then(
      (r) => { if (r.id) navigate(pageUrl(r.id)); },
      (e: Error) => dispatch({ type: 'error', message: e.message }),
    );
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
      // Esc steps back one level at a time: walkthrough, then selection, then the answer, to the whole map.
      if (e.key === 'Escape') {
        if (s.tour !== null) dispatch({ type: 'tour', stop: null });
        else if (selSize(s.selection)) dispatch({ type: 'clearSelection' });
        else dispatch({ type: 'overview' });
        return;
      }
      if (typing || s.tour === null) return;
      if (e.key === 'ArrowRight') dispatch({ type: 'tour', stop: s.tour + 1 });
      if (e.key === 'ArrowLeft') dispatch({ type: 'tour', stop: s.tour - 1 });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [s.tour, s.selection]);

  const shown = s.answers.find((a) => a.id === s.shown);
  const pendingFix = shown?.fix && ['proposed', 'applying', 'failed'].includes(s.fixes[shown.fix.id]?.status ?? '') ? shown.fix : null;
  const onSelect = useCallback((kind: keyof Sel, id: string, additive: boolean) => dispatch({ type: 'select', kind, id, additive }), []);
  const onClear = useCallback(() => dispatch({ type: 'clearSelection' }), []);
  const drawn = visibleMap(s);
  const added = addedIds(s);
  // The same map one level up (overview.ts). What's lit there is whatever stands for what's lit on the steps.
  const big = useMemo(() => (level === 'big' && drawn ? overviewOf(drawn, s.report) : null), [level, drawn, s.report]);
  const view = currentView(s);
  const bigView = useMemo(
    () => (big && view ? { focus: view.focus ? inOverview(big, [view.focus])[0] ?? null : null, highlight: inOverview(big, view.highlight) } : null),
    [big, view],
  );
  // Pressing a box or arrow of the big picture opens the steps it stands for.
  const openSteps = useCallback((_kind: keyof Sel, id: string) => {
    const first = big?.inside[id]?.[0];
    chooseLevel('steps');
    if (first) dispatch({ type: 'focus', id: first });
  }, [big, chooseLevel]);
  const touring = !!s.map && s.tour !== null;
  // The panel shows only when it has something to say: an answer, what's selected, Claude's progress or an error
  // (before the map exists, it says how making it is going). Earlier questions are in the dock. During the walkthrough
  // it would only hold an error or Claude's progress. Otherwise the map gets the room.
  const hasPanel = !s.map || !!s.error || !!s.job || s.shown !== null || selSize(s.selection) > 0;
  const panel = hasPanel && (!touring || !!s.error || s.job?.kind === 'ask');
  // One question box: at the bottom of the conversation while it's open, in the dock while it isn't.
  const askInPanel = panel && !!s.map;
  const composer = s.map ? (
    <Composer
      map={s.map}
      selection={s.selection}
      draft={draft}
      busy={!!s.job}
      autoFocus={askInPanel}
      onDraft={setDraft}
      onRemove={(kind, id) => dispatch({ type: 'select', kind, id, additive: true })}
      onSend={() => ask(draft)}
    />
  ) : null;

  return (
    // The map's camera (useReactFlow) needs the provider around it.
    <ReactFlowProvider>
    <div className="app">
      <header className="topbar">
        <a className="brand" href={pageUrl()} title="All maps in this repo"><i className="brand-mark" aria-hidden="true" />illuminate</a>
        <div className="topbar-map">
          {s.meta?.parent && <a className="crumb" href={pageUrl(s.meta.parent.mapId)} title={`Back to the map this one came from: ${s.meta.parent.question}`}>← {s.meta.parent.question}</a>}
          <MapSwitcher mapId={mapId} question={s.map?.question ?? s.job?.question ?? ''} />
        </div>
        <MapStatus report={s.report} />
        <a className="pill-btn" href={pageUrl()} title="Ask a new question and make a map for it">New map</a>
        <StopButton busy={!!s.job} onStopped={onStopped} onError={(message) => dispatch({ type: 'error', message })} />
        <span className={s.connected ? 'live on' : 'live'} title={s.connected ? 'Connected to illuminate' : 'Reconnecting to illuminate…'} />
      </header>
      <div className={panel ? 'body' : 'body full'} style={{ '--panel-w': `${panelWidth}px` } as CSSProperties}>
        <div className="canvas">
          {s.map && drawn ? (
            <>
              {big
                ? <MapGraph key="big" map={big.map} report={big.report} selection={NO_SELECTION} view={bigView} fresh={NO_IDS} added={NO_IDS} ghost={null} touring={touring} onSelect={openSteps} onClear={onClear} />
                : <MapGraph key="steps" map={drawn} report={s.report} selection={s.selection} view={view} fresh={s.fresh} added={added} ghost={pendingFix ?? null} touring={touring} onSelect={onSelect} onClear={onClear} />}
              <div className="level" role="group" aria-label="How much detail the map shows">
                <button className={level === 'big' ? 'on' : undefined} aria-pressed={level === 'big'} onClick={() => chooseLevel('big')} title="Each part of the app as one box">Big picture</button>
                <button className={level === 'steps' ? 'on' : undefined} aria-pressed={level === 'steps'} onClick={() => chooseLevel('steps')} title="Every step inside each part">Steps</button>
              </div>
              {!touring && !panel && <ConversationButton state={s} dispatch={dispatch} />}
              {touring && <TourBubble map={s.map} report={s.report} stop={s.tour!} onTour={(stop) => dispatch({ type: 'tour', stop })} onAsk={setDraft} />}
              <Dock map={s.map} tour={s.tour} onTour={(stop) => dispatch({ type: 'tour', stop })} selected={selSize(s.selection)}>
                {askInPanel ? null : composer}
              </Dock>
            </>
          ) : (
            <div className="empty">{s.phase === 'making' ? <div className="pulse">Claude is exploring the code…</div> : null}</div>
          )}
        </div>
        {panel && <PanelResizer width={panelWidth} onWidth={setPanelWidth} />}
        {panel && <Panel state={s} dispatch={dispatch} onFix={onFix} onFocus={(id) => dispatch({ type: 'focus', id })} onOffer={onOffer} composer={askInPanel ? composer : null} />}
      </div>
    </div>
    </ReactFlowProvider>
  );
}
