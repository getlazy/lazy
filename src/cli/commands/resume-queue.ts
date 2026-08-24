/**
 * `lazy daemon resume-queue`
 *
 * Read-only visibility into the slow-lane auto-resume queue
 * (src/daemon/auto-resume-queue.ts): tasks whose fast-lane circuit breaker
 * tripped (MAX_CONSECUTIVE_INTERRUPTIONS consecutive crashes) and are now
 * waiting for a round-robin retry, gated by daemon.auto_resume_interval_minutes
 * and daemon.auto_resume_gap_minutes.
 */

import { join } from 'path';
import { requireLazyRoot, requireStorage, displayId, parseFlags } from '../helpers';
import { loadConfig } from '../../config/loader';
import { theme } from '../theme';
import { describeExpiry } from '../../utils/local-day';
import { listSlowLaneQueue, getLastProjectAutoResumeAt } from '../../daemon/auto-resume-queue';

export async function commandResumeQueue(args: string[]): Promise<void> {
  parseFlags(args, [], 'daemon resume-queue');

  const root = requireLazyRoot();
  const storage = await requireStorage();
  const config = await loadConfig(root);
  const dataDir = join(root, config.data.path);
  const now = Date.now();

  console.log(theme.header('Slow-lane auto-resume queue'));

  if (!config.daemon.auto_resume) {
    console.log(`  ${theme.warning('daemon.auto_resume is false')} — auto-resume is disabled entirely.`);
    return;
  }

  const queue = await listSlowLaneQueue(storage, config, now);

  if (queue.length === 0) {
    console.log('  (empty — no tasks are waiting on the slow lane)');
    return;
  }

  const lastProjectAttempt = await getLastProjectAutoResumeAt(dataDir);
  const gapMs = config.daemon.auto_resume_gap_minutes * 60_000;
  const gapEligibleAt = lastProjectAttempt === null ? now : lastProjectAttempt + gapMs;

  console.log(`  ${queue.length} task(s) queued, retried one at a time, oldest attempt first.\n`);

  queue.forEach((entry, i) => {
    const id = displayId(entry.task);
    const attemptsLabel = `attempt ${entry.attempts + 1}/${entry.maxAttempts}`;
    const nextEligibleAt = Math.max(entry.intervalEligibleAt, i === 0 ? gapEligibleAt : 0);

    let holdReason: string;
    if (i === 0 && gapEligibleAt > entry.intervalEligibleAt && gapEligibleAt > now) {
      holdReason = `waiting on project-wide gap (auto_resume_gap_minutes=${config.daemon.auto_resume_gap_minutes})`;
    } else if (entry.intervalEligibleAt > now) {
      holdReason = `waiting on retry interval (auto_resume_interval_minutes=${config.daemon.auto_resume_interval_minutes})`;
    } else if (i === 0) {
      holdReason = 'eligible now';
    } else {
      holdReason = 'waiting for its turn (round-robin)';
    }

    const nextLabel = nextEligibleAt <= now ? 'now' : describeExpiry(new Date(nextEligibleAt));
    const lastLabel = entry.lastAttemptAt === null ? 'never' : new Date(entry.lastAttemptAt).toLocaleString();

    console.log(`  ${theme.taskId(id)}  ${theme.label(attemptsLabel)}`);
    console.log(`    Last attempt: ${lastLabel}`);
    console.log(`    Next eligible: ${nextLabel}`);
    console.log(`    ${theme.separator(holdReason)}`);
  });

  console.log(`\nA task drops out of this queue on any healthy turn, or gives up for good after ` +
    `daemon.auto_resume_max_attempts (${config.daemon.auto_resume_max_attempts}) — resume it manually then with ` +
    `${theme.command('lazy resume <task>')}.`);
}

export function resumeQueueUsage(): void {
  console.log(`Usage: lazy daemon resume-queue

Read-only: show the slow-lane auto-resume queue — tasks whose fast-lane
circuit breaker tripped (repeated crashes) and are now waiting for a
round-robin retry.

For each queued task, prints: attempts used/max, last attempt time, next
eligible time, and whether the project-wide gap or the per-task retry
interval is what's currently holding it back.

Related config (lazy.toml [daemon]):
  auto_resume                   Master switch for auto-resume (both lanes)
  auto_resume_interval_minutes  How often a given task is retried once queued
  auto_resume_gap_minutes       Minimum spacing between ANY two auto-resumes
  auto_resume_max_attempts      Slow-lane attempts before giving up for good

Examples:
  lazy daemon resume-queue      # Show the current slow-lane queue`);
}
