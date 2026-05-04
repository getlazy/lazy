/**
 * lazy watch — Real-time JSONL conversation renderer.
 *
 * Reads the agent's JSONL session log and renders the full conversation
 * (thinking blocks, tool calls, tool results, assistant responses) directly
 * in the user's terminal. No tmux involvement.
 */

import { access, readdir, stat, open } from 'fs/promises';
import { join } from 'path';
import {
  requireStorage, requireLazyRoot, displayId, parseFlags,
  resolveTaskOrExit, getWorktreePath,
} from '../helpers';
import { theme, dim } from '../theme';
import { encodeProjectPath } from '../../import/claude-code-logs';
import { renderEntry, type RawLogEntry } from '../watch-renderer';

const SANDBOX_DIR = '.lazy-task-sandbox';
const POLL_INTERVAL_MS = 500;
const STATUS_CHECK_INTERVAL_MS = 5000;

// ── Session file discovery ──────────────────────────────────────────────

async function findSessionFile(worktreePath: string): Promise<string | null> {
  const encodedPath = encodeProjectPath(worktreePath);
  const projectDir = join(worktreePath, SANDBOX_DIR, '.claude', 'projects', encodedPath);

  try {
    await access(projectDir);
  } catch {
    // Project directory doesn't exist yet — agent hasn't started writing logs
    return null;
  }

  let latestFile: string | null = null;
  let latestMtime = 0;

  try {
    const entries = await readdir(projectDir);
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const fullPath = join(projectDir, entry);
      try {
        const st = await stat(fullPath);
        if (st.mtimeMs > latestMtime) {
          latestMtime = st.mtimeMs;
          latestFile = fullPath;
        }
      } catch {
        // File may have been deleted or renamed between readdir and stat
        // (agent rotates session files). Safe to skip — next poll will pick it up.
      }
    }
  } catch {
    // Directory was removed between access() and readdir() — rare race condition
    // during agent restart. Safe to return null and retry on next poll.
  }

  return latestFile;
}

// ── Main command ────────────────────────────────────────────────────────

export async function commandWatch(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [], 'watch');

  if (parsed.positional.length === 0) {
    // No task specified — find all working tasks and let user pick
    const storage = await requireStorage();
    try {
      const tasks = await storage.listTasksWithOptions({ workingOnly: true });

      if (tasks.length === 0) {
        console.log('No tasks are currently running.');
        process.exit(0);
      }

      if (tasks.length === 1) {
        const task = tasks[0];
        await doWatch(storage, task);
        return;
      }

      // Multiple working tasks — list them
      console.log('Multiple tasks are running. Specify which one to watch:\n');
      for (const task of tasks) {
        console.log(`  lazy watch ${displayId(task)}    # ${task.goal}`);
      }
      console.log('');
      process.exit(0);
    } finally {
      await storage.close();
    }
    return;
  }

  const taskId = parsed.positional[0];
  const storage = await requireStorage();

  try {
    const task = await resolveTaskOrExit(storage, taskId);

    if (task.status !== 'working') {
      console.error(`Task ${displayId(task)} is not currently running. Status: ${task.status}`);
      process.exit(1);
    }

    await doWatch(storage, task);
  } finally {
    await storage.close();
  }
}

