// What the person sees at a box: a screenshot illuminate took (with the thing the box is about marked), an image file
// from the repo, or a rough sketch of a component's visible parts. Only screens the checker confirmed get here.
import { useState } from 'react';
import { screenUrl } from './api';
import type { CheckReport, CodeMap, ScreenShow } from './types';

const cls = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');
const pct = (n: number) => `${Math.max(0, Math.min(1, n)) * 100}%`;

/** The confirmed screen of a box, if it has one. */
export function screenOf(report: CheckReport | null, id: string): ScreenShow | null {
  const c = report?.screens?.[id];
  return c?.status === 'confirmed' ? c.show : null;
}

/** The first confirmed screen among these boxes (a walkthrough stop's, say), with the box it belongs to. */
export function firstScreen(map: CodeMap, report: CheckReport | null, ids: readonly string[]): { name: string; show: ScreenShow } | null {
  for (const id of ids) {
    const show = screenOf(report, id);
    const node = map.nodes.find((n) => n.id === id);
    if (show && node) return { name: node.name, show };
  }
  return null;
}

export function ScreenView({ show, name }: { show: ScreenShow; name: string }) {
  // A whole screen in a narrow card makes the marked thing tiny, so it starts zoomed in on the mark.
  const [whole, setWhole] = useState(false);
  if (show.kind === 'capture') {
    const box = show.box;
    const zoomed = !!box && !whole;
    const origin = box ? `${pct(box.x + box.w / 2)} ${pct(box.y + box.h / 2)}` : undefined;
    return (
      <figure className="screen">
        <div className="screen-shot" style={{ aspectRatio: `${show.width} / ${show.height}` }}>
          <div className="screen-zoom" style={zoomed ? { transform: 'scale(2.2)', transformOrigin: origin } : undefined}>
            <img src={screenUrl(show)} alt={`The screen at “${name}”${show.title ? `: ${show.title}` : ''}`} loading="lazy" />
            {box && <i className="screen-mark" aria-hidden="true" style={{ left: pct(box.x), top: pct(box.y), width: pct(box.w), height: pct(box.h) }} />}
          </div>
        </div>
        <figcaption className="muted small">
          Screenshot of {show.from}
          {box && <> · <button className="linklike" onClick={() => setWhole(!whole)}>{whole ? 'Zoom in' : 'Show the whole screen'}</button></>}
        </figcaption>
      </figure>
    );
  }
  if (show.kind === 'image') {
    return (
      <figure className="screen">
        <div className="screen-image"><img src={screenUrl(show)} alt={`Image used at “${name}”`} loading="lazy" /></div>
        <figcaption className="muted small">{show.file}</figcaption>
      </figure>
    );
  }
  const hl = show.highlight?.trim().toLowerCase();
  return (
    <figure className="screen">
      <div className="screen-sketch" role="img" aria-label={`Rough sketch of the screen at “${name}”`}>
        {show.elements.map((e, i) => (
          <span key={i} className={cls('sk', `sk-${e.kind}`, hl === e.text.trim().toLowerCase() && 'sk-mark')}>{e.kind === 'image' ? `▧ ${e.text}` : e.text}</span>
        ))}
      </div>
      <figcaption className="muted small">Rough sketch from {show.file}, not a screenshot</figcaption>
    </figure>
  );
}
