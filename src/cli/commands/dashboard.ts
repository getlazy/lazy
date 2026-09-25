/**
 * `lazy dashboard` — sign in to this project's web dashboard.
 *
 * The dashboard requires a browser session (see src/daemon/dashboard-auth.ts).
 * This command is how one is obtained: it asks the daemon over `/rpc` for a
 * one-time login ticket and opens the browser at a URL carrying it. The browser
 * exchanges the ticket for an `HttpOnly; SameSite=Strict` cookie and is
 * redirected to the clean URL; the ticket is spent.
 *
 * `/rpc` is deliberately the only way to get one. A task container can reach
 * the daemon's port (it is how MCP works) and holds an MCP token — and `/rpc`
 * refuses MCP tokens. So an agent cannot mint itself a way into the dashboard.
 *
 * Printing instead of opening is the fallback, not the default: a login ticket
 * is single-use, so "opened a browser that was never there" spends it on
 * nothing. `decideBrowserOpen` refuses in every environment where that is a
 * real risk, and an opener that fails falls back to printing too.
 */

import { parseFlags, requireLazyRoot, refuseIfBoundClone } from '../helpers';
import { isTTY } from '../editor';
import { decideBrowserOpen, openInBrowser } from '../open-url';
import {
  DASHBOARD_HOSTNAME,
  checkDaemonHealth,
  cleanupStaleFiles,
  ensureDaemon,
  isDaemonRunning,
} from '../../daemon';
import { DaemonClient, RpcApplicationError } from '../../daemon/client';
import { dashboardUrlFromStatus } from '../../daemon/dashboard-availability';
import { checkDashboardAddress, dashboardAddressNote } from '../../daemon/dashboard-address';
import { lookup } from 'node:dns/promises';

