/**
 * lazy watch — Unified task timeline.
 *
 * `lazy watch` follows the *task*, not the agent. The supervisor and the
 * agent are both parts of the task: this command tails the supervisor's
 * stdout (phase transitions, merges, post-turn check output) and the agent
 * JSONL session log together so the user sees whichever side is currently
 * driving — pre-turn merge, agent thinking, post-turn check, retries, etc.
 *
 * Layout per refresh:
 *   - A one-line supervisor header (phase + elapsed) re-printed every 5s.
 *   - Supervisor stdout lines streamed as they arrive (dim, prefixed `sup>`).
 *   - Agent JSONL entries rendered via the existing pretty renderer.
 *
 * The two streams are printed as they arrive (no time-merge) — supervisor
 * lines stand out visually via dim() so they don't compete with the
 * formatted agent output.
 */

import { open, stat } from 'fs/promises';
import {
  requireStorage, requireLazyRoot, displayId, parseFlags, taskRef,
  resolveTaskOrExit, getWorktreePath,
} from '../helpers';
import { theme, dim } from '../theme';
import { findLatestSessionFile } from '../../agent/session-discovery';
import { renderEntry, type RawLogEntry } from '../watch-renderer';
import { createRunner } from '../../runner';
import type { FollowHandle } from '../../runner/types';
import { protocolDir as getProtocolDir, readStatus } from '../../protocol';
import { renderStatusHeader } from '../status-header';

const POLL_INTERVAL_MS = 500;
const STATUS_CHECK_INTERVAL_MS = 5000;

// ── Session file discovery ──────────────────────────────────────────────

async function findSessionFile(worktreePath: string): Promise<string | null> {
  const info = await findLatestSessionFile(worktreePath);
  return info?.path ?? null;
}

// ── Main command ────────────────────────────────────────────────────────

export async function commandWatch(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [], 'watch');

  if (parsed.positional.length === 0) {
    const storage = await requireStorage();
    try {
      const tasks = await storage.listTasksWithOptions({ workingOnly: true });

      if (tasks.length === 0) {
        console.log('No tasks are currently running.');
        process.exit(0);
      }

      if (tasks.length === 1) {
        await doWatch(storage, tasks[0]);
        return;
      }

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
  const protoDir = getProtocolDir(task.id);

  console.log(`Watching task ${theme.taskId(display)}...\n`);

  // Print initial header (if status.json exists)
  printHeader(protoDir);

  // Start tailing supervisor stdout via the runner
  let followHandle: FollowHandle | null = null;
  try {
    const runner = await createRunner(root);
    const session = await storage.getSessionByTaskId(task.id);
    const runName = session?.container_name ?? runner.runNameForTask(taskRef(task));
    followHandle = runner.followOutput(runName);
  } catch {
    // Runner unavailable (e.g. Docker not running) — agent stream still works.
  }

  let supervisorReaderDone = false;
  if (followHandle?.stdout) {
    const stdout = followHandle.stdout;
    void (async () => {
      const reader = stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            process.stdout.write(dim(`sup> ${line}`) + '\n');
          }
        }
        if (buffer.trim()) {
          process.stdout.write(dim(`sup> ${buffer}`) + '\n');
        }
      } catch {
        // Stream ended — normal on supervisor exit.
      } finally {
        supervisorReaderDone = true;
      }
    })();
  } else {
    supervisorReaderDone = true;
  }

  // Wait for the agent's JSONL session file to appear (best effort — task
  // may be in pre-turn phases where the agent has not started yet).
  let sessionFile = await findSessionFile(worktreePath);

  let lastFileSize = 0;
  let lastStatusCheck = Date.now();
  let lastHeaderPrint = Date.now();
  let currentSessionFile = sessionFile;
  let partialLine = '';

  let running = true;
  const stopFollowing = () => {
    try { followHandle?.process.kill(); } catch { /* best effort */ }
  };
  const onSigint = () => {
    running = false;
    stopFollowing();
    console.log(dim('\n\nStopped watching.'));
    process.exit(0);
  };
  process.on('SIGINT', onSigint);

  try {
    while (running) {
      const newSessionFile = await findSessionFile(worktreePath);
      if (newSessionFile && newSessionFile !== currentSessionFile) {
        currentSessionFile = newSessionFile;
        lastFileSize = 0;
        partialLine = '';
      }

      if (currentSessionFile) {
        let fileSize: number;
        try {
          const st = await stat(currentSessionFile);
          fileSize = st.size;
        } catch {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        if (fileSize > lastFileSize) {
          const newBytes = await readTail(currentSessionFile, lastFileSize, fileSize);
          lastFileSize = fileSize;

          if (newBytes) {
            const chunk = partialLine + newBytes;
            const lines = chunk.split('\n');
            partialLine = lines.pop() ?? '';

            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const entry = JSON.parse(line) as RawLogEntry;
                renderEntry(entry);
              } catch {
                // Malformed JSON — agent may be mid-write. Skip.
              }
            }
          }
        }
      }

      const now = Date.now();

      // Refresh header every 5s alongside the status check
      if (now - lastHeaderPrint >= STATUS_CHECK_INTERVAL_MS) {
        lastHeaderPrint = now;
        printHeader(protoDir);
      }

      if (now - lastStatusCheck >= STATUS_CHECK_INTERVAL_MS) {
        lastStatusCheck = now;
        try {
          const current = await storage.getTask(task.id);
          if (!current || current.status !== 'working') {
            stopFollowing();
            console.log(dim(`\n\nTask ${display} is no longer running (status: ${current?.status ?? 'unknown'}).`));
            return;
          }
        } catch {
          // Storage query failed — non-fatal, retry next tick.
        }
      }

      await sleep(POLL_INTERVAL_MS);
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    stopFollowing();
    // Reference to avoid unused-variable warning; reader runs detached.
    void supervisorReaderDone;
  }
}

function printHeader(protoDir: string): void {
  const status = readStatus(protoDir);
  process.stdout.write(dim(renderStatusHeader(status)) + '\n');
}

async function readTail(filePath: string, start: number, end: number): Promise<string | null> {
  let fh;
  try {
    fh = await open(filePath, 'r');
    const buf = Buffer.alloc(end - start);
    const { bytesRead } = await fh.read(buf, 0, end - start, start);
    return buf.toString('utf-8', 0, bytesRead);
  } catch {
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

Watch a task in real-time as a unified timeline.

Tails both the supervisor's stdout (pre-turn merges, post-turn check output,
phase transitions, retries) and the agent's JSONL session log, printing each
stream as lines arrive. A one-line status header above the stream shows the
current supervisor phase and how long it has been running; it refreshes
every 5 seconds.

Arguments:
  <task-code>    Task to watch (code or short ID). If omitted and only one
                 task is running, watches that task automatically.

Exits when the task leaves 'working' status or you press Ctrl-C.

Examples:
  lazy watch fix-auth      # Watch a specific task
  lazy watch               # Watch the only running task
  lazy watch abc12345      # Watch by short ID`);
}
