import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { controlRefusalScript } from '../../src/server/control-refusal';

// INVARIANT: a refusal consumes the click before any action handler runs,
// explains the server's answer as text, and still works after a tab is replaced.
test('refusals are readable, escaped and keyboard accessible on dynamic controls', async () => {
  const win = new Window({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
  try {
    win.eval(controlRefusalScript().replace(/^<script>|<\/script>$/g, ''));
    win.document.body.innerHTML = '<div><button data-control-refusal="Wait &lt;then&gt; retry">Pair</button></div>';
    const button = win.document.querySelector('button')!;
    let calls = 0;
    button.addEventListener('click', () => { calls++; });
    button.click();
    button.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(calls).toBe(0);
    expect(win.document.querySelectorAll('[role=alert]').length).toBe(1);
    expect(win.document.querySelector('[role=alert]')!.textContent).toBe('Wait <then> retry');
    expect(win.document.querySelector('then')).toBeNull();
    expect(button.disabled).toBe(false);
    button.removeAttribute('data-control-refusal');
    button.click();
    expect(calls).toBe(1);
  } finally { await win.happyDOM.close(); }
});

// INVARIANT: a busy submit guard prevents duplicate requests without removing
// the control from keyboard focus. Clearing busy allows a retry after failure.
test('busy controls explain repeated clicks and prevent a second submit', async () => {
  const win = new Window({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
  try {
    win.eval(controlRefusalScript().replace(/^<script>|<\/script>$/g, ''));
    win.document.body.innerHTML = '<form><button type="submit" aria-busy="true">Saving…</button></form>';
    const form = win.document.querySelector('form')!;
    const button = win.document.querySelector('button')!;
    let calls = 0;
    form.addEventListener('submit', event => { event.preventDefault(); calls++; });
    button.click();
    form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    expect(calls).toBe(0);
    expect(form.querySelector('[role=alert]')!.textContent).toContain('Wait for it to finish');
    button.removeAttribute('aria-busy');
    button.click();
    expect(calls).toBe(1);
  } finally { await win.happyDOM.close(); }
});

// INVARIANT: "Load all" is busy only while a request is outstanding. Once it
// finishes, another click explains the completed state instead of being inert.
test('loading all diffs clears busy and explains completion', async () => {
  const { progressiveLoaderScript } = await import('../../src/server/review-progressive');
  const win = new Window({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
  try {
    win.document.body.innerHTML = '<div data-rv-file-list><button data-rv-load-all>Load all</button></div>' +
      '<div id="rv-root"><section class="rv-file-pending" data-rv-pending="a.ts" data-rv-large data-rv-lines="2000"></section></div>';
    win.eval('window.IntersectionObserver = function () { this.observe = function () {}; };');
    win.fetch = async () => new win.Response(JSON.stringify({ files: { 'a.ts': '<section class="rv-file">Loaded</section>' } }), { headers: { 'content-type': 'application/json' } });
    win.eval(controlRefusalScript().replace(/^<script>|<\/script>$/g, ''));
    win.eval(progressiveLoaderScript('/files').replace(/^<script>|<\/script>$/g, ''));
    const button = win.document.querySelector('button')!;
    button.click();
    expect(button.getAttribute('aria-busy')).toBe('true');
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(win.document.querySelector('.rv-file')!.textContent).toBe('Loaded');
    expect(button.hasAttribute('aria-busy')).toBe(false);
    button.click();
    expect(win.document.querySelector('[role=alert]')!.textContent).toContain('All available diffs are loaded');
  } finally { await win.happyDOM.close(); }
});
