/**
 * The last failed daemon start, as `lazy daemon status` should report it.
 *
 * The startup-error marker outlives its cause: a person who fixed the problem
 * (e.g. recorded store ownership with `lazy system store-rehome`) and then
 * asked for status was shown the old refusal as if it were still true, with
 * the remedy they had just run. A cause this module can re-check is checked
 * again, and a fixed one is reported as fixed, with the next step.
 */

import { readFile } from 'fs/promises';
import { getStartupErrorPath } from './paths';
import { UnownedStoreError } from '../storage/store-owner';

export type LastStartFailure =
  | { kind: 'open'; message: string }
  | { kind: 'resolved'; message: string; resolution: string };

/** Marker text of an unowned-store refusal (UnownedStoreError's own wording). */
const UNOWNED_MARKER = 'has no recorded owning checkout';

export async function readLastStartFailure(projectRoot: string): Promise<LastStartFailure | null> {
  let message: string;
  try {
    message = (await readFile(getStartupErrorPath(projectRoot), 'utf-8')).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`could not read the last start failure at ${getStartupErrorPath(projectRoot)}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!message) return null;
  if (message.includes(UNOWNED_MARKER)) {
    const { checkProjectStoreOwnership } = await import('../storage');
    try {
      await checkProjectStoreOwnership(projectRoot);
      return {
        kind: 'resolved',
        message,
        resolution: 'The last start stopped because the store had no recorded owner. Ownership is recorded now, so that is fixed. Start the daemon: `lazy daemon start`.',
      };
    } catch (err) {
      // Still unowned (or another ownership problem): the marker stands.
      if (!(err instanceof UnownedStoreError)) return { kind: 'open', message: err instanceof Error ? err.message : String(err) };
    }
  }
  return { kind: 'open', message };
}
