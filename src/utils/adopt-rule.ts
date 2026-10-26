/**
 * The ONE ownership rule every "adopt" site applies (the supervisor wrapper,
 * the member container, Start services, the builder entry, and the daemon /
 * supervisor realignment in ./worktree-ownership.ts).
 *
 * Adopt exists for a ROOT-run daemon on native Linux, which leaves what it
 * writes owned by uid 0. So adopt hands back ONLY entries owned by uid 0, and
 * never descends into a directory owned by any other user — a Postgres, Redis
 * or MySQL data directory the task's own services run as their own user. The
 * old rule ("anything the container user cannot write → chown -R the whole
 * path") re-owned a running Postgres's data dir on every turn and broke it.
 *
 * Pure strings: these fragments run under `sh` inside containers.
 */

/** `find` predicates (shell) after the start path: prune foreign-owned dirs, match root-owned entries. */
function findBody(uidExpr: string, excl: string, action: string): string {
  const e = excl ? ` ${excl}` : '';
  return `\\( ! -uid 0 ! -uid ${uidExpr} -type d -prune \\) -o \\( -uid 0${e} ${action} \\)`;
}

/** Shell: exit 0 iff something under "$p" is root-owned and not writable by the caller. */
export function adoptProbeShell(pathExpr: string, excl = ''): string {
  return `find ${pathExpr} ${findBody('"$(id -u)"', excl, '! -writable -print -quit')} 2>/dev/null | grep -q .`;
}

/** Shell: give every root-owned entry under the path to the caller (through sudo). Never -R, never a foreign owner's file. */
export function adoptChownShell(pathExpr: string, excl = ''): string {
  return `sudo -n find ${pathExpr} ${findBody('"$(id -u)"', excl, '-exec chown -h "$(id -u):$(id -g)" {} +')}`;
}

/** argv form for a process that knows the target uid (daemon side, or the supervisor). */
export function adoptChownArgv(paths: string[], uid: number, gid: number, useSudo: boolean): string[] {
  return [
    ...(useSudo ? ['sudo', '-n'] : []),
    'find', ...paths,
    '(', '!', '-uid', '0', '!', '-uid', String(uid), '-type', 'd', '-prune', ')',
    '-o', '(', '-uid', '0', '-exec', 'chown', '-h', `${uid}:${gid}`, '{}', '+', ')',
  ];
}

/** argv: print the first root-owned entry (foreign-owned dirs pruned). */
export function adoptProbeArgv(paths: string[], uid: number): string[] {
  return ['find', ...paths,
    '(', '!', '-uid', '0', '!', '-uid', String(uid), '-type', 'd', '-prune', ')',
    '-o', '(', '-uid', '0', '-print', '-quit', ')'];
}
