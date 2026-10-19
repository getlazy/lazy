/**
 * The CLI's confirmation for launching an agent while the project's own runner
 * image is not ready (the daemon builds it at boot — src/daemon/runner-image.ts).
 *
 * Asked BEFORE anything that collects input (the unblock editor) and before
 * the launch RPC, so declining loses nothing. The daemon is the authority: it
 * refuses an unconfirmed launch anyway, this only turns that refusal into a
 * question.
 *
 * `--default-image` (or `--yes`, which answers every confirmation) says yes
 * without a prompt; a non-interactive run with neither is refused, never
 * defaulted, because the default image is only allowed when someone chose it.
 */
import { isTTY, promptYesNo } from './editor';
import { theme } from '../render/theme';
import { queryRunnerImage } from '../daemon/rpc-fallback';

/**
 * Returns `true` when the launch should carry `useDefaultImage`, `false` when
 * no confirmation is needed. Exits (code 1) when the person declines or cannot
 * be asked.
 */
export async function confirmDefaultRunnerImage(taskId: string, opts: { defaultImage: boolean; yes: boolean }): Promise<boolean> {
  const answer = await askDefaultRunnerImage(taskId, opts);
  if (answer === null) process.exit(1);
  return answer;
}

/**
 * The same question without exiting: `null` when the person declined or could
 * not be asked — for callers that must stay running afterwards (the per-hunk
 * review keeps its menu and the comments already saved).
 */
export async function askDefaultRunnerImage(taskId: string, opts: { defaultImage: boolean; yes: boolean }): Promise<boolean | null> {
  const answer = await queryRunnerImage({ taskId });
  if (!answer?.task?.needsConfirmation) return false;

  console.log(theme.warning(answer.description));
  if (opts.defaultImage || opts.yes) {
    console.log(`Running on lazy's default runner image (${answer.project.defaultImage ?? 'lazy-runner'}). It stays there until you switch it back.`);
    return true;
  }
  if (!isTTY()) {
    console.error(
      'Not launched: the project\'s runner image is not ready.\n' +
      'Pass --default-image to run on lazy\'s default runner image now, or wait for the image (`lazy system runner-image` shows it).',
    );
    return null;
  }
  const ok = await promptYesNo(
    `Run it now on lazy's default runner image (${answer.project.defaultImage ?? 'lazy-runner'}) instead? No waits for the project's image`,
    false,
  );
  if (!ok) {
    console.log('Not launched. Try again once the project\'s runner image is ready.');
    return null;
  }
  return true;
}
