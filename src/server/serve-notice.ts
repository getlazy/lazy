/**
 * What a human sees when they open a task service's URL and nothing answers.
 *
 * `http://web.my-task.lazy.localhost:26024` is a stable name, so people
 * bookmark it, leave it open in a tab and hit reload after lunch — by which
 * time the container may be down, the port unpublished, or the dev server
 * simply not started. "Connection refused" is the answer the raw loopback port
 * gave, and it tells the human nothing about which of those it was or what to
 * press.
 *
 * So a browser NAVIGATION to a dead service is redirected to the task page
 * carrying two query params, and the page renders this banner above everything
 * else: what was opened, why it did not answer, the buttons that fix it, and a
 * link to try again. Nothing here is new machinery — the buttons are the same
 * Start container / Start services controls the Services card already renders.
 *
 * INVARIANT: rendering this banner starts NOTHING. It is reached by a GET, and
 * a GET that starts a container would be a CSRF vector — any page anywhere
 * could embed `<img src="http://web.my-task.lazy.localhost:26024">` and spend
 * the human's machine. Every start on this page is a POST behind a button.
 */

import type { ProbedServeState } from './services-card';
import { startContainerHtml, type ContainerControls } from './container-start';
import { taskPath } from './task-urls';
import { isHostLabel, serviceHostLabel } from '../serve/subdomain';
import { escapeHtml } from './escape';

/** Query param naming the service label that was opened. */
export const SERVE_NOTICE_SERVICE_PARAM = 'serve';
/** Query param naming why it did not answer. */
export const SERVE_NOTICE_REASON_PARAM = 'serve_reason';

/**
 * Why a service did not answer. A closed set, and the URL carries only these
 * spellings — the banner text is composed here from the task's own state, never
 * from anything the caller of the URL supplied.
 */
export type ServeNoticeReason =
  /** The task's container is not running. */
  | 'not-running'
  /** This runner has no container, so there is nothing to proxy to. */
  | 'no-container-runner'
  /** No `[serve]` service by that name or port. */
  | 'unknown-service'
  /** Declared, but this container does not publish it (created before the edit). */
  | 'not-published'
  /** Published, but a TCP connect to it was refused — the app is not up. */
  | 'not-listening';

const REASONS: ReadonlySet<string> = new Set<ServeNoticeReason>([
  'not-running',
  'no-container-runner',
  'unknown-service',
  'not-published',
  'not-listening',
]);

export interface ServeNotice {
  /** Service label as it appeared in the hostname. */
  service: string;
  reason: ServeNoticeReason;
}

/**
 * Read the notice out of a task-page URL, or null when there is none.
 *
 * Both params are validated, not trusted: the service must be a host label
 * (which is all the proxy could have matched anyway) and the reason must be one
 * of ours. A hand-typed or hostile query string therefore cannot put arbitrary
 * text on the task page, and cannot make the banner appear with a made-up
 * cause.
 */
export function parseServeNotice(url: URL): ServeNotice | null {
  const service = url.searchParams.get(SERVE_NOTICE_SERVICE_PARAM);
  const reason = url.searchParams.get(SERVE_NOTICE_REASON_PARAM);
  if (!service || !reason) return null;
  if (!isHostLabel(service) || !REASONS.has(reason)) return null;
  return { service, reason: reason as ServeNoticeReason };
}

/**
 * Where the proxy sends a browser whose navigation found nothing listening.
 *
 * Path-only (`/tasks/...`), so it is same-origin-relative from the proxy's own
 * response and cannot be pointed anywhere else. `taskRef` is the task's URL
 * segment — code when unique, id otherwise, already escaped — resolved by the
 * proxy from the daemon's store, and `service` is the label the proxy matched
 * against the host. No part of this is echoed from the request.
 */
export function serveNoticePath(taskRef: string, service: string, reason: ServeNoticeReason): string {
  const params = new URLSearchParams({
    [SERVE_NOTICE_SERVICE_PARAM]: service,
    [SERVE_NOTICE_REASON_PARAM]: reason,
  });
  return `/tasks/${taskRef}?${params.toString()}`;
}

/**
 * The sentence explaining the reason, as PLAIN TEXT — the caller escapes it.
 *
 * The port named here comes from the task's OWN resolved state, looked up by
 * the service label, never from the URL: the number in the banner is the number
 * the container publishes.
 */
