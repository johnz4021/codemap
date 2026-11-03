// The side panel: what the map is, the walkthrough, answers at three depths with their sources, fixes to approve,
// details of whatever is selected, and live progress while Claude works.
import type { Dispatch, ReactNode } from 'react';
import type { Action, Depth, FixState, State } from './state';
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

function Card({ eyebrow, title, children, tone }: { eyebrow?: string; title?: ReactNode; children: ReactNode; tone?: 'ai' | 'ok' | 'dead' }) {
  return (
    <section className={cls('card', tone && `card-${tone}`)}>
      {eyebrow && <div className="eyebrow">{eyebrow}</div>}
      {title && <h2 className="card-title">{title}</h2>}
      {children}
    </section>
  );
}

function Depths({ depth, dispatch, texts }: { depth: Depth; dispatch: Dispatch<Action>; texts: Partial<Record<Depth, string>> }) {
  const tabs: [Depth, string][] = [['concept', 'Concept'], ['how', 'How it works'], ['code', 'Code']];
  const available = tabs.filter(([d]) => texts[d]);
  const shown = texts[depth] ? depth : (available[0]?.[0] ?? 'concept');
  if (!available.length) return null;
  return (
    <div className="depths">
      <div className="tabs" role="tablist">
        {available.map(([d, label]) => (
          <button key={d} role="tab" aria-selected={shown === d} className={cls('tab', shown === d && 'on')} onClick={() => dispatch({ type: 'depth', depth: d })}>
            {label}
          </button>
        ))}
      </div>
      <div className={cls('depth-text', shown === 'code' && 'mono')}>{texts[shown]}</div>
    </div>
  );
}

function Chips({ map, report, ids, onPick }: { map: CodeMap; report: CheckReport | null; ids: { id: string; status: string }[]; onPick: (id: string) => void }) {
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
          <li><span className="ic">✓</span>Re-checked the map against the new code</li>
          {fix.edgeId && <li><span className="ic">✓</span>New confirmed connection: {nameOf(map, fix.edgeId)}</li>}
          {fix.closed.length > 0 && <li><span className="ic">✓</span>Closed: {fix.closed.length === 1 ? 'the missing connection' : `${fix.closed.length} missing connections`}</li>}
        </ul>
        <div className="btns"><button className="btn" onClick={onUndo}>Undo this fix</button></div>
      </Card>
    );
  }
  if (fix.status === 'rejected' || fix.status === 'undone') {
    return <Card eyebrow={fix.status === 'undone' ? 'Fix undone' : 'Fix rejected'}><p className="muted">{p.summary}</p>{fix.status === 'undone' && <div className="btns"><button className="btn" onClick={onApprove}>Apply it again</button></div>}</Card>;
  }
  return (
    <Card eyebrow={`Proposed fix · ${p.files.length} ${p.files.length === 1 ? 'file' : 'files'} · nothing changed yet`} tone="ai">
      <p>{p.summary}</p>
      {p.connects && <p className="muted small">The green dashed arrow on the map is the connection this would create.</p>}
      <pre className="diff">{p.diff.split('\n').map((l, i) => <span key={i} className={l.startsWith('+ ') ? 'add' : l.startsWith('- ') ? 'del' : l.includes(' · ') ? 'file' : ''}>{l}{'\n'}</span>)}</pre>
      {dirty.length > 0 ? (
        <p className="warn small">⚠ {dirty.map((f) => f.file).join(', ')} {dirty.length === 1 ? 'has' : 'have'} uncommitted changes. They'll be kept; the fix applies on top.</p>
      ) : (
        <div className="chips"><span className="chip static"><span className="tick">✓</span>no uncommitted changes in these files</span></div>
      )}
      {fix.problems.length > 0 && <ul className="problems">{fix.problems.map((x) => <li key={x}>{x}</li>)}</ul>}
      <div className="btns">
        <button className="btn primary" disabled={fix.status === 'applying'} onClick={onApprove}>{fix.status === 'applying' ? 'Applying…' : 'Approve'}</button>
        <button className="btn" onClick={onReject}>Reject</button>
      </div>
      <p className="muted small">Codemap writes exactly this change, then re-checks the map. It won't apply if these files change first.</p>
    </Card>
  );
}

