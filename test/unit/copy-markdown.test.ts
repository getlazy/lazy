import { describe, test, expect } from 'bun:test';
import { copyMarkdownButtonHtml, copyMarkdownScript } from '../../src/server/copy-markdown';

function runScript(env: { clipboard?: { writeText: (t: string) => Promise<void> }; secure: boolean; execOk?: boolean }) {
  const js = copyMarkdownScript().replace(/^<script>|<\/script>$/g, '');
  let handler: (ev: unknown) => void = () => {};
  const appended: unknown[] = [];
  const document = {
    addEventListener: (_: string, h: (ev: unknown) => void) => { handler = h; },
    createElement: () => ({ setAttribute() {}, style: {}, select() {}, value: '' }),
    body: { appendChild: (e: unknown) => appended.push(e), removeChild() {} },
    execCommand: () => env.execOk ?? false,
  };
  const win = { isSecureContext: env.secure };
  new Function('document', 'navigator', 'window', 'setTimeout', 'clearTimeout', js)(
    { ...document, execCommand: document.execCommand }, { clipboard: env.clipboard }, win, () => 0, () => {},
  );
  return {
    click: async (source: string) => {
      const m = copyMarkdownButtonHtml(source).match(/data-copy-md="([^"]*)"/)!;
      const attr = m[1]!.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      const btn: any = { textContent: 'Copy', classList: { toggle() {}, remove() {} }, getAttribute: () => attr };
      handler({ target: { closest: () => btn }, preventDefault() {}, stopPropagation() {} });
      await new Promise((r) => setTimeout(r, 5));
      return btn.textContent as string;
    },
  };
}

describe('copy-markdown script', () => {
  // INVARIANT: the clipboard receives the markdown source exactly, CR/LF included.
  // The attribute is JSON so HTML attribute normalisation cannot alter it.
  test('writes the exact source to the clipboard', async () => {
    const written: string[] = [];
    const src = '# H\r\n\r\n- a\r\n```js\r\nx<y>"z"\r\n```\r\n[l](https://e.com?a=1&b=2)';
    const r = runScript({ secure: true, clipboard: { writeText: async (t) => { written.push(t); } } });
    expect(await r.click(src)).toBe('Copied');
    expect(written).toEqual([src]);
  });

  test('reports failure when neither clipboard nor fallback works', async () => {
    const r = runScript({ secure: false, execOk: false });
    expect(await r.click('# x')).toBe('Copy failed');
  });

  test('falls back to execCommand without a secure context', async () => {
    const r = runScript({ secure: false, execOk: true });
    expect(await r.click('# x')).toBe('Copied');
  });
});
