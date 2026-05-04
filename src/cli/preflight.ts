/**
 * Filesystem preflight check.
 *
 * Probes read+write access to the directories lazy persists state to, so that
 * a terminal without OS-level permission (macOS TCC, restrictive Unix perms,
 * read-only mounts) produces an actionable error naming the path and the
 * fix — not a cryptic EACCES from deep inside storage code.
 *
 * Runs once per CLI invocation. Skipped for help/version/completion, for
 * internal child-process commands (supervisor, mcp), and in test mode
 * (LAZY_TEST=1) — test temp dirs are always accessible, and failing
 * preflight there would be noise.
 */

import { stat, readdir, writeFile, unlink, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { getHome } from '../utils/home';

interface PreflightFailure {
  path: string;
  operation: 'read' | 'write';
  code: string;
}

async function probeRead(path: string): Promise<PreflightFailure | null> {
  try {
    const st = await stat(path);
    if (st.isDirectory()) {
      await readdir(path);
    }
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'EACCES';
    if (code === 'ENOENT') return null;
    if (code === 'EACCES' || code === 'EPERM') {
      return { path, operation: 'read', code };
    }
    return null;
  }
}

async function probeWrite(path: string): Promise<PreflightFailure | null> {
  // Deterministic marker name: self-healing across crashes (writeFile
  // truncates the same path on the next run) and bounded at one file per
  // probed directory rather than accumulating per-PID/per-timestamp.
  const marker = join(path, '.lazy-preflight-probe');
  try {
    await writeFile(marker, '');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'EACCES';
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      return { path, operation: 'write', code };
    }
    return null;
  }
  try {
    await unlink(marker);
  } catch {
    // Best-effort cleanup — writeFile already succeeded, so the probe has
    // answered its question. ENOENT means a concurrent lazy process beat us
    // to the unlink; other errors leave a zero-byte file that the next
    // invocation will truncate+unlink. Bounded, self-healing.
  }
  return null;
}

/** Map common TERM_PROGRAM values to user-friendly names. */
function terminalName(): string {
  const t = process.env.TERM_PROGRAM;
  if (!t) return 'your terminal';
  switch (t) {
    case 'Apple_Terminal': return 'Terminal';
    case 'iTerm.app': return 'iTerm';
    case 'vscode': return 'VS Code';
    case 'ghostty':
    case 'Ghostty': return 'Ghostty';
    case 'WezTerm': return 'WezTerm';
    case 'Hyper': return 'Hyper';
    case 'Alacritty': return 'Alacritty';
    case 'kitty': return 'kitty';
    case 'tabby': return 'Tabby';
    default: return t;
  }
}

function formatError(failure: PreflightFailure): string {
  const verb = failure.operation === 'read' ? 'read' : 'write to';
  const lines: string[] = [];
  lines.push(`Error: lazy cannot ${verb} ${failure.path} (${failure.code}).`);
  lines.push('');

  if (process.platform === 'darwin') {
    const term = terminalName();
    lines.push(`On macOS this is typically a privacy-protection block: ${term} lacks`);
    lines.push('permission to access this folder.');
    lines.push('');
    lines.push('Fix:');
    lines.push('  1. Open System Settings > Privacy & Security > Full Disk Access');
    lines.push(`  2. Add ${term} (or the terminal you run lazy from) and enable it`);
    lines.push(`  3. Restart ${term} and run lazy again`);
    lines.push('');
    lines.push('(If you only want to grant access to a specific folder, use');
    lines.push(' Files & Folders instead of Full Disk Access.)');
  } else {
    lines.push(`Check that ${failure.path} and its parent directories are`);
    lines.push(`${failure.operation === 'read' ? 'readable' : 'writable'} by the current user.`);
  }

  return lines.join('\n');
}

function fail(failure: PreflightFailure): never {
  console.error(formatError(failure));
  process.exit(1);
}

/**
 * Ensure a directory exists and is read+write accessible. Creates it
 * (recursively) if missing. Returns a failure description on permission
 * errors. Missing parents that we can create are fine; missing parents we
 * can't create surface as a permission failure on the first inaccessible
 * ancestor.
 */
async function ensureAccessible(path: string): Promise<PreflightFailure | null> {
  try {
    await mkdir(path, { recursive: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'EACCES';
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      // Find the deepest ancestor that actually exists — that's the one the
      // user needs to fix permissions on.
      let current = path;
      while (true) {
        try {
          await stat(current);
          return { path: current, operation: 'write', code };
        } catch {
          const parent = dirname(current);
          if (parent === current) break;
          current = parent;
        }
      }
      return { path, operation: 'write', code };
    }
    // Other errors propagate — not a permission problem we should mask.
    throw err;
  }

  const readFailure = await probeRead(path);
  if (readFailure) return readFailure;
  return probeWrite(path);
}

/**
 * Run filesystem preflight for the current CLI invocation.
 *
 * Probes:
 *  - `cwd`                            (read)       — git-root discovery, config loading
 *  - `~/.lazy`                        (read+write) — daemon state (socket, PID, logs) and user-global config
 *  - project `.lazy/` or `.workshop/` (read+write) — task storage, worktrees, recovery files
 *
 * On failure: prints an actionable error naming the path, the operation that
 * failed, the error code, and a platform-specific remediation hint; then
 * exits with code 1.
 *
 * @param lazyRoot - The resolved lazy project root, or null if not in a lazy project.
 */
export async function runPreflight(lazyRoot: string | null): Promise<void> {
  const cwdFailure = await probeRead(process.cwd());
  if (cwdFailure) fail(cwdFailure);

  const globalFailure = await ensureAccessible(join(getHome(), '.lazy'));
  if (globalFailure) fail(globalFailure);

  if (lazyRoot) {
    for (const name of ['.lazy', '.workshop']) {
      const projectDir = join(lazyRoot, name);
      try {
        const st = await stat(projectDir);
        if (!st.isDirectory()) continue;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue;
        fail({ path: projectDir, operation: 'read', code: code ?? 'EACCES' });
      }
      const readFailure = await probeRead(projectDir);
      if (readFailure) fail(readFailure);
      const writeFailure = await probeWrite(projectDir);
      if (writeFailure) fail(writeFailure);
    }
  }
}
