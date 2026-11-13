// The map itself: areas as containers, steps as boxes, labeled arrows, missing connections as red dashed arrows and a
// proposed fix as a green dashed one. Click to select (shift-click adds).
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  getBezierPath,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { layoutKey, layoutMap, sides, type ExtraEdge, type Layout } from './layout';
import type { Sel, View } from './state';
import type { CheckReport, CodeMap, FixProposal } from './types';

const cls = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

type StepData = {
  name: string;
  sub: string;
  kind: string;
  confirmed: boolean;
  /** It has a confirmed picture of the screen, shown when the box is selected or the walkthrough stops on it. */
  screen: boolean;
  selected: boolean;
  hl: boolean;
  dim: boolean;
  fresh: boolean;
  onClick: (additive: boolean) => void;
};
type AreaData = { label: string; note: string | null; dim: boolean };
type LinkData = {
  label: string;
  /** Sideways bend in px, so arrows between the same two steps don't hide each other. */
  offset?: number;
  variant: 'edge' | 'absence' | 'ghost';
  confirmed: boolean;
  hl: boolean;
  dim: boolean;
  selected: boolean;
  onClick?: (additive: boolean) => void;
};
type StepNodeT = Node<StepData, 'step'>;
type AreaNodeT = Node<AreaData, 'area'>;
type LinkEdgeT = Edge<LinkData, 'link'>;

/** What kind of box it is, in words, and the little mark drawn beside it. */
const KIND: Record<string, [label: string, mark: string]> = {
  entry: ['Where it starts', '▸'],
  store: ['Saved data', '▤'],
  external: ['Outside the app', '↗'],
  job: ['Background job', '◷'],
};

const SIDES = [['t', Position.Top], ['r', Position.Right], ['b', Position.Bottom], ['l', Position.Left]] as const;

/** A source and a target handle on every side, so an arrow can leave and enter by whichever sides face each other. */
function Handles() {
  return (
    <>
      {SIDES.map(([s, pos]) => <Handle key={`s${s}`} id={`s${s}`} type="source" position={pos} className="handle" isConnectable={false} />)}
      {SIDES.map(([s, pos]) => <Handle key={`t${s}`} id={`t${s}`} type="target" position={pos} className="handle" isConnectable={false} />)}
    </>
  );
}

function StepNode({ data }: NodeProps<StepNodeT>) {
  return (
    // `nopan`: pressing on a step must not start a canvas pan, or the pan can swallow the click.
    <div
      className={cls('step', 'nopan', `kind-${data.kind}`, !data.confirmed && 'unconfirmed', data.selected && 'selected', data.hl && 'hl', data.dim && 'dim')}
      onClick={(e) => {
        e.stopPropagation();
        data.onClick(e.shiftKey || e.metaKey);
      }}
    >
      <Handles />
      {/* Plain steps need no label; the other kinds say what they are. */}
      {(KIND[data.kind] || data.fresh || data.screen) && (
        <div className="step-head">
          {KIND[data.kind] && <><i className="step-mark" aria-hidden="true">{KIND[data.kind]![1]}</i>{KIND[data.kind]![0]}</>}
          {data.screen && <span className="badge-screen" title="Select this step to see the screen">▣ Screen</span>}
          {data.fresh && <span className="badge-new">New</span>}
        </div>
      )}
      <div className="step-name" title={data.name}>{data.name}</div>
      <div className="step-code" title={data.confirmed ? 'Confirmed against the code' : "The checker couldn't confirm this against the code"}>
        <span className={data.confirmed ? 'tick' : 'qmark'}>{data.confirmed ? '✓' : '?'}</span>
        <span className="step-sub">{data.sub}</span>
      </div>
    </div>
  );
}

function AreaNode({ data }: NodeProps<AreaNodeT>) {
  return (
    <div className={cls('area', data.dim && 'dim')}>
      <div className="area-label">
        {data.label}
        {data.note && <span className="area-note"> {data.note}</span>}
      </div>
    </div>
  );
}

