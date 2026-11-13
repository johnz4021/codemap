// The side panel is the conversation about this map: each question, Claude's reply (a few plain sentences; the map
// does the explaining), and under a reply whatever came with it (a fix to approve, the offer of a new map, boxes it added). Claude's
// progress shows at the end while it works, then what's selected, then the question box.
// (The walkthrough is a bubble on the map: tour.tsx. The button that reopens a closed conversation: history.tsx.)
import { useEffect, useRef, useState, type Dispatch, type ReactNode } from 'react';
import { pageUrl } from './api';
import { ScreenView, screenOf } from './screen';
import { Markdown } from './markdown';
import { layersOf, type Action, type FixState, type State } from './state';
import type { Answer, CheckReport, ClaimCheck, CodeMap } from './types';

const cls = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

/** A readable name for any id on the map. */
export function nameOf(map: CodeMap, id: string): string {
  const n = map.nodes.find((x) => x.id === id);
  if (n) return n.name;
  const e = map.edges.find((x) => x.id === id);
  if (e) return `${nameOf(map, e.from)} → ${nameOf(map, e.to)}`;
  const a = map.absences.find((x) => x.id === id);
  if (a) return a.claim;
  const area = map.areas.find((x) => x.id === id);
  return area?.label ?? id;
}

function checkOf(report: CheckReport | null, id: string): ClaimCheck | { status: 'confirmed' | 'unconfirmed'; reasons: string[]; evidence?: never } | null {
  if (!report) return null;
  return report.nodes[id] ?? report.edges[id] ?? (report.absences[id] ? { status: report.absences[id]!.status, reasons: report.absences[id]!.reasons } : null);
}

function Card({ eyebrow, title, children, tone, className }: { eyebrow?: string; title?: ReactNode; children: ReactNode; tone?: 'ai' | 'ok' | 'dead' | 'focus'; className?: string }) {
  return (
    <section className={cls('card', tone && `card-${tone}`, className)}>
      {eyebrow && <div className="eyebrow">{eyebrow}</div>}
      {title && <h2 className="card-title">{title}</h2>}
      {children}
    </section>
  );
}

function Chips({ map, ids, onPick }: { map: CodeMap; ids: { id: string; status: string }[]; onPick: (id: string) => void }) {
  if (!ids.length) return null;
  return (
    <div className="chips">
      {ids.map(({ id, status }) => (
        <button key={id} className={cls('chip', status !== 'confirmed' && 'chip-unconfirmed')} onClick={() => onPick(id)} title={status === 'confirmed' ? 'Confirmed against the code' : "Couldn't confirm against the code"}>
          <span className={status === 'confirmed' ? 'tick' : 'qmark'}>{status === 'confirmed' ? '✓' : '?'}</span>
          {nameOf(map, id)}
        </button>
      ))}
    </div>
  );
}

function Progress({ lines, working }: { lines: string[]; working: boolean }) {
  const shown = lines.slice(-8);
  return (
    <ul className="progress">
      {shown.map((l, i) => (
        <li key={`${i}-${l}`} className={cls(working && i === shown.length - 1 && 'running')}>
          <span className="ic">{working && i === shown.length - 1 ? '…' : '✓'}</span>
          {l}
        </li>
      ))}
      {!shown.length && working && <li className="running"><span className="ic">…</span>Starting</li>}
    </ul>
  );
}

