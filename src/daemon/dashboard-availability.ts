/**
 * Whether the web dashboard is reachable, and which URL to show.
 *
 * SOURCE OF TRUTH IS THE DAEMON, NOT THE CALLER'S ENV. Managed mode
 * (`LAZY_MANAGED`) is armed on the daemon process by the fleet supervisor.
 * The builder CLI and an MCP subprocess typically do not have that env, so
 * they must not call {@link isManagedMode} themselves and then invent a URL
 * from bindHost+port. GET `/daemon/status` carries `dashboardUrl`: a string
 * when the dashboard is on, `null` when it is off (managed). Older daemons
 * omit the field; those fall back to formatting bindHost+webPort.
 *
 * In-process (MCP handlers running inside the daemon, review-session builder
 * turns) we ARE the daemon, so {@link isManagedMode} and {@link getDaemonContext}
 * are the right reads — no HTTP round-trip to ourselves.
 */
import { isManagedMode } from '../config/managed';
import { hasDaemonContext, getDaemonContext } from './context';
import { checkDaemonHealth, type DaemonStatus } from './lifecycle';
import { formatDashboardUrl } from './dashboard-url';

import dashboardOnPrompt from '../prompts/builder-dashboard.md' with { type: 'text' };
import dashboardOffPrompt from '../prompts/builder-dashboard-unavailable.md' with { type: 'text' };

/** Dashboard is on (clickable URL) or off/unreachable (do not invent a URL). */
export type DashboardAvailability =
  | { available: true; url: string }
  | { available: false; reason: 'off' | 'unreachable' };

/**
 * Pick the user-facing dashboard URL out of a `/daemon/status` payload.
 *
 * `null` from a new daemon means the dashboard is off (managed mode) — do
 * NOT fall back to formatting bindHost+port, which would invent a 404 link.
 * A missing field means an older daemon; format from bindHost+webPort then.
 */
export function dashboardUrlFromStatus(
  status: Pick<DaemonStatus, 'running' | 'webPort' | 'bindHost' | 'dashboardUrl'>,
): string | null {
  if (!status.running) return null;
  if (status.dashboardUrl !== undefined) return status.dashboardUrl;
  if (!status.webPort) return null;
  return formatDashboardUrl(status.bindHost, status.webPort);
}

/** Same payload, classified for the builder prompt (on vs off vs unreachable). */
export function dashboardAvailabilityFromStatus(
  status: Pick<DaemonStatus, 'running' | 'webPort' | 'bindHost' | 'dashboardUrl'>,
): DashboardAvailability {
  const url = dashboardUrlFromStatus(status);
  if (url) return { available: true, url };
  // A running daemon that sent `dashboardUrl: null` is managed — off, not down.
  if (status.running && status.dashboardUrl === null) {
    return { available: false, reason: 'off' };
  }
  return { available: false, reason: 'unreachable' };
}

/**
 * Resolve dashboard availability for this process.
 *
 * Never throws: a missed lookup becomes `{ available: false, reason: 'unreachable' }`
 * so a builder launch or `lazy_status` still proceeds, with no fabricated URL.
 */
export async function resolveDashboardAvailability(
  projectRoot?: string,
): Promise<DashboardAvailability> {
  // In-process: we are the daemon. Managed mode is our own env.
  if (hasDaemonContext()) {
    if (isManagedMode()) return { available: false, reason: 'off' };
    const ctx = getDaemonContext();
    return {
      available: true,
      url: ctx.dashboardUrl ?? formatDashboardUrl(ctx.bindHost, ctx.webPort),
    };
  }

  if (!projectRoot) {
    return { available: false, reason: 'unreachable' };
  }

  try {
    const status = await checkDaemonHealth(projectRoot);
    return dashboardAvailabilityFromStatus(status);
  } catch {
    return { available: false, reason: 'unreachable' };
  }
}

/**
 * The "Dashboard" block injected into the builder system prompt.
 *
 * Always returns a section — either the URL + path patterns, or the sentence
 * that the dashboard is unavailable. The builder must never be left to guess.
 */
export function renderDashboardPromptSection(availability: DashboardAvailability): string {
  if (availability.available) {
    return dashboardOnPrompt.replace(/\{\{DASHBOARD_URL\}\}/g, availability.url).trimEnd();
  }
  const reason = availability.reason === 'off'
    ? 'this daemon is managed — use Lazy Teams; the local dashboard is disabled'
    : 'the daemon dashboard could not be reached at launch';
  return dashboardOffPrompt.replace(/\{\{UNAVAILABLE_REASON\}\}/g, reason).trimEnd();
}
