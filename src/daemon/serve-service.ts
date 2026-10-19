/**
 * ServeActions over the daemon's project store — read and designate the
 * project's Start services command without the web layer touching storage or
 * lazy.toml.
 *
 * The web port is declared in src/server/serve-actions.ts; this is what the
 * daemon injects. The same functions back the `serve.setStartServicesCmd` RPC
 * (Lazy Teams' designate control) and the `startServicesCmd` field of
 * `servePorts`, so the dashboard and Teams cannot disagree.
 */

import { getOrCreateStorage } from './rpc-handlers';
import {
  clearStartServicesCmd,
  clearStopServicesCmd,
  resolveProjectStopServicesCmd,
  setStopServicesCmd,
  resolveProjectStartServicesCmd,
  setStartServicesCmd,
  StartServicesCmdError,
} from '../serve/start-cmd';
import type { ServeActions } from '../server/serve-actions';
import { RpcError } from './rpc-error';
import { requireString } from './rpc-params';

export function createServeActions(projectRoot: string): ServeActions {
  return {
    async getStartServicesCmd(): Promise<string> {
      return resolveProjectStartServicesCmd(await getOrCreateStorage(), projectRoot);
    },
    async setStartServicesCmd(command: string): Promise<{ command: string }> {
      return handleSetStartServicesCmd({ command });
    },
    async clearStartServicesCmd(): Promise<{ command: string }> {
      return handleClearStartServicesCmd();
    },
  };
}

/**
 * RPC / in-process handler. Validates at the boundary (external surface) and
 * saves the command in the project store through the one shared helper.
 */
export async function handleSetStartServicesCmd(
  params: Record<string, unknown>,
): Promise<{ command: string }> {
  // requireString rejects absent/non-string; setStartServicesCmd then applies
  // the non-empty single-line rule.
  // `actor` is accepted and ignored: this write deliberately does not restamp
  // the settings record's updatedBy (see setStartServicesCmd).
  const command = requireString(params, 'command');
  try {
    const saved = await setStartServicesCmd(await getOrCreateStorage(), command);
    return { command: saved };
  } catch (err) {
    if (err instanceof StartServicesCmdError) {
      throw new RpcError(400, err.message);
    }
    throw err;
  }
}

/**
 * RPC: the project's Start services command, `{ command, stopCommand }` ('' when
 * none). `stopCommand` rides the same answer so one read renders both.
 */
export async function handleGetStartServicesCmd(projectRoot: string): Promise<{ command: string; stopCommand: string }> {
  const storage = await getOrCreateStorage();
  const [command, stopCommand] = await Promise.all([
    resolveProjectStartServicesCmd(storage, projectRoot),
    resolveProjectStopServicesCmd(storage),
  ]);
  return { command, stopCommand };
}

/**
 * RPC: clear the project's Start services command. Answers `{ command: '' }`,
 * the same shape as a designation, so a client renders both the same way.
 */
export async function handleClearStartServicesCmd(): Promise<{ command: string }> {
  await clearStartServicesCmd(await getOrCreateStorage());
  return { command: '' };
}

/**
 * RPC: designate the project's Stop services command. Same validation and the
 * same `{ command }` answer as the Start one; a refusal is a 400.
 */
export async function handleSetStopServicesCmd(
  params: Record<string, unknown>,
): Promise<{ command: string }> {
  const command = requireString(params, 'command');
  try {
    return { command: await setStopServicesCmd(await getOrCreateStorage(), command) };
  } catch (err) {
    if (err instanceof StartServicesCmdError) throw new RpcError(400, err.message);
    throw err;
  }
}

/** RPC: clear the Stop services command. Answers `{ command: '' }`. */
export async function handleClearStopServicesCmd(): Promise<{ command: string }> {
  await clearStopServicesCmd(await getOrCreateStorage());
  return { command: '' };
}