function FixCard({ fix, onApprove, onReject, onUndo, map }: { fix: FixState; map: CodeMap; onApprove: () => void; onReject: () => void; onUndo: () => void }) {
  const p = fix.proposal;
  const dirty = p.files.filter((f) => f.uncommitted);
  if (fix.status === 'applied') {
    return (
      <Card eyebrow="Fix applied · re-checked" tone="ok">
        <ul className="progress">
          <li><span className="ic">✓</span>Changed {p.files.length} {p.files.length === 1 ? 'file' : 'files'}: {p.files.map((f) => f.file).join(', ')}</li>
          {fix.edgeId && <li><span className="ic">✓</span>New confirmed connection: {nameOf(map, fix.edgeId)}</li>}
          {fix.closed.length > 0 && <li><span className="ic">✓</span>Closed: {fix.closed.length === 1 ? 'the missing connection' : `${fix.closed.length} missing connections`}</li>}
        </ul>
        {fix.undoable
          ? <div className="btns"><button className="btn" onClick={onUndo}>Undo this fix</button></div>
          : <p className="muted small">Undo ended when illuminate stopped. Use git to reverse it.</p>}
      </Card>
    );
  }
  if (fix.status === 'rejected' || fix.status === 'undone') {
    return <Card eyebrow={fix.status === 'undone' ? 'Fix undone' : 'Fix rejected'}><Markdown text={p.summary} className="muted" />{fix.status === 'undone' && <div className="btns"><button className="btn" onClick={onApprove}>Apply it again</button></div>}</Card>;
  }
  return (
    <Card eyebrow={`Proposed fix · ${p.files.length} ${p.files.length === 1 ? 'file' : 'files'} · nothing changed yet`} tone="ai">
      <Markdown text={p.summary} />
      {p.connects && <p className="muted small">The green dashed arrow is the connection it adds.</p>}
      <pre className="diff">{p.diff.split('\n').map((l, i) => <span key={i} className={l.startsWith('+ ') ? 'add' : l.startsWith('- ') ? 'del' : l.includes(' · ') ? 'file' : ''}>{l}{'\n'}</span>)}</pre>
      {dirty.length > 0 ? (
        <p className="warn small">⚠ {dirty.map((f) => f.file).join(', ')} {dirty.length === 1 ? 'has' : 'have'} uncommitted changes. They'll be kept; the fix applies on top.</p>
      ) : null}
      {fix.problems.length > 0 && <ul className="problems">{fix.problems.map((x) => <li key={x}>{x}</li>)}</ul>}
      <div className="btns">
        <button className="btn primary" disabled={fix.status === 'applying'} onClick={onApprove}>{fix.status === 'applying' ? 'Applying…' : 'Approve'}</button>
        <button className="btn" onClick={onReject}>Reject</button>
      </div>
      <p className="muted small">Won't apply if these files change first.</p>
    </Card>
  );
}

export type PanelProps = {
  state: State;
  dispatch: Dispatch<Action>;
  onFix: (fixId: string, action: 'approve' | 'reject' | 'undo') => void;
  onFocus: (id: string) => void;
  onOffer: (answerId: string, choice: 'map' | 'words') => void;
  /** The question box, at the bottom of the conversation. */
  composer: ReactNode;
};

export function Panel({ state: s, dispatch, onFix, onFocus, onOffer, composer }: PanelProps) {
  const map = s.map;
  const job = s.job;
  const scroller = useRef<HTMLDivElement>(null);

  // Keep the newest turn in view as the conversation grows and while Claude works.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [s.answers.length, job?.progress.length, !!job]);

  if (s.phase === 'loading') return <aside className="panel"><div className="panel-scroll"><Card><p className="muted">Loading…</p></Card></div></aside>;
  if (s.phase === 'missing') return <aside className="panel"><div className="panel-scroll"><Card title="No map here"><p className="muted">This map isn't in this repo.</p></Card></div></aside>;
  if (!map) {
    return (
      <aside className="panel">
        <div className="panel-scroll">
          {job && (
            <Card eyebrow="Making your map" title={job.question} tone="ai">
              <Progress lines={job.progress} working />
            </Card>
          )}
          {s.phase === 'failed' && <Card title="The map couldn't be made" tone="dead"><p>{s.error}</p></Card>}
        </div>
      </aside>
    );
  }

  const selected = [...s.selection.nodes, ...s.selection.edges, ...s.selection.absences];
  const layers = layersOf(s);
  const allHidden = layers.length > 0 && layers.every((l) => !l.visible);

  return (
    <aside className="panel" aria-label="Conversation about this map">
      <header className="panel-head">
        <h2 className="panel-title">Conversation</h2>
        {layers.length > 0 && (
          <button className="link-btn small" onClick={() => dispatch({ type: 'allLayers', visible: allHidden })}>{allHidden ? 'Show everything' : 'Show the original map'}</button>
        )}
        <button className="card-close" aria-label="Close the conversation" title="Close (Esc). It stays here to reopen." onClick={() => dispatch({ type: 'overview' })}>×</button>
      </header>

      <div className="panel-scroll" ref={scroller}>
        {s.error && <div className="banner banner-dead" role="alert">{s.error}<button className="link-btn" onClick={() => dispatch({ type: 'error', message: null })}>Dismiss</button></div>}

        {s.answers.map((a) => (
          <Turn key={a.id} answer={a} state={s} dispatch={dispatch} onFix={onFix} onFocus={onFocus} onOffer={onOffer} />
        ))}

        {job?.kind === 'ask' && (
          <article className="turn">
            <You question={job.question} />
            <Card eyebrow="Claude is working" tone="ai">
              <Progress lines={job.progress} working />
            </Card>
          </article>
        )}

        {!s.answers.length && !job && !selected.length && <p className="muted small thread-empty">Ask anything about this map. Click a box or arrow first to ask about it.</p>}
      </div>

      <footer className="panel-foot">
        {selected.length > 0 && <Selected key={selected.join(' ')} map={map} report={s.report} ids={selected} compact={s.answers.length > 0 || job?.kind === 'ask'} />}
        {composer}
      </footer>
    </aside>
  );
}

