import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown, parseBlocks } from '../src/markdown';

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe('Markdown in what Claude writes', () => {
  it('turns blank lines into paragraphs and single line breaks into breaks', () => {
    expect(html('First idea.\nStill first.\n\nSecond idea.')).toBe('<div class="md"><p>First idea.<br/>Still first.</p><p>Second idea.</p></div>');
  });

  it('shows bold, italic, code and links as formatting', () => {
    expect(html('The **server** calls `answer()` *once*; see [docs](https://example.com).')).toBe(
      '<div class="md"><p>The <strong>server</strong> calls <code>answer()</code> <em>once</em>; see <a href="https://example.com" target="_blank" rel="noreferrer">docs</a>.</p></div>',
    );
  });

  it('leaves snake_case and lone symbols alone', () => {
    expect(html('Calls make_map with 2 * 3 items.')).toBe('<div class="md"><p>Calls make_map with 2 * 3 items.</p></div>');
  });

  it('builds bullet and numbered lists, keeping the numbering', () => {
    expect(html('Steps:\n- Read the reply\n- Check it\n\n3. Third\n4. Fourth')).toBe(
      '<div class="md"><p>Steps:</p><ul><li>Read the reply</li><li>Check it</li></ul><ol start="3"><li>Third</li><li>Fourth</li></ol></div>',
    );
  });

  it('keeps code blocks as they are, formatting symbols and all', () => {
    expect(html('Before\n```ts\nconst a = **b**;\n```\nAfter')).toBe('<div class="md"><p>Before</p><pre><code>const a = **b**;</code></pre><p>After</p></div>');
  });

  it('never makes a link out of anything but a web address, and never injects HTML', () => {
    const out = html('[click](javascript:alert(1)) <img src=x onerror=alert(1)>');
    expect(out).not.toContain('href');
    expect(out).toContain('&lt;img');
  });

  it('treats headings as emphasised lines', () => {
    expect(parseBlocks('## How it works\nText')).toEqual([{ kind: 'h', text: 'How it works' }, { kind: 'p', text: 'Text' }]);
  });
});
