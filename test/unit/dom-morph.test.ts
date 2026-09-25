/**
 * The keyed DOM morph, exercised in a real DOM.
 *
 * INVARIANT: a live update patches by node identity and never clobbers what the
 * human is doing. A refresh that empties a half-typed comment box, collapses an
 * open `<details>`, or re-creates every card (losing scroll and view state) is
 * a bug — that is the whole reason the live island morphs instead of replacing.
 *
 * These run the SHIPPED script text (`domMorphScript()`), not a re-implementation,
 * so the assertions cover what the browser actually gets.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Window } from 'happy-dom';
import { domMorphScript, MORPH_PRESERVED_ATTRIBUTES, MORPH_LIVE_CHILDREN_ATTR } from '../../src/server/dom-morph';

let win: InstanceType<typeof Window>;

/** Strip the `<script>` wrapper and run the island in a fresh window. */
function installMorph(w: InstanceType<typeof Window>): void {
  const src = domMorphScript().replace(/^<script>/, '').replace(/<\/script>$/, '');
  (w as unknown as { eval(code: string): void }).eval(src);
}

function el(w: InstanceType<typeof Window>, html: string): HTMLElement {
  const host = w.document.createElement('div');
  host.innerHTML = html;
  return host as unknown as HTMLElement;
}

function morph(target: HTMLElement, source: HTMLElement): void {
  (win as unknown as { lzMorph(a: unknown, b: unknown): boolean }).lzMorph(target, source);
}

beforeEach(() => {
  win = new Window({ url: 'http://localhost/' });
  installMorph(win);
});

afterEach(async () => {
  await win.happyDOM.close();
});