/** Your side of a turn: the question. */
function You({ question, about }: { question: string; about?: string }) {
  return (
    <div className="you">
      <p className="you-q">{question}</p>
      {about && <span className="you-about">About {about}</span>}
    </div>
  );
}

/** One question and everything that came back for it. */
function Turn({ answer: a, state: s, dispatch, onFix, onFocus, onOffer }: { answer: Answer; state: State; dispatch: Dispatch<Action>; onFix: PanelProps['onFix']; onFocus: (id: string) => void; onOffer: PanelProps['onOffer'] }) {
  const map = s.map!;
  const fix = a.fix ? s.fixes[a.fix.id] ?? null : null;
  const lit = a.id === s.shown;
  const about = [...(a.selection.nodes ?? []), ...(a.selection.edges ?? []), ...(a.selection.absences ?? [])].map((id) => nameOf(map, id)).join(', ');
  const layer = layersOf(s).find((l) => l.answerId === a.id);
  const fixProblems = a.problems.filter((x) => x.startsWith('The proposed fix'));
  const otherProblems = a.problems.filter((x) => !x.startsWith('The proposed fix'));
  // What the reply relies on is lit on the map, so it isn't listed. Only say so when some of it didn't check out
  // (as the map is now: a later fix can confirm it, or remove it).
  const shaky = a.refs.filter((r) => r.status !== 'unknown' && checkOf(s.report, r.id)?.status === 'unconfirmed').map((r) => r.id);
  const onMap = a.moves.highlight.length > 0 || !!a.moves.focus || a.added.length > 0 || (a.screens ?? []).length > 0;

  return (
    <article className="turn">
      <You question={a.question} about={about || undefined} />
      {a.offer ? (
        <OfferCard answer={a} busy={!!s.job} onOffer={onOffer} />
      ) : (
        <section className={cls('card', 'reply', lit && 'card-focus')}>
          <div className="reply-meta">
            <span>{a.source === 'map' ? 'From the map' : 'Looked in the code'}</span>
            {onMap && (lit
              ? <span className="reply-lit">Lit on the map</span>
              : <button className="link-btn small" onClick={() => dispatch({ type: 'show', answerId: a.id })}>Show on the map</button>)}
          </div>
          <Markdown text={a.concept} className="depth-text" />
          {(a.screens ?? []).map((id) => {
            const show = screenOf(s.report, id);
            return show ? <ScreenView key={id} show={show} name={nameOf(map, id)} /> : null;
          })}
          {shaky.length > 0 && (
            <p className="warn small reply-warn">
              Relies on {shaky.length === 1 ? '1 thing' : `${shaky.length} things`} the checker couldn't confirm:{' '}
              {shaky.map((id, i) => (
                <span key={id}>
                  {i > 0 && ', '}
                  <button className="link-btn small" title="Show it on the map" onClick={() => onFocus(id)}>{nameOf(map, id)}</button>
                </span>
              ))}
            </p>
          )}
          {layer && (
            <div className="reply-added">
              <span>Added {layer.ids.length} to the map</span>
              <button className="link-btn small" onClick={() => dispatch({ type: 'layer', answerId: a.id, visible: !layer.visible })}>{layer.visible ? 'Hide' : 'Show'}</button>
            </div>
          )}
          {otherProblems.length > 0 && (
            <details className="problems-box"><summary>{otherProblems.length} thing{otherProblems.length === 1 ? '' : 's'} Claude found but couldn't confirm or show</summary><ul className="problems">{otherProblems.map((x) => <li key={x}>{x}</li>)}</ul></details>
          )}
        </section>
      )}
      {fix && <FixCard fix={fix} map={map} onApprove={() => onFix(fix.proposal.id, 'approve')} onReject={() => onFix(fix.proposal.id, 'reject')} onUndo={() => onFix(fix.proposal.id, 'undo')} />}
      {fixProblems.length > 0 && (
        <Card eyebrow="The proposed fix can't be applied" tone="dead"><ul className="problems">{fixProblems.map((x) => <li key={x}>{x.replace('The proposed fix can\'t be applied: ', '')}</li>)}</ul><p className="muted small">Ask again, or ask for a smaller change.</p></Card>
      )}
    </article>
  );
}

