/**
 * The forge token a MANAGED (Lazy Teams) daemon pushes and opens PRs with, and
 * the one question that tells whether it works: can this repository be pushed
 * to, as that identity?
 *
 * A Teams daemon starts with the token in its environment (`GH_TOKEN` /
 * `GITLAB_TOKEN`), seeded by the fleet. Nothing reads it by name: the clone's
 * git credential helper expands the variable from the environment of every git
 * the daemon runs, and `gh` / `glab` read it the same way. So replacing the
 * token on a RUNNING daemon is exactly replacing that variable on
 * `process.env` — every child spawned afterwards inherits the new value
 * (src/utils/spawn.ts passes the live environment; Bun's own default does not).
 *
 * Rails is the source of truth and pushes the resolved token here whenever the
 * member's connection or the team's integration changes, and after every
 * start (Projects::PushForgeCredentialJob). It also rewrites the seeded secrets
 * file the fleet starts the daemon from.
 *
 * KEPT ACROSS A RESTART NOBODY TOLD TEAMS ABOUT. A daemon restarted from the
 * machine's own shell (`lazy daemon restart`) starts with the shell's
 * environment, not Teams': the last pushed token used to be lost there, and
 * with it every push (2026-10-20). So in managed mode the pushed credential is
 * also written to the daemon's private directory — `0600`, beside the member
 * credentials, never in a worktree — and re-applied at boot
 * ({@link restoreForgeCredential}); a revoke deletes it.
 *
 * TEAMS' SEEDED ENVIRONMENT IS AUTHORITATIVE over this copy. Every time Teams
 * writes the seeded secrets (a start, a token change, a revoke while this
 * daemon is down) it DELETES this file first (lazy-teams
 * FleetProjectFiles#write_secrets_env_locked), so a boot finds either nothing —
 * and runs on the freshly seeded token, or none — or a copy written by a push
 * made AFTER that seed. A withdrawn token can therefore never come back here.
 * Order inside the daemon: the file is written (or deleted) BEFORE the
 * environment changes, so a failed write refuses the push and Teams retries.
 */

import { createHash, randomUUID } from 'crypto';
import { mkdir, open, readFile, rename, unlink } from 'fs/promises';
import { dirname } from 'path';
import { spawn } from '../utils/spawn';
import { logger } from '../utils/logger';
import { isManagedMode } from '../config/managed-mode';
import { getForgeCredentialPath } from './paths';
import { classifyForgeRefusal, forgeRefusalFix, isTransportFailure, type ForgeRefusalKind } from '../remote/forge-rejection';

export type ForgeKind = 'github' | 'gitlab';

export const FORGE_TOKEN_VARS: Record<ForgeKind, string> = {
  github: 'GH_TOKEN',
  gitlab: 'GITLAB_TOKEN',
};

const FORGE_LABELS: Record<ForgeKind, string> = { github: 'GitHub', gitlab: 'GitLab' };

/**
 * A token's fingerprint: the first 8 hex of its sha256. Never the secret, and
 * enough to see at a glance whether the token a daemon HOLDS is the one a
 * connection was saved with — the mismatch that cost an afternoon on
 * 2026-10-20. Rails computes the same thing for the saved connection.
 */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 8);
}

/** Whose identity the pushed token is. Never a secret. */
export interface ForgeCredentialSummary {
  kind: ForgeKind;
  /** The verified forge handle, when the token is a member's own connection. */
  handle?: string;
  /** `user` = a member's own connection; `integration` = the team/project fallback. */
  source: 'user' | 'integration';
  updatedAt: string;
  /** {@link tokenFingerprint} of the token now held. */
  fingerprint: string;
}

interface PersistedForgeCredential {
  kind: ForgeKind;
  token: string;
  handle?: string;
  source: 'user' | 'integration';
  updatedAt: string;
}

let current: ForgeCredentialSummary | null = null;

export function isForgeKind(value: unknown): value is ForgeKind {
  return value === 'github' || value === 'gitlab';
}

