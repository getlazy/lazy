/** The dashboard page for one task service while its declared port starts. */

import { layoutHtml } from './templates';
import { escapeHtml } from './escape';
import { taskSessionsPanelHtml, taskSessionsClientScript } from './task-sessions-panel';
import { shellClientScript } from './shell-ui';

export function safeServiceReturnPath(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(value)) return '/';
  return value;
}

export function taskServiceWaitPageHtml(input: {
  taskSeg: string;
  service: string;
  port: number;
  command: string;
}): string {
  const name = escapeHtml(input.service);
  const back = `/tasks/${input.taskSeg}/services`;
  const body = `<main class="lz-run-page" id="lz-task-service-wait">` +
    `<h1>Services are starting</h1>` +
    `<p>Waiting for <code>${name}</code> on port ${input.port} to answer. This page opens it as soon as it does.</p>` +
    `<p>Start command: <code>${escapeHtml(input.command)}</code></p>` +
    `<p><a href="${escapeHtml(back)}">Back to Services</a></p>` +
    `<h2>Start command live progress</h2>` + taskSessionsPanelHtml(input.taskSeg) +
    `<script>(function () {
      var url = location.href;
      async function check() {
        try {
          var response = await fetch(url, { redirect: 'manual', cache: 'no-store', headers: { Accept: 'text/html' } });
          if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
            location.reload(); return;
          }
        } catch (_) { /* Keep the visible session output and ask again. */ }
        setTimeout(check, 2000);
      }
      setTimeout(check, 2000);
    })();</script>` + taskSessionsClientScript() + shellClientScript() + `</main>`;
  return layoutHtml('Services are starting', body);
}