/** "This looks like a different part of the app": a new map for it (or the one that already covers it), or words. */
function OfferCard({ answer, busy, onOffer }: { answer: Answer; busy: boolean; onOffer: (answerId: string, choice: 'map' | 'words') => void }) {
  const o = answer.offer!;
  if (o.status === 'mapped') {
    return (
      <Card eyebrow="A different part of the app">
        <p className="muted">You made a new map for this.</p>
        {o.mapId && <div className="btns"><a className="btn primary" href={pageUrl(o.mapId)}>Open it</a></div>}
      </Card>
    );
  }
  if (o.status === 'answered') {
    return <Card eyebrow="A different part of the app"><p className="muted">Answered in words, below.</p></Card>;
  }
  return (
    <Card eyebrow="A different part of the app" tone="ai">
      <p>This is about a different part of the app than this map shows.</p>
      {o.existing && <p>There's already a map for it: “{o.existing.question}”.</p>}
      <div className="btns">
        {o.existing && <a className="btn primary" href={pageUrl(o.existing.id)}>Open that map</a>}
        <button className={o.existing ? 'btn' : 'btn primary'} onClick={() => onOffer(answer.id, 'map')}>Make a new map for this</button>
        <button className="btn" disabled={busy} onClick={() => onOffer(answer.id, 'words')} title={busy ? 'Claude is still working on this map' : undefined}>Just answer in words</button>
      </div>
    </Card>
  );
}

/** What's selected: what your next question will be about, with what the map says about it. */
/**
 * What's selected, above the question box. Once there's a conversation it's one line with "Details" to open it, so
 * picking a box while reading a reply doesn't cover the reply.
 */
function Selected({ map, report, ids, compact }: { map: CodeMap; report: CheckReport | null; ids: string[]; compact: boolean }) {
  const [open, setOpen] = useState(!compact);
  if (ids.length > 1) {
    return (
      <Card eyebrow={`Asking about ${ids.length} things`} className="card-selected">
        <Chips map={map} ids={ids.map((id) => ({ id, status: checkOf(report, id)?.status ?? 'unknown' }))} onPick={() => undefined} />
      </Card>
    );
  }
  const id = ids[0]!;
  const node = map.nodes.find((n) => n.id === id);
  const edge = map.edges.find((e) => e.id === id);
  const gap = map.absences.find((a) => a.id === id);
  const c = checkOf(report, id);
  const evidence = node?.evidence ?? edge?.evidence ?? [];
  const evidenceChecks = c && 'evidence' in c && c.evidence ? c.evidence : [];
  const what = node ? 'Step' : edge ? 'Connection' : 'Missing connection';
  if (!open) {
    return (
      <div className={cls('selected-line', gap && 'selected-line-dead')}>
        <span className="eyebrow">{what}</span>
        <span className="selected-name">{nameOf(map, id)}</span>
        <button className="link-btn small" onClick={() => setOpen(true)}>Details</button>
      </div>
    );
  }
  return (
    <Card eyebrow={what} title={nameOf(map, id)} tone={gap ? 'dead' : undefined} className="card-selected">
      {compact && <button className="link-btn small selected-hide" onClick={() => setOpen(false)}>Hide details</button>}
      {node?.explain?.concept && <Markdown text={node.explain.concept} className="depth-text" />}
      {node && screenOf(report, node.id) && <ScreenView show={screenOf(report, node.id)!} name={node.name} />}
      {gap && <p>Nothing in the code connects these. Searching <code>{gap.search.pattern}</code>{gap.search.paths ? <> in <code>{gap.search.paths.join(', ')}</code></> : null}: {report?.absences[gap.id]?.found ?? '?'} {report?.absences[gap.id]?.found === 1 ? 'match' : 'matches'}.</p>}
      {c && c.status !== 'confirmed' && <div className="warn small">Couldn't confirm against the code: {c.reasons.join('; ')}</div>}
      {evidence.length > 0 && (
        <div className="basis">
          <div className="eyebrow">In the code</div>
          <div className="chips">
            {evidence.map((e, i) => {
              const ok = evidenceChecks[i]?.ok ?? false;
              return <span key={i} className={cls('chip static', !ok && 'chip-unconfirmed')}><span className={ok ? 'tick' : 'qmark'}>{ok ? '✓' : '?'}</span>{e.file}:{evidenceChecks[i]?.foundAt ?? e.line}</span>;
            })}
          </div>
        </div>
      )}
    </Card>
  );
}