function applyToEnv(kind: ForgeKind, token: string, env: NodeJS.ProcessEnv): void {
  for (const [k, name] of Object.entries(FORGE_TOKEN_VARS)) {
    if (k === kind) env[name] = token;
    else delete env[name];
  }
}

/**
 * Replace the forge token in this daemon's environment. The OTHER forge's
 * variable is cleared: a project has one remote, and a stale GitLab token left
 * beside a new GitHub one would be a second identity nobody chose.
 */
export function putForgeCredential(
  input: { kind: ForgeKind; token: string; handle?: string; source: 'user' | 'integration' },
  env: NodeJS.ProcessEnv = process.env,
): ForgeCredentialSummary {
  applyToEnv(input.kind, input.token, env);
  current = {
    kind: input.kind,
    ...(input.handle ? { handle: input.handle } : {}),
    source: input.source,
    updatedAt: new Date().toISOString(),
    fingerprint: tokenFingerprint(input.token),
  };
  return current;
}

/** Withdraw every forge token from this daemon's environment. */
export function revokeForgeCredential(env: NodeJS.ProcessEnv = process.env): { revoked: boolean } {
  let revoked = false;
  for (const name of Object.values(FORGE_TOKEN_VARS)) {
    if (env[name]) revoked = true;
    delete env[name];
  }
  current = null;
  return { revoked };
}

/** What was last pushed, or null (nothing pushed since this daemon started). */
export function currentForgeCredential(): ForgeCredentialSummary | null {
  return current;
}

/** The fingerprint of the forge token this process holds NOW, whoever put it there. */
export function heldTokenFingerprint(forge: ForgeKind | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  const token = forge ? env[FORGE_TOKEN_VARS[forge]] : undefined;
  return token ? tokenFingerprint(token) : null;
}

/** Persist the pushed credential (managed mode only), 0600 from its first byte. */
export async function persistForgeCredential(
  projectRoot: string,
  input: { kind: ForgeKind; token: string; handle?: string; source: 'user' | 'integration' },
): Promise<void> {
  if (!isManagedMode()) return;
  const path = getForgeCredentialPath(projectRoot);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const record: PersistedForgeCredential = { ...input, updatedAt: new Date().toISOString() };
  // Unique per call, not per process: two pushes can overlap in one daemon.
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(JSON.stringify(record));
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (err) {
    // A failed write must never leave a stray copy of the token beside the
    // real file: remove the half-written temp file, then refuse the push.
    await unlink(tmp).catch((unlinkErr: NodeJS.ErrnoException) => {
      if (unlinkErr.code !== 'ENOENT') {
        logger.warn(`Could not remove the temporary forge credential file ${tmp}: ${unlinkErr.message}`);
      }
    });
    throw new Error(`could not store the forge credential at ${path}: ${(err as Error).message}`);
  }
}

/** The username git sends with a forge token over https — as the fleet's clone helper sends it. */
const FORGE_CLONE_USERNAMES: Record<ForgeKind, string> = { github: 'x-access-token', gitlab: 'oauth2' };

/**
 * The credential helper that hands git this forge's token, read from the
 * ENVIRONMENT of whichever git runs it. The same helper Lazy Teams installs at
 * clone and start (lazy-teams FleetProjectFiles#clone_credential_args); only
 * the variable's NAME is ever written to `.git/config`, never the token.
 */
export function forgeCredentialHelper(kind: ForgeKind): string {
  return `!f() { echo username=${FORGE_CLONE_USERNAMES[kind]}; echo "password=$${FORGE_TOKEN_VARS[kind]}"; }; f`;
}

export type CredentialHelperOutcome =
  | { outcome: 'installed' | 'present' }
  | { outcome: 'skipped'; reason: string };

