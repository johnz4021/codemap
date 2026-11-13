// The panel's width: drag its left edge (or focus the edge and use the arrow keys). Remembered between visits.
import { useCallback, useEffect, useState } from 'react';

const KEY = 'illuminate-panel-width';
const MIN = 300;
const DEFAULT = 400;
/** Never squeeze the map narrower than this. */
const MAP_MIN = 360;

const clamp = (w: number) => Math.round(Math.max(MIN, Math.min(w, Math.max(MIN, window.innerWidth - MAP_MIN))));

export function usePanelWidth(): [number, (w: number) => void] {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(KEY));
    return clamp(saved > 0 ? saved : DEFAULT);
  });
  const set = useCallback((w: number) => {
    const next = clamp(w);
    setWidth(next);
    localStorage.setItem(KEY, String(next));
  }, []);
  // A smaller window can't keep a panel that leaves no room for the map.
  useEffect(() => {
    const onResize = () => setWidth((w) => clamp(w));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return [width, set];
}

/** The draggable left edge of the panel. The panel sits flush right, so its width is the distance to the window's edge. */
export function PanelResizer({ width, onWidth }: { width: number; onWidth: (w: number) => void }) {
  return (
    <div
      className="panel-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Panel width"
      aria-valuenow={width}
      aria-valuemin={MIN}
      tabIndex={0}
      title="Drag to resize the panel"
      onPointerDown={(e) => {
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        document.body.classList.add('resizing');
        const move = (ev: PointerEvent) => onWidth(window.innerWidth - ev.clientX);
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
          document.body.classList.remove('resizing');
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      }}
      onDoubleClick={() => onWidth(DEFAULT)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') { e.preventDefault(); onWidth(width + 24); }
        if (e.key === 'ArrowRight') { e.preventDefault(); onWidth(width - 24); }
      }}
    />
  );
}
