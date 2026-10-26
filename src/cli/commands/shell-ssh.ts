/**
 * `lazy shell <task> --ssh-config [--install]` and the hidden
 * `lazy shell <task> --stdio [--root <clone>]` — SSH into a task, behind the
 * one verb that already enters it (docs/design/task-sessions-and-ssh.md §5).
 *
 *   --ssh-config   print the `~/.ssh/config` Host block for the task
 *   --install      also make this machine's key (`~/.lazy/ssh/id_ed25519`),
 *                  register it with Lazy Teams (bound clone), pin the task's
 *                  host key from the authenticated lazy channel and write the
 *                  block into `~/.lazy/ssh/config`, offering to add its Include
 *   --stdio        the ProxyCommand: SSH bytes on stdin/stdout, to the daemon's
 *                  attach route in `?mode=ssh` (through Teams for a bound clone)
 *   --root <dir>   the clone to act for, so a ProxyCommand works from any
 *                  directory (VS Code and `scp` run it from anywhere)
 *
 * Bound clone: the connection lands in the member's own container, as the web
 * Shell does. Solo: in the task's container, as `lazy shell <task>` does.
 */

import { hostname } from 'os';
import { isAbsolute, resolve } from 'path';
import { stat } from 'fs/promises';
import { isTTY, promptYesNo } from '../editor';
import { parseFlags } from '../helpers';
import { findLazyRoot } from '../../project-paths';
import { queryTaskShow, rpcAttachSession, rpcSshHostKey, queryEnsureTaskContainer } from '../../daemon/rpc-fallback';
import { boundCloneLogin } from './bound-session';
import { resolveTeamsLogin } from '../../teams/login';
import { remoteAttachUrl } from '../../teams/session-terminal';
import { sessionAttachPath } from '../../daemon/session-attach';
import { getDaemonTcpTarget, readToken } from '../../daemon/lifecycle';
import { runSshStdioPump } from '../../ssh/stdio-pump';
import { sshConfigBlock, sshHostAlias, selfInvocation } from '../../ssh/config-block';
import {
  ensureLocalSshKey,
  pinKnownHost,
  upsertSshConfigBlock,
  sshConfigIncludeStatus,
  installSshConfigInclude,
  lazySshConfigPath,
  LAZY_SSH_CONFIG_INCLUDE,
} from '../../ssh/local-files';
import { registerSshKey } from '../../teams/ssh-keys';

export const SHELL_SSH_FLAGS = ['--ssh-config', '--stdio'];

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Whether these `lazy shell` arguments ask for one of the SSH modes. */
export function wantsShellSsh(args: string[]): boolean {
  const sep = args.indexOf('--');
  const own = sep === -1 ? args : args.slice(0, sep);
  return own.some((a) => SHELL_SSH_FLAGS.includes(a));
}