/**
 * Make sure the clone's git hands `kind`'s token to its remote, so a token
 * pushed to a RUNNING daemon works for `git push` at once.
 *
 * Teams installs the helper at clone and start, keyed on the token it SEEDED:
 * a project started with no token got none, and a later live push reached only
 * `gh`/`glab` — git still had nothing to send (turn-71 review). The daemon
 * installs it here, when it receives the token, because it is the one process
 * that sits beside the clone on every backend (on the host for local Docker,
 * inside the guest for the microVM) and is running exactly when a live push
 * arrives; the fleet's start path still installs it for a seeded token.
 *
 * Same rules as the fleet's: only for an `https://` remote (a token must not
 * cross the network in the clear — a forge token is never handed to an
 * `http://` or SSH remote); the helper list is reset first, so a helper from
 * the system or global config (a Mac's `osxkeychain`) cannot answer before it;
 * idempotent, so a clone already carrying exactly this helper is left alone.
 */
export async function ensureForgeCredentialHelper(
  root: string,
  kind: ForgeKind,
  opts: { remote: string; run?: RunCommand },
): Promise<CredentialHelperOutcome> {
  const run = opts.run ?? defaultRunCommand;
  const url = await run(['git', 'remote', 'get-url', opts.remote], root);
  if (url.exitCode !== 0) return { outcome: 'skipped', reason: `the clone has no remote '${opts.remote}'` };
  if (!/^https:\/\//i.test(url.stdout.trim())) {
    return { outcome: 'skipped', reason: `remote '${opts.remote}' is not an https:// URL, so no forge token is handed to it` };
  }
  const helper = forgeCredentialHelper(kind);
  const current = await run(['git', 'config', '--local', '--get-all', 'credential.helper'], root);
  // exit 1 = no helper configured, anything else is a real failure.
  if (current.exitCode !== 0 && current.exitCode !== 1) {
    throw new Error(`could not read the clone's credential helpers (git exited ${current.exitCode}): ${current.stderr.trim()}`);
  }
  const lines = current.exitCode === 0 ? current.stdout.replace(/\n$/, '').split('\n') : [];
  if (lines.length === 2 && lines[0] === '' && lines[1] === helper) return { outcome: 'present' };
  for (const argv of [
    ['git', 'config', '--local', '--replace-all', 'credential.helper', ''],
    ['git', 'config', '--local', '--add', 'credential.helper', helper],
  ]) {
    const r = await run(argv, root);
    if (r.exitCode !== 0) {
      throw new Error(`could not install the ${FORGE_LABELS[kind]} credential helper in the clone (git exited ${r.exitCode}): ${r.stderr.trim()}`);
    }
  }
  return { outcome: 'installed' };
}