export type PanelProps = {
  state: State;
  dispatch: Dispatch<Action>;
  onAsk: (question: string) => void;
  onDraft: (text: string) => void;
  onFix: (fixId: string, action: 'approve' | 'reject' | 'undo') => void;
  onFocus: (id: string) => void;
};

export function Panel({ state: s, dispatch, onAsk, onDraft, onFix, onFocus }: PanelProps) {
  const map = s.map;
  const job = s.job;

  if (s.phase === 'loading') return <aside className="panel"><Card><p className="muted">Loading the map…</p></Card></aside>;
  if (s.phase === 'missing') return <aside className="panel"><Card title="No map here"><p className="muted">This map doesn't exist in this repo. Go back to the list to open another one or ask a new question.</p></Card></aside>;
  if (!map) {
    return (
      <aside className="panel">
        {job && (
          <Card eyebrow="Making your map" title={job.question} tone="ai">
            <Progress lines={job.progress} working />
            <p className="muted small">Claude explores the code, then a plain program checks every box and arrow before you see them.</p>
          </Card>
        )}
        {s.phase === 'failed' && <Card title="The map couldn't be made" tone="dead"><p>{s.error}</p></Card>}
      </aside>
    );
  }

  const answer = s.answers.find((a) => a.id === s.shown) ?? null;
  const fix = answer?.fix ? s.fixes[answer.fix.id] ?? null : null;
  const stop = s.tour !== null ? map.tour[s.tour] : null;
  const selected = [...s.selection.nodes, ...s.selection.edges, ...s.selection.absences];

  return (
    <aside className="panel">
      {s.error && <div className="banner banner-dead" role="alert">{s.error}<button className="link-btn" onClick={() => dispatch({ type: 'error', message: null })}>Dismiss</button></div>}

      {job?.kind === 'ask' && (
        <Card eyebrow="Claude is working" title={`“${job.question}”`} tone="ai">
          <Progress lines={job.progress} working />
        </Card>
      )}

      {stop && s.tour !== null && (
        <Card eyebrow={`Walkthrough · stop ${s.tour + 1} of ${map.tour.length}`} title={stop.title}>
          <div className="dots" aria-hidden="true">
            {map.tour.map((t, i) => <i key={t.id} className={cls(i === s.tour && 'on', i < s.tour! && 'done')} />)}
          </div>
          <p className="depth-text">{stop.text}</p>
          {stop.terms?.length ? <p className="muted small">Terms: {stop.terms.join(', ')}</p> : null}
          {stop.ask?.length ? (
            <div className="follow">{stop.ask.map((q) => <button key={q} className="follow-btn" onClick={() => onAsk(q)}>{q}</button>)}</div>
          ) : null}
          <div className="tour-nav">
            <button className="btn" disabled={s.tour === 0} onClick={() => dispatch({ type: 'tour', stop: s.tour! - 1 })}>◀ Back</button>
            <button className="btn" onClick={() => onDraft(`About “${stop.title}”: `)}>Ask about this step</button>
            <span className="grow" />
            {s.tour < map.tour.length - 1
              ? <button className="btn primary" onClick={() => dispatch({ type: 'tour', stop: s.tour! + 1 })}>Next ▶</button>
              : <button className="btn primary" onClick={() => dispatch({ type: 'tour', stop: null })}>Done</button>}
          </div>
          <div className="kbd">← → to step · Esc to leave the walkthrough</div>
        </Card>
      )}

      {!stop && answer && (
        <Card eyebrow={`Answer${answer.added.length ? ` · added ${answer.added.length} to the map` : ''}`} title={`“${answer.question}”`}>
          <Depths depth={s.depth} dispatch={dispatch} texts={{ concept: answer.concept, how: answer.how, code: answer.code }} />
          {(() => {
            // Sources as the map is now: drop what a later fix removed, and show each one's current status.
            const refs = answer.refs.filter((r) => r.status !== 'unknown' && checkOf(s.report, r.id)).map((r) => ({ id: r.id, status: checkOf(s.report, r.id)!.status }));
            return refs.length > 0 && <div className="basis"><div className="eyebrow">Based on</div><Chips map={map} report={s.report} ids={refs} onPick={onFocus} /></div>;
          })()}
          {answer.problems.filter((x) => !x.startsWith('The proposed fix')).length > 0 && (
            <details className="problems-box"><summary>{answer.problems.length} thing{answer.problems.length === 1 ? '' : 's'} Claude found but couldn't confirm</summary><ul className="problems">{answer.problems.map((x) => <li key={x}>{x}</li>)}</ul></details>
          )}
          {answer.followUps.length > 0 && <div className="follow">{answer.followUps.map((q) => <button key={q} className="follow-btn" onClick={() => onAsk(q)}>{q}</button>)}</div>}
        </Card>
      )}

      {!stop && fix && <FixCard fix={fix} map={map} onApprove={() => onFix(fix.proposal.id, 'approve')} onReject={() => onFix(fix.proposal.id, 'reject')} onUndo={() => onFix(fix.proposal.id, 'undo')} />}
      {!stop && answer?.problems.some((x) => x.startsWith('The proposed fix')) && (
        <Card eyebrow="The proposed fix can't be applied" tone="dead"><ul className="problems">{answer.problems.filter((x) => x.startsWith('The proposed fix')).map((x) => <li key={x}>{x.replace('The proposed fix can\'t be applied: ', '')}</li>)}</ul><p className="muted small">Ask again, or ask for a smaller change.</p></Card>
      )}

      {!stop && selected.length > 0 && <Selected map={map} report={s.report} ids={selected} depth={s.depth} dispatch={dispatch} />}

      {!stop && !answer && !selected.length && !job && (
        <Card eyebrow="This map" title={map.question}>
          <p className="muted">{map.areas.length} areas, {map.nodes.length} steps, {map.edges.length} connections{map.absences.length ? `, ${map.absences.length} missing` : ''}. Read it left to right; every arrow says how one step leads to the next.</p>
          {map.tour.length > 0 && <div className="btns"><button className="btn primary" onClick={() => dispatch({ type: 'tour', stop: 0 })}>Take the walkthrough ({map.tour.length} stops)</button></div>}
          <p className="muted small">Click a box or an arrow to see what it is and ask about it. Shift-click to pick several, or use Pick to drag around a region.</p>
        </Card>
      )}

      {s.answers.length > 1 && !stop && (
        <Card eyebrow="Earlier questions">
          <ul className="history">
            {s.answers.slice().reverse().map((a) => (
              <li key={a.id}><button className={cls('link-btn', a.id === s.shown && 'on')} onClick={() => dispatch({ type: 'show', answerId: a.id })}>{a.question}</button></li>
            ))}
          </ul>
        </Card>
      )}
    </aside>
  );
}

