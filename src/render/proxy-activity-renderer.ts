/**
 * Rendering proxy traffic as watchable lines.
 *
 * One line per event, pure and side-effect free so the shape is unit-testable
 * without a daemon, a proxy or a terminal.
 *
 * WHAT A LINE MAY CONTAIN: the passage of a request — who made it, where it
 * went, how it ended, and (where the wire format is Anthropic's) the model and
 * token totals the record already carries. NEVER a credential, a token value,
 * or request/response content. Cursor records are coarse BY CONSTRUCTION —
 * lazy does not parse cursor's connect-rpc protobuf, so model/usage are null on
 * those records and the line says so rather than inventing detail.
 *
 * FAILURES ARE LOUD. A revoked placeholder hammering the proxy, a policy denial
 * or a rerouted request is the reason a human is watching at all; those get
 * colour, a marker word that survives `grep` and a plain terminal, and — for a
 * credential refusal — the remedy spelled out on its own line.
 */

import { theme, dim } from './theme';
import { CREDENTIAL_REFUSED_PREFIX, type ProxyActivityEvent } from '../proxy/activity';

/** Prefix that marks a proxy line, next to watch's `sup>` supervisor lines. */
export const PROXY_LINE_PREFIX = 'net>';

/** Longest any single agent-controlled field may render as. */
const MAX_FIELD_LENGTH = 200;

/**
 * Make one agent-supplied string safe to print on a human's terminal.
 *
 * INVARIANT — every event field that originates in the agent's own request
 * (path, method, model, backend, role, task attribution, and the upstream error
 * text) goes through here before it reaches the screen. These lines are watched
 * by a HUMAN OPERATOR, and the values are chosen by the very process the
 * operator is supervising: a request path containing an ANSI escape can retitle
 * their terminal, erase lines above it, or forge a green ✓ for a request that
 * was denied. Stripping C0/C1 controls (which includes ESC, and therefore every
 * escape sequence) removes the whole class rather than blocklisting sequences.
 *
 * Length is bounded too — a 20 KB path is a scroll-wipe by other means.
 */
function safe(value: string): string {
  const stripped = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
  return stripped.length > MAX_FIELD_LENGTH
    ? `${stripped.slice(0, MAX_FIELD_LENGTH)}…`
    : stripped;
}

function clockTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function formatTokens(total: number | null): string {
  if (total === null) return '';
  return `${total.toLocaleString('en-US')} tok`;
}

/**
 * Who made the request. `-` rather than a blank, so an unattributed request is
 * visibly unattributed instead of looking like a formatting glitch — traffic
 * the proxy could not tie to a grant is itself worth noticing.
 */
function who(event: ProxyActivityEvent, includeTask: boolean): string {
  const role = safe(event.role ?? '-');
  if (!includeTask) return role;
  // The FULL attribution, not a truncation: what the proxy stamps is the task
  // ref (a code, or an 8-char short id), and cutting a code at eight characters
  // renders `add-agent-to-unblock` and `add-agent-to-unblock-clone-1` as the
  // same `add-agen` — ambiguous in exactly the firehose where telling tasks
  // apart is the entire job of this column.
  return `${role}/${event.taskId ? safe(event.taskId) : '-'}`;
}

/** `POST /v1/messages` — plus a `[cursor]` tag when the backend is coarse. */
function request(event: ProxyActivityEvent): string {
  const tag = event.backend === 'cursor' ? dim(' [cursor]') : '';
  return `${safe(event.method)} ${safe(event.path)}${tag}`;
}

export interface ProxyLineOptions {
  /**
   * Include the task id in the identity column. False when every line on the
   * screen already belongs to one watched task — repeating it eight times a
   * minute is noise.
   */
  includeTask?: boolean;
}

/**
 * Render one event as a display line, or null when there is nothing to show.
 *
 * A `close` for a request whose `open` was already printed still prints: the
 * outcome (status, duration, tokens) is the half that says whether the agent
 * got an answer, and pairing them by eye is what makes a stall visible.
 */
export function renderProxyActivity(
  event: ProxyActivityEvent,
  options: ProxyLineOptions = {},
): string {
  const includeTask = options.includeTask ?? false;
  const head = `${dim(PROXY_LINE_PREFIX)} ${dim(clockTime(event.ts))} `;

  if (event.kind === 'open') {
    const model = event.model ? dim(` ${safe(event.model)}`) : '';
    return `${head}${dim('▸')} ${theme.label(who(event, includeTask))} ${request(event)}${model}`;
  }

  const parts: string[] = [];
  const duration = formatDuration(event.durationMs);
  if (duration) parts.push(dim(duration));
  if (event.model) parts.push(dim(safe(event.model)));
  const tokens = formatTokens(event.totalTokens);
  if (tokens) parts.push(dim(tokens));

  const markers: string[] = [];
  if (event.denials > 0) markers.push(theme.error(`DENY(${event.denials})`));
  if (event.rerouted) markers.push(theme.warning('REROUTE'));

  if (event.failed) {
    markers.unshift(theme.error(`FAIL(${event.status ?? 'no-response'})`));
    if (event.error) markers.push(theme.error(safe(event.error)));
  }

  const glyph = event.failed ? theme.error('✗') : theme.success('✓');
  const status = event.failed
    ? ''
    : dim(String(event.status ?? '-')) + ' ';

  const tail = [...parts, ...markers].filter(Boolean).join('  ');
  return `${head}${glyph} ${theme.label(who(event, includeTask))} ${status}${request(event)}  ${tail}`.trimEnd();
}

/**
 * The remedy line for a credential refusal, or null.
 *
 * A 401 from the proxy is NOT an upstream auth problem the user should go
 * debug at Anthropic — it means the placeholder a container is presenting has
 * no live grant behind it (the task was accepted/rejected/closed, or the daemon
 * restarted and the launch outlived it). A watcher seeing a burst of these
 * deserves to be told that, once, rather than left to guess.
 */
export function credentialRefusalHint(event: ProxyActivityEvent): string | null {
  if (event.kind !== 'close') return null;
  if (event.status !== 401) return null;
  if (!event.error?.startsWith(CREDENTIAL_REFUSED_PREFIX)) return null;
  return theme.warning(
    '     ↳ the container is presenting a placeholder with no live grant — ' +
      'the launch outlived its task or the daemon restarted. Run `lazy doctor`.',
  );
}