function reasonText(notice: ServeNotice, serve: ProbedServeState | null): string {
  const match = serve?.services.find((s) => serviceHostLabel(s) === notice.service);
  const port = match ? ` on port ${match.port}` : '';

  switch (notice.reason) {
    case 'not-running':
      return 'the container is not running, so none of its ports are published.';
    case 'no-container-runner':
      return 'this task runs without a container, so lazy has no port mapping to route through — ' +
        'anything it starts is already on this machine’s own loopback address.';
    case 'unknown-service':
      return 'this task declares no service by that name or port.';
    case 'not-published':
      return 'the container does not publish that port — it was created before the [serve] entry, ' +
        'so it needs a restart to pick it up.';
    case 'not-listening':
      return `nothing is listening${port} inside the container — the port is published, but the ` +
        `server has not been started.`;
  }
}

/**
 * The banner. `serve` is the task's own probed state (for the port number and
 * to keep the wording honest); `controls` carries the same buttons the Services
 * card offers, and is absent on a page with no daemon action port.
 *
 * `retryUrl` is composed by the caller from the task's own labels and the
 * dashboard's own authority — deliberately not carried in the query string,
 * where it would be an attacker-supplied link on a page the human trusts.
 */
export function serveNoticeHtml(
  task: { id: string; code?: string | null },
  notice: ServeNotice,
  serve: ProbedServeState | null,
  controls?: ContainerControls & { taskId: string; startServicesCmd: string; shellAvailable: boolean },
  retryUrl?: string | null,
): string {
  const taskRef = task.code ?? task.id.substring(0, 8);
  const startServicesBtn = startServicesButtonHtml(controls);
  const buttons =
    (controls ? startContainerHtml(controls.taskId, controls) : '') +
    startServicesBtn.buttonHtml;
  const retry = retryUrl
    ? `<a class="lz-serve-retry" href="${escapeHtml(retryUrl)}">Try again</a>`
    : '';

  // This banner lives on the LANDING tab, which polls and morphs its body —
  // unlike the Services card's own tab (policy 'never'). The actions row and
  // the mount slot are siblings under one data-lz-shell-step wrapper, not the
  // mount nested inside the row: the row is a horizontal flex container, and
  // a terminal placed inside it was squeezed to button width. The mount
  // itself also carries data-lz-live-children so a background morph leaves a
  // live terminal alone instead of deleting it (dom-morph.ts).
  const step = buttons || retry
    ? `<div class="lz-serve-notice-body" data-lz-shell-step>` +
      `<div class="lz-serve-notice-actions">${buttons}${retry}</div>` +
      (startServicesBtn.mountHtml || '') +
      `</div>`
    : '';

  // role="status" lives on the HEAD sentence only, not the whole banner: the
  // Start services terminal mounts inside this div, and a live region around
  // it would have a screen reader announce every line of build output as it
  // streams in, rather than just the one sentence that actually changed.
  return `<div class="lz-serve-notice">` +
    `<p class="lz-serve-notice-head" role="status">You opened <code>${escapeHtml(notice.service)}</code> on ` +
    `<code>${escapeHtml(taskRef)}</code>, but ${escapeHtml(reasonText(notice, serve))}</p>` +
    step +
    `<p class="lz-serve-notice-more"><a href="${taskPath(task)}/services">` +
    `Services — declared ports and branch-port advice</a></p>` +
    `</div>`;
}

/**
 * The Start services button, in the same shape the Services card uses: run the
 * project's Start services command in this page's shell panel, mounted
 * in place (same `data-lz-shell-mount` slot `services-card.ts`'s
 * `startServicesHtml` uses) — no tab switch. Rendered only when there is a
 * command AND a live shell to run it in — a button that cannot do anything is
 * worse than no button on a page whose whole message is "here is how to fix
 * this".
 *
 * Returns the button (for the actions row) and the mount slot separately —
 * see `serveNoticeHtml`'s comment on why they cannot share the flex row.
 */
function startServicesButtonHtml(
  controls?: { taskId: string; startServicesCmd: string; shellAvailable: boolean },
): { buttonHtml: string; mountHtml: string } {
  if (!controls?.startServicesCmd || !controls.shellAvailable) return { buttonHtml: '', mountHtml: '' };
  const cmd = controls.startServicesCmd;
  return {
    buttonHtml:
      `<button type="button" class="btn btn-sm rv-cmd-run" data-lz-shell-run="${escapeHtml(cmd)}"` +
      ` data-lz-shell-for="${escapeHtml(controls.taskId)}" data-lz-shell-label="Services">Start services</button>` +
      `<button type="button" class="rv-cmd-open" hidden>Open</button>` +
      `<button type="button" class="rv-cmd-rerun" hidden>Re-run</button>`,
    mountHtml: `<div class="lz-shell-mount" data-lz-shell-mount data-lz-live-children hidden></div>`,
  };
}
