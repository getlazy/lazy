/**
 * `lazy builder`, `lazy pair` and `lazy shell` in a clone bound to Lazy Teams.
 *
 * A bound clone has no local daemon, and a session started beside it would
 * reason about refs it cannot see and capture its conversation nowhere (design
 * doc §5.1). So these commands launch NOTHING on this machine: the session runs
 * on the server, next to the store and the repository, and this terminal
 * attaches to it through Teams' relay route (src/teams/session-terminal.ts).
 * The same session is reachable from the Teams web page.
 *
 * Every decision stays where it already lives: which session a member has, and
 * whether a second attach joins it, is the daemon's (`startBuilderSession`);
 * whether this member may attach at all is Teams' (the same policy its browser
 * terminal uses); which container a session id reaches is the daemon's again,
 * from the session record. This module only asks and relays.
 */

import type { TeamsLogin } from '../../teams/login';
import type { BuilderSession } from '../../storage/types';
import { requireStorage } from '../helpers';
import { resolveTeamsLogin, readTeamsLogin, MultipleTeamsLoginsError } from '../../teams/login';
import {
  rpcStartBuilderSession,
  rpcAttachSession,
  rpcEndBuilderSession,
  rpcStopBuilderSession,
  queryTaskShow,
} from '../../daemon/rpc-fallback';
import {
  remoteAttachUrl,
  runRemoteTerminal,
  localTerminalSize,
  type RemoteAttachMode,
  type RemoteTerminalOutcome,
} from '../../teams/session-terminal';

const DETACH_HINT = 'ctrl-]';

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Refuse flags that choose something a server-side session decides for itself. */
function refuseLocalOnlyFlags(command: string, args: string[], allowed: Set<string>): void {
  const offending = args.filter((a) => a.startsWith('-') && !allowed.has(a));
  if (offending.length === 0) return;
  fail(
    `\`lazy ${command}\` in a clone bound to Lazy Teams attaches to a session on the server, ` +
    `so ${offending.join(', ')} ${offending.length === 1 ? 'does' : 'do'} not apply here — ` +
    'the server decides how its sessions run. Run it without them.',
  );
}

async function attachAndReport(
  root: string,
  sessionId: string,
  mode: RemoteAttachMode,
  afterwards: (outcome: RemoteTerminalOutcome) => void,
): Promise<void> {
  const bound = await resolveTeamsLogin(root);
  if (!bound) fail('this clone is no longer logged in to Lazy Teams. Run `lazy login <url>` again.');
  const size = localTerminalSize(process.stdout);
  const url = remoteAttachUrl({
    teamsUrl: bound.login.binding.teams_url,
    project: bound.login.binding.project,
    sessionId,
    cols: size.cols,
    rows: size.rows,
    mode,
  });
  const outcome = await runRemoteTerminal({ url, token: bound.token });
  afterwards(outcome);
}

// --- lazy builder ---------------------------------------------------------

/**
 * `lazy builder [end|stop [<session-id>]]` in a bound clone.
 * `lazy builder list` is not handled here: it lists captured conversations
 * through storage, which already reaches the project's store through Teams.
 */
export async function commandBuilderBound(root: string, login: TeamsLogin, args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === 'end' || sub === 'stop') {
    await endOrStopBuilderSession(root, sub, args[1]);
    return;
  }
  // `--yes` / `--autonomous` restate what a server-side session already is
  // (autonomous, confirmed by starting it); everything else chooses a model,
  // an effort or a conversation to resume, which the server decides.
  refuseLocalOnlyFlags('builder', args, new Set(['--yes', '--autonomous']));
  if (args.some((a) => !a.startsWith('-'))) {
    fail(`unknown builder subcommand '${args.find((a) => !a.startsWith('-'))}'. Use \`lazy builder\`, \`lazy builder end\` or \`lazy builder stop\`.`);
  }

  let session;
  try {
    session = await rpcStartBuilderSession();
  } catch (err) {
    fail(`could not start your builder session: ${errorText(err)}`);
  }
  try {
    await rpcAttachSession(session.id);
  } catch (err) {
    fail(`your builder session ${session.id} cannot be attached to: ${errorText(err)}`);
  }

  console.error(
    `Attached to your builder session ${session.id} on ${login.binding.teams_url} (${login.binding.project}).\n` +
    `It runs on the server: ${DETACH_HINT} detaches and leaves it running; \`lazy builder end\` ends it.`,
  );
  await attachAndReport(root, session.id, 'attach', (outcome) => {
    if (outcome.kind === 'detached') {
      console.error(`\nDetached. Session ${session.id} is still running — \`lazy builder\` reattaches, \`lazy builder end\` ends it.`);
      return;
    }
    if (outcome.kind === 'exited') {
      console.error(`\nThe builder in session ${session.id} exited${outcome.code === null ? '' : ` (code ${outcome.code})`}.`);
      process.exitCode = outcome.code ?? 0;
      return;
    }
    console.error(`\nLost the connection to session ${session.id}: ${outcome.message}. It may still be running — \`lazy builder\` reattaches.`);
    process.exitCode = 1;
  });
}

