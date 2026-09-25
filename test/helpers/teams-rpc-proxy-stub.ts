/**
 * The RPC half of a stand-in Lazy Teams, for bound-clone e2e suites: the
 * `/api/projects/<project>/rpc/<command>` route, which authenticates the
 * clone's CLI token and relays to a REAL daemon on the member's own actor
 * token — exactly what `Api::Cli::RpcController` does.
 *
 * It admits exactly what the Rails tables admit, read off the Ruby source by
 * `loadRailsPolicyTables()`, and refuses everything else with the route's own
 * wording (a refused storage method names the COMMAND `storage`, never the
 * method). One copy, shared by every suite that relays: a second hand-written
 * stub is how a method the real route refuses once shipped green.
 *
 * It also refuses what the route refuses on the request's CONTENTS, from the
 * same tables and in the same words: a body key outside the command's
 * `BODY_KEYS` list (`CliRpcCommand.body_refusal`), and a storage write whose
 * arguments the browser could not have produced
 * (`StorageMethodPolicy.argument_refusal`: a task setting outside
 * `METADATA_KEYS`, a target other than a parent task or `main`). Without
 * these a tool that sends an extra key looked like it worked here and would be
 * refused by the real route. The effort-LEVEL check is not mirrored (its list
 * lives in another Ruby file), nor is the TaskAction row — both are the Rails
 * suite's to prove.
 */

import { loadRailsPolicyTables } from './rails-policy-tables';

export interface TeamsRpcRelayOptions {
  /** `acme/lazy-toy` — the project path segment of the proxy route. */
  project: string;
  /** The CLI ApiToken the clone's login record carries. */
  cliToken: string;
  /** The daemon's TCP target (`http://127.0.0.1:<port>`). */
  daemonTarget: () => string;
  /** The MEMBER's actor token on that daemon (what Teams relays with). */
  memberToken: () => string;
  /** The daemon's project root (`X-Lazy-Project`). */
  projectRoot: string;
  /** Records `command` or `storage:<method>` for every call relayed. */
  proxied?: string[];
}

/**
 * Answer one request to the proxy route, or return `null` when the path is not
 * an RPC route (so a caller can serve other Teams routes — the attach relay —
 * from the same server).
 */
export async function relayTeamsRpc(req: Request, opts: TeamsRpcRelayOptions): Promise<Response | null> {
  const tables = loadRailsPolicyTables();
  const url = new URL(req.url);
  const base = `/api/projects/${opts.project}/rpc/`;
  if (!url.pathname.startsWith(base)) return null;
  if (req.headers.get('authorization') !== `Bearer ${opts.cliToken}`) {
    return Response.json({ error: 'A CLI-scoped API token is required.' }, { status: 401 });
  }
  const command = url.pathname.slice(base.length);
  const body = await req.text();
  const params = body ? JSON.parse(body) : {};
  if (command !== 'storage' && !tables.cliCommands.has(command)) {
    return Response.json({ error: `Unknown or unsupported command '${command}'.` }, { status: 404 });
  }
  if (command === 'storage' && !tables.storageMethods.has(params.method)) {
    return Response.json({ error: "Unknown or unsupported command 'storage'." }, { status: 404 });
  }
  const extra = Object.keys(params).filter((key) => !(tables.bodyKeys.get(command)?.has(key) ?? false));
  if (extra.length > 0) {
    return Response.json(
      { error: `'${command}' cannot carry ${extra.map((k) => JSON.stringify(k)).join(', ')} from a clone logged in to Lazy Teams.` },
      { status: 403 },
    );
  }
  if (command === 'storage') {
    const reason = storageArgumentRefusal(params.method, params.args ?? {}, tables.metadataKeys);
    if (reason) return Response.json({ error: reason }, { status: 403 });
  }
  opts.proxied?.push(command === 'storage' ? `storage:${params.method}` : command);
  const reply = await fetch(`${opts.daemonTarget()}/rpc/${command}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.memberToken()}`,
      'X-Lazy-Project': opts.projectRoot,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });
  return new Response(await reply.arrayBuffer(), {
    status: reply.status,
    headers: { 'Content-Type': reply.headers.get('content-type') ?? 'application/json' },
  });
}

/** `StorageMethodPolicy.argument_refusal`, minus the effort-level check. */
function storageArgumentRefusal(method: string, args: Record<string, any>, metadataKeys: Set<string>): string | null {
  if (method === 'updateTaskMetadata') {
    if (!metadataKeys.has(args.key)) {
      return `Task setting ${JSON.stringify(args.key)} cannot be changed from a clone logged in to Lazy Teams.`;
    }
    if (args.key === 'effort_explicit' && args.value !== 'true') return 'effort_explicit can only be set to "true".';
    return null;
  }
  if (method === 'updateTaskTarget') {
    const target = args.target;
    if (typeof target !== 'object' || target === null) return 'A task target must be an object.';
    if (target.kind === 'task') {
      return typeof target.parentTaskId === 'string' && target.parentTaskId !== ''
        ? null
        : 'A parent target must name the parent task.';
    }
    if (target.kind === 'branch') {
      return target.branch === 'main'
        ? null
        : `A task cannot be pointed at branch ${JSON.stringify(target.branch)} from a clone logged in to Lazy Teams; ` +
          'only a parent task can be set, or the parent cleared.';
    }
    return `Unknown task target kind ${JSON.stringify(target.kind)}.`;
  }
  return null;
}