function Selected({ map, report, ids, depth, dispatch }: { map: CodeMap; report: CheckReport | null; ids: string[]; depth: Depth; dispatch: Dispatch<Action> }) {
  if (ids.length > 1) {
    return (
      <Card eyebrow={`${ids.length} selected`}>
        <Chips map={map} report={report} ids={ids.map((id) => ({ id, status: checkOf(report, id)?.status ?? 'unknown' }))} onPick={() => undefined} />
        <p className="muted small">Ask about them together in the box below.</p>
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
  return (
    <Card eyebrow={node ? 'Step' : edge ? 'Connection' : 'Missing connection'} title={nameOf(map, id)} tone={gap ? 'dead' : undefined}>
      {node?.explain && <Depths depth={depth} dispatch={dispatch} texts={node.explain} />}
      {gap && <p>The code has no connection here. Codemap re-ran the search <code>{gap.search.pattern}</code>{gap.search.paths ? <> in <code>{gap.search.paths.join(', ')}</code></> : null} and found {report?.absences[gap.id]?.found ?? '?'} {report?.absences[gap.id]?.found === 1 ? 'match' : 'matches'}.</p>}
      {c && c.status !== 'confirmed' && <div className="warn small">Couldn't confirm against the code: {c.reasons.join('; ')}</div>}
      {evidence.length > 0 && (
        <div className="basis">
          <div className="eyebrow">Where it is in the code</div>
          <div className="chips">
            {evidence.map((e, i) => {
              const ok = evidenceChecks[i]?.ok ?? false;
              return <span key={i} className={cls('chip static', !ok && 'chip-unconfirmed')}><span className={ok ? 'tick' : 'qmark'}>{ok ? '✓' : '?'}</span>{e.file}:{evidenceChecks[i]?.foundAt ?? e.line}</span>;
            })}
          </div>
        </div>
      )}
      <p className="muted small">Ask about it in the box below.</p>
    </Card>
  );
}
