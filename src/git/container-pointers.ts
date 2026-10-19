import type { Runner } from '../runner/types';
import { stat } from 'fs/promises';
import { validateWorktreeGitPointers } from './worktree-pointers';

export type ContainerGitPointerProbe =
  | { kind: 'healthy' }
  | { kind: 'broken' }
  | { kind: 'unavailable'; reason: string };

export async function probeContainerGitPointers(
  root: string,
  worktreePath: string,
  runner: Pick<Runner, 'execInRun'>,
  containerName: string,
): Promise<ContainerGitPointerProbe> {
  const pointers = await validateWorktreeGitPointers(root, worktreePath);
  const argv = pointers.pointerFiles.flatMap(pointer => [pointer.target, pointer.content]);
  if (process.platform === 'linux') {
    const directory = await stat(worktreePath, { bigint: true });
    argv.push(worktreePath, `${directory.dev}:${directory.ino}`);
  }
  const script = `remaining=${pointers.pointerFiles.length}; ` +
    'while [ "$remaining" -gt 0 ]; do target=$1; expected=$2; shift 2; remaining=$((remaining - 1)); [ -x "${target%/*}" ] || exit 43; [ -f "$target" ] && [ ! -L "$target" ] || exit 42; actual=$(cat -- "$target" && printf .) || exit 43; [ "$actual" = "$expected." ] || exit 42; done; ' +
    'if [ "$#" -gt 0 ]; then actual=$(stat -c "%d:%i" -- "$1") || exit 43; [ "$actual" = "$2" ] || exit 42; fi';
  try {
    const exitCode = await runner.execInRun(containerName, ['sh', '-c', script, 'git-pointer-check', ...argv], { timeoutMs: 10000 });
    if (exitCode === 0) return { kind: 'healthy' };
    if (exitCode === 42) return { kind: 'broken' };
    return { kind: 'unavailable', reason: `Pointer probe exited with ${exitCode === null ? 'no exit code' : `code ${exitCode}`}.` };
  } catch (err) {
    return { kind: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
  }
}