/** A curve bent `offset` px to one side of the straight line, with its label at the bend. */
function bentPath(sx: number, sy: number, tx: number, ty: number, offset: number): [string, number, number] {
  const len = Math.hypot(tx - sx, ty - sy) || 1;
  const nx = -(ty - sy) / len;
  const ny = (tx - sx) / len;
  const cx = (sx + tx) / 2 + nx * offset * 2;
  const cy = (sy + ty) / 2 + ny * offset * 2;
  return [`M ${sx} ${sy} Q ${cx} ${cy} ${tx} ${ty}`, (sx + tx) / 2 + nx * offset, (sy + ty) / 2 + ny * offset];
}

function LinkEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }: EdgeProps<LinkEdgeT>) {
  const [path, lx, ly] = data?.offset
    ? bentPath(sourceX, sourceY, targetX, targetY, data.offset)
    : getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  if (!data) return null;
  return (
    <>
      {data.selected && <path d={path} className="edge-halo" />}
      <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={18} />
      <EdgeLabelRenderer>
        <div
          className={cls('link-label', `link-${data.variant}`, !data.confirmed && 'unconfirmed', data.hl && 'hl', data.dim && 'dim', data.selected && 'selected', 'nodrag nopan')}
          style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
          onClick={(e) => {
            e.stopPropagation();
            data.onClick?.(e.shiftKey || e.metaKey);
          }}
        >
          {data.variant === 'absence' && <span className="gap-q" aria-hidden="true">?</span>}
          <span className="link-text">{data.label}</span>
          {!data.confirmed && data.variant === 'edge' && <span className="q"> ?</span>}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { step: StepNode, area: AreaNode };
const edgeTypes = { link: LinkEdge };

export type GraphProps = {
  map: CodeMap;
  report: CheckReport | null;
  selection: Sel;
  view: View | null;
  fresh: string[];
  /** What answers added: laid out around the original map so its boxes don't move. */
  added: readonly string[];
  ghost: FixProposal | null;
  /** The walkthrough is running: keep what it lights up clear of its bubble, bottom left. */
  touring: boolean;
  onSelect: (kind: keyof Sel, id: string, additive: boolean) => void;
  onClear: () => void;
};

/** Node ids a view is about: boxes directly, plus the ends of any arrows or gaps it names. */
function nodesOf(map: CodeMap, ids: readonly string[]): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    if (map.nodes.some((n) => n.id === id)) out.add(id);
    const e = map.edges.find((x) => x.id === id);
    if (e) out.add(e.from).add(e.to);
    const a = map.absences.find((x) => x.id === id);
    if (a?.between) out.add(a.between.from).add(a.between.to);
  }
  return [...out];
}

/** Room the camera leaves on the left for the walkthrough bubble (its width plus a margin). */
const TOUR_ROOM = '440px';

const shortClaim = (claim: string) => (claim.length > 28 ? `${claim.slice(0, 26)}…` : claim);