describe('lzMorph', () => {
  test('keeps the identity of keyed nodes it has seen before', () => {
    const target = el(win, `<ul><li data-lz-key="a">A</li><li data-lz-key="b">B</li></ul>`);
    const before = target.querySelector('[data-lz-key="b"]');
    const source = el(win, `<ul><li data-lz-key="a">A</li><li data-lz-key="b">B!</li></ul>`);
    morph(target, source);
    const after = target.querySelector('[data-lz-key="b"]');
    expect(after).toBe(before as never);
    expect(after?.textContent).toBe('B!');
  });

  // Newest-first lists prepend. The surviving rows must be the SAME nodes, or
  // scroll position, view state and text selection all die on every poll.
  test('prepending a row keeps every existing row', () => {
    const target = el(win, `<ul><li data-lz-key="a">A</li><li data-lz-key="b">B</li></ul>`);
    const a = target.querySelector('[data-lz-key="a"]');
    const source = el(win, `<ul><li data-lz-key="new">N</li><li data-lz-key="a">A</li><li data-lz-key="b">B</li></ul>`);
    morph(target, source);
    expect(target.querySelectorAll('li').length).toBe(3);
    expect(target.querySelector('[data-lz-key="a"]')).toBe(a as never);
    expect(target.querySelector('li')?.textContent).toBe('N');
  });

  test('a row the server no longer sends is removed', () => {
    const target = el(win, `<ul><li data-lz-key="a">A</li><li data-lz-key="b">B</li></ul>`);
    morph(target, el(win, `<ul><li data-lz-key="a">A</li></ul>`));
    expect(target.querySelectorAll('li').length).toBe(1);
    expect(target.querySelector('[data-lz-key="b"]')).toBeNull();
  });

  // This is item 10 of the engineer's UI feedback, and the reason the morph
  // exists rather than a re-fetch: a draft must survive a background refresh.
  test('never overwrites a half-typed textarea or input', () => {
    const target = el(win, `<form id="f"><textarea name="feedback"></textarea><input name="reason" value=""></form>`);
    const textarea = target.querySelector('textarea') as unknown as HTMLTextAreaElement;
    const input = target.querySelector('input') as unknown as HTMLInputElement;
    textarea.value = 'half a thought about the diff';
    input.value = 'because';
    morph(target, el(win, `<form id="f"><textarea name="feedback"></textarea><input name="reason" value="stale"></form>`));
    expect(textarea.value).toBe('half a thought about the diff');
    expect(input.value).toBe('because');
    // The server's copy is not even written to the attribute: a later reset()
    // must not resurrect a default the human never saw.
    expect(input.getAttribute('value')).toBe('');
  });

  test('leaves an open <details> open and a collapsed card collapsed', () => {
    const target = el(win, `<div><details id="g" open><summary>s</summary>x</details><section data-viewed-key="card:1" data-collapsed="1">c</section></div>`);
    morph(
      target,
      el(win, `<div><details id="g"><summary>s</summary>x</details><section data-viewed-key="card:1">c2</section></div>`),
    );
    expect((target.querySelector('#g') as unknown as HTMLDetailsElement).hasAttribute('open')).toBe(true);
    expect(target.querySelector('[data-viewed-key="card:1"]')?.getAttribute('data-collapsed')).toBe('1');
    expect(target.querySelector('[data-viewed-key="card:1"]')?.textContent).toBe('c2');
  });

  test('client-owned attributes are neither written nor removed', () => {
    for (const attr of MORPH_PRESERVED_ATTRIBUTES) {
      const target = el(win, `<div><span id="s" ${attr}="1">x</span></div>`);
      morph(target, el(win, `<div><span id="s">x</span></div>`));
      expect(target.querySelector('#s')?.getAttribute(attr)).toBe('1');
    }
  });

  test('server-owned attributes still update', () => {
    const target = el(win, `<div><a id="l" href="/old" class="lz-tab">t</a></div>`);
    morph(target, el(win, `<div><a id="l" href="/new" class="lz-tab lz-tab-current">t</a></div>`));
    expect(target.querySelector('#l')?.getAttribute('href')).toBe('/new');
    expect(target.querySelector('#l')?.getAttribute('class')).toBe('lz-tab lz-tab-current');
  });

  test('a node whose tag changed is replaced rather than half-patched', () => {
    const target = el(win, `<div><span id="x">old</span></div>`);
    morph(target, el(win, `<div><p id="x">new</p></div>`));
    expect(target.querySelector('#x')?.tagName).toBe('P');
    expect(target.querySelector('#x')?.textContent).toBe('new');
  });

  test('unkeyed text and elements are patched in place', () => {
    const target = el(win, `<div class="lz-subtasks"><h2>Subtasks (2)</h2></div>`);
    const h2 = target.querySelector('h2');
    morph(target, el(win, `<div class="lz-subtasks"><h2>Subtasks (3)</h2></div>`));
    expect(target.querySelector('h2')).toBe(h2 as never);
    expect(h2?.textContent).toBe('Subtasks (3)');
  });

  /**
   * The morph writes the SERVER's markup over a body other islands have
   * already written into. `annotateProse` (review.ts) adds `.rv-prose-block`
   * and `data-line` to a paragraph the server rendered plain, and appends an
   * "Ask or comment on this line" button that is in no server response.
   *
   * This test pins that the morph DOES remove both — it has to, or it could
   * never delete anything the server stopped sending. That is exactly why
   * `applyBody` re-runs `window.lzAnnotateProse` afterwards; asserting the
   * removal here is what makes the necessity of that call visible.
   */
  test('client-appended children and client-written classes do not survive a morph', () => {
    const target = el(
      win,
      `<div data-rv-prose><p class="rv-prose-block" data-file="report" data-line="3">text` +
        `<button class="rv-prose-add">+</button></p>` +
        `<div class="rv-prose-thread-wrap">a thread</div></div>`,
    );
    morph(target, el(win, `<div data-rv-prose><p>text</p></div>`));

    const p = target.querySelector('p');
    expect(p?.querySelector('.rv-prose-add')).toBeNull();
    expect(target.querySelector('.rv-prose-thread-wrap')).toBeNull();
    expect(p?.getAttribute('data-line')).toBeNull();
    expect(p?.className).toBe('');
    // The paragraph itself is the same node — identity survives even though
    // the decoration does not, so a re-annotation puts it all back in place.
    expect(p?.textContent).toBe('text');
  });

  // INVARIANT: a live shell terminal is appended into a `.lz-shell-mount` slot
  // the server always renders empty. Without this marker a background poll's
  // morph deletes the terminal (morphChildren diffs the live child against
  // the server's empty source) even though the slot's own `hidden` attribute
  // is preserved — leaving a blank box, a running PTY the reader can no
  // longer see, and a Start/Run button that is inert forever after (the mount
  // node itself survives, so JS still thinks a session is live there).
  test(`a node with ${MORPH_LIVE_CHILDREN_ATTR} keeps its live children through a morph`, () => {
    const target = el(
      win,
      `<div class="step"><button>Start</button>` +
        `<div class="lz-shell-mount is-live" data-lz-shell-mount ${MORPH_LIVE_CHILDREN_ATTR}>` +
        `<div class="lz-shell-session">terminal</div></div></div>`,
    );
    const mount = target.querySelector('[data-lz-shell-mount]');
    const session = target.querySelector('.lz-shell-session');
    // The server always renders this slot back to empty and hidden.
    const source = el(
      win,
      `<div class="step"><button>Start</button>` +
        `<div class="lz-shell-mount" data-lz-shell-mount ${MORPH_LIVE_CHILDREN_ATTR} hidden></div></div>`,
    );
    morph(target, source);
    expect(target.querySelector('[data-lz-shell-mount]')).toBe(mount as never);
    expect(target.querySelector('.lz-shell-session')).toBe(session as never);
    expect(target.querySelector('.lz-shell-session')?.textContent).toBe('terminal');
  });
});
