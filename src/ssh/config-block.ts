/**
 * The `~/.ssh/config` Host block `lazy shell <task> --ssh-config` prints
 * (docs/design/task-sessions-and-ssh.md §5). The block ANCHORS ITS PROJECT:
 * VS Code and `scp` run a ProxyCommand from any directory, so it names the
 * clone with `--root <absolute path>` and lazy itself by an absolute path.
 *
 * The alias is task.project.team.teams-host in Teams, task.project.lazy solo.
 */

import { basename } from 'path';
import { SSH_LOGIN_USER } from './keys';

/** A shell word, quoted only when it needs to be. */
export function shWord(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** An SSH-pattern-safe rendering of a name: lowercase letters, digits, dashes. */
export function aliasLabel(raw: string): string {
  const s = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'project';
}

/** The task's segment of the alias: its code, else its id's first 8 characters. */
export function taskAliasSegment(task: { id: string; code?: string | null }): string {
  return task.code ? aliasLabel(task.code) : task.id.slice(0, 8).toLowerCase();
}

/** SSH-only task address; ProxyCommand handles the connection, never DNS. */
export function sshHostAlias(task: { id: string; code?: string | null }, project: { teamsProject?: string; teamsUrl?: string; root?: string }): string {
  if (project.teamsProject) {
    const [team, name] = project.teamsProject.split('/');
    if (!team || !name || !project.teamsUrl) throw new Error('SSH naming needs the Teams team, project and install URL');
    const install = new URL(project.teamsUrl);
    // Keep the ordinary HTTPS address readable; other origins name their
    // scheme and effective port so installing one cannot replace another.
    const suffix = install.protocol === 'https:' && !install.port
      ? '' : `--${install.protocol.slice(0, -1)}-${install.port || (install.protocol === 'https:' ? '443' : '80')}`;
    return [taskAliasSegment(task), aliasLabel(name), aliasLabel(team), install.hostname + suffix].join('.');
  }
  return [taskAliasSegment(task), aliasLabel(basename(project.root ?? 'project')), 'lazy'].join('.');
}

/**
 * argv that starts THIS lazy from anywhere: the compiled binary itself, or
 * `bun run <abs>/src/index.ts` when running from source.
 */
export function selfInvocation(execPath: string = process.execPath, mainScript: string | undefined = Bun.main): string[] {
  const exe = basename(execPath);
  if ((exe === 'bun' || exe === 'bun.exe') && mainScript && mainScript.endsWith('.ts')) return [execPath, 'run', mainScript];
  return [execPath];
}

export interface SshConfigBlockInput {
  alias: string;
  /** What `--stdio` resolves: the task's code or id. */
  taskRef: string;
  /** Absolute path of the clone (project root) the block anchors. */
  root: string;
  /** argv of lazy itself ({@link selfInvocation}). */
  lazyArgv: string[];
}

/** The Host block, ready to paste or to write into `~/.lazy/ssh/config`. */
export function sshConfigBlock(input: SshConfigBlockInput): string {
  const proxy = [...input.lazyArgv, 'shell', input.taskRef, '--stdio', '--root', input.root].map(shWord).join(' ');
  return [
    `Host ${input.alias}`,
    `  HostName ${input.alias}`,
    `  User ${SSH_LOGIN_USER}`,
    `  ProxyCommand ${proxy}`,
    `  HostKeyAlias ${input.alias}`,
    '  UserKnownHostsFile ~/.lazy/ssh/known_hosts',
    // Pinned by --install from the authenticated lazy channel.
    '  StrictHostKeyChecking yes',
    '  IdentityFile ~/.lazy/ssh/id_ed25519',
    '  IdentitiesOnly yes',
    '  ForwardAgent no',
    '  ForwardX11 no',
    '',
  ].join('\n');
}