export function MapGraph(p: GraphProps) {
  // A proposed fix's arrow is drawn only while both of its ends are (a hidden layer can hide one).
  const ghost = p.ghost?.connects && p.map.nodes.some((n) => n.id === p.ghost!.connects!.from) && p.map.nodes.some((n) => n.id === p.ghost!.connects!.to) ? p.ghost : null;
  const extra: ExtraEdge[] = useMemo(() => (ghost?.connects ? [{ id: ghost.id, from: ghost.connects.from, to: ghost.connects.to }] : []), [ghost]);
  const key = layoutKey(p.map, extra, p.added);
  const [layout, setLayout] = useState<{ key: string; layout: Layout } | null>(null);
  const rf = useReactFlow();

  useEffect(() => {
    let live = true;
    void layoutMap(p.map, extra, new Set(p.added)).then((l) => live && setLayout({ key, layout: l }));
    return () => {
      live = false;
    };
    // The key captures everything the layout depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const hl = p.view?.highlight.length ? new Set(p.view.highlight) : null;
  const lit = useMemo(() => (hl ? new Set(nodesOf(p.map, [...hl])) : null), [hl, p.map]);
  const sel = p.selection;

  const nodes = useMemo((): (StepNodeT | AreaNodeT)[] => {
    if (!layout) return [];
    const l = layout.layout;
    const reached = (areaId: string) => !lit || p.map.nodes.some((n) => n.area === areaId && lit.has(n.id));
    const areaNodes: AreaNodeT[] = p.map.areas.flatMap((a) => {
      const box = l.areas[a.id];
      if (!box) return [];
      return [{
        id: `area:${a.id}`,
        type: 'area' as const,
        position: { x: box.x, y: box.y },
        style: { width: box.w, height: box.h },
        data: { label: a.label, note: null, dim: !reached(a.id) },
        selectable: false,
        draggable: false,
        zIndex: 0,
      }];
    });
    const stepNodes: StepNodeT[] = p.map.nodes.flatMap((n) => {
      const box = l.nodes[n.id];
      if (!box) return [];
      const sub = n.symbol ? n.symbol.slice(n.symbol.indexOf('#') + 1) : `${n.evidence[0]!.file.split('/').pop()}:${n.evidence[0]!.line}`;
      return [{
        id: n.id,
        type: 'step' as const,
        parentId: `area:${n.area}`,
        extent: 'parent' as const,
        position: { x: box.x, y: box.y },
        data: {
          name: n.name,
          sub,
          kind: n.kind,
          confirmed: p.report?.nodes[n.id]?.status === 'confirmed',
          screen: p.report?.screens?.[n.id]?.status === 'confirmed',
          selected: sel.nodes.includes(n.id),
          hl: !!lit?.has(n.id),
          dim: !!lit && !lit.has(n.id),
          fresh: p.fresh.includes(n.id),
          onClick: (additive) => p.onSelect('nodes', n.id, additive),
        },
        draggable: false,
        zIndex: 1,
      }];
    });
    return [...areaNodes, ...stepNodes];
  }, [layout, p.map, p.report, sel, lit, p.fresh, p.onSelect]);

  const edges = useMemo((): LinkEdgeT[] => {
    if (!layout) return [];
    const marker = (color: string) => ({ type: MarkerType.ArrowClosed, width: 16, height: 16, color });
    const on = (id: string) => !!hl?.has(id);
    const handles = (from: string, to: string) => {
      const [a, b] = sides(p.map, layout.layout, from, to);
      return { sourceHandle: `s${a}`, targetHandle: `t${b}` };
    };
    const out: LinkEdgeT[] = p.map.edges.map((e) => {
      const confirmed = p.report?.edges[e.id]?.status === 'confirmed';
      const isHl = on(e.id) || (!!lit && lit.has(e.from) && lit.has(e.to) && !hl);
      const variant = 'edge' as const;
      return {
        id: `e:${e.id}`,
        source: e.from,
        target: e.to,
        ...handles(e.from, e.to),
        type: 'link' as const,
        className: cls('link', `link-${variant}`, !confirmed && 'unconfirmed', on(e.id) && 'hl', !!hl && !on(e.id) && 'dim', sel.edges.includes(e.id) && 'selected'),
        markerEnd: marker(on(e.id) ? 'var(--path)' : 'var(--line-strong)'),
        zIndex: 2,
        data: {
          label: e.label,
          variant,
          confirmed,
          hl: isHl,
          dim: !!hl && !on(e.id),
          selected: sel.edges.includes(e.id),
          onClick: (additive) => p.onSelect('edges', e.id, additive),
        },
      };
    });
    const fixes = (a: { from: string; to: string }) => ghost?.connects?.from === a.from && ghost.connects.to === a.to;
    for (const a of p.map.absences) {
      if (!a.between) continue;
      // While a fix for this gap is proposed, its green arrow takes the gap's place.
      if (fixes(a.between)) continue;
      const confirmed = p.report?.absences[a.id]?.status === 'confirmed';
      out.push({
        id: `a:${a.id}`,
        source: a.between.from,
        target: a.between.to,
        ...handles(a.between.from, a.between.to),
        type: 'link',
        className: cls('link', 'link-absence', !confirmed && 'unconfirmed', on(a.id) && 'hl', !!hl && !on(a.id) && 'dim', sel.absences.includes(a.id) && 'selected'),
        markerEnd: marker('var(--dead)'),
        zIndex: 2,
        data: {
          label: shortClaim(a.claim),
          variant: 'absence',
          confirmed,
          hl: on(a.id),
          dim: !!hl && !on(a.id),
          selected: sel.absences.includes(a.id),
          onClick: (additive) => p.onSelect('absences', a.id, additive),
        },
      });
    }
    if (ghost?.connects) {
      out.push({
        id: `g:${ghost.id}`,
        source: ghost.connects.from,
        target: ghost.connects.to,
        ...handles(ghost.connects.from, ghost.connects.to),
        type: 'link',
        className: 'link link-ghost',
        markerEnd: marker('var(--ok)'),
        zIndex: 3,
        data: { label: `+ ${ghost.connects.label}`, variant: 'ghost', confirmed: true, hl: true, dim: false, selected: false },
      });
    }
    // Arrows that join the same two steps (either way round) bend apart, so each line and label stays visible.
    const byPair = new Map<string, LinkEdgeT[]>();
    for (const e of out) {
      const key = [e.source, e.target].sort().join('|');
      byPair.set(key, [...(byPair.get(key) ?? []), e]);
    }
    for (const group of byPair.values()) {
      if (group.length < 2) continue;
      group.forEach((e, i) => {
        if (e.data) e.data.offset = (i - (group.length - 1) / 2) * 44;
      });
    }
    return out;
  }, [layout, p.map, p.report, sel, hl, lit, ghost, p.onSelect]);

  // When the map area changes width (the panel comes and goes, or is dragged wider), keep what was in the middle in
  // the middle, rather than letting the panel slide over the right-hand side of the map.
  const paneWidth = useStore((st) => st.width);
  const lastWidth = useRef(0);
  useEffect(() => {
    const before = lastWidth.current;
    lastWidth.current = paneWidth;
    if (!before || !paneWidth || before === paneWidth) return;
    const vp = rf.getViewport();
    void rf.setViewport({ ...vp, x: vp.x + (paneWidth - before) / 2 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneWidth]);

  // The camera follows the view: fly to what's in focus, or show the whole map. It waits (a frame at a time) until
  // React Flow has measured every box, or it would fit an empty canvas.
  const viewKey = JSON.stringify([layout?.key, p.view?.focus, p.view?.highlight, p.touring]);
  const firstFit = useRef(true);
  useEffect(() => {
    if (!layout) return;
    const ids = p.view ? nodesOf(p.map, p.view.highlight.length ? p.view.highlight : p.view.focus ? [p.view.focus] : []) : [];
    let frame = 0;
    let handle = 0;
    const tick = () => {
      const ns = rf.getNodes();
      // Measurements live on React Flow's internal nodes, not on the (controlled) nodes we pass in.
      // Two frames at least, so a canvas that just changed width (the panel hides during the walkthrough) is measured.
      if (frame < 2 || !ns.length || !ns.every((n) => rf.getInternalNode(n.id)?.measured?.width)) {
        if (frame++ < 60) handle = requestAnimationFrame(tick);
        return;
      }
      const duration = firstFit.current ? 0 : 650;
      firstFit.current = false;
      // Keep clear of the dock along the bottom.
      const padding = ids.length
        ? ({ top: '60px', left: p.touring ? TOUR_ROOM : '60px', right: '60px', bottom: '150px' } as const)
        : ({ top: '64px', left: '32px', right: '32px', bottom: '130px' } as const); // top: the earlier-questions button
      void rf.fitView(ids.length ? { nodes: ids.map((n) => ({ id: n })), duration, padding, maxZoom: 1.15 } : { duration, padding, maxZoom: 1.1 });
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey]);


  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      // Steps select themselves (see StepNode); this handler only keeps React Flow from turning their pointer events off.
      onNodeClick={() => undefined}
      onEdgeClick={(e, edge) => {
        if (edge.id.startsWith('e:')) p.onSelect('edges', edge.id.slice(2), e.shiftKey || e.metaKey);
        if (edge.id.startsWith('a:')) p.onSelect('absences', edge.id.slice(2), e.shiftKey || e.metaKey);
      }}
      onPaneClick={p.onClear}
      panOnDrag
      elementsSelectable={false}
      nodesDraggable={false}
      nodesConnectable={false}
      minZoom={0.15}
      maxZoom={2}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.3} />
    </ReactFlow>
  );
}