export async function commandShellSsh(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'ssh-config', takesValue: false },
    { name: 'install', takesValue: false },
    { name: 'yes', aliases: ['y'], takesValue: false },
    { name: 'stdio', takesValue: false },
    { name: 'root', takesValue: true },
  ], 'shell');
  const stdio = parsed.flags.get('stdio') === true;
  const sshConfig = parsed.flags.get('ssh-config') === true;
  const install = parsed.flags.get('install') === true;
  if (stdio && sshConfig) fail('--stdio and --ssh-config are separate modes; pick one.');
  if (install && !sshConfig) fail('--install goes with --ssh-config.');
  const taskRef = parsed.positional[0];
  if (!taskRef || parsed.positional.length > 1) fail('usage: lazy shell <task> --ssh-config [--install]');

  if (stdio) {
    // stdout belongs to SSH from here on: anything lazy prints goes to stderr.
    console.log = console.error;
    console.info = console.error;
  }

  const rootFlag = parsed.flags.get('root');
  if (typeof rootFlag === 'string') {
    if (!isAbsolute(rootFlag)) fail(`--root must be an absolute path, got ${rootFlag}`);
    try {
      if (!(await stat(rootFlag)).isDirectory()) fail(`--root ${rootFlag} is not a directory`);
    } catch (err) {
      fail(`--root ${rootFlag}: ${errorText(err)}`);
    }
    process.chdir(rootFlag);
  }
  const root = findLazyRoot();
  if (!root) fail('not inside a lazy project (or a clone bound to Lazy Teams). Run it in the clone, or pass --root.');
  const bound = await boundCloneLogin(root);

  let shown;
  try {
    shown = await queryTaskShow(taskRef);
  } catch (err) {
    fail(errorText(err));
  }
  if (!shown) fail(`Task not found: ${taskRef}`);
  if (shown.ambiguous) fail(`'${taskRef}' matches more than one task: ${shown.matches.map((m) => m.code ?? m.id).join(', ')}. Be more specific.`);
  const task = shown.data.task;
  const sessionId = shown.data.session?.id;
  if (!sessionId) fail(`task ${taskRef} has no environment yet — start it first.`);
  const stableRef = task.code ?? task.id;

  if (stdio) {
    // The daemon's own answer for THIS person, asked before any socket: a
    // refused upgrade reaches `ssh` with no reason it can show, so the
    // sentence (no Claude account connected, an environment that cannot be
    // made, …) is printed here, on the stderr `ssh` passes through.
    const preflight = async () => {
      try {
        const info = await rpcAttachSession(sessionId);
        const refusal = info.refusals?.ssh ?? info.refusals?.shell;
        if (refusal) fail(refusal);
      } catch (err) {
        fail(`cannot reach task ${stableRef}: ${errorText(err)}`);
      }
    };
    let url: string;
    let headers: Record<string, string>;
    if (bound) {
      await preflight();
      const login = await resolveTeamsLogin(root);
      if (!login) fail('this clone is no longer logged in to Lazy Teams. Run `lazy login <url>` again.');
      url = remoteAttachUrl({
        teamsUrl: login.login.binding.teams_url,
        project: login.login.binding.project,
        projectId: login.login.binding.project_id,
        sessionId,
        cols: 80,
        rows: 24,
        mode: 'ssh',
      });
      headers = { Authorization: `Bearer ${login.token}` };
    } else {
      // Solo: the task's own container, started when it is not running —
      // exactly what `lazy shell <task>` does.
      try {
        await queryEnsureTaskContainer({ taskId: task.id, restart: false });
      } catch (err) {
        fail(`could not start task ${stableRef}'s container: ${errorText(err)}`);
      }
      // After the container is up: discovery checks that it runs.
      await preflight();
      const target = getDaemonTcpTarget(root);
      const token = readToken(root);
      if (!target || !token) fail('the local lazy daemon is not running. Run any lazy command (e.g. `lazy list`) to start it, then connect again.');
      url = `${target.replace(/^http/, 'ws')}${sessionAttachPath(sessionId)}?mode=ssh`;
      headers = { Authorization: `Bearer ${token}`, 'X-Lazy-Project': root };
    }
    process.exit(await runSshStdioPump({ url, headers }));
  }

  // --ssh-config
  const alias = sshHostAlias(task, bound ? { teamsProject: bound.binding.project, teamsUrl: bound.binding.teams_url } : { root });
  const block = sshConfigBlock({ alias, taskRef: stableRef, root: resolve(root), lazyArgv: selfInvocation() });
  const explanation = bound
    ? `${alias} is a name for ssh only: ssh reaches the task through Lazy Teams over ${new URL(bound.binding.teams_url).protocol.slice(0, -1).toUpperCase()} (no DNS, no open SSH port).`
    : `${alias} is a name for ssh only: ssh reaches the task through the local lazy daemon (no DNS, no open SSH port).`;
  if (!install) {
    process.stdout.write(block);
    console.error(explanation);
    console.error(
      `\nPaste this into ~/.ssh/config, or run \`lazy shell ${stableRef} --ssh-config --install\` to set it up for you ` +
      '(it also makes this machine\'s key and pins the task\'s host key).',
    );
    return;
  }

  // The same per-mode answer the Shell gets: a member who could not open a
  // Shell here (no Claude account connected, a runtime that cannot host a
  // member container) hears why now rather than from a failed connection.
  try {
    const info = await rpcAttachSession(sessionId);
    const refusal = info.refusals?.ssh ?? info.refusals?.shell;
    if (refusal) fail(refusal);
  } catch (err) {
    fail(`cannot reach task ${stableRef}: ${errorText(err)}`);
  }

  const key = await ensureLocalSshKey(`lazy@${hostname()}`);
  if (key.created) console.log(`Made this machine's lazy SSH key: ~/.lazy/ssh/id_ed25519 (${key.publicKey.fingerprint})`);
  if (bound) {
    const login = await resolveTeamsLogin(root);
    if (!login) fail('this clone is no longer logged in to Lazy Teams. Run `lazy login <url>` again.');
    try {
      const reg = await registerSshKey({
        teamsUrl: login.login.binding.teams_url,
        token: login.token,
        publicKey: key.publicLine,
        name: `lazy@${hostname()}`,
      });
      console.log(`Registered it with ${login.login.binding.teams_url} as "${reg.name}" (Account settings → SSH keys).`);
    } catch (err) {
      fail(errorText(err));
    }
  }
  try {
    const host = await rpcSshHostKey(sessionId);
    await pinKnownHost(alias, host.hostKey);
  } catch (err) {
    fail(`could not fetch task ${stableRef}'s host key: ${errorText(err)}`);
  }
  await upsertSshConfigBlock(alias, block);
  console.log(`Wrote Host ${alias} to ${lazySshConfigPath()} and pinned its host key.`);
  console.log(explanation);
  const includeStatus = await sshConfigIncludeStatus();
  if (includeStatus === 'installed') {
    console.log('SSH Include already set up in ~/.ssh/config.');
  } else {
    if (includeStatus === 'scoped') {
      console.log('Your lazy SSH Include is below a Host or Match block and applies only inside that block. Other Include paths and shared patterns will stay in place.');
    } else if (includeStatus === 'unexpanded') {
      console.log('OpenSSH does not expand bare $HOME in Include paths; use ${HOME} or ~ instead. Your lazy Include is not active.');
    }
    const prompt = includeStatus === 'unexpanded'
      ? `Replace the bare $HOME Include with \`${LAZY_SSH_CONFIG_INCLUDE}\` at the top of ~/.ssh/config so \`ssh ${alias}\` works?`
      : `${includeStatus === 'scoped' ? 'Move' : 'Add'} \`${LAZY_SSH_CONFIG_INCLUDE}\` ${includeStatus === 'scoped' ? 'to' : 'at'} the top of ~/.ssh/config so \`ssh ${alias}\` works?`;
    const consent = parsed.flags.get('yes') === true || (isTTY() && await promptYesNo(
      prompt, true));
    if (consent) {
      const { backup, changed, moved } = await installSshConfigInclude();
      console.log(changed && includeStatus === 'unexpanded'
        ? `Replaced the bare $HOME Include with ${LAZY_SSH_CONFIG_INCLUDE} at the top of ~/.ssh/config.`
        : changed
        ? `${moved ? 'Moved' : 'Added'} ${LAZY_SSH_CONFIG_INCLUDE} ${moved ? 'to' : 'at'} the top of ~/.ssh/config.`
        : 'SSH Include already set up in ~/.ssh/config.');
      if (backup) console.log('Saved the old file as ~/.ssh/config.lazy-backup.');
    } else {
      console.log(`One-time step: ${includeStatus === 'scoped' ? "move lazy's Include" : includeStatus === 'unexpanded' ? 'replace the bare $HOME Include with this line' : 'add this line'} at the TOP of ~/.ssh/config:\n  ${LAZY_SSH_CONFIG_INCLUDE}\nAn Include after a Host block applies only to that block. Re-run with --yes to finish this automatically.`);
    }
  }
  console.log(`Connect with:  ssh ${alias}`);
  console.log(`Copy files:    scp ./file ${alias}:`);
  console.log(`Editors:       VS Code Remote-SSH or JetBrains Gateway → host ${alias}`);
}