async function endOrStopBuilderSession(root: string, verb: 'end' | 'stop', explicitId: string | undefined): Promise<void> {
  let id = explicitId;
  if (!id) {
    // The member's own not-yet-ended session, whatever state its container is
    // in — a stopped one can still be ended, and one whose container died can
    // still be stopped or ended. The daemon answers for the CALLER's member
    // from their token; the member argument here is ignored on a shared daemon.
    let active: BuilderSession | null;
    try {
      const storage = await requireStorage();
      active = await storage.getActiveBuilderSessionForMember(root, null);
    } catch (err) {
      fail(`could not look up your builder session: ${errorText(err)}`);
    }
    if (!active) fail(`you have no builder session on this project to ${verb}.`);
    id = active.id;
  }
  try {
    const result = verb === 'end' ? await rpcEndBuilderSession(id) : await rpcStopBuilderSession(id);
    console.log(verb === 'end'
      ? `Ended builder session ${result.id}.`
      : `Stopped builder session ${result.id}. \`lazy builder\` resumes its conversation.`);
  } catch (err) {
    fail(`could not ${verb} builder session ${id}: ${errorText(err)}`);
  }
}

// --- lazy pair / lazy shell -----------------------------------------------

/**
 * `lazy pair <task>` / `lazy shell <task>` in a bound clone: attach to the
 * task's CURRENT session on the server in that mode. The daemon decides
 * whether the terminal may open — on a shared daemon it runs in a container
 * of the member's own, and is refused while a turn runs, before the task has
 * run one, or while another member is in — and a refusal is shown as it is.
 * Nothing is launched locally either way.
 */
export async function commandTaskTerminalBound(
  command: 'pair' | 'shell',
  root: string,
  args: string[],
): Promise<void> {
  refuseLocalOnlyFlags(command, args, new Set());
  const taskRef = args.find((a) => !a.startsWith('-'));
  if (!taskRef) fail(`\`lazy ${command} <task>\` needs a task.`);

  let shown;
  try {
    shown = await queryTaskShow(taskRef);
  } catch (err) {
    fail(errorText(err));
  }
  if (!shown) fail(`Task not found: ${taskRef}`);
  if (shown.ambiguous) {
    fail(`'${taskRef}' matches more than one task: ${shown.matches.map((m) => m.code ?? m.id).join(', ')}. Be more specific.`);
  }
  const sessionId = shown.data.session?.id;
  if (!sessionId) fail(`task ${taskRef} has no session on the server yet — start it first.`);

  try {
    await rpcAttachSession(sessionId);
  } catch (err) {
    fail(`cannot ${command} into task ${taskRef} through Lazy Teams: ${errorText(err)}`);
  }
  console.error(`Attached to task ${taskRef} on the server (${command}). ${DETACH_HINT} detaches.`);
  await attachAndReport(root, sessionId, command, (outcome) => {
    if (outcome.kind === 'closed') {
      console.error(`\nLost the connection: ${outcome.message}.`);
      process.exitCode = 1;
    } else if (outcome.kind === 'exited') {
      process.exitCode = outcome.code ?? 0;
    }
  });
}

/**
 * This clone's Teams login, or null for an ordinary local project. Two logins
 * at once is a broken state whose only recovery is `lazy logout`; it refuses
 * by name rather than guessing which install to attach through.
 */
export async function boundCloneLogin(root: string): Promise<TeamsLogin | null> {
  try {
    return await readTeamsLogin(root);
  } catch (err) {
    if (err instanceof MultipleTeamsLoginsError) fail(err.message);
    throw err;
  }
}
