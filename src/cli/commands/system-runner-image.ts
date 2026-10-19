/**
 * `lazy system runner-image` — the project's own runner image, which the
 * daemon builds when it starts (src/daemon/runner-image.ts).
 *
 *   lazy system runner-image                  where the build is (or why it failed)
 *   lazy system runner-image <task>           also: which image that task runs on
 *   lazy system runner-image retry            build it again (after fixing the Dockerfile)
 *   lazy system runner-image rebuild          build it again even when it is up to date
 *   lazy system runner-image cancel           stop the running build
 *   lazy system runner-image log [--follow]   the build's log, step by step
 *   lazy system runner-image use-project <task>
 *                                             switch a task running on lazy's default
 *                                             image back to the project's, from its next turn
 *
 * A client only: every answer, and every rule behind it, is the daemon's.
 */
import { parseFlags } from '../helpers';
import { theme } from '../../render/theme';
import {
  queryRunnerImage, queryRetryRunnerImage, queryUseCustomRunnerImage,
  queryRebuildRunnerImage, queryCancelImageBuild, queryImageBuildLog,
  type ImageBuildLogAnswer,
} from '../../daemon/rpc-fallback';

function formatDuration(ms: number | null): string {
  if (ms === null) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** One line per step: status, label, timing. */
function printSteps(build: NonNullable<ImageBuildLogAnswer['build']>): void {
  for (const s of build.steps) {
    const mark = s.status === 'failed' ? theme.error('✗') : s.status === 'running' ? '…' : s.status === 'cancelled' ? '-' : '✓';
    const timing = s.status === 'cached' ? 'cached' : formatDuration(s.durationMs);
    console.log(`  ${mark} ${s.label}${timing ? `  (${timing})` : ''}`);
  }
}

async function printLog(follow: boolean, buildId: string | undefined): Promise<void> {
  let after = 0;
  let page = await queryImageBuildLog({ buildId, after });
  if (!page.build) {
    console.log('No image build has run since the daemon started.');
    return;
  }
  const build = page.build;
  console.log(`${build.title} — ${build.outcome}, step ${build.progress.step} of ${build.progress.total}`);
  if (page.truncatedBefore) console.log(theme.warning('(older lines were dropped from this log)'));
  for (;;) {
    for (const line of page.lines) console.log(line.source === 'lazy' ? theme.timestamp(`[lazy] ${line.text}`) : line.text);
    after = page.next;
    if (!follow || !page.build || page.build.outcome !== 'running') break;
    page = await queryImageBuildLog({ buildId: build.id, after, waitMs: 20_000 });
  }
  const last = page.build ?? build;
  console.log('');
  console.log(`Steps (${last.outcome}, ${formatDuration(last.durationMs)}):`);
  printSteps(last);
  if (last.failure) {
    console.log('');
    console.log(theme.error(`Failed${last.failure.stepLabel ? ` at ${last.failure.stepLabel}` : ''}:`));
    console.log(last.failure.output);
  }
}

export async function commandSystemRunnerImage(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'json', takesValue: false },
    { name: 'no-cache', takesValue: false },
    { name: 'follow', aliases: ['f'], takesValue: false },
    { name: 'build', takesValue: true },
  ], 'system runner-image');
  const [first, second] = parsed.positional;
  const json = parsed.flags.get('json') === true;

  try {
    if (first === 'retry') {
      const r = await queryRetryRunnerImage();
      console.log(r.description);
      return;
    }
    if (first === 'rebuild') {
      const r = await queryRebuildRunnerImage({ noCache: parsed.flags.get('no-cache') === true });
      if (json) { console.log(JSON.stringify(r, null, 2)); return; }
      console.log(r.description);
      console.log('Follow it with: lazy system runner-image log --follow');
      return;
    }
    if (first === 'cancel') {
      const r = await queryCancelImageBuild();
      if (json) { console.log(JSON.stringify(r, null, 2)); return; }
      console.log(`Cancelled build ${r.cancelled ?? ''}. The project's image is now: ${r.imageState.state}.`);
      return;
    }
    if (first === 'log') {
      const buildId = parsed.flags.get('build');
      if (json) {
        console.log(JSON.stringify(await queryImageBuildLog({ buildId: typeof buildId === 'string' ? buildId : undefined }), null, 2));
        return;
      }
      await printLog(parsed.flags.get('follow') === true, typeof buildId === 'string' ? buildId : undefined);
      return;
    }
    if (first === 'use-project') {
      if (!second) {
        console.error('Error: `lazy system runner-image use-project` needs a task.');
        process.exit(1);
      }
      const r = await queryUseCustomRunnerImage({ taskId: second });
      console.log(r.switched ? theme.success(r.message) : r.message);
      return;
    }

    const answer = await queryRunnerImage(first ? { taskId: first } : {});
    if (json) {
      console.log(JSON.stringify(answer, null, 2));
      return;
    }
    const line = answer.ready ? answer.description : theme.warning(answer.description);
    console.log(line);
    // A Rebuild replacing a ready image keeps that image in use: no fallback.
    if (!answer.ready && (answer.project.state === 'building' || answer.project.state === 'checking' || answer.project.state === 'failed')) {
      console.log(`Builders run on lazy's default image (${answer.project.defaultImage ?? 'lazy-runner'}) meanwhile; agents do once someone confirms it.`);
    }
    const build = answer.imageState?.build;
    if (build && build.outcome === 'running') {
      console.log(`Step ${build.progress.step} of ${build.progress.total}${build.progress.label ? `: ${build.progress.label}` : ''}`);
      console.log('Follow it with: lazy system runner-image log --follow');
    }
    if (answer.project.state === 'failed') {
      console.log(answer.ready
        ? 'The current image stays in use. Fix the Dockerfile, then run: lazy system runner-image rebuild'
        : 'Fix the Dockerfile, then run: lazy system runner-image retry');
    }
    const banner = answer.task?.banner;
    if (banner) {
      console.log('');
      console.log(banner.text);
      if (banner.action === 'use_custom_image') {
        console.log(`Switch it back with: lazy system runner-image use-project ${first}`);
      }
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

export function systemRunnerImageUsage(): void {
  console.log(`Usage: lazy system runner-image [<task>] [--json]
       lazy system runner-image retry
       lazy system runner-image rebuild [--no-cache] [--json]
       lazy system runner-image cancel [--json]
       lazy system runner-image log [-f, --follow] [--build <id>] [--json]
       lazy system runner-image use-project <task>

The project's own runner image ([docker] dockerfile in lazy.toml) is built by
the daemon when it starts. Everything except launching an agent keeps working
meanwhile. Builders start on lazy's default runner image and say so; agents
run on it only after you confirm (--default-image on start, unblock and resume).

Nothing switches back on its own once the project's image is ready.

  <task>        Also show which image that task runs on
  retry         Build the image again, e.g. after fixing a failed build
  rebuild       Build it again even when it is up to date; the current image
                stays in use until the new one succeeds. With no custom image,
                rebuilds lazy's default image from scratch
  --no-cache    With rebuild: refetch everything the Dockerfile pulls
  cancel        Stop the running build (an adoption's, or the project image's)
  log           The build's log with each step's timing; --follow streams it
  --build <id>  With log: a specific build (as named by --json output)
  use-project   Run the task on the project's image again from its next turn
  --json        Machine-readable output`);
}
