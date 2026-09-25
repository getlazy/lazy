import { requireLazyRoot, requireStorage, parseFlags, resolveTaskOrExit } from '../helpers';
import { displayId } from '../../task/identity';
import { getTaskServeState } from '../../serve/discovery';
import { findService, type ResolvedService } from '../../serve/ports';
import { probeServices } from '../../serve/probe';
import { displayUrlFor } from '../../serve/subdomain';
import { primeDashboardAuthority } from '../../serve/authority';

/**
 * `lazy url <task> [name-or-port]` — where a task's declared services are
 * reachable on this machine.
 *
 * Two shapes on purpose. With no service argument it LISTS, aligned, for a human
 * deciding which one to open. With one it prints exactly one bare URL and
 * nothing else, so `open "$(lazy url my-task web)"` works.
 *
 * The URL printed is the subdomain name (`http://web.my-task.lazy.localhost:26024`),
 * because the human's next move is to open it in a browser and the name is what
 * gives the app its own cookie jar and a URL that survives a container recreate.
 * `--direct` prints the raw `127.0.0.1` mapping instead, for curl and scripts:
 * browsers resolve `*.localhost` internally, but the OS resolver usually does
 * not, and a wildcard cannot go in /etc/hosts.
 */
export async function commandUrl(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [{ name: 'direct', takesValue: false }], 'url');
  const direct = parsed.flags.get('direct') === true;

  const taskId = parsed.positional[0];
  if (!taskId) {
    urlUsage();
    process.exit(1);
  }
  const serviceQuery = parsed.positional[1];

  const root = requireLazyRoot();
  // Where the proxy answers, so a subdomain URL can be composed at all. Skipped
  // for --direct, which is asking for the mapping this would decorate.
  if (!direct) await primeDashboardAuthority(root);
  const storage = await requireStorage();

  try {
    const task = await resolveTaskOrExit(storage, taskId);
    const session = await storage.getSessionByTaskId(task.id);
    const state = await getTaskServeState(root, task, session);

    if (state.declared.length === 0) {
      console.error(
        `Task ${displayId(task)} declares no ports. Add them to lazy.toml:\n` +
        `\n  [serve]\n  ports = [3000]\n` +
        `\nPorts are published when the task's container is created, so the task ` +
        `needs to be (re)started after adding them.`,
      );
      process.exit(1);
    }

    if (state.unavailable === 'no-container-runner') {
      console.error(
        `Task ${displayId(task)} runs on the ${state.runnerType} runner, which shares this ` +
        `machine's network — a server it starts is already on http://127.0.0.1:<the port it bound>. ` +
        `There is no mapping to look up.`,
      );
      process.exit(1);
    }

    if (state.unavailable === 'not-running') {
      console.error(
        `Task ${displayId(task)} has no running container, so nothing is published yet.\n` +
        `Start it with \`lazy start ${displayId(task)}\`, or enter it with ` +
        `\`lazy shell ${displayId(task)}\` (which brings it up).`,
      );
      process.exit(1);
    }

    // --- One service, one bare URL (scriptable) ---
    if (serviceQuery !== undefined) {
      const service = findService(state.services, serviceQuery);
      if (!service) {
        const known = state.services.map(s => s.name).join(', ');
        console.error(
          `Task ${displayId(task)} has no service "${serviceQuery}". Declared: ${known}.`,
        );
        process.exit(1);
      }
      if (!service.url) {
        console.error(unpublishedMessage(task, service.name, service.port));
        process.exit(1);
      }
      console.log(urlOf(service, direct));
      return;
    }

    // --- All services ---
    // Same probe the daemon RPC and the web Services card use: a bare TCP
    // connect, closed on connect, no bytes sent. ● = something is listening
    // behind the URL right now; ○ = the port is published but nothing answers.
    const services = await probeServices(state.services);
    const width = Math.max(...services.map(s => s.name.length));
    for (const service of services) {
      const label = service.name.padEnd(width);
      if (service.url) {
        const dot = service.listening ? '● listening' : '○ not listening';
        console.log(`${label}  ${urlOf(service, direct)}  ${dot}`);
      } else {
        console.log(`${label}  (not published — container predates this port)`);
      }
    }

    // Only worth saying when a name was actually printed: it explains why these
    // URLs may not resolve in curl, and names the flag that fixes that.
    if (!direct && services.some(s => s.publicUrl)) {
      console.log(
        `\nThese names resolve in Chromium and Firefox. For curl and scripts, ` +
        `\`lazy url ${displayId(task)} <service> --direct\` prints the 127.0.0.1 URL.`,
      );
    }

    // A declared-but-unpublished port is always a stale container, never a
    // transient state, so say the one thing that fixes it.
    if (state.services.some(s => !s.url)) {
      console.log(
        `\nSome declared ports are not published. Published ports are fixed when a ` +
        `container is created — restart the task to pick up the current [serve] config.`,
      );
    }
  } finally {
    await storage.close();
  }
}

/**
 * The URL to print for one published service.
 *
 * `--direct` is the raw mapping; otherwise the subdomain name when this process
 * managed to learn where the dashboard answers, and the raw mapping when it did
 * not (no daemon running — in which case the proxy is not answering either, so
 * the direct URL is the more useful of the two anyway).
 */
function urlOf(service: ResolvedService, direct: boolean): string {
  const url = direct ? service.url : displayUrlFor(service);
  // Callers reach this only for a published service, where `url` is non-null;
  // the fallback keeps the type honest without inventing a second failure mode.
  return url ?? service.url ?? '';
}

function unpublishedMessage(task: { id: string; code?: string | null }, name: string, port: number): string {
  return (
    `Service "${name}" (container port ${port}) is declared but not published by the ` +
    `running container. Published ports are fixed when a container is created, so a ` +
    `container started before this port was declared does not have it. Restart the ` +
    `task to pick up the current [serve] config.`
  );
}

export function urlUsage(): void {
  console.log(`Usage: lazy url <task_id> [service]

Show where a task's declared [serve] ports are reachable on this machine.

Arguments:
  <task_id>    ID of the task (prefix matching works)
  [service]    A service name or container port. Prints exactly one bare URL,
               with no labels, so it composes in scripts.

Options:
  --direct     Print the raw http://127.0.0.1:<port> mapping instead of the name

Ports are declared per project in lazy.toml:

  [serve]
  ports = [3000, 5173]        # identity is the port itself

  [serve.services]            # or give them names
  web = 3000
  api = 8080

Each declared port is published to an OS-assigned port on 127.0.0.1 when the
task's container is CREATED, so parallel tasks never collide and nothing is
exposed off this machine. Editing [serve] takes effect the next time the task's
container is created.

The URL printed is a name served by the running daemon:

  http://web.my-task.lazy.localhost:<dashboard port>

It stays the same across container recreates (the 127.0.0.1 port does not), and
each task gets its own cookie jar, so two tasks running the same app no longer
log each other out. Chromium and Firefox resolve *.localhost themselves; the OS
resolver usually does not, and a wildcard cannot go in /etc/hosts — so use
--direct for curl, and for anything that is not a browser.

The list shows liveness per service — ● when a TCP connect to the published
port succeeds (something is listening), ○ when nothing answers yet. The check
never sends a request to the app.

Examples:
  lazy url my-task              # List every service, its URL and liveness
  lazy url my-task web          # Just the web service's URL
  lazy url my-task 3000         # By container port
  open "$(lazy url my-task web)"
  curl "$(lazy url my-task web --direct)"`);
}
