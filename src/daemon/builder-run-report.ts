/**
 * Everything the daemon knows about ONE builder run, in one answer — the
 * `builderRunReport` RPC behind Teams' run-report command and the support
 * bundle. An operator pasting one of these back is the whole diagnosis: no
 * log search, no shell into the machine.
 *
 * - the run row (state, builder id, the start timeline, how it last ended);
 * - the launch warmup's status;
 * - the container's state, output and supervisor log as they are NOW (the
 *   same reader the dead-builder recovery uses, so a live container reads the
 *   same way a dead one does);
 * - every daemon log line about the run: its run id, and every builder id it
 *   has been on (read off the trail's "run X is builder Y" lines), plus the
 *   launch warmup lines.
 *
 * Control-token only (refused for member tokens in handleRpc): it quotes the
 * daemon's own log. Read-only.
 */
import { open, stat } from 'fs/promises';
import { getLogPath } from './paths';
import { RpcError } from './rpc-error';
import { getOrCreateStorage } from './rpc-handlers';
import { createRunner } from '../runner';
import { launchWarmupStatus } from './launch-warmup';
import { builderSupervisorLogHostPath } from '../builder/supervisor-log-path';
import { builderSessionLaunchDir, resolveBuilderSessionHomeDir } from '../builder/claude-home';

/** How far back into each log file a report reads. */
const LOG_READ_BYTES = 4 * 1024 * 1024;
const MAX_LOG_LINES = 2000;

export async function handleBuilderRunReport(projectRoot: string, params: Record<string, unknown>) {
  if (typeof params.id !== 'string' || !params.id.trim()) throw new RpcError(400, 'id is required');
  const id = params.id.trim();
  const storage = await getOrCreateStorage();
  const run = await storage.getBuilderSession(id);
  if (!run || run.projectRoot !== projectRoot) throw new RpcError(404, `No builder run ${id} on this project`);

  const container = run.containerName ? await describeContainer(projectRoot, run) : null;
  const log = await runLogLines(projectRoot, run.id, run.builderId);
  return {
    generatedAt: new Date().toISOString(),
    run,
    warmup: launchWarmupStatus(),
    container,
    log,
  };
}

async function describeContainer(projectRoot: string, run: { containerName: string | null; builderId: string; memberEmail: string | null }) {
  try {
    const runner = await createRunner(projectRoot);
    const name = run.containerName!;
    const running = await runner.isRunning(name).catch(() => null);
    const evidence = runner.describeExitedRun
      ? await runner.describeExitedRun(name, {
          rawLines: 500,
          keepLines: 80,
          supervisorLogHostFile: builderSupervisorLogHostPath(
            builderSessionLaunchDir(resolveBuilderSessionHomeDir(projectRoot, run.memberEmail), run.builderId),
            run.builderId,
          ),
        })
      : [];
    return { name, running, evidence: evidence.join('\n') };
  } catch (err) {
    return { name: run.containerName, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The daemon log's lines about this run, oldest first. Two passes: the run id
 * finds the trail's mapping lines, which name every builder id the run has
 * been on; then any line naming the run, one of those builders or the launch
 * warmup is kept. Continuation lines (a stack trace) stay with their line.
 */
export async function runLogLines(projectRoot: string, runId: string, currentBuilderId: string): Promise<{ lines: string[]; errors: string[] }> {
  const errors: string[] = [];
  const path = getLogPath(projectRoot);
  let text = '';
  for (const file of [`${path}.1`, path]) {
    try {
      text += await readTail(file, LOG_READ_BYTES);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        errors.push(`could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { lines: filterRunLog(text, runId, currentBuilderId), errors };
}

/** The pure half of {@link runLogLines}: which entries of a daemon log are about this run. */
export function filterRunLog(text: string, runId: string, currentBuilderId: string): string[] {
  const entries: string[] = [];
  for (const raw of text.split('\n')) {
    if (/^\d{4}-\d\d-\d\dT/.test(raw) || entries.length === 0) entries.push(raw);
    else entries[entries.length - 1] += `\n${raw}`;
  }
  const builderIds = new Set([currentBuilderId]);
  const mapping = new RegExp(`run ${escape(runId)} is builder ([0-9a-f]{8})`);
  for (const e of entries) {
    const m = mapping.exec(e);
    if (m) builderIds.add(m[1]!);
  }
  const needles = [runId, ...[...builderIds].flatMap((b) => [`builder ${b}`, `lazy-builder-${b}`]), 'Launch warmup'];
  const lines = entries.filter((e) => needles.some((n) => e.includes(n)));
  return lines.slice(-MAX_LOG_LINES);
}

async function readTail(file: string, bytes: number): Promise<string> {
  const size = (await stat(file)).size;
  const length = Math.min(size, bytes);
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString('utf-8');
    // Drop a partial first line when the read started mid-file.
    return length < size ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await handle.close();
  }
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
