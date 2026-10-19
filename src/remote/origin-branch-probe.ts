/**
 * Is a branch on the remote — and could we even ask?
 *
 * `git fetch <remote> <branch>` fails the same way for "not pushed yet" and
 * "remote unreachable". `git ls-remote --exit-code` tells them apart: exit 0 =
 * the branch is there, exit 2 = the remote answered and has no such branch,
 * anything else = the remote could not be asked. Accept relies on the
 * difference: only an ABSENT branch is safe to accept past, since an
 * unreachable one may hold pushed commits the squash would leave out.
 */
import { runGit } from '../utils/git';

export type OriginBranchProbe =
  | { kind: 'present' }
  | { kind: 'absent' }
  | { kind: 'unreachable'; detail: string };

export async function probeOriginBranch(remote: string, branch: string, cwd: string): Promise<OriginBranchProbe> {
  const r = await runGit(['ls-remote', '--exit-code', '--heads', remote, `refs/heads/${branch}`], { cwd, timeout: 60_000 });
  if (r.exitCode === 0) return { kind: 'present' };
  if (r.exitCode === 2) return { kind: 'absent' };
  return { kind: 'unreachable', detail: (r.stderr || `git ls-remote exited ${r.exitCode}`).trim() };
}
