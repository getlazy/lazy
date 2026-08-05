/**
 * Bridge Claude Code session files between the sandbox and the host so that
 * `claude --resume` can find them when the user runs `lazy pair` on the host.
 *
 * Docker runner: Claude Code inside the container writes session JSONLs into
 * `/home/user/.claude/projects/<encoded-cwd>/`. That is bind-mounted from
 * `<worktree>/.lazy-task-sandbox/.claude`, so on the host the JSONLs appear
 * at `<worktree>/.lazy-task-sandbox/.claude/projects/<encoded-cwd>/`.
 *
 * Host-process runner: Claude Code writes directly to `~/.claude/projects/`
 * on the host, and no bridging is needed.
 *
 * Kept in its own module so unit tests can import it without pulling in
 * heavy supervisor / docker launch modules.
 */
import { join } from 'path';
import { existsSync, mkdirSync, symlinkSync, unlinkSync, lstatSync, readdirSync } from 'fs';
import { stat, readFile, mkdir, copyFile, access } from 'fs/promises';
import { getHome } from '../../utils/home';
import { encodeProjectPath } from '../../import/claude-code-logs';
import type { RunnerType } from '../../config/types';

const SANDBOX_DIR = '.lazy-task-sandbox';

/** Container runners isolate the agent's `.claude` in the mounted sandbox dir. */
function isContainerRunner(type: RunnerType): boolean {
  return type === 'docker' || type === 'podman';
}

export interface BridgeResult {
  /** True if the session JSONL is accessible at the host's ~/.claude/projects/ */
  accessible: boolean;
  /** Cleanup function that removes any symlinks we created */
  cleanup: () => void;
  /** Human-readable trace of paths checked and outcomes (for error reporting) */
  diagnostics: string[];
  /**
   * Other session IDs found in the sandbox project dir. Non-empty when the
   * requested session ID was not found but other sessions exist — useful to
   * tell the user which sessions ARE available.
   */
  availableSandboxSessions: string[];
}

/**
 * Recognition cues for a sandbox session, used to help the user pick the
 * right session when stale-recovery has multiple candidates.
 */
export interface SandboxSessionSummary {
  id: string;
  /** Milliseconds since the JSONL was last modified, or null if mtime unavailable. */
  ageMs: number | null;
  /** Last human (user) text content in the JSONL — null if none / file unreadable. */
  lastHumanText: string | null;
}

/**
 * Inspect each sandbox session JSONL and pull out the cues a human needs to
 * recognize which session is which: how long ago it was last touched and the
 * last thing they typed in it. Mirrors how `claude --resume` lists sessions.
 *
 * Returned list is sorted newest-first (smallest ageMs first).
 */
export async function summarizeSandboxSessions(
  worktreePath: string,
  sessionIds: string[],
): Promise<SandboxSessionSummary[]> {
  const sandboxProjectDir = join(
    worktreePath,
    SANDBOX_DIR,
    '.claude',
    'projects',
    encodeProjectPath(worktreePath),
  );

  const summaries = await Promise.all(
    sessionIds.map(async (id): Promise<SandboxSessionSummary> => {
      const jsonlPath = join(sandboxProjectDir, `${id}.jsonl`);
      let ageMs: number | null = null;
      let lastHumanText: string | null = null;

      try {
        const st = await stat(jsonlPath);
        ageMs = Math.max(0, Date.now() - st.mtimeMs);
      } catch {
        // file gone or unreadable — leave ageMs null
      }

      try {
        const content = await readFile(jsonlPath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());
        // Walk backwards so we surface the most recent human input.
        for (let i = lines.length - 1; i >= 0; i--) {
          let obj: { type?: string; message?: { content?: unknown } };
          try {
            obj = JSON.parse(lines[i]);
          } catch {
            continue;
          }
          if (obj.type !== 'user') continue;
          const text = extractUserText(obj.message?.content);
          // Skip tool_result-only "user" entries (auto-generated, not human input).
          if (text && text.trim()) {
            lastHumanText = text.trim();
            break;
          }
        }
      } catch {
        // read failure — leave lastHumanText null
      }

      return { id, ageMs, lastHumanText };
    }),
  );

  summaries.sort((a, b) => {
    if (a.ageMs == null && b.ageMs == null) return 0;
    if (a.ageMs == null) return 1;
    if (b.ageMs == null) return -1;
    return a.ageMs - b.ageMs;
  });

  return summaries;
}

function extractUserText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((c: { type?: string }) => c?.type === 'text')
      .map((c: { text?: string }) => c.text ?? '');
    if (texts.length > 0) return texts.join('\n');
  }
  return null;
}

function listSandboxSessions(sandboxProjectDir: string): string[] {
  try {
    return readdirSync(sandboxProjectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace(/\.jsonl$/, ''));
  } catch {
    return [];
  }
}

