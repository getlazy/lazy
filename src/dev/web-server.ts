/**
 * The web dashboard, served from source, as a client of the running daemon.
 *
 * WHY THIS IS NOT A LAZY COMMAND
 * This file is deliberately NOT registered in the CLI dispatcher, not listed in
 * src/cli/commands/index.ts, and not completable. It is a development entry
 * point run through `bun run dev:server`, so the shipped `lazy` surface is
 * unchanged — no new command, no hidden flag. Someone reading `lazy --help` on
 * a release build sees exactly what they saw before this landed.
 *
 * WHAT IT IS
 * A client, in the same sense the CLI is a client. It opens no store, takes no
 * .storage-lock and has no read-only mode: reads go through `RemoteStorage`
 * over the daemon's `storage` RPC, and every mutation goes through the review
 * RPC commands, landing in the daemon's own review-service.ts. Reviewing,
 * commenting, asking, unblocking and accepting therefore behave here exactly as
 * they do on the daemon's dashboard, against the real store.
 *
 * That is also why there is no local fallback when the daemon is down: it
 * refuses to start and names the fix. The same client shape has to work against
 * a REMOTE daemon, where there is no store on this filesystem to fall back to.
 *
 * WHAT IT BUYS
 * The daemon keeps serving and is restarted only when daemon code changes:
 *   - Edit a template or route → `bun --watch` restarts THIS process only.
 *   - Edit a stylesheet → not even that. The CSS is served from
 *     src/server/styles/*.css by a route that re-reads the files per request
 *     (`stylesheetFromDisk`), with `Cache-Control: no-store`, so a plain page
 *     reload shows the change.
 *
 * `--watch`, NOT `--hot`. Measured: under `--hot` the process stays up but goes
 * on serving the pre-edit HTML, because the module graph is patched while the
 * already-captured handler closure is not. Caveat that costs ten confusing
 * minutes if you hit it: editors and tools that save by writing a temp file and
 * renaming it over the original (`sed -i`, some editors' atomic save) leave
 * Bun's watcher holding the OLD inode, so nothing reloads. Save in place, or
 * restart the script.
 */

import { DaemonClient } from '../daemon/client';
import { RemoteStorage } from '../storage/remote-storage';
import { createRpcReviewActions } from '../cli/review-actions-rpc';
import { createWebRequestHandler, tryBindTcpPort } from '../server';
import { findLazyRoot } from '../cli/init';
import { DEFAULT_SERVER_BIND } from '../config/constants';

/** Default dev port. Deliberately not the daemon's 26024 — both run at once. */
export const DEV_WEB_PORT = 26124;

export interface DevWebServerOptions {
  /** Project root. Defaults to the lazy root found from cwd. */
  projectRoot?: string;
  port?: number;
  host?: string;
}

export class DevWebServerError extends Error {}

/**
 * Start the dev web server. Throws DevWebServerError with an actionable message
 * when the daemon is not reachable or the port is taken — never falls back to
 * serving from a directly-opened store.
 */
export async function startDevWebServer(options: DevWebServerOptions = {}) {
  const projectRoot = options.projectRoot ?? findLazyRoot(process.cwd());
  if (!projectRoot) {
    throw new DevWebServerError(
      'Not inside a lazy project (no .lazy directory found). Run this from a project, or pass --project <path>.',
    );
  }

  // NOT tryRemoteStorage(): that helper returns null under LAZY_TEST=1 and
  // LAZY_IS_DAEMON=1 so CLI processes can fall back to a direct store. This
  // server has no fallback by design — it is always a daemon client — so it
  // builds the client itself and fails loudly when there is none.
  const client = DaemonClient.create(projectRoot);
  if (!client) {
    throw new DevWebServerError(
      `No daemon is running for ${projectRoot}. The dev web server is a client of the daemon — ` +
        'it reads and writes over RPC and never opens the store itself.\n' +
        'Start one with: lazy daemon start',
    );
  }

  let storagePath: string;
  try {
    storagePath = (await client.rpc('storage', projectRoot, {
      method: 'getStoragePath',
      args: {},
    })) as string;
  } catch (err) {
    throw new DevWebServerError(
      `Could not reach the daemon for ${projectRoot}: ${err instanceof Error ? err.message : String(err)}\n` +
        'Check it with: lazy daemon status',
    );
  }

  const storage = new RemoteStorage(client, projectRoot, storagePath);
  const actions = createRpcReviewActions(client, projectRoot);
  const handler = createWebRequestHandler(storage, actions, { stylesheetFromDisk: true });

  const port = options.port ?? DEV_WEB_PORT;
  const host = options.host ?? DEFAULT_SERVER_BIND;
  // maxAttempts 1: silently drifting to another port is exactly the kind of
  // ambient state this server exists to avoid — say the port is busy instead.
  const bound = tryBindTcpPort(port, handler, 1, host);
  if (!bound) {
    throw new DevWebServerError(
      `Port ${port} is already in use on ${host}. Free it, or pass --port <n>.`,
    );
  }

  return { server: bound.server, url: `http://${host}:${port}`, projectRoot };
}

function parseArgs(argv: string[]): DevWebServerOptions {
  const options: DevWebServerOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') options.port = Number(argv[++i]);
    else if (arg === '--project') options.projectRoot = argv[++i];
    else if (arg === '--host') options.host = argv[++i];
    else throw new DevWebServerError(`Unknown argument: ${arg}. Usage: --port <n> --project <path> --host <addr>`);
  }
  if (options.port !== undefined && !Number.isFinite(options.port)) {
    throw new DevWebServerError('--port must be a number');
  }
  return options;
}

if (import.meta.main) {
  try {
    const { url, projectRoot } = await startDevWebServer(parseArgs(process.argv.slice(2)));
    console.log(`lazy dev web server → ${url}`);
    console.log(`  project: ${projectRoot}`);
    console.log('  all reads and writes go through the running daemon');
    console.log('  stylesheet edits need only a page reload; template edits restart this process');
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
