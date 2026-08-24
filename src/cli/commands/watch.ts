/**
 * lazy watch — Unified task timeline.
 *
 * `lazy watch` follows the *task*, not the agent. The supervisor, the proxy
 * and the agent are all parts of the task: this command tails all three so
 * the user sees whichever side is currently driving — pre-turn merge, agent
 * thinking, API calls in flight, post-turn check, retries, etc.
 *
 * Layout per refresh:
 *   - A one-line supervisor header (phase + elapsed) re-printed every 5s.
 *   - Proxy traffic lines as requests open and settle (prefixed `net>`).
 *   - Supervisor stdout lines streamed as they arrive (dim, prefixed `sup>`).
 *   - Agent JSONL entries rendered via the existing pretty renderer.
 *
 * WHY PROXY TRAFFIC IS THE LOAD-BEARING STREAM: the other two are
 * agent-specific in practice. Only Claude writes a readable session JSONL;
 * cursor-agent's --print emits one blob at exit and its agent stream is
 * opaque connect-rpc protobuf lazy deliberately does not parse. Every agent's
 * API calls ride lazy's always-on proxy with per-task attribution, so the
 * proxy is the ONE agent-agnostic place where "the agent is doing something"
 * is observable. Passage only — never request or response content.
 *
 * The streams are printed as they arrive (no time-merge) — supervisor lines
 * stand out visually via dim() so they don't compete with the formatted agent
 * output.
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
import type { FollowHandle, Runner } from '../../runner/types';
import { protocolDir as getProtocolDir, readStatus } from '../../protocol';
import { renderStatusHeader } from '../status-header';
import { computeWorkingSubstate, formatWorkingSubstate } from '../../utils/working-substate';
import { streamProxyActivity, type ProxyStreamHandle } from '../proxy-activity-stream';
import { PROXY_LINE_PREFIX } from '../proxy-activity-renderer';

const POLL_INTERVAL_MS = 500;
const STATUS_CHECK_INTERVAL_MS = 5000;

// ── Session file discovery ──────────────────────────────────────────────

async function findSessionFile(projectDir: string): Promise<string | null> {
  const info = await findLatestSessionFile(projectDir);
  return info?.path ?? null;
}

// ── Main command ────────────────────────────────────────────────────────

export async function commandWatch(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'traffic', takesValue: false },
    { name: 'no-traffic', takesValue: false },
  ], 'watch');

  const trafficOnly = parsed.flags.get('traffic') === true;
  const showTraffic = parsed.flags.get('no-traffic') !== true;

  if (trafficOnly && !showTraffic) {
    console.error('--traffic and --no-traffic contradict each other. Pick one.');
    process.exit(1);
  }

  // Traffic only, no task stream at all. With no task named this is the
  // firehose across every task — useful when several are running and the
  // question is "is anything moving?" rather than "what is THIS task doing?".
  if (trafficOnly) {
    if (parsed.positional.length === 0) {
      await watchTrafficOnly(null, null);
      return;
    }
    const storage = await requireStorage();
    try {
      const task = await resolveTaskOrExit(storage, parsed.positional[0]);
      // Deliberately NOT gated on status === 'working': a task's last requests
      // are worth seeing right after it stops, and the replay window carries
      // them. The full watch below does gate, because it tails a live run.
      await watchTrafficOnly(task.id, displayId(task));
    } finally {
      await storage.close();
    }
    return;
  }

  if (parsed.positional.length === 0) {
    const storage = await requireStorage();
    try {
      const tasks = await storage.listTasksWithOptions({ workingOnly: true });

      if (tasks.length === 0) {
        console.log('No tasks are currently running.');
        process.exit(0);
      }

      if (tasks.length === 1) {
        await doWatch(storage, tasks[0], showTraffic);
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

    await doWatch(storage, task, showTraffic);
  } finally {
    await storage.close();
  }
}

/**
 * `lazy watch --traffic`: proxy requests only, no agent or supervisor stream.
 * Agent-agnostic by construction — this view never touches an agent's own
 * output format, so a Cursor task and a Claude task look the same here.
 */
async function watchTrafficOnly(taskId: string | null, display: string | null): Promise<void> {
  const scope = display ? `task ${theme.taskId(display)}` : 'all tasks';
  console.log(`Watching ${theme.label('proxy traffic')} for ${scope}. Ctrl-C to stop.\n`);
  console.log(dim('Every agent API request rides lazy\'s proxy; lines below are requests passing through it.\n'));

  const stream = streamProxyActivity({
    ...(taskId ? { taskId } : {}),
    // Only worth repeating the task on every line when more than one can appear.
    includeTask: taskId === null,
    write: (line) => process.stdout.write(line + '\n'),
  });

  const onSigint = () => {
    stream.stop();
    console.log(dim('\n\nStopped watching.'));
    process.exit(0);
  };
  process.on('SIGINT', onSigint);
  try {
    await stream.done;
  } finally {
    process.removeListener('SIGINT', onSigint);
    stream.stop();
  }
}

