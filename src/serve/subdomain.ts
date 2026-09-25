/**
 * Where a task's `[serve]` services live in the browser's eyes:
 * `http://<service>.<task>.lazy.localhost:<dashboard-port>`.
 *
 * The published loopback URL (`http://127.0.0.1:49154`) is still the truth about
 * the container — this module is about the NAME humans and browsers use to get
 * there. Two reasons it has to be a name:
 *
 *  - **Cookies ignore ports.** Every task app on `127.0.0.1` shares one cookie
 *    jar, so two Rails tasks clobber each other's session. This is exactly why
 *    the dashboard already moved to `lazy.localhost`
 *    (src/daemon/dashboard-url.ts) — the same trick, one level down.
 *  - **The URL stops moving.** A host port is OS-assigned at container creation,
 *    so it changes on every recreate; `web.my-task.lazy.localhost:26024` does
 *    not, and a browser tab or a bookmark survives a restart.
 *
 * `*.localhost` is loopback by RFC 6761 and Chromium and Firefox resolve it
 * internally, so nothing has to be installed for a browser to reach it. The OS
 * resolver often does NOT (glibc, measured, does not), and a wildcard cannot go
 * in /etc/hosts — which is why `lazy url --direct` exists and why the docs point
 * curl at it.
 *
 * The suffix is a PARAMETER everywhere in here, never a literal: it comes from
 * `dashboardHostFor()` today and will be something else under Teams.
 */

import type { ResolvedService } from './ports';

/** Longest a single DNS label may be (RFC 1035). */
export const MAX_HOST_LABEL_LENGTH = 63;

/**
 * A valid DNS label, lowercase: letters, digits and inner hyphens.
 *
 * A LEADING DIGIT is deliberately allowed — `3000.my-task.lazy.localhost` has
 * to work, since a bare `[serve] ports = [3000]` entry is named by its port.
 * RFC 1123 permits it and browsers accept it.
 */
const HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Whether `value` can stand as one label of a hostname, as-is. */
export function isHostLabel(value: string): boolean {
  return value.length > 0 && value.length <= MAX_HOST_LABEL_LENGTH && HOST_LABEL_RE.test(value);
}

/**
 * The label that addresses a task: its code when the code is a valid label,
 * its short id otherwise.
 *
 * New task codes are constrained to DNS labels (src/task/identity.ts), but codes
 * created before that rule may contain dots — and a dot in the code would split
 * into extra labels and address nothing. Such a task is reachable by short id
 * instead, which is always a valid label, and every URL surface prints that
 * form for it. Existing tasks are never renamed.
 */
export function taskHostLabel(task: { id: string; code?: string | null }): string {
  const code = task.code?.toLowerCase();
  if (code && isHostLabel(code)) return code;
  return task.id.substring(0, 8);
}

/**
 * The label that addresses a service: its name when that is a valid label, its
 * container port otherwise.
 *
 * `[serve.services]` names may contain `_` and uppercase (`NAME_PATTERN` in
 * ./ports.ts), neither of which belongs in a hostname. The port is always a
 * valid label and `findService` accepts it, so it is the fallback rather than
 * mangling the name into something the human never wrote.
 */
export function serviceHostLabel(service: { name: string; port: number }): string {
  const name = service.name.toLowerCase();
  return isHostLabel(name) ? name : String(service.port);
}

/** A Host header parsed as `<service>.<task>.<suffix>`. */
export interface ServeHostRef {
  /** Service label as written: a `[serve.services]` name or a container port. */
  service: string;
  /** Task label as written: a task code or a short id. */
  task: string;
}

/**
 * Split a Host header into the service and task it addresses, or null when the
 * request is not for a task service.
 *
 * Null covers everything the dashboard itself must keep serving: the bare
 * dashboard host, a raw `127.0.0.1`, a foreign Host header, and any prefix that
 * is not exactly two well-formed labels. Deliberately strict — this is the
 * predicate that decides whether a request leaves the daemon for a container,
 * so anything ambiguous stays with the daemon.
 */
export function parseServeHost(
  hostHeader: string | null | undefined,
  suffixHost: string,
): ServeHostRef | null {
  if (!hostHeader) return null;
  const host = stripPort(hostHeader).toLowerCase();
  const suffix = suffixHost.trim().toLowerCase();
  if (!suffix || host === suffix) return null;
  if (!host.endsWith(`.${suffix}`)) return null;

  const prefix = host.slice(0, host.length - suffix.length - 1);
  const labels = prefix.split('.');
  if (labels.length !== 2) return null;

  const [service, task] = labels as [string, string];
  if (!isHostLabel(service) || !isHostLabel(task)) return null;
  return { service, task };
}

/**
 * The host part of a Host header, without the port.
 *
 * IPv6 literals are bracketed in a Host header (`[::1]:26024`), so the bracket
 * form is handled before the naive "last colon" rule that would otherwise cut a
 * v6 address in half.
 */
function stripPort(hostHeader: string): string {
  const trimmed = hostHeader.trim();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end === -1 ? trimmed : trimmed.slice(0, end + 1);
  }
  const colon = trimmed.lastIndexOf(':');
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

/**
 * `http://<service>.<task>.<authority>` — the URL a human opens.
 *
 * `authority` is the dashboard's own `host[:port]`, so the service rides the
 * port the dashboard already answers on. No trailing slash: this is composed
 * into `lazy url` output and hrefs.
 */
export function serviceSubdomainUrl(service: string, task: string, authority: string): string {
  return `http://${service}.${task}.${authority}`;
}

/**
 * Where the dashboard answers, as `host[:port]`, for URL building — or null in a
 * process that does not know (a CLI with no daemon reachable, a unit test).
 *
 * Process-scoped and set once: in the daemon at bind time, in a CLI command from
 * the daemon's health report. It is deliberately not threaded through every
 * render path — "which authority does this machine's dashboard answer on" is a
 * property of the process, not of the request being rendered, and half the
 * surfaces that print a service URL (the review page, `lazy show`) have no
 * request to read it from.
 *
 * Null is a supported state, not a failure: every surface falls back to the
 * direct loopback URL, which is what it printed before subdomains existed.
 */
let dashboardAuthorityValue: string | null = null;

export function setDashboardAuthority(authority: string | null): void {
  dashboardAuthorityValue = authority && authority.trim() ? authority.trim() : null;
}

export function dashboardAuthority(): string | null {
  return dashboardAuthorityValue;
}

/**
 * Attach the subdomain URL to each resolved service.
 *
 * `publicUrl` is null exactly when `url` is — an unpublished port has no
 * container-side listener for the proxy to reach either, so promising a name
 * that can only 502 would be a worse answer than the "not published" the
 * surfaces already show.
 */
export function withPublicUrls<T extends ResolvedService>(
  task: { id: string; code?: string | null },
  services: T[],
  authority: string | null = dashboardAuthority(),
): T[] {
  if (!authority) return services;
  const taskLabel = taskHostLabel(task);
  return services.map((service) => ({
    ...service,
    publicUrl: service.url ? serviceSubdomainUrl(serviceHostLabel(service), taskLabel, authority) : null,
  }));
}

/** The URL a surface should show for a service: the name when there is one. */
export function displayUrlFor(service: ResolvedService): string | null {
  return service.publicUrl ?? service.url;
}
