import { describe, expect, test } from 'bun:test';
import { artifactsTabHtml } from '../../src/server/artifacts-tab';
import { actionDialogChromeHtml } from '../../src/server/action-dialog';
import { bundledStylesheet } from '../../src/server/styles';
import { browserSuiteSkipped, dumpDomOfHtml, screenshotDashboardPage } from '../helpers/page-screenshot';
import type { TaskArtifact } from '../../src/types';

const skipped = await browserSuiteSkipped('static-text-drawers');
const body = Array.from({ length: 100 }, (_, index) => `Line ${index}: full static text.`).join('\n');
const artifact: TaskArtifact = {
  id: 'artifact', task_id: 'task', name: 'output.txt', size: body.length,
  sha256: '', mime_type: 'text/plain', binary: false, origin: 'output',
  created_at: 0, created_by: 'agent',
};

function pageHtml(): string {
  return `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${bundledStylesheet()}</style></head><body>
    <main style="max-width:960px;margin:auto;padding:16px"><h1>Artifacts</h1>
    ${artifactsTabHtml({ taskId: 'task', artifacts: [artifact], texts: new Map([[artifact.name, body]]) })}
    ${actionDialogChromeHtml()}</main></body></html>`;
}

describe.skipIf(skipped)('static text drawers', () => {
  test('an artifact expands to full height and folds back to its header', async () => {
    const probe = `<script>
      const drawer = document.querySelector('.lz-artifact-preview');
      drawer.querySelector('summary').click();
      const text = drawer.querySelector('pre');
      const fullHeight = text.clientHeight > innerHeight && text.scrollHeight === text.clientHeight;
      drawer.querySelector('summary').click();
      const collapsed = !drawer.open && !text.checkVisibility();
      drawer.querySelector('summary').click();
      document.documentElement.dataset.probe = JSON.stringify({ fullHeight, collapsed, reopened: text.checkVisibility(), client: text.clientHeight, scroll: text.scrollHeight });
    </script>`;
    const dom = await dumpDomOfHtml(pageHtml().replace('</body>', `${probe}</body>`));
    const result = JSON.parse(dom.match(/data-probe="([^"]+)"/)![1]!.replaceAll('&quot;', '"'));
    expect(result).toMatchObject({ fullHeight: true, collapsed: true, reopened: true });
  }, 60_000);

  test('progress and errors use one dialog scroll and independently collapse', async () => {
    const probe = `<script>
      const dialog = document.querySelector('#lz-action-dialog');
      dialog.showModal();
      const steps = document.querySelector('#lz-action-steps');
      steps.hidden = false;
      steps.innerHTML = Array.from({length:100}, (_, index) => '<li>Progress '+index+'</li>').join('');
      const error = document.querySelector('#lz-action-error');
      error.hidden = false;
      error.textContent = 'An error';
      const drawer = steps.closest('details');
      const fullHeight = steps.clientHeight > innerHeight && steps.scrollHeight === steps.clientHeight;
      drawer.querySelector('summary').click();
      const collapsed = !steps.checkVisibility() && error.checkVisibility();
      drawer.querySelector('summary').click();
      dialog.scrollTop = dialog.scrollHeight;
      const reachable = error.getBoundingClientRect().bottom <= dialog.getBoundingClientRect().bottom;
      document.documentElement.dataset.probe = JSON.stringify({ fullHeight, collapsed, reachable, client: steps.clientHeight, scroll: steps.scrollHeight, errorBottom: error.getBoundingClientRect().bottom, dialogBottom: dialog.getBoundingClientRect().bottom });
    </script>`;
    const dom = await dumpDomOfHtml(pageHtml().replace('</body>', `${probe}</body>`));
    const result = JSON.parse(dom.match(/data-probe="([^"]+)"/)![1]!.replaceAll('&quot;', '"'));
    expect(result).toMatchObject({ fullHeight: true, collapsed: true, reachable: true });
    if (process.env.LAZY_SCREENSHOTS === '1') {
      for (const width of [1280, 390]) {
        await screenshotDashboardPage({
          fetch: async () => new Response(pageHtml()), base: 'http://localhost', path: '/',
          out: `/tmp/daemon-action-drawers-${width}.png`, width, height: 1000,
          injectScript: "document.querySelector('#lz-action-dialog').showModal(); document.querySelector('#lz-action-dialog-title').textContent = 'Accept task'; const steps = document.querySelector('#lz-action-steps'); steps.hidden = false; steps.innerHTML = '<li>Checking task</li><li>Checking branch</li>'; const error = document.querySelector('#lz-action-error'); error.hidden = false; error.textContent = 'The branch needs syncing before it can be accepted.';",
        });
      }
    }
  }, 60_000);

  test.skipIf(process.env.LAZY_SCREENSHOTS !== '1')('captures static drawers at desktop and phone widths', async () => {
    for (const width of [1280, 390]) {
      await screenshotDashboardPage({
        fetch: async () => new Response(pageHtml()), base: 'http://localhost', path: '/',
        out: `/tmp/daemon-static-drawers-${width}.png`, width, height: 1000,
        injectScript: "document.querySelector('.lz-artifact-preview').open = true;",
      });
    }
  }, 60_000);
});
