// Claude writes Markdown out of habit; show it as formatting rather than symbols. A small, safe subset: paragraphs and
// line breaks, headings, bullet and numbered lists, code blocks, **bold**, *italic*, `code` and [links](https://…).
// It builds React elements (never HTML strings), so nothing in the text can run on the page.
import type { ReactNode } from 'react';

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[]; start: number }
  | { kind: 'code'; text: string };

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s*[-*+•]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,4})[.)]\s+(.*)$/;

/** Splits text into blocks: a blank line ends a paragraph; list items and code fences are their own blocks. */
export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: 'p', text: para.join('\n') });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE.test(line)) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]!); i++) body.push(lines[i]!);
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      blocks.push({ kind: 'h', text: h[1]! });
      continue;
    }
    const b = BULLET.exec(line);
    const n = b ? null : NUMBERED.exec(line);
    if (b || n) {
      flush();
      const kind = b ? 'ul' : 'ol';
      const last = blocks[blocks.length - 1];
      const item = b ? b[1]! : n![2]!;
      if (last && last.kind === kind) last.items.push(item);
      else blocks.push(kind === 'ul' ? { kind, items: [item] } : { kind, items: [item], start: Number(n![1]) });
      continue;
    }
    // A line that carries on a list item (indented, right after it) belongs to that item.
    const last = blocks[blocks.length - 1];
    if (!para.length && last && (last.kind === 'ul' || last.kind === 'ol') && /^\s+\S/.test(line)) {
      last.items[last.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

// `code`, **bold** / __bold__, *italic* / _italic_ (not inside words, so snake_case stays), [text](url).
const INLINE = /(`+)([^`]+?)\1|\*\*(.+?)\*\*|__(.+?)__|\*(?!\s)(.+?)\*|(?<![\w])_(?!\s)(.+?)_(?![\w])|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Inline formatting within a block. Single line breaks stay line breaks. */
export function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  let n = 0;
  const plain = (s: string) => {
    s.split('\n').forEach((part, i) => {
      if (i > 0) out.push(<br key={`${key}-br${n++}`} />);
      if (part) out.push(part);
    });
  };
  for (const m of text.matchAll(INLINE)) {
    plain(text.slice(at, m.index));
    const k = `${key}-${n++}`;
    if (m[2] !== undefined) out.push(<code key={k}>{m[2]}</code>);
    else if (m[3] !== undefined || m[4] !== undefined) out.push(<strong key={k}>{inline(m[3] ?? m[4]!, k)}</strong>);
    else if (m[5] !== undefined || m[6] !== undefined) out.push(<em key={k}>{inline(m[5] ?? m[6]!, k)}</em>);
    else if (m[7] !== undefined) {
      const url = m[8]!;
      // Only real web links open; anything else (a file path, javascript:) stays as text.
      out.push(/^https?:\/\//i.test(url) ? <a key={k} href={url} target="_blank" rel="noreferrer">{inline(m[7], k)}</a> : <span key={k}>{inline(m[7], k)}</span>);
    }
    at = m.index + m[0].length;
  }
  plain(text.slice(at));
  return out;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseBlocks(text);
  if (!blocks.length) return null;
  return (
    <div className={className ? `md ${className}` : 'md'}>
      {blocks.map((b, i) => {
        const k = `b${i}`;
        if (b.kind === 'p') return <p key={k}>{inline(b.text, k)}</p>;
        if (b.kind === 'h') return <p key={k} className="md-h">{inline(b.text, k)}</p>;
        if (b.kind === 'code') return <pre key={k}><code>{b.text}</code></pre>;
        const items = b.items.map((it, j) => <li key={`${k}-${j}`}>{inline(it, `${k}-${j}`)}</li>);
        return b.kind === 'ul' ? <ul key={k}>{items}</ul> : <ol key={k} start={b.start}>{items}</ol>;
      })}
    </div>
  );
}
