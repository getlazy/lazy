/**
 * Credential hydration — put the stored secret into the daemon's environment.
 *
 * THE PROBLEM THIS SOLVES. Everything downstream of the daemon reads the model
 * credential from an environment variable: `getAuthEnvVars`, the proxy's
 * upstream credential resolution, container env inheritance. That is a good
 * design — one shape, one place — but it made the credential a property of the
 * SHELL the daemon happened to be started from. `lazy upgrade` restarts the
 * daemon from whatever shell ran it, so an upgrade in a terminal without the
 * token exported aborted at the gate with "no authentication credential found
 * in the environment", having stopped nothing and rebuilt nothing. Reported
 * repeatedly, and correctly: the credential was on the machine, just not in that
 * shell.
 *
 * Hydration runs ONCE, inside `startDaemonServer`, BEFORE the gate: the stored
 * secret is copied into the daemon process's own env, and from there the rest of
 * lazy works exactly as it did. Nothing downstream had to learn about the store.
 *
 * ENV WINS. A variable that is already set is never overwritten — an operator
 * who exported a token for this one daemon gets that token, and the migration
 * promise ("existing env setups keep working unchanged") is structural rather
 * than a thing we remembered to preserve.
 *
 * ...BUT HYDRATION'S OWN COPY IS NOT AN EXPORT. Every value written here is
 * marked (see ./hydrated-env.ts) so resolution can tell a reflection of the
 * store from a user's export and keep preferring the store for the former.
 * Without that mark a daemon that started with a credential stored held it for
 * its whole life: `lazy auth set openai` wrote the new key, the startup copy
 * outranked it, and every turn went on failing on the retired one. The mark is
 * matched by VALUE, so this stays the only writer that has to know about it.
 *
 * The mark carries the INDEX ENTRY the secret came from, which is what keeps
 * "the store wins" cheap: resolution compares that entry against the index — a
 * JSON read, no backend, no unlock prompt — and only opens the backend when the
 * entry has actually changed. Hydration is still the one startup read; it is no
 * longer the last read of the daemon's life.
 *
 * THIS IS THE ONLY PLACE THAT READS THE SECRET AT STARTUP. The gate reads the
 * non-secret index (see `../daemon/credential-gate.ts`) precisely so a detached
 * daemon does not block on a keychain unlock prompt to answer a yes/no question.
 * Hydration does have to open the backend — but it happens once, in the daemon,
 * and a failure there is loud rather than a daemon that comes up unable to talk
 * to the API.
 *
 * The value is never logged. Hydration logs the provider, the backend it came
 * from and the env var it filled — enough to explain where a credential came
 * from when someone is debugging, and nothing more.
 */

import { logger } from '../utils/logger';
import { loadConfig } from '../config/loader';
import {
  type Provider,
  envVarFor,
  credentialLabel,
  credentialSelfRefreshing,
  requiredProviders,
} from './providers';
import { credentialInEnv, credentialPresence, getStoredCredential } from './store';
import { markHydratedEnvValue } from './hydrated-env';
import type { BackendId } from './backends';

/** One credential moved from the store into the environment. */
export interface HydratedCredential {
  provider: Provider;
  /** The env var that was filled. */
  envVar: string;
  /** Which backend served the secret. */
  backend: BackendId;
}

/**
 * Fill in the environment for every provider this project needs.
 *
 * Providers whose env var is already set (and non-blank) are left alone; ones
 * with no stored credential either are simply skipped — the gate that runs next
 * is what turns that into an actionable refusal. Hydration's job is to make a
 * credential available, not to decide whether one is required.
 *
 * @param projectRoot - Project root (resolves role targets and the store)
 * @param env - Environment to fill (defaults to this process's environment)
 * @returns What was hydrated, in provider order — for logging and diagnostics
 */
