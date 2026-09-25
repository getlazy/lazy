/**
 * Headless builder turn launcher for UI review sessions.
 *
 * Composes the daemon-side admission, credential, MCP, and runner launch that
 * `lazy builder` does interactively — but runs a single `claude -p` turn and
 * returns the parsed answer for Storage to record.
 */

import { randomUUID } from 'crypto';
import { join } from 'path';
import { getOrCreateStorage } from './rpc-handlers';
import { handleBuilderSlot, handleGetDaemonMcpConfig } from './rpc-handlers';
import { assembleReviewPreamble } from './review-session-preamble';
import { loadConfig } from '../config/loader';
import { createRunner } from '../runner';
import { assembleBuilderSystemPrompt } from '../builder/system-prompt';
import type { LaunchBuilderHeadlessParams } from '../runner/types';
import {
  resolveBuilderProjectsDirForLaunch,
  isTrustedResumeProjectsDir,
  type BuilderLaunchProjects,
} from '../builder/projects-isolation';
import { revokeBuilderMcpToken } from '../builder/mcp-session';
import { getLaunchAuthEnvVars } from '../capture/claude';
import { withLiveProxyTarget } from './auth-env';
import {
  credentialEnvForPlan,
  NO_OWNER_CREDENTIAL_MARKER,
  planTurnCredential,
  releaseTurnCredential,
  TurnCredentialUnavailableError,
} from './turn-credentials';
import { teamModeEnabled, getUserCredential } from './user-credentials';
import { actorEmail } from '../actor-ref';
import type { ActorInput } from '../types';
import { logger } from '../utils/logger';
import { resolveRoleTarget } from '../utils/role-target';
import {
  REVIEW_SESSION_FIRST_TURN_CLOSER,
} from '../server/review-session-actions';

export interface ReviewSessionTurnLaunchInput {
  projectRoot: string;
  taskId: string;
  reviewSessionId: string;
  prompt: string;
  resumeSessionId?: string | null;
  actor?: ActorInput;
}

export interface ReviewSessionTurnLaunchResult {
  answer: string;
  sessionId: string | null;
}

/** Injectable seam for unit tests — defaults to {@link launchReviewSessionBuilderTurn}. */
export type ReviewSessionTurnLauncher = (
  input: ReviewSessionTurnLaunchInput,
) => Promise<ReviewSessionTurnLaunchResult>;

/**
 * Refuse before launch when team mode requires the acting user's credential and
 * none is stored. Single-user installs skip this (daemon env path).
 */
export async function assertReviewSessionActorCredential(
  projectRoot: string,
  actor?: ActorInput,
): Promise<void> {
  if (!(await teamModeEnabled(projectRoot))) return;

  const ownerEmail = actorEmail(actor);
  if (!ownerEmail) {
    throw new TurnCredentialUnavailableError(
      `${NO_OWNER_CREDENTIAL_MARKER}: a review-session turn must be initiated by a signed-in user ` +
      `(actor token naming a person). Connect your Claude account and retry.`,
    );
  }
  const credential = await getUserCredential(projectRoot, ownerEmail);
  if (!credential) {
    throw new TurnCredentialUnavailableError(
      `${NO_OWNER_CREDENTIAL_MARKER}: this review-session turn was initiated by user '${ownerEmail}', ` +
      `who has no Anthropic credential stored in this daemon. Connect your Claude account and retry.`,
    );
  }
}

/** Full builder system prompt — same substitutions as `lazy builder`. */
export async function buildReviewSessionBuilderSystemPrompt(
  projectRoot: string,
): Promise<string> {
  const runner = await createRunner(projectRoot);
  const storage = await getOrCreateStorage();
  return assembleBuilderSystemPrompt({ lazyRoot: projectRoot, runner, storage });
}

/**
 * Run `fn` with the credential env the review conversation's builder must
 * carry: null when nobody is named or outside team mode (the daemon-env path),
 * otherwise a session placeholder bound to the reviewer. The binding is
 * released whatever happens.
 *
 * A key of its OWN, never the task id. The conversation runs BESIDE the task,
 * which may be running (or about to run) a real turn whose binding lives under
 * its id: binding there re-pointed that turn's placeholder at the reviewer —
 * billing them for the rest of somebody else's turn, and handing the builder
 * container the very same token — and releasing it revoked the turn's
 * credential, so the turn died with a 401 when the conversation ended. The
 * placeholder handed to the builder is the one bound under this key, because
 * it is the one this plan returns.
 */
