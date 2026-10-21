/**
 * Who a write from the daemon's own dashboard names.
 *
 * The dashboard is a loopback surface the machine's owner sits in front of, so
 * its writes carry the role `human` and, where one can be named, the PERSON:
 * the daemon's git identity — the same person a laptop's CLI write names
 * (`applyCallerActor`, ./rpc-handlers.ts). Unconfigured, a write keeps the bare
 * role. In managed mode people are named by their token only, and the
 * dashboard is off there anyway.
 *
 * Resolved per write (cached 60s inside `resolveGitIdentity`), so a config
 * fixed while the daemon runs is picked up without a restart.
 */

import type { ActorInput } from '../types';
import { resolveGitIdentity } from '../identity';
import { isManagedMode } from '../config/managed';

export async function dashboardActor(projectRoot: string): Promise<ActorInput> {
  if (isManagedMode()) return 'human';
  const resolution = await resolveGitIdentity(projectRoot);
  if (!resolution.configured) return 'human';
  const { email, name } = resolution.identity;
  return { role: 'human', email, ...(name ? { name } : {}) };
}
