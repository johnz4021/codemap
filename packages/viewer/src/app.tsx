// The two screens: the list of maps (with a box to ask a new question), and a map with its panel and input bar.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { ApiError, api, connect, pageUrl, token } from './api';
import { Composer } from './composer';
import { MapGraph } from './graph';
import { Home } from './home';
import { Panel } from './panel';
import { currentView, initialState, reducer, type Sel } from './state';
import type { CheckReport, CodeMap } from './types';

export function App() {
  if (!token) {
    return (
      <main className="home">
        <h1>Open codemap from its link</h1>
        <p className="muted lede">This page needs the link codemap printed in your terminal (it ends in <code>?t=…</code>). That keeps other websites from talking to your local codemap.</p>
      </main>
    );
  }
  const m = /^\/m\/([a-z0-9-]{1,80})\/?$/.exec(location.pathname);
  return m ? <MapScreen mapId={m[1]!} /> : <Home />;
}

function Summary({ report }: { report: CheckReport | null }) {
  if (!report) return null;
  const { claims, confirmed, unconfirmed } = report.summary;
  return unconfirmed
    ? <span className="summary warn" title="Some claims didn't check out against the code; they're marked with ?">✓ {confirmed} of {claims} confirmed · {unconfirmed} couldn't be</span>
    : <span className="summary ok" title="Every box and arrow was checked against the code">✓ All {claims} claims confirmed</span>;
}

function JumpTo({ map, onPick }: { map: CodeMap; onPick: (id: string) => void }) {
  const [text, setText] = useState('');
  return (
    <form
      className="jump"
      onSubmit={(e) => {
        e.preventDefault();
        const q = text.trim().toLowerCase();
        const hit = map.nodes.find((n) => n.name.toLowerCase() === q) ?? map.nodes.find((n) => n.name.toLowerCase().includes(q) || n.symbol?.toLowerCase().includes(q));
        if (hit) { onPick(hit.id); setText(''); }
      }}
    >
      <input id="jump" list="jump-names" value={text} onChange={(e) => setText(e.target.value)} placeholder="⌕ Jump to…" aria-label="Jump to a step" />
      <datalist id="jump-names">{map.nodes.map((n) => <option key={n.id} value={n.name} />)}</datalist>
    </form>
  );
}

function MapScreen({ mapId }: { mapId: string }) {
  const [s, dispatch] = useReducer(reducer, mapId, initialState);
  const [draft, setDraft] = useState('');
  const [pick, setPick] = useState(false);
  const wasConnected = useRef(false);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
      if (e.key === 'Escape') {
        if (s.tour !== null) dispatch({ type: 'tour', stop: null });
        else dispatch({ type: 'clearSelection' });
        return;
      }
      if (typing || s.tour === null) return;
      if (e.key === 'ArrowRight') dispatch({ type: 'tour', stop: s.tour + 1 });
      if (e.key === 'ArrowLeft') dispatch({ type: 'tour', stop: s.tour - 1 });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [s.tour]);

  const shown = s.answers.find((a) => a.id === s.shown);
  const pendingFix = shown?.fix && ['proposed', 'applying', 'failed'].includes(s.fixes[shown.fix.id]?.status ?? '') ? shown.fix : null;
  const onSelect = useCallback((kind: keyof Sel, id: string, additive: boolean) => dispatch({ type: 'select', kind, id, additive }), []);
  const onSelectMany = useCallback((selection: Sel) => dispatch({ type: 'selectMany', selection }), []);
  const onClear = useCallback(() => dispatch({ type: 'clearSelection' }), []);

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href={pageUrl()}>codemap</a>
        <span className="nav">
          <button aria-label="Back" disabled={s.viewIndex < 0} onClick={() => dispatch({ type: 'back' })}>◀</button>
          <button aria-label="Forward" disabled={s.viewIndex >= s.views.length - 1} onClick={() => dispatch({ type: 'forward' })}>▶</button>
        </span>
        <span className="topq">{s.map?.question ?? s.job?.question ?? ''}</span>
        <Summary report={s.report} />
        <span className="grow" />
        {s.map && <JumpTo map={s.map} onPick={(id) => dispatch({ type: 'focus', id })} />}
        {s.map && <button className={pick ? 'tool on' : 'tool'} aria-pressed={pick} onClick={() => setPick(!pick)} title="Drag around a region to select it">⬚ Pick</button>}
        {s.map && s.map.tour.length > 0 && <button className="tool" onClick={() => dispatch({ type: 'tour', stop: s.tour === null ? 0 : null })}>{s.tour === null ? 'Walkthrough' : 'Leave walkthrough'}</button>}
        <span className={s.connected ? 'live on' : 'live'} title={s.connected ? 'Connected to codemap' : 'Reconnecting to codemap…'} />
      </header>
      <div className="body">
        <div className="canvas">
          {s.map ? (
            <>
              <ReactFlowProvider>
                <MapGraph map={s.map} report={s.report} selection={s.selection} view={currentView(s)} fresh={s.fresh} ghost={pendingFix ?? null} pick={pick} onSelect={onSelect} onSelectMany={onSelectMany} onClear={onClear} />
              </ReactFlowProvider>
              <Composer
                map={s.map}
                selection={s.selection}
                draft={draft}
                busy={!!s.job}
                onDraft={setDraft}
                onRemove={(kind, id) => dispatch({ type: 'select', kind, id, additive: true })}
                onSend={() => ask(draft)}
              />
            </>
          ) : (
            <div className="empty">{s.phase === 'making' ? <div className="pulse">Claude is exploring the code…</div> : null}</div>
          )}
        </div>
        <Panel state={s} dispatch={dispatch} onAsk={ask} onDraft={setDraft} onFix={onFix} onFocus={(id) => dispatch({ type: 'focus', id })} />
      </div>
    </div>
  );
}
