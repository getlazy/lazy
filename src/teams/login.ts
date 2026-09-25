/**
 * The login record of a clone bound to a Teams install (design doc §4.2–4.3).
 *
 * ONE CLONE, ONE PROJECT. There is no `lazy use` and no `--local`: a clone is a
 * checkout of one repository, and a person working against two installs or two
 * projects has two clones — which they have anyway. So this module reads and
 * writes exactly one record, and treats a second one as a fault to report rather
 * than a list to choose from.
 *
 * WHERE IT LIVES. In lazy's own per-project credential store, in the scope it
 * already has: the secret goes to the keychain / libsecret / 0600 backend like
 * any other credential, and the non-secret half — which install, which project,
 * when — sits beside it in the index as a {@link CredentialBinding}. THE BINDING
 * IS THE LOGIN RECORD. Not a second file, not a second concept: a clone is bound
 * exactly when it holds a login, and `lazy logout` unbinding it is the same act
 * as deleting the credential. That split is also what lets a bare `lazy login`
 * and `lazy doctor` print where this clone points without reading a secret (and
 * so without an OS keychain unlock prompt).
 *
 * The store's rules carry over unchanged, including "disagreement is an error,
 * not a miss": an index that claims a login with no secret behind it fails
 * loudly naming both, rather than quietly behaving like an unbound clone.
 */

import type { CredentialBinding } from '../credentials/store';
import {
  deleteCredential,
  getStoredCredential,
  readCredentialIndex,
  setCredential,
} from '../credentials/store';

/**
 * Credential names for a Teams login are namespaced, so a login can never
 * collide with a model-provider credential and every login is recognizable
 * without consulting its binding.
 */
export const TEAMS_CREDENTIAL_PREFIX = 'teams:';

/** A clone's binding, and the credential name holding the token for it. */
export interface TeamsLogin {
  credentialName: string;
  binding: CredentialBinding;
}

/**
 * The install a URL names, as a credential name: `teams:teams.example.com`, or
 * `teams:localhost:3000` when a port is part of the address.
 *
 * The host and not the whole URL, because scheme and path are not identity — a
 * person who typed `https://teams.example.com/` yesterday and
 * `https://teams.example.com` today has not logged in to two places.
 */
export function teamsCredentialName(teamsUrl: string): string {
  return `${TEAMS_CREDENTIAL_PREFIX}${new URL(teamsUrl).host}`;
}

/**
 * Normalize what a human typed into a base URL.
 *
 * A bare host gets `https://` — `lazy login teams.example.com` is what people
 * type, and refusing it teaches nothing. An explicit `http://` is kept: a
 * self-hosted install on a laptop or a private network is a real case, and
 * silently upgrading it to a scheme the server does not serve would fail with a
 * connection error that names nothing.
 */
export function normalizeTeamsUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('A Teams URL is required, e.g. https://teams.example.com');

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(
      `'${input}' is not a URL. Give the address of your Teams install, ` +
      `e.g. https://teams.example.com`,
    );
  }
  if (!url.hostname) {
    throw new Error(`'${input}' names no host. Give an address like https://teams.example.com`);
  }
  return `${url.protocol}//${url.host}`;
}

/**
 * Thrown by {@link readTeamsLogin} when the index holds more than one Teams
 * login — its own class so a caller deciding "is this clone bound" can tell
 * THIS specific, Teams-shaped fault apart from an unrelated one (a corrupted
 * credential index breaks every credential it holds, not only Teams logins,
 * and answering "is this clone bound" from that read is a guess either way —
 * see `refuseIfBoundClone` and `isCloneBound` in the CLI, which treat this
 * class as "yes, ambiguously" and anything else as "cannot tell, don't act on
 * it").
 */
export class MultipleTeamsLoginsError extends Error {
  constructor(count: number, projects: string) {
    super(
      `This clone holds ${count} Teams logins, and a clone can be bound to only one ` +
      `project: ${projects}.\n` +
      `Run \`lazy logout\` to clear them, then \`lazy login <url>\` for the one you meant.`,
    );
    this.name = 'MultipleTeamsLoginsError';
  }
}

/**
 * This clone's login, or null when it is not bound.
 *
 * Reads the INDEX only — no secret, no keychain prompt. A second login record is
 * a fault rather than a choice: one clone, one project, so two of them means the
 * store was edited or restored into a state lazy cannot act on, and picking one
 * would be picking somebody's infrastructure at random.
 */
