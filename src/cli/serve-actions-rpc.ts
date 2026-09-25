/**
 * A ServeActions implementation backed by the daemon's
 * `serve.getStartServicesCmd` / `serve.setStartServicesCmd` RPCs.
 *
 * Same reason as doctor-actions-rpc / memory-actions-rpc: the from-source web
 * UI is a client, not a second reader or writer of the project store.
 */

import type { DaemonClient } from '../daemon/client';
import type { ServeActions } from '../server/serve-actions';

export function createRpcServeActions(client: DaemonClient, projectRoot: string): ServeActions {
  return {
    async getStartServicesCmd(): Promise<string> {
      const result = (await client.rpc('serve.getStartServicesCmd', projectRoot, {})) as {
        command: string;
      };
      return result.command;
    },
    async clearStartServicesCmd(): Promise<{ command: string }> {
      return (await client.rpc('serve.clearStartServicesCmd', projectRoot, {})) as { command: string };
    },
    async setStartServicesCmd(command: string): Promise<{ command: string }> {
      return (await client.rpc('serve.setStartServicesCmd', projectRoot, { command, actor: 'human' })) as {
        command: string;
      };
    },
  };
}
