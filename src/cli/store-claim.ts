import { isManagedMode } from '../config/managed-mode';
import { rehomeProjectStore, unownedProjectStore } from '../daemon/store-ownership';
import { isLoggedToFile, markLoggedToFile } from '../utils/logged-error';
import { isTTY, promptYesNo } from './editor';

/** Startup only: consent must precede dispatch and any editor or feedback prompt. */
export async function withStoreClaimPrompt<T>(root: string, args: string[], start: () => Promise<T>): Promise<T> {
  // A detached child must never inherit a terminal's consent, and --yes only
  // suppresses this prompt: it cannot authorize assigning somebody's data.
  // Callers that cannot consent need no interception of startup errors.
  if (!isTTY() || isManagedMode() || process.env.LAZY_DAEMON_BACKGROUND === '1' ||
      args.includes('--yes') || args.includes('-y')) return start();

  try {
    return await start();
  } catch (err) {
    const unowned = await unownedProjectStore(root);
    if (unowned && await promptYesNo(
      `This store at ${unowned.store} has no recorded owner. Claim it for ${unowned.projectRoot}?`, false,
    )) {
      await rehomeProjectStore(root, 'unowned');
      // One retry, outside this catch: another failure cannot ask again.
      return start();
    }
    const failure = new Error(`Could not start the project daemon: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    // Startup may already have logged this failure. Preserve its marker so
    // the dispatcher does not write the same message again.
    throw isLoggedToFile(err) ? markLoggedToFile(failure) : failure;
  }
}
