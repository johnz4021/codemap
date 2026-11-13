// The input bar floating over the map. What's selected rides along as chips; Enter sends, Shift+Enter adds a line.
import { useEffect, useRef } from 'react';
import { nameOf } from './panel';
import type { Sel } from './state';
import type { CodeMap } from './types';

export type ComposerProps = {
  map: CodeMap;
  selection: Sel;
  draft: string;
  busy: boolean;
  /** Focus the box when it appears (it moves into the conversation when that opens). */
  autoFocus?: boolean;
  onDraft: (text: string) => void;
  onRemove: (kind: keyof Sel, id: string) => void;
  onSend: () => void;
};

export function Composer({ map, selection, draft, busy, autoFocus, onDraft, onRemove, onSend }: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const chips = (['nodes', 'edges', 'absences'] as const).flatMap((kind) => selection[kind].map((id) => ({ kind, id })));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [draft]);
  useEffect(() => {
    if (draft) ref.current?.focus();
  }, [draft === '']);
  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true });
    // Only when it first appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy && draft.trim()) onSend();
      }}
    >
      {chips.map((c) => (
        <span key={`${c.kind}:${c.id}`} className={`sel-chip sel-${c.kind}`}>
          <span className="sel-text" title={nameOf(map, c.id)}>
            {c.kind === 'absences' ? '✕ ' : '◉ '}
            {nameOf(map, c.id)}
          </span>
          <button type="button" aria-label={`Remove ${nameOf(map, c.id)}`} onClick={() => onRemove(c.kind, c.id)}>×</button>
        </span>
      ))}
      <textarea
        ref={ref}
        id="ask"
        rows={1}
        value={draft}
        placeholder={busy ? 'Claude is working…' : chips.length ? 'Ask about what you selected…' : 'Ask about this map…'}
        onChange={(e) => onDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!busy && draft.trim()) onSend();
          }
        }}
        aria-label="Ask a question about the map"
      />
      <button type="submit" className="send" disabled={busy || !draft.trim()} aria-label="Send">↑</button>
    </form>
  );
}