export async function commandDashboard(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    // --print and --no-open mean the same thing to the code; both exist because
    // both are the obvious spelling depending on what the caller is thinking
    // ("give me the URL" vs "don't open anything").
    { name: 'print', aliases: ['p'], takesValue: false },
    { name: 'no-open', takesValue: false },
    { name: 'project', takesValue: true },
  ], 'dashboard');

  const projectFlag = parsed.flags.get('project');
  const projectRoot = typeof projectFlag === 'string' ? projectFlag : requireLazyRoot();
  const printOnly = parsed.flags.get('print') === true || parsed.flags.get('no-open') === true;

  // There is no local daemon to serve it — Teams is the web surface for a
  // bound clone (design doc §4.7's table).
  await refuseIfBoundClone('dashboard', projectRoot);

  // Auto-start like every other human-facing command. The dispatcher already
  // ran ensureDaemon for the root it detected from cwd — this call matters when
  // that root is not this one (`--project`), or when the dispatcher's attempt
  // failed and it continued degraded. ensureDaemon is a no-op when a daemon is
  // already up, and bails under LAZY_TEST.
  if (!isDaemonRunning(projectRoot)) {
    try {
      await ensureDaemon('dashboard', projectRoot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: could not start the daemon for ${projectRoot}: ${message}`);
      console.error('Diagnose it with: lazy doctor');
      process.exit(1);
    }
  }

  if (!isDaemonRunning(projectRoot)) {
    cleanupStaleFiles(projectRoot);
    console.error('Error: daemon is not running. Start it with `lazy daemon start`.');
    process.exit(1);
  }

  const status = await checkDaemonHealth(projectRoot);
  if (!status.running) {
    console.error(
      status.unresponsive
        ? 'Error: daemon is alive but unresponsive (event loop stuck). Clear it with `lazy daemon restart`.'
        : 'Error: daemon process is alive but not responding. Try: lazy daemon restart',
    );
    process.exit(1);
  }
  if (!status.webPort) {
    console.error('Error: daemon is running but the web dashboard port is not available.');
    process.exit(1);
  }

  const client = await DaemonClient.create(projectRoot);
  if (!client) {
    console.error('Error: daemon is not reachable. Try: lazy daemon restart');
    process.exit(1);
  }

  let ticket: string;
  let param: string;
  try {
    const result = await client.rpc('mintDashboardTicket', projectRoot, {}) as {
      ticket: string;
      param: string;
    };
    ticket = result.ticket;
    param = result.param;
  } catch (err) {
    // A managed daemon refuses with its own message ("this daemon is managed;
    // use Lazy Teams") — pass it through rather than reframing it as a failure
    // to open a browser.
    const message = err instanceof RpcApplicationError || err instanceof Error
      ? err.message
      : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }

  const base = dashboardUrlFromStatus(status);
  if (!base) {
    console.error('Error: daemon is running but the web dashboard is not available.');
    process.exit(1);
  }
  const loginUrl = `${base}/?${param}=${ticket}`;
  const resolutionNote = await dashboardHostNote(new URL(base).hostname);

  // The link printed below is the one the daemon SERVES, because that is the
  // one that works. When lazy.toml asks for another address it must not go by
  // silently — one line, on stderr so `--print` still composes.
  const addressProblem = await checkDashboardAddress(projectRoot, status);
  if (addressProblem) console.error(dashboardAddressNote(addressProblem));

  const decision = decideBrowserOpen({
    platform: process.platform,
    isTty: isTTY(),
    env: process.env,
    printOnly,
  });

  if (decision.open) {
    if (await openInBrowser(loginUrl)) {
      console.log(`Opened the lazy dashboard: ${base}`);
      if (resolutionNote) console.log(resolutionNote);
      return;
    }
    console.log('Could not open a browser. Open this link to sign in (it works once):');
    console.log(loginUrl);
    if (resolutionNote) console.log(resolutionNote);
    return;
  }

  if (printOnly) {
    // Machine-facing: the URL alone on stdout, so `--print` composes. The
    // resolution note, when there is one, goes to stderr for the same reason.
    console.log(loginUrl);
    if (resolutionNote) console.error(resolutionNote);
    return;
  }

  console.log(`Open this link to sign in (${decision.reason}). It works once:`);
  console.log(loginUrl);
  if (resolutionNote) console.log(resolutionNote);
}

/**
 * The advisory note about `lazy.localhost`, or null when none is needed.
 *
 * The dashboard has its own hostname so the browser scopes its session cookie
 * away from the task app ports published on 127.0.0.1 (see
 * src/daemon/dashboard-url.ts). `*.localhost` is loopback by RFC 6761 and
 * Chromium and Firefox resolve it internally — but the OS resolver often does
 * NOT (glibc, measured, does not), and Safari's behaviour is not something this
 * code can assert. So: probe, and when the machine's own resolver cannot see
 * the name, say honestly that the browser may still be fine and give the
 * one-line fix if it is not. Never fatal — the probe answers a question about
 * the operator's machine, not about the daemon.
 */
async function dashboardHostNote(host: string): Promise<string | null> {
  if (host !== DASHBOARD_HOSTNAME) return null;
  try {
    await lookup(host);
    return null;
  } catch (err) {
    // Any lookup failure (ENOTFOUND, EAI_AGAIN, a resolver that times out) puts
    // us in the same place: this machine's resolver cannot confirm the name, so
    // print the advisory. The specific code adds nothing the operator can act
    // on differently.
    void err;
    return (
      `Note: this machine's resolver does not know ${host}. Chrome and Firefox resolve\n`
      + `*.localhost to loopback themselves, so the link usually works anyway. If your browser\n`
      + `cannot reach it, add this line to /etc/hosts:  127.0.0.1 ${host}`
    );
  }
}

export function dashboardUsage(): void {
  console.log(`Usage: lazy dashboard [options]

Sign in to this project's web dashboard and open it in your browser.

The dashboard needs a signed-in browser session — it lives on the same port as
the daemon's RPC and MCP endpoints, which task containers can reach. This
command asks the daemon for a one-time login link and opens it; the browser
trades the link for a session cookie that lasts 30 days of use.

By default the dashboard is addressed as http://lazy.localhost:<port>, not
127.0.0.1. Task apps started by [serve] are published on 127.0.0.1, and browser
cookies are scoped by hostname and not by port — sharing one would hand a
task's app your dashboard session. A trusted reverse proxy can instead supply
one exact public origin with [server] dashboard_url; other hosts are refused.

Options:
  -p, --print     Print the login URL instead of opening a browser
  --no-open       Same as --print
  --project PATH  Explicit project root (default: auto-detect from cwd)

lazy prints the link instead of opening it whenever a browser cannot be opened:
no terminal, an SSH session, no graphical session, or the opener failing.

The link works ONCE. Run this command again for a new one.

Examples:
  lazy dashboard              # Sign in and open the dashboard
  lazy dashboard --print      # Print the one-time login link
  lazy daemon dashboard-url   # Print the dashboard's plain URL (no sign-in)`);
}