async function doWatch(
  storage: import('../../storage').Storage,
  task: import('../../types').Task,
  showTraffic: boolean,
): Promise<void> {
  const root = requireLazyRoot();
  const worktreePath = getWorktreePath(root, task);
  const display = displayId(task);
  const protoDir = getProtocolDir(task.id);

  console.log(`Watching task ${theme.taskId(display)}...\n`);

  // The universal layer. The supervisor stream and the agent's session log are
  // both agent-specific in practice (only Claude writes a readable JSONL;
  // cursor-agent emits one blob at exit), so proxy traffic is the only stream
  // that says "the agent is doing something" for EVERY agent lazy runs.
  let proxyStream: ProxyStreamHandle | null = null;
  if (showTraffic) {
    console.log(dim(`${PROXY_LINE_PREFIX} agent API requests through lazy's proxy (--no-traffic to hide)`));
    proxyStream = streamProxyActivity({
      taskId: task.id,
      // One task on screen — repeating its id on every line would be noise.
      includeTask: false,
      write: (line) => process.stdout.write(line + '\n'),
    });
  }

  // The runner is the source of truth for where the agent writes its session
  // JSONL, so we create it up front (construction is cheap and doesn't touch
  // Docker) and ask it for the project dir to tail.
  const runner = await createRunner(root);
  const projectDir = runner.agentSessionProjectDir(worktreePath);

  // Start tailing supervisor stdout via the runner. Keep the run name in scope
  // so the header can also probe run liveness for the substate.
  let followHandle: FollowHandle | null = null;
  let runName: string | null = null;
  try {
    const session = await storage.getSessionByTaskId(task.id);
    runName = session?.container_name ?? runner.runNameForTask(taskRef(task));
    followHandle = runner.followOutput(runName);
  } catch {
    // Supervisor follow unavailable (e.g. Docker daemon down) — agent stream
    // still works because it reads the JSONL directly off the filesystem.
  }

  // Print initial header (if status.json exists)
  await printHeader(protoDir, runner, runName);

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
  let sessionFile = await findSessionFile(projectDir);

  let lastFileSize = 0;
  let lastStatusCheck = Date.now();
  let lastHeaderPrint = Date.now();
  let currentSessionFile = sessionFile;
  let partialLine = '';

  let running = true;
  const stopFollowing = () => {
    try { followHandle?.process.kill(); } catch { /* best effort */ }
    proxyStream?.stop();
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
      const newSessionFile = await findSessionFile(projectDir);
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
        await printHeader(protoDir, runner, runName);
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

async function printHeader(
  protoDir: string,
  runner: Runner | null,
  runName: string | null,
): Promise<void> {
  const status = readStatus(protoDir);
  let line = renderStatusHeader(status);

  // Append the derived substate (agent / harness:<phase> / not-alive), reconciled
  // with run liveness via the shared derivation, when the runner is available.
  if (runner && runName) {
    try {
      const info = await runner.getRunInfo(runName);
      const substate = await computeWorkingSubstate(protoDir, info?.running === true);
      // Drop the retry detail from the substate suffix — the header half already
      // renders it, and repeating "attempt 7: <error>" twice on one line makes a
      // long line longer without adding anything.
      const suffix = substate && substate.kind === 'harness' && substate.retry
        ? formatWorkingSubstate({ ...substate, retry: undefined })
        : substate && formatWorkingSubstate(substate);
      if (suffix) line += `  [${suffix}]`;
    } catch {
      // Liveness probe failed (runner hiccup) — the supervisor header is still
      // useful on its own, so render it without the substate suffix.
    }
  }

  process.stdout.write(dim(line) + '\n');
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

Streams three things as they happen:
  net>   every API request the agent makes through lazy's proxy — the one
         signal that works for EVERY agent (Claude, Cursor, anything else),
         because it watches traffic rather than an agent's output format
  sup>   the supervisor's stdout (pre-turn merges, post-turn check output,
         phase transitions, retries)
  agent  the agent's own JSONL session log, rendered — where the agent
         writes one (Claude does; cursor-agent does not)

A one-line status header shows the current supervisor phase and how long it
has been running; it refreshes every 5 seconds.

Arguments:
  <task-code>    Task to watch (code or short ID). If omitted and only one
                 task is running, watches that task automatically.

Options:
  --traffic      Show ONLY proxy traffic. With no task, that is every task's
                 traffic at once (the firehose).
  --no-traffic   Hide the proxy traffic lines.

Exits when the task leaves 'working' status or you press Ctrl-C.

Examples:
  lazy watch fix-auth      # Watch a specific task
  lazy watch               # Watch the only running task
  lazy watch abc12345      # Watch by short ID
  lazy watch --traffic     # Proxy traffic across every running task
  lazy watch fix-auth --traffic   # Only fix-auth's API requests`);
}
