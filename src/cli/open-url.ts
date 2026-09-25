/**
 * Opening a URL in the operator's browser, and knowing when not to try.
 *
 * The decision is split from the doing on purpose: `decideBrowserOpen` is pure,
 * so every rule about when lazy prints a URL instead of opening it is testable
 * without a browser, a display, or a subprocess.
 *
 * Getting this wrong is not cosmetic. A command that "opens the browser" over
 * an SSH session either does nothing visible or opens a window on a machine
 * nobody is sitting at — and for `lazy dashboard` the URL carries a one-time
 * login ticket, so a silent failure spends the ticket on nothing and leaves the
 * operator with no way in.
 */

import { spawn } from '../utils/spawn';

/** Everything the decision depends on, passed in so tests can vary it. */
export interface BrowserOpenContext {
  platform: NodeJS.Platform;
  /** Is stdout attached to an interactive terminal? */
  isTty: boolean;
  env: Record<string, string | undefined>;
  /** The user asked for the URL, not a browser (`--print` / `--no-open`). */
  printOnly?: boolean;
}

export type BrowserOpenDecision =
  | { open: true }
  | { open: false; reason: string };

/**
 * Should lazy try to open a browser here, or just print the URL?
 *
 * Conservative by design: every "no" prints a URL the operator can use, while a
 * wrong "yes" spends a single-use login ticket on a browser that never appeared.
 */
export function decideBrowserOpen(ctx: BrowserOpenContext): BrowserOpenDecision {
  if (ctx.printOnly) return { open: false, reason: 'asked for the URL only' };

  // No terminal means no human watching this invocation — a script, a hook, a
  // CI step. Opening a browser from one is a surprise, not a convenience.
  if (!ctx.isTty) return { open: false, reason: 'not an interactive terminal' };

  // A remote shell: the browser would open on the far end, where nobody is.
  if (ctx.env.SSH_CONNECTION || ctx.env.SSH_TTY || ctx.env.SSH_CLIENT) {
    return { open: false, reason: 'this is an SSH session' };
  }

  // macOS and Windows have exactly one desktop session and `open` / `start`
  // find it; there is no display variable to consult.
  if (ctx.platform === 'darwin' || ctx.platform === 'win32') return { open: true };

  // WSL reaches the Windows desktop through interop, with no X display of its own.
  if (ctx.env.WSL_DISTRO_NAME || ctx.env.WSL_INTEROP) return { open: true };

  // Everything else (Linux, BSD) needs a graphical session to open into.
  if (ctx.env.DISPLAY || ctx.env.WAYLAND_DISPLAY) return { open: true };
  return { open: false, reason: 'no graphical session (DISPLAY is unset)' };
}

/** The platform's "open this in the default application" command. */
export function browserOpenCommand(platform: NodeJS.Platform, url: string): string[] {
  if (platform === 'darwin') return ['open', url];
  // The empty string is `start`'s window-title argument. Without it, a URL in
  // quotes is taken AS the title and nothing opens.
  if (platform === 'win32') return ['cmd', '/c', 'start', '', url];
  return ['xdg-open', url];
}

/**
 * Try to open `url` in the default browser. Returns false when the opener could
 * not be run or exited non-zero — the caller prints the URL instead.
 *
 * Never throws: a missing `xdg-open` is a normal outcome on a minimal Linux
 * install, and the fallback (print the URL) is perfectly good.
 */
export async function openInBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  try {
    const proc = spawn(browserOpenCommand(platform, url), {
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore',
      // The opener hands off to the desktop and returns; it should never sit
      // here. The wrapper's 60s default would stall the command that long if it
      // did.
      timeout: 10_000,
    });
    return (await proc.exited) === 0;
  } catch {
    // spawn() already turns ENOENT into a readable message, but the caller does
    // not need it: "could not open a browser, here is the URL" is the whole
    // remedy, and the missing binary is not something to fix mid-command.
    return false;
  }
}