export async function readTeamsLogin(projectRoot: string): Promise<TeamsLogin | null> {
  const entries = await readCredentialIndex(projectRoot);
  const logins = entries.filter(
    (entry) => entry.provider.startsWith(TEAMS_CREDENTIAL_PREFIX) && entry.binding,
  );

  if (logins.length === 0) return null;
  if (logins.length > 1) {
    throw new MultipleTeamsLoginsError(
      logins.length,
      logins.map((e) => `${e.provider} → ${e.binding?.project}`).join(', '),
    );
  }

  const entry = logins[0];
  return { credentialName: entry.provider, binding: entry.binding! };
}

/**
 * This clone's login AND its token, for a caller that is about to make a
 * request. Throws — through the store — when the index claims a login the
 * backend cannot produce.
 */
export async function resolveTeamsLogin(
  projectRoot: string,
): Promise<{ login: TeamsLogin; token: string } | null> {
  const login = await readTeamsLogin(projectRoot);
  if (!login) return null;

  const stored = await getStoredCredential(projectRoot, login.credentialName);
  if (!stored) {
    // `getStoredCredential` throws its own loud message when the index HAS an
    // entry the backend will not serve, so reaching here means the entry
    // vanished between the two reads. Say that rather than returning a login
    // with no token in it.
    throw new Error(
      `The login for ${login.binding.teams_url} disappeared while it was being read. ` +
      `Run \`lazy login ${login.binding.teams_url}\` again.`,
    );
  }
  return { login, token: stored.value };
}

/**
 * Write the login record — the token into the backend, the binding into the
 * index — replacing whatever this clone held before.
 *
 * Replacing rather than appending is the one-clone-one-project rule enforced at
 * the write: logging in to a second install unbinds the first, which is what
 * `lazy login` says it is doing before it does it.
 */
export async function writeTeamsLogin(
  projectRoot: string,
  input: { teamsUrl: string; token: string; project: string; projectId: string },
): Promise<TeamsLogin> {
  const existing = await readTeamsLogin(projectRoot);
  const credentialName = teamsCredentialName(input.teamsUrl);
  const binding: CredentialBinding = {
    teams_url: input.teamsUrl,
    project: input.project,
    project_id: input.projectId,
    bound_at: new Date().toISOString(),
  };

  await setCredential(projectRoot, {
    provider: credentialName,
    kind: 'api-key',
    secret: input.token,
    binding,
  });

  // SAVE FIRST, ACT SECOND. The superseded login is removed only once the new
  // one is durably written: deleting first left a locked keychain or a disk
  // error with no login at all — the working binding gone and the freshly
  // minted token live and held by nobody. A brief overlap is tolerable, because
  // `readTeamsLogin` reports two records loudly rather than picking one.
  if (existing && existing.credentialName !== credentialName) {
    await deleteCredential(projectRoot, existing.credentialName);
  }

  return { credentialName, binding };
}

/**
 * Delete the login record. Returns what was removed, or null if nothing was.
 *
 * ENUMERATES rather than going through {@link readTeamsLogin}, which REFUSES a
 * store holding two logins and tells the person to run `lazy logout` — so
 * resolving through it made logout throw the error that names logout as the
 * remedy, with no lazy command able to recover the clone at all. Unbinding is
 * the one operation that never has to pick between two records: it wants them
 * all gone. The ambiguity error stays on every path that must choose one.
 *
 * The state is reachable: `writeTeamsLogin` writes before deleting (so a failure
 * cannot destroy a working login), and a delete that then fails leaves two.
 */
export async function clearTeamsLogin(
  projectRoot: string,
): Promise<(TeamsLogin & { removedCount: number }) | null> {
  const entries = await readCredentialIndex(projectRoot);
  const logins = entries.filter(
    (entry) => entry.provider.startsWith(TEAMS_CREDENTIAL_PREFIX) && entry.binding,
  );
  if (logins.length === 0) return null;

  for (const entry of logins) await deleteCredential(projectRoot, entry.provider);

  // The newest is what the person thinks they are logged in to, so it is what
  // the message names when there was more than one.
  const newest = logins.reduce((a, b) => (
    Date.parse(b.binding!.bound_at) > Date.parse(a.binding!.bound_at) ? b : a
  ));
  return {
    credentialName: newest.provider,
    binding: newest.binding!,
    removedCount: logins.length,
  };
}