export async function hydrateCredentialEnv(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HydratedCredential[]> {
  const config = await loadConfig(projectRoot);
  const hydrated: HydratedCredential[] = [];

  for (const provider of requiredProviders(config)) {
    // A SELF-REFRESHING credential is never hydrated, and this is a correctness
    // rule rather than an optimisation. Renewal reads the current secret,
    // exchanges it upstream — retiring the old one there and then — and writes
    // the new one back to the STORE. A hydrated copy would put a second,
    // unwritable home for that secret into the loop: the renewing resolver
    // would be handed this copy, exchange a refresh token the store no longer
    // holds, and have nowhere to put the result. The credential then works
    // until the first renewal and is permanently dead after it, with nothing
    // saying why. The rule does not rest on which of env and store wins — it
    // held when an env value outranked the store, and holds now that hydration's
    // own copies do not. Such a resolver reads and rewrites the store directly,
    // so skipping it here costs nothing.
    if (credentialSelfRefreshing(provider)) {
      logger.debug(
        `${credentialLabel(provider)} renews itself from the store — not hydrating it into the environment.`,
      );
      continue;
    }

    // The INDEX ENTRY, read before the secret. It is what the mark below
    // carries, so that every later resolve can ask "is the store still holding
    // what I hydrated?" from this same JSON rather than from the backend.
    const entry = await credentialPresence(projectRoot, provider);
    if (!entry) continue;

    const stored = await getStoredCredential(projectRoot, provider);
    if (!stored) continue;

    const envVar = envVarFor(provider, stored.kind);
    if (!envVar) {
      // A stored kind with no env var cannot reach anything downstream. Loud,
      // because it means the store holds a credential that will never be used.
      logger.warn(
        `Stored ${credentialLabel(provider)} credential has kind "${stored.kind}", ` +
        `which has no environment variable — ignoring it. Re-store it with \`lazy auth set ${provider}\`.`,
      );
      continue;
    }

    const existing = env[envVar];
    if (existing && existing.trim().length > 0) {
      logger.debug(`${envVar} already set in the environment — not hydrating from the store.`);
      continue;
    }

    env[envVar] = stored.value;
    markHydratedEnvValue(provider, envVar, stored.value, {
      updatedAt: entry.updatedAt,
      hint: entry.hint,
      kind: entry.kind,
      backend: entry.backend,
    });
    hydrated.push({ provider, envVar, backend: stored.backend });
    logger.info(
      `Loaded ${credentialLabel(provider)} credential from the ${stored.backend} store into ${envVar}.`,
    );
  }

  return hydrated;
}

/**
 * Refuse to continue when the index promised a credential that never reached
 * the environment.
 *
 * WHY THIS EXISTS AS A SEPARATE CHECK. The gate answers "is a credential
 * available?" from the NON-SECRET INDEX (see ../daemon/credential-gate.ts) — it
 * must not open a backend, or a detached auto-start would block on a keychain
 * unlock nobody can answer. But that means the gate reads the very record whose
 * disagreement with the backend made hydration fail: index says stored, backend
 * has nothing, hydration throws, and the gate then cheerfully answers "stored"
 * and lets the daemon up with an empty environment. That daemon runs, answers
 * RPC, and 401s on every model request — the exact failure ../credentials/store.ts
 * describes itself as existing to prevent, and on a detached start the only
 * evidence is one line in a log file nobody is watching.
 *
 * So: after hydration, anything the gate would accept on the strength of the
 * STORE must actually be in the environment. If it is not, the store's promise
 * was not kept, and that is fatal rather than logged.
 *
 * This also covers the non-throwing miss: a stored credential whose kind has no
 * environment variable is skipped by hydration with a warning, yet still counts
 * as present in the index.
 *
 * @param projectRoot - Project root (resolves role targets and the store)
 * @param hydrationError - Whatever `hydrateCredentialEnv` threw, if anything —
 *   surfaced in the refusal, because it is the only thing that says WHY
 * @param env - Environment to check (defaults to this process's environment)
 */
export async function assertStoredCredentialsReachedEnv(
  projectRoot: string,
  hydrationError?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = await loadConfig(projectRoot);
  const unmet: Provider[] = [];

  for (const provider of requiredProviders(config)) {
    // A self-refreshing credential is deliberately NOT hydrated (see above), so
    // "stored but not in the environment" is its correct and expected state —
    // not a broken promise. Checking it here would refuse to start a daemon
    // whose credential is perfectly fine.
    if (credentialSelfRefreshing(provider)) continue;
    // Asked of the environment DIRECTLY, not through the precedence helpers:
    // hydration's copies deliberately do not outrank the store any more, so
    // `locateCredential` answers 'store' for a credential that hydrated
    // perfectly, and reading that as a broken promise would refuse to start
    // every daemon this check exists to protect. The question here has always
    // been the literal one — index says stored, did the secret reach the
    // environment — and now it is asked that way.
    if (!credentialInEnv(provider, env) && (await credentialPresence(projectRoot, provider))) {
      unmet.push(provider);
    }
  }

  if (unmet.length === 0) return;

  const detail = hydrationError instanceof Error
    ? hydrationError.message
    : hydrationError !== undefined
      ? String(hydrationError)
      : 'the stored credential could not be turned into an environment variable';

  const names = unmet.map((p) => credentialLabel(p)).join(', ');
  throw new Error(
    `The credential store says a ${names} credential is stored, but it could not be loaded:\n` +
    `\n${detail}\n\n` +
    `Refusing to start. A daemon without a usable credential runs, answers RPC and launches ` +
    `containers, but every model request fails with an authentication error and nothing says why.\n` +
    `  Re-store it:  lazy auth set ${unmet[0]}\n` +
    `  Or drop the stale record and use the environment instead:  lazy auth rm ${unmet[0]}`,
  );
}