export async function withReviewSessionCredential<T>(
  projectRoot: string,
  input: { reviewSessionId: string; ownerEmail: string | null | undefined },
  fn: (credEnv: Array<{ key: string; value: string }> | null) => Promise<T>,
): Promise<T> {
  const key = `review-session:${input.reviewSessionId}:${randomUUID()}`;
  try {
    let credEnv: Array<{ key: string; value: string }> | null = null;
    if (input.ownerEmail) {
      // The reviewer PAYS for their own conversation, and that is all this
      // launch says about them: it is a spender, not the task's turn owner,
      // which decides a NAME as well as a credential. A review session id is
      // not one of the task's sessions either, so no turn owner is recorded
      // here at all. Who the BUILDER is attributed to
      // is §3.3 case 1, a different question.
      const plan = await planTurnCredential(projectRoot, {
        taskId: key,
        sessionId: input.reviewSessionId,
        spender: { email: input.ownerEmail },
      });
      credEnv = credentialEnvForPlan(plan);
    }
    return await fn(credEnv);
  } finally {
    try {
      await releaseTurnCredential(projectRoot, key);
    } catch (err) {
      logger.warn(
        `Could not release review-session credential binding for review session ` +
        `${input.reviewSessionId.substring(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Run one headless builder turn: admit slot, bind credential, launch container,
 * parse answer, release slot and revoke MCP token.
 */
export async function launchReviewSessionBuilderTurn(
  input: ReviewSessionTurnLaunchInput,
): Promise<ReviewSessionTurnLaunchResult> {
  const { projectRoot, reviewSessionId, prompt, resumeSessionId, actor } = input;

  await assertReviewSessionActorCredential(projectRoot, actor);

  const config = await loadConfig(projectRoot);
  const dataDirAbs = join(projectRoot, config.data.path);
  const builderId = randomUUID().split('-')[0]!;
  const daemonMcpName = `builder-${builderId}`;

  const admission = await handleBuilderSlot(projectRoot, { action: 'admit', builderId });
  if (!admission.admitted) {
    throw new Error(
      `Builder concurrency limit reached (${admission.running}/${admission.limit} slots in use). ` +
      `Wait for another builder session to finish, then retry.`,
    );
  }

  const { configPath: daemonConfigPath } = await handleGetDaemonMcpConfig(projectRoot, {
    name: daemonMcpName,
  });

  const ownerEmail = actorEmail(actor);
  try {
    const builderTarget = await withLiveProxyTarget(
      resolveRoleTarget('builder', config),
      config,
    );
    // The identity's profile is what the proxy routes this session's traffic by,
    // so it is the profile the builder role actually resolved to — hard-coding
    // the built-in name would send a pinned builder to the primary upstream.
    const identity = {
      role: 'builder' as const, taskId: null, label: `review-session:${builderId}`,
      profile: builderTarget.profile,
    };
    const runner = await createRunner(projectRoot);
    const systemPrompt = await buildReviewSessionBuilderSystemPrompt(projectRoot);

    let projects: BuilderLaunchProjects | undefined;
    if (runner.usesSandbox()) {
      const hostDir = await resolveBuilderProjectsDirForLaunch({
        dataDirAbs,
        lazyRoot: projectRoot,
        resumeId: resumeSessionId ?? null,
      });
      if (hostDir) {
        projects = {
          hostDir,
          trustWritable: await isTrustedResumeProjectsDir({
            hostDir,
            lazyRoot: projectRoot,
            resumeId: resumeSessionId ?? null,
          }),
        };
      }
    }

    return await withReviewSessionCredential(projectRoot, { reviewSessionId, ownerEmail }, async (credEnv) => {
      // The plan's credential goes THROUGH getLaunchAuthEnvVars as injectedCreds,
      // never around it: the proxy address, first-party flag and audit headers
      // come only from in there, and a builder handed a lazy-sess-… placeholder
      // without them dials api.anthropic.com directly with a token only lazy's
      // proxy can resolve. The session placeholder itself passes through
      // unchanged.
      //
      // The surface follows the runner that actually launches the builder: a
      // container reaches the proxy through the Docker host alias, a host process
      // through loopback, and neither address works from the other side.
      const authEnvVars = await getLaunchAuthEnvVars(
        identity,
        builderTarget,
        { role: 'builder' },
        runner.usesSandbox() ? 'container' : 'host',
        credEnv ?? undefined,
      );

      const launchParams: LaunchBuilderHeadlessParams = {
        lazyRoot: projectRoot,
        systemPrompt,
        prompt,
        resumeSessionId,
        builderId,
        daemonConfigPath,
        projects,
        authEnvVars,
      };

      const result = await runner.launchBuilderHeadless(launchParams);
      return { answer: result.answer, sessionId: result.sessionId };
    });
  } finally {
    try {
      await handleBuilderSlot(projectRoot, { action: 'release', builderId });
    } catch (err) {
      logger.debug(
        `Builder slot release failed for ${builderId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await revokeBuilderMcpToken(daemonMcpName);
  }
}

/** Assemble the first-turn preamble text (exported for optional CLI debug seam). */
export async function assembleReviewSessionFirstMessage(
  projectRoot: string,
  taskId: string,
): Promise<string> {
  const preamble = await assembleReviewPreamble(projectRoot, taskId);
  return `${preamble}\n\n${REVIEW_SESSION_FIRST_TURN_CLOSER}`;
}