export function bridgeSessionFiles(worktreePath: string, sessionId?: string): BridgeResult {
  const diagnostics: string[] = [];
  const sandboxClaudeDir = join(worktreePath, SANDBOX_DIR, '.claude');
  const encodedPath = encodeProjectPath(worktreePath);
  const sandboxProjectDir = join(sandboxClaudeDir, 'projects', encodedPath);
  const hostProjectsDir = join(getHome(), '.claude', 'projects');
  const hostProjectDir = join(hostProjectsDir, encodedPath);

  diagnostics.push(`sandbox project dir: ${sandboxProjectDir}`);
  diagnostics.push(`host project dir:    ${hostProjectDir}`);
  if (sessionId) {
    diagnostics.push(`session id:          ${sessionId}`);
  }

  const makeResult = (accessible: boolean, cleanup: () => void, available: string[] = []): BridgeResult => ({
    accessible,
    cleanup,
    diagnostics,
    availableSandboxSessions: available,
  });

  // If there's no sandbox project dir, check if the session is already
  // accessible at the host location (host-process runner writes directly to
  // ~/.claude/).
  if (!existsSync(sandboxProjectDir)) {
    diagnostics.push('sandbox project dir: does not exist');
    if (sessionId) {
      const hostSessionFile = join(hostProjectDir, `${sessionId}.jsonl`);
      if (existsSync(hostSessionFile)) {
        diagnostics.push(`host session file:   ${hostSessionFile} (found — no bridging needed)`);
        return makeResult(true, () => {});
      }
      diagnostics.push(`host session file:   ${hostSessionFile} (not found)`);
    }
    return makeResult(false, () => {});
  }

  // List what IS in the sandbox — useful for diagnostics and for telling the
  // user which sessions are available when the requested one is missing.
  const sandboxSessions = listSandboxSessions(sandboxProjectDir);
  diagnostics.push(`sandbox sessions:    ${sandboxSessions.length === 0 ? '(none)' : sandboxSessions.join(', ')}`);

  if (sessionId && !sandboxSessions.includes(sessionId)) {
    // The stored session ID points at a JSONL that doesn't exist in the
    // sandbox. Don't silently bridge something — report what was found.
    diagnostics.push(`sandbox session file for ${sessionId}: not found`);
    return makeResult(false, () => {}, sandboxSessions);
  }

  // If the session file already exists at the destination, check if it's
  // actually the same file (e.g., Docker bind mount). If so, no bridging needed.
  if (sessionId) {
    const sessionFile = `${sessionId}.jsonl`;
    const destFile = join(hostProjectDir, sessionFile);
    const srcFile = join(sandboxProjectDir, sessionFile);
    if (existsSync(destFile) && existsSync(srcFile)) {
      try {
        const destStat = lstatSync(destFile);
        const srcStat = lstatSync(srcFile);
        if (destStat.ino === srcStat.ino && destStat.dev === srcStat.dev) {
          diagnostics.push('host session file shares inode with sandbox — already accessible');
          return makeResult(true, () => {});
        }
      } catch {
        // Fall through to symlink approach
      }
    }
  }

  // Ensure host projects dir exists
  mkdirSync(hostProjectsDir, { recursive: true });

  // Inspect the host project dir. Three cases:
  //  - doesn't exist → symlink whole sandbox project dir
  //  - exists as a dangling symlink (e.g., from a crashed previous pair run
  //    whose sandbox is gone) → remove and replace with a fresh symlink
  //  - exists as a real dir or a valid symlink → bridge individual files
  let hostDirExisted = false;
  let hostDirIsDangling = false;
  try {
    lstatSync(hostProjectDir);
    hostDirExisted = true;
    try {
      readdirSync(hostProjectDir);
    } catch {
      hostDirIsDangling = true;
    }
  } catch {
    hostDirExisted = false;
  }

  if (hostDirIsDangling) {
    diagnostics.push('host project dir:    dangling symlink (removing and recreating)');
    try {
      unlinkSync(hostProjectDir);
      hostDirExisted = false;
    } catch (err) {
      diagnostics.push(`failed to remove dangling symlink: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const createdSymlinks: string[] = [];

  if (!hostDirExisted) {
    try {
      symlinkSync(sandboxProjectDir, hostProjectDir);
      createdSymlinks.push(hostProjectDir);
      diagnostics.push(`created symlink:     ${hostProjectDir} → ${sandboxProjectDir}`);
    } catch (err) {
      diagnostics.push(`failed to symlink host project dir: ${err instanceof Error ? err.message : String(err)}`);
      return makeResult(false, () => {}, sandboxSessions);
    }
  } else {
    // Host project dir exists — symlink individual session files
    const entries = readdirSync(sandboxProjectDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(sandboxProjectDir, entry.name);
      const destPath = join(hostProjectDir, entry.name);

      try {
        lstatSync(destPath);
        continue;
      } catch {
        // Doesn't exist — safe to create symlink
      }

      try {
        symlinkSync(srcPath, destPath);
        createdSymlinks.push(destPath);
      } catch (err) {
        diagnostics.push(`failed to symlink ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Verify the session file is actually accessible now
  let accessible = true;
  if (sessionId) {
    const sessionFile = join(hostProjectDir, `${sessionId}.jsonl`);
    accessible = existsSync(sessionFile);
    if (!accessible) {
      diagnostics.push(`verification:        ${sessionFile} (not accessible after bridging)`);
    }
  }

  const cleanup = () => {
    for (const linkPath of createdSymlinks) {
      try {
        const stat = lstatSync(linkPath);
        if (stat.isSymbolicLink()) {
          unlinkSync(linkPath);
        }
      } catch {
        // Best effort cleanup
      }
    }
  };

  return makeResult(accessible, cleanup, accessible ? [] : sandboxSessions);
}

/**
 * Seed the sandbox with a host-written session JSONL so a container agent can
 * `claude --resume <sessionId>` after a task switches from the host-process
 * runner to a container runner.
 *
 * The reverse of {@link bridgeSessionFiles}: a symlink does NOT work here. The
 * agent container is a separate mount namespace that mounts only the sandbox
 * `.claude`; a symlink in the sandbox dir pointing at host `~/.claude` would
 * dangle inside the container. So we COPY the real JSONL from
 * `~/.claude/projects/<encoded>/<sid>.jsonl` into the mounted sandbox at
 * `<worktree>/.lazy-task-sandbox/.claude/projects/<encoded>/<sid>.jsonl`.
 */
export async function seedSandboxFromHost(
  worktreePath: string,
  sessionId: string,
): Promise<{ seeded: boolean; diagnostics: string[] }> {
  const diagnostics: string[] = [];
  const encodedPath = encodeProjectPath(worktreePath);
  const hostSessionFile = join(getHome(), '.claude', 'projects', encodedPath, `${sessionId}.jsonl`);
  const sandboxProjectDir = join(worktreePath, SANDBOX_DIR, '.claude', 'projects', encodedPath);
  const sandboxSessionFile = join(sandboxProjectDir, `${sessionId}.jsonl`);

  diagnostics.push(`host session file:    ${hostSessionFile}`);
  diagnostics.push(`sandbox session file: ${sandboxSessionFile}`);

  try {
    await access(hostSessionFile);
  } catch {
    diagnostics.push('host session file: not found — nothing to seed');
    return { seeded: false, diagnostics };
  }

  // If the sandbox already has this session (e.g. shared inode via bind mount,
  // or a prior seed), don't clobber it — the in-container agent may have
  // appended turns the host copy doesn't have.
  try {
    await access(sandboxSessionFile);
    diagnostics.push('sandbox session file: already present — leaving as-is');
    return { seeded: true, diagnostics };
  } catch {
    // Not present — proceed to copy.
  }

  try {
    await mkdir(sandboxProjectDir, { recursive: true });
    await copyFile(hostSessionFile, sandboxSessionFile);
    diagnostics.push('copied host session JSONL into sandbox');
    return { seeded: true, diagnostics };
  } catch (err) {
    diagnostics.push(`failed to seed sandbox: ${err instanceof Error ? err.message : String(err)}`);
    return { seeded: false, diagnostics };
  }
}

/**
 * Bridge an agent's session JSONL across a host↔container runner boundary so
 * `claude --resume <sessionId>` finds it under the NEW runner before launch.
 * Called at a launch point when a task switches runners since the session last
 * ran. No-op when both runners are on the same side of the boundary.
 *
 *  - container → host: reuse {@link bridgeSessionFiles} (symlink sandbox→host).
 *  - host → container: {@link seedSandboxFromHost} (copy host→sandbox).
 */
export async function bridgeSessionForRunnerSwitch(
  worktreePath: string,
  sessionId: string,
  fromType: RunnerType,
  toType: RunnerType,
): Promise<{ bridged: boolean; diagnostics: string[] }> {
  const fromContainer = isContainerRunner(fromType);
  const toContainer = isContainerRunner(toType);

  if (fromContainer === toContainer) {
    // Same side of the boundary (host↔host or docker↔podman): the session file
    // is already where the new runner looks for it. No bridging needed.
    return { bridged: false, diagnostics: [`no boundary crossed (${fromType} → ${toType})`] };
  }

  if (fromContainer && !toContainer) {
    const result = bridgeSessionFiles(worktreePath, sessionId);
    return { bridged: result.accessible, diagnostics: result.diagnostics };
  }

  // host → container
  const result = await seedSandboxFromHost(worktreePath, sessionId);
  return { bridged: result.seeded, diagnostics: result.diagnostics };
}
