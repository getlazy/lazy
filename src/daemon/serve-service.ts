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

/** RPC: the project's Start services command, `{ command }` ('' when none). */
export async function handleGetStartServicesCmd(projectRoot: string): Promise<{ command: string }> {
  return { command: await resolveProjectStartServicesCmd(await getOrCreateStorage(), projectRoot) };
}

/**
 * RPC: clear the project's Start services command. Answers `{ command: '' }`,
 * the same shape as a designation, so a client renders both the same way.
 */
export async function handleClearStartServicesCmd(): Promise<{ command: string }> {
  await clearStartServicesCmd(await getOrCreateStorage());
  return { command: '' };
}
