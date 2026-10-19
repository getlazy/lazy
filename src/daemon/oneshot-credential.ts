/**
 * Who pays for a machine one-shot the daemon runs BESIDE a task — a link
 * description, a memory compact, the fidelity summary written at accept — in
 * team mode.
 *
 * One rule for all of them: the PERSON who asked pays, with their own
 * credential for the profile the one-shot RUNS ON (the builder role's), and a
 * one-shot nobody asked for (the control plane, a merge the forge reported)
 * is paid by the project's service credential holder the same way. Lacking
 * that credential, the plan throws {@link TurnCredentialUnavailableError}
 * naming the profile and the person — never a fallback to the daemon's own
 * credentials, which on a Lazy Teams host belong to whoever set the project up.
 *
 * Outside team mode nothing changes: `fn` gets no env, and the one-shot runs on
 * the builder credential as it always has.
 *
 * The binding lives under a key of its OWN, never a task id: the task may be
 * running a real turn whose binding and recorded owner live under its id, and
 * re-pointing then revoking those would kill that turn with a 401 and bill it
 * to whoever asked for this one-shot. It is released whatever happens.
 */

import { randomUUID } from 'crypto';
import { loadConfig } from '../config/loader';
import {
  credentialEnvForPlan,
  planTurnCredential,
  releaseTurnCredential,
  sideLaunchCredentialProblem,
} from './turn-credentials';
import { teamModeEnabled } from './user-credentials';
import { revokeGrantsByBindingKey } from '../proxy/credential-broker';
import { logger } from '../utils/logger';

export type OneshotCredentialEnv = Array<{ key: string; value: string }> | undefined;

/** The profile a one-shot runs on: the builder role's (INVARIANT oneshot-runs-on-builder). */
export async function oneshotProfile(projectRoot: string): Promise<string> {
  return (await loadConfig(projectRoot)).models.roles.builder.profile;
}

/**
 * Why `email` (or, null, the service credential holder) cannot pay for a
 * one-shot here, or null when they can — the up-front check a surface makes
 * before it does anything a refusal would waste. Null outside team mode.
 */
export async function oneshotCredentialProblem(projectRoot: string, email: string | null): Promise<string | null> {
  return sideLaunchCredentialProblem(projectRoot, email, await oneshotProfile(projectRoot));
}

export async function withOneshotCredential<T>(
  projectRoot: string,
  purpose: string,
  email: string | null,
  fn: (env: OneshotCredentialEnv) => Promise<T>,
): Promise<T> {
  if (!(await teamModeEnabled(projectRoot))) return fn(undefined);
  const key = `oneshot:${purpose}:${randomUUID()}`;
  try {
    const plan = await planTurnCredential(projectRoot, {
      taskId: key,
      sessionId: key,
      // A spender, never a turn owner: a one-shot decides nobody's turn.
      ...(email ? { spender: { email } } : {}),
      spenderProfile: await oneshotProfile(projectRoot),
    });
    return await fn(credentialEnvForPlan(plan) ?? undefined);
  } finally {
    await releaseTurnCredential(projectRoot, key);
    // The launch's grants are paid through this binding and die with it. A
    // grant left behind resolves to nobody (its binding is revoked above), so
    // a failure here is logged, never allowed to replace the run's outcome.
    try {
      await revokeGrantsByBindingKey(projectRoot, key);
    } catch (err) {
      logger.warn(`Could not revoke the grants of one-shot ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