async function doWatch(storage: import('../../storage').Storage, task: import('../../types').Task): Promise<void> {
  const root = requireLazyRoot();
  const worktreePath = getWorktreePath(root, task);
  const display = displayId(task);

  console.log(`Watching task ${theme.taskId(display)}...\n`);

  // Wait for session file to appear
  let sessionFile = await findSessionFile(worktreePath);
  if (!sessionFile) {
    process.stdout.write(dim('Waiting for agent to start...'));
    while (!sessionFile) {
      // Check if task is still working
      const current = await storage.getTask(task.id);
      if (!current || current.status !== 'working') {
        console.log('');
        console.log(`\nTask ${theme.taskId(display)} is no longer running (status: ${current?.status ?? 'unknown'}).`);
        return;
      }

      await sleep(POLL_INTERVAL_MS);
      sessionFile = await findSessionFile(worktreePath);
    }
    // Clear the waiting message
    process.stdout.write('\r' + ' '.repeat(40) + '\r');
  }

  // Replay existing content then tail for new entries
  let lastFileSize = 0;
  let lastStatusCheck = Date.now();
  let currentSessionFile = sessionFile;
  // Buffer for incomplete lines split across reads
  let partialLine = '';

  // Handle Ctrl-C gracefully
  let running = true;
  const onSigint = () => {
    running = false;
    console.log(dim('\n\nStopped watching.'));
    process.exit(0);
  };
  process.on('SIGINT', onSigint);

  try {
    while (running) {
      // Check for new or changed session file
      const newSessionFile = await findSessionFile(worktreePath);
      if (newSessionFile && newSessionFile !== currentSessionFile) {
        currentSessionFile = newSessionFile;
        lastFileSize = 0;
        partialLine = '';
      }

      if (currentSessionFile) {
        // Check for new content by stat-ing the file
        let fileSize: number;
        try {
          const st = await stat(currentSessionFile);
          fileSize = st.size;
        } catch {
          // File may have been rotated or deleted mid-poll — retry next tick
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        if (fileSize > lastFileSize) {
          // Read only the new bytes since the last read
          const newBytes = await readTail(currentSessionFile, lastFileSize, fileSize);
          lastFileSize = fileSize;

          if (newBytes) {
            // Prepend any leftover partial line from the previous read
            const chunk = partialLine + newBytes;
            const lines = chunk.split('\n');
            // The last element may be a partial line (no trailing newline yet)
            partialLine = lines.pop() ?? '';

            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const entry = JSON.parse(line) as RawLogEntry;
                renderEntry(entry);
              } catch {
                // Malformed JSON line — agent may be mid-write. The line is lost
                // (we already advanced past it), but this is rare and non-critical.
              }
            }
          }
        }
      }

      // Periodically check if task is still working
      const now = Date.now();
      if (now - lastStatusCheck >= STATUS_CHECK_INTERVAL_MS) {
        lastStatusCheck = now;
        try {
          const current = await storage.getTask(task.id);
          if (!current || current.status !== 'working') {
            console.log(dim(`\n\nTask ${display} is no longer running (status: ${current?.status ?? 'unknown'}).`));
            return;
          }
        } catch {
          // Storage query failed (e.g. DB locked) — non-fatal, keep watching.
          // The next status check in 5s will retry.
        }
      }

      await sleep(POLL_INTERVAL_MS);
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

/**
 * Read bytes from a file between `start` and `end` offsets.
 * Returns the decoded UTF-8 string, or null if the read fails.
 */
async function readTail(filePath: string, start: number, end: number): Promise<string | null> {
  let fh;
  try {
    fh = await open(filePath, 'r');
    const buf = Buffer.alloc(end - start);
    const { bytesRead } = await fh.read(buf, 0, end - start, start);
    return buf.toString('utf-8', 0, bytesRead);
  } catch {
    // File may have been truncated or rotated between stat and read.
    // Safe to return null — next poll will detect the new file via findSessionFile.
    return null;
  } finally {
    await fh?.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function watchUsage(): void {
  console.log(`Usage: lazy watch [<task-code>]

Watch an agent working on a task in real-time.

Renders the agent's full conversation from its JSONL session log directly
in your terminal — thinking blocks, tool calls with inputs, tool results,
and assistant responses. No tmux required.

Arguments:
  <task-code>    Task to watch (code or short ID). If omitted and only one
                 task is running, watches that task automatically.

The command replays the conversation from the beginning (so you can scroll
back) then tails for new entries. Exits when the task leaves 'working'
status or you press Ctrl-C.

Examples:
  lazy watch fix-auth      # Watch a specific task
  lazy watch               # Watch the only running task
  lazy watch abc12345      # Watch by short ID`);
}