/** Delete the persisted credential, so a revoked token cannot come back at boot. */
export async function forgetForgeCredential(projectRoot: string): Promise<void> {
  try {
    await unlink(getForgeCredentialPath(projectRoot));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * At daemon boot in managed mode: re-apply the last pushed forge credential,
 * which is newer than whatever environment this process was started with.
 * Returns what was applied. A file that will not parse is reported and ignored
 * — the daemon then runs on its start environment, and the next push from
 * Teams rewrites it.
 */
export async function restoreForgeCredential(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ForgeCredentialSummary | null> {
  if (!isManagedMode(env)) return null;
  let raw: string;
  try {
    raw = await readFile(getForgeCredentialPath(projectRoot), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`cannot read the stored forge credential at ${getForgeCredentialPath(projectRoot)}: ${(err as Error).message}`);
  }
  let record: PersistedForgeCredential;
  try {
    record = JSON.parse(raw) as PersistedForgeCredential;
  } catch (err) {
    logger.warn(`Ignoring the stored forge credential at ${getForgeCredentialPath(projectRoot)}: it does not parse (${(err as Error).message}). Teams re-sends it after this start.`);
    return null;
  }
  if (!isForgeKind(record.kind) || typeof record.token !== 'string' || !record.token) return null;
  const summary = putForgeCredential(record, env);
  current = { ...summary, updatedAt: record.updatedAt };
  return current;
}

// ── Push access ────────────────────────────────────────────────────────

export interface CommandResult { exitCode: number; stdout: string; stderr: string }
export type RunCommand = (argv: string[], cwd: string) => Promise<CommandResult>;
/** An HTTP GET: status, headers (lower-case names) and parsed JSON body (or null). */
export type FetchJson = (url: string, headers: Record<string, string>) => Promise<{ status: number; headers: Record<string, string>; body: unknown }>;

/**
 * The outcome of asking the forge whether this repository can be pushed to.
 *
 * `result` is the classification a surface turns into a remedy; `forgeMessage`
 * is what the forge itself said, verbatim (the last lines of git's stderr),
 * because "push failed" without it is the failure this exists to end.
 */
export type PushAccessResult =
  | 'ok'
  | 'no_credential'
  | 'ssh_remote'
  | 'unreachable'
  | 'no_remote'
  | 'failed'
  | ForgeRefusalKind;

export interface PushAccess {
  result: PushAccessResult;
  ok: boolean;
  remote: string;
  remoteUrl?: string;
  forge?: ForgeKind;
  /** One plain sentence: what happened. */
  summary: string;
  /** One plain sentence: what to do about it. Absent when nothing is wrong. */
  remedy?: string;
  forgeMessage?: string;
  /** GitHub's SSO authorization URL, when it gave one. */
  ssoUrl?: string;
  /** {@link tokenFingerprint} of the token this daemon holds now, or null. */
  heldFingerprint: string | null;
  checkedAt: string;
}

// Per step, and the git and API steps run in PARALLEL: the whole check fits inside
// the 8s a Lazy Teams page waits for a daemon answer (Client::WEB_TIMEOUT).
// A forge slower than this reads as unreachable, which is the honest answer.
export const PUSH_CHECK_TIMEOUT_MS = 6_000;

export const defaultRunCommand: RunCommand = async (argv, cwd) => {
  try {
    const proc = spawn(argv, {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      // Never prompt: a missing credential must fail, not hang.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: PUSH_CHECK_TIMEOUT_MS,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } catch (err) {
    return { exitCode: 127, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
  }
};

export const defaultFetchJson: FetchJson = async (url, headers) => {
  const res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(PUSH_CHECK_TIMEOUT_MS) });
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
  const body = await res.json().catch(() => null);
  return { status: res.status, headers: out, body };
};

function isSshUrl(url: string): boolean {
  return /^ssh:\/\//i.test(url) || /^[^/@\s]+@[^:/\s]+:/.test(url);
}

/** `owner/repo` of a github.com https remote, or null. */
function githubRepoOf(url: string): string | null {
  const m = /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The last meaningful lines of git's stderr, with any URL credentials masked. */
function forgeMessageOf(stderr: string): string {
  return stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^To\s/.test(l) && !/^hint:/.test(l))
    .slice(-3)
    .join(' ')
    .replace(/(https?:\/\/)[^@\s/]+@/gi, '$1***@');
}

/** Turn git's refusal into a classification. Exit codes decide success; text only names the failure. */
export function classifyPushFailure(stderr: string): PushAccessResult {
  // A recognised refusal wins: git prints `RPC failed; HTTP 403` for one.
  const refusal = classifyForgeRefusal(stderr);
  // git had no credential to offer: the same answer, and the same remedy, as
  // the check finding no token before it ever asked.
  if (refusal?.kind === 'missing_credential') return 'no_credential';
  if (refusal) return refusal.kind;
  return isTransportFailure(stderr) ? 'unreachable' : 'failed';
}

function remedyFor(result: PushAccessResult, forge: ForgeKind | undefined, refusalText = ''): string | undefined {
  const label = forge ? FORGE_LABELS[forge] : 'forge';
  switch (result) {
    case 'ok': return undefined;
    case 'no_credential':
      return `Connect your ${label} account (Account settings → Forge connections), or have a team admin set the team's ${label} integration.`;
    case 'ssh_remote':
      return `Change the project's remote to its https:// URL: the ${label} token is only used for https remotes.`;
    case 'unreachable':
      return `The repository host could not be reached from the project's machine. Try again shortly.`;
    case 'no_remote':
      return 'The project clone has no remote configured.';
    case 'failed':
      return `${label} refused the push for a reason lazy does not recognise. A project admin can see ${label}'s own message; reconnecting the account with a fresh token that can write to the repository is the usual fix.`;
    default: {
      const refusal = classifyForgeRefusal(refusalText) ?? { kind: result };
      return forgeRefusalFix(refusal.kind === result ? refusal : { kind: result }, forge);
    }
  }
}

const SUMMARIES: Partial<Record<PushAccessResult, string>> = {
  unauthorized: 'The forge refused the credential (401).',
  no_credential: 'No forge credential was offered, so the push could not authenticate.',
  forbidden: 'The forge refused the push: this identity cannot write to the repository (403).',
  sso_required: "The token is not authorized for the organization's SAML single sign-on.",
  protected_branch: 'The forge refused the push under a branch protection rule.',
  workflow_scope: 'The token lacks the scope to change workflow files.',
  not_found: 'The forge says the repository was not found for this identity.',
  unreachable: 'The repository host could not be reached.',
  failed: 'The push check failed.',
};

/**
 * GitHub's API answer for the repository, as this token: the SSO header
 * (`X-GitHub-SSO: required; url=…`) and `permissions.push`. Used to refine a
 * refusal git described vaguely, and to catch a token that can read but not
 * write. Null when it could not be asked — never a verdict of its own.
 */
async function githubApiView(repo: string, token: string, fetchJson: FetchJson):
  Promise<{ sso?: { url?: string }; push?: boolean; status: number } | null> {
  try {
    const res = await fetchJson(`https://api.github.com/repos/${repo}`, {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'lazy-push-check',
    });
    const ssoHeader = res.headers['x-github-sso'];
    const sso = ssoHeader && /required/i.test(ssoHeader)
      ? { url: /url=(\S+)/i.exec(ssoHeader)?.[1] }
      : undefined;
    const perms = (res.body as { permissions?: { push?: boolean } } | null)?.permissions;
    return { ...(sso ? { sso } : {}), ...(typeof perms?.push === 'boolean' ? { push: perms.push } : {}), status: res.status };
  } catch (err) {
    logger.debug(`push check: GitHub API not asked (${err instanceof Error ? err.message : err})`);
    return null;
  }
}

/**
 * Ask the forge — through the SAME credential helper the daemon's real pushes
 * use — whether `remote` accepts a push. `git push --dry-run` deleting a throwaway
 * ref authenticates the receive-pack handshake (which is where GitHub and
 * GitLab refuse an identity without write access) and changes nothing — and,
 * as a deletion, needs no local commit, so an empty clone can be probed too. No ref is
 * created on the remote, ever. For a github.com repository the API is asked
 * too, which names an SSO refusal and the authorization URL git cannot.
 */
export async function checkPushAccess(
  root: string,
  opts: { remote: string; forge?: ForgeKind; fallbackForge?: ForgeKind; run?: RunCommand; env?: NodeJS.ProcessEnv; fetchJson?: FetchJson },
): Promise<PushAccess> {
  const run = opts.run ?? defaultRunCommand;
  const env = opts.env ?? process.env;
  // Decided from the REMOTE once it is known (forgeForRemote), never from the
  // `[remote] driver` name: a managed `local`-driver project still pushes to
  // its origin with the token Teams seeded.
  let forge = opts.forge;
  let tokenVar = forge ? FORGE_TOKEN_VARS[forge] : undefined;
  const checkedAt = new Date().toISOString();
  let heldFingerprint = heldTokenFingerprint(forge, env);
  const done = (result: PushAccessResult, summary: string, extra: Partial<PushAccess> = {}, refusalText = ''): PushAccess => {
    const remedy = remedyFor(result, forge, refusalText);
    return { result, ok: result === 'ok', remote: opts.remote, ...(forge ? { forge } : {}), summary, ...(remedy ? { remedy } : {}), heldFingerprint, checkedAt, ...extra };
  };

  const url = await run(['git', 'remote', 'get-url', opts.remote], root);
  if (url.exitCode !== 0) return done('no_remote', `The clone has no remote '${opts.remote}'.`);
  const remoteUrl = url.stdout.trim();
  if (!forge) {
    forge = forgeForRemote(remoteUrl, env, opts.fallbackForge);
    tokenVar = forge ? FORGE_TOKEN_VARS[forge] : undefined;
    heldFingerprint = heldTokenFingerprint(forge, env);
  }

  if (isSshUrl(remoteUrl)) {
    // Summaries never carry the remote URL: every member reads them, and a URL
    // can hold credentials or name a host they need not see. Admins get
    // `remoteUrl` beside it.
    return done('ssh_remote', `The remote is an SSH address; the project's forge token cannot authenticate it.`, { remoteUrl });
  }
  const token = tokenVar ? env[tokenVar] : undefined;
  if (tokenVar && !token) {
    return done('no_credential', `No ${FORGE_LABELS[forge!]} credential is set for this project, so pushes cannot authenticate.`, { remoteUrl });
  }

  const probeRef = `refs/heads/lazy-push-check-${Date.now().toString(36)}`;
  const repo = forge === 'github' ? githubRepoOf(remoteUrl) : null;
  // In parallel, so the check stays inside one PUSH_CHECK_TIMEOUT_MS.
  const [push, api] = await Promise.all([
    run(['git', 'push', '--dry-run', '--porcelain', opts.remote, `:${probeRef}`], root),
    repo && token ? githubApiView(repo, token, opts.fetchJson ?? defaultFetchJson) : Promise.resolve(null),
  ]);

  if (api?.sso) {
    const org = repo!.split('/')[0];
    const text = `SAML SSO required for the '${org}' organization${api.sso.url ? ` ${api.sso.url}` : ''}`;
    return done('sso_required', SUMMARIES.sso_required!, {
      remoteUrl,
      ...(api.sso.url ? { ssoUrl: api.sso.url } : {}),
      forgeMessage: push.exitCode === 0 ? `GitHub API: X-GitHub-SSO: required` : forgeMessageOf(push.stderr) || 'GitHub API: X-GitHub-SSO: required',
    }, text);
  }

  if (push.exitCode === 0) {
    // git's handshake passed; the API can still say this identity may only read.
    if (api?.push === false) {
      return done('forbidden', 'This identity can read the repository but not push to it (GitHub reports no push permission).', {
        remoteUrl, forgeMessage: 'GitHub API: permissions.push = false',
      });
    }
    return done('ok', 'Push access confirmed.', { remoteUrl });
  }

  const result = classifyPushFailure(push.stderr);
  const forgeMessage = forgeMessageOf(push.stderr) || `git exited ${push.exitCode}`;
  const ssoUrl = result === 'sso_required' ? classifyForgeRefusal(push.stderr)?.ssoUrl : undefined;
  return done(result, SUMMARIES[result] ?? SUMMARIES.failed!, { remoteUrl, forgeMessage, ...(ssoUrl ? { ssoUrl } : {}) }, push.stderr);
}

/**
 * Which forge's token a remote is pushed with, decided from the REMOTE — the
 * same host rules Lazy Teams uses to choose the token (lazy-teams
 * Forge.for_repo_url): github.com and *.github.com are GitHub; gitlab.com and
 * gitlab.* are GitLab. For any other host Teams seeds the team's GitHub
 * integration as GH_TOKEN, so the token actually present decides: the last one
 * pushed, else whichever forge variable is set, else `fallback` (the configured
 * forge driver, so a forge project with no token at all still reads "no
 * credential"). Undefined when nothing decides.
 */
export function forgeForRemote(
  remoteUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  fallback?: ForgeKind,
): ForgeKind | undefined {
  const host = (/^[\w.+-]+@([^:/]+):/.exec(remoteUrl)?.[1]
    ?? hostOfUrl(remoteUrl)).toLowerCase();
  if (host === 'github.com' || host.endsWith('.github.com')) return 'github';
  if (host === 'gitlab.com' || host.startsWith('gitlab.')) return 'gitlab';
  if (current) return current.kind;
  if (env[FORGE_TOKEN_VARS.github]) return 'github';
  if (env[FORGE_TOKEN_VARS.gitlab]) return 'gitlab';
  return fallback;
}

/** The host of a URL-shaped remote; '' for one that is not a URL (a local path) — it has no host to match. */
function hostOfUrl(url: string): string {
  if (!URL.canParse(url)) return '';
  return new URL(url).hostname;
}
