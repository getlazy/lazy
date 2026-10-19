/**
 * `lazy login` / `lazy logout` / `lazy clone <clone-url>` — log
 * this machine in to a Lazy Teams install, and bind a clone to one project on
 * it, without anybody pasting a secret (design doc §4.2–4.4).
 *
 * TWO LEVELS, modelled on `gh auth login` + `gh auth setup-git`:
 *
 *   MACHINE. Any `lazy login <install>` stores a token for that install in a
 *   machine-level credential store and makes git to that exact origin carry it
 *   (../../teams/git-bearer.ts), so a plain `git clone https://<install>/git/…`
 *   works afterwards in any directory — behind an authenticating proxy too.
 *   Outside a repository that is all it does.
 *
 *   CLONE. Inside a clone it ALSO binds that clone to one project, as before.
 *
 * DEVICE AUTHORIZATION, not a pasted token: a pasted token lives in a shell
 * history and on a screen share. Not a local callback server either — the CLI
 * may be on a machine whose browser is somewhere else, which is the whole point
 * of a remote client. So the CLI prints a code that authorizes nothing, and the
 * human approves it in a browser that is already signed in. (Behind a proxy the
 * install asks for a browser hand-off to 127.0.0.1 instead.)
 *
 * THE PROJECT IS CHOSEN, NEVER INFERRED. The origin URL is not consulted, and
 * there is deliberately no flag to make it be: two clones of one repository can
 * belong to different Teams projects, and a command that quietly picked one
 * because a remote matched is not a command that did what it said. Interactively
 * that is a pick-list; non-interactively `--project` is REQUIRED. `lazy clone`
 * is not an exception: the person NAMES the project there.
 *
 * ONE CLONE, ONE PROJECT. No `lazy use`, no `--local`. Logging in again
 * replaces the record, and says so.
 *
 * THE ANCHOR IS THE GIT ROOT, not `resolveLazyRoot()`. A bound clone has no local
 * daemon and no local store (§4.4), so requiring `lazy init` to have run first
 * would contradict the model this command exists to set up.
 */

import { hostname } from 'os';
import { basename, resolve } from 'path';
import { realpath, stat } from 'fs/promises';
import { findGitRoot } from '../../project-paths';
import { spawnSyncInteractive } from '../../utils/spawn';
import { parseFlags } from '../helpers';
import { isTTY, promptChoice } from '../editor';
import { theme } from '../../render/theme';
import { decideBrowserOpen, openInBrowser } from '../open-url';
import {
  type MachineGitConfigured,
  configureMachineGitAuth,
  gitAuthOrigin,
  machineGitConfigured,
  removeCloneGitBearer,
  removeMachineGitAuth,
  retireMisissuedGitIncludes,
} from '../../teams/git-bearer';
import {
  deleteMachineLogin,
  listMachineLogins,
  machineLoginOnOtherScheme,
  readMachineToken,
  storedOriginToken,
  writeMachineLogin,
} from '../../teams/machine-login';
import { discoverLoginMode, loopbackLogin } from '../../teams/loopback-login';
import {
  type TeamsProject,
  TeamsRequestError,
  fetchProjects,
  pollDeviceToken,
  requestDeviceCode,
} from '../../teams/device-auth';
import {
  clearTeamsLogin,
  normalizeTeamsUrl,
  readTeamsLogin,
  writeTeamsLogin,
} from '../../teams/login';
import { assertTokenIssuedBy, assertVerificationUriOn } from '../../teams/token-origin';

/** What a login was asked to do, once the arguments have been read. */
interface LoginOptions {
  project?: string;
  deviceName?: string;
  /** Force the device-code flow even when the install asks for the loopback one. */
  device?: boolean;
}

/** What the approval page will name this machine. */
function defaultDeviceName(root: string | null): string {
  const host = hostname().split('.')[0] || 'unknown-host';
  return root ? `${host} (${basename(root)})` : host;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseUrlOrExit(urlArg: string): string {
  try {
    return normalizeTeamsUrl(urlArg);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * Stop git sending a token to an origin other than the one that issued it — the
 * plaintext leak an older `lazy clone http://…` left behind — and say so.
 * Runs at the start of login, logout and clone, before anything else.
 */
async function retireLeakingGitAuth(): Promise<void> {
  for (const origin of await retireMisissuedGitIncludes(storedOriginToken)) {
    console.log(theme.warning(
      `Git to ${origin} was sending a login issued by a different address; lazy removed that git setup.`,
    ));
    console.log(theme.separator(
      '  That token may have crossed the network unencrypted — revoke it at Account settings → Git & CLI tokens.',
    ));
  }
}

/** A bare `lazy login`: which installs is this machine logged in to, and where does this clone point? */
async function printStatus(root: string | null): Promise<void> {
  const installs = await listMachineLogins();
  if (installs.length === 0) {
    console.log('This machine is not logged in to a Lazy Teams install.');
  } else {
    console.log(`This machine is logged in to: ${installs.map((h) => theme.label(h)).join(', ')}`);
    console.log(theme.separator('  git to those installs carries the login; lazy logout <teams-url> ends it'));
  }
  if (!root) {
    if (installs.length === 0) console.log(theme.separator('  Log in with: lazy login <teams-url>'));
    return;
  }

  const login = await readTeamsLogin(root);
  if (!login) {
    console.log('This clone is not bound to a Lazy Teams project.');
    console.log(theme.separator('  Bind it with: lazy login <teams-url>'));
    return;
  }

  const { binding } = login;
  console.log(`This clone is bound to ${theme.label(binding.project)} on ${binding.teams_url}`);
  console.log(theme.separator(`  bound ${new Date(binding.bound_at).toLocaleString()}`));
  console.log(theme.separator('  lazy logout unbinds this clone'));
}

/**
 * Which project this clone is.
 *
 * `--project` matches the qualified slug (`acme/api-server`), and matching is
 * exact: a prefix match would make an ambiguous argument silently pick one.
 */
function selectByFlag(projects: TeamsProject[], wanted: string, teamsUrl: string, fresh: boolean): TeamsProject {
  const match = projects.find((p) => p.slug === wanted);
  if (match) return match;

  console.error(
    `Error: no project '${wanted}' on this install, or you are not a member of it.\n` +
    `  You can bind a clone to:\n` +
    projects.map((p) => `    ${p.slug}`).join('\n'),
  );
  if (fresh) console.error(orphanedTokenNote(teamsUrl));
  process.exit(1);
}

/**
 * What to say when the login ENDS after approval without storing the token.
 *
 * Approval mints a real CLI-scoped token on the install. Every ending past that
 * point — a project list that failed, a flag naming a project they are not in, a
 * Ctrl-C at the pick-list, a credential write that could not complete — leaves
 * that token live and held by nobody. Telling the person it exists and where to
 * retire it is the difference between a failed command and a silent orphan.
 */
function orphanedTokenNote(teamsUrl: string): string {
  return (
    `  This login had already been approved, so an API token exists on ${new URL(teamsUrl).host} ` +
    `that this machine did not keep.\n` +
    `  Revoke it at Settings → API tokens, then run \`lazy login ${teamsUrl}\` again.`
  );
}

/**
 * Get a freshly approved token: the browser hand-off behind a proxy, else the
 * device code.
 *
 * `coversGit` is whether the token can authenticate git. The browser login has
 * always minted git + command-line tokens; a code-approved token says so in its
 * `scopes`, and an install too old to send them mints command-line-only ones. Git
 * is configured only for a token that covers it: a header the install refuses
 * would count as a failed git sign-in on every fetch, and would block git from
 * falling back to a pasted Git token for that install.
 */
async function approveLogin(
  teamsUrl: string,
  deviceName: string,
  device: boolean,
): Promise<{ token: string; email: string; coversGit: boolean }> {
  // The install's configuration says which login it wants (see
  // discoverLoginMode); --device overrides it for a machine with no browser.
  const mode = device ? 'device' : await discoverLoginMode(teamsUrl);
  const approved: { token: string; email: string; scopes?: string[] } = mode === 'loopback'
    ? await runLoopbackLogin(teamsUrl, deviceName)
    : await runDeviceLogin(teamsUrl, deviceName);
  // Before the token is stored or sent anywhere: it must be from the install
  // that was typed, or a look-alike relaying a real approval collects it.
  assertTokenIssuedBy(approved.token, teamsUrl, mode === 'loopback');

  console.log('');
  console.log(theme.success(`  ✓ Approved as ${approved.email}`));
  console.log('');
  const coversGit = mode === 'loopback' || approved.scopes?.includes('git') === true;
  return { token: approved.token, email: approved.email, coversGit };
}

/**
 * Run `work` with a freshly approved token at stake: every way out that is not
 * a stored login names the token left behind — including an interrupt.
 */
async function guardFreshToken<T>(teamsUrl: string, fresh: boolean, work: () => Promise<T>): Promise<T> {
  if (!fresh) return work();
  const onInterrupt = () => {
    console.error('');
    console.error('Error: login interrupted before this machine stored anything.');
    console.error(orphanedTokenNote(teamsUrl));
    process.exit(130);
  };
  process.on('SIGINT', onInterrupt);
  try {
    return await work();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    console.error(orphanedTokenNote(teamsUrl));
    process.exit(1);
  } finally {
    process.off('SIGINT', onInterrupt);
  }
}

/**
 * Store the machine login and, when the token covers git, make git to the
 * install carry it. Says out loud which user-level git config it changed — no
 * hidden side effects.
 */
async function storeMachineLogin(
  teamsUrl: string,
  token: string,
  coversGit: boolean,
): Promise<MachineGitConfigured | null> {
  await writeMachineLogin(teamsUrl, token);
  if (!coversGit) {
    // An include an earlier login left would keep sending a token that is no
    // longer this machine's login; the git setup follows the CURRENT login.
    const removedFrom = await removeMachineGitAuth(teamsUrl);
    console.log(theme.separator(
      "  This install's login does not grant git access yet, so git was not set up.",
    ));
    if (removedFrom) {
      console.log(theme.separator(`  Removed the git include an earlier login added to ${removedFrom}.`));
    }
    console.log(theme.separator(
      "  Update the install, or use a Git token from Account settings → Git & CLI tokens as git's password.",
    ));
    return null;
  }
  const git = await configureMachineGitAuth(teamsUrl, token);
  const origin = gitAuthOrigin(teamsUrl);
  console.log(theme.success(`  Git over HTTPS to ${origin} now carries this login.`));
  console.log(theme.separator(
    git.addedInclude
      ? `  Added include.path = ${git.includeFile} to your user-level git config (${git.globalConfigFile}).`
      : `  Refreshed ${git.includeFile} (already included from ${git.globalConfigFile}).`,
  ));
  console.log(theme.separator(
    `  That file (0600) sends the token to ${origin} only, and never follows a redirect.`,
  ));
  if (git.retiredCloneHeaders > 0) {
    console.log(theme.separator(
      `  Removed ${git.retiredCloneHeaders} older per-clone git header file(s) for ${origin}, so those clones send one header.`,
    ));
  }
  return git;
}

/**
 * The machine's token for an install: the stored one when it still works, or a
 * fresh approval. `reuse` is false for an explicit `lazy login`, which always
 * approves afresh (that is how someone replaces an expired or revoked token).
 */
async function machineToken(
  teamsUrl: string,
  deviceName: string,
  device: boolean,
  reuse: boolean,
): Promise<{ token: string; fresh: boolean; coversGit: boolean; projects?: TeamsProject[] }> {
  if (reuse) {
    const stored = await readMachineToken(teamsUrl);
    if (stored) {
      try {
        const projects = await fetchProjects(teamsUrl, stored);
        console.log(theme.separator(`  Using this machine's login to ${new URL(teamsUrl).host}.`));
        // A stored login covers git exactly when its login configured git (a
        // code-approved login from before git was part of every login does not).
        const coversGit = await machineGitConfigured(teamsUrl);
        return { token: stored, fresh: false, coversGit, projects };
      } catch (err) {
        if (!(err instanceof TeamsRequestError) || (err.status !== 401 && err.status !== 403)) throw err;
        console.log(theme.warning(`This machine's login to ${new URL(teamsUrl).host} no longer works; approving a new one.`));
      }
    }
  }
  // A login on the other scheme is never reused here, and a new one is not
  // started silently either: `lazy clone http://…` after `lazy login https://…`
  // is almost always the install's own link getting the scheme wrong, and the
  // remedy is the https address, not a second token that travels in plaintext.
  // Only the downgrade is refused: typing https with an http login on file just
  // approves an https one, since nothing then travels in plaintext.
  const other = new URL(teamsUrl).protocol === 'http:' ? await machineLoginOnOtherScheme(teamsUrl) : null;
  if (other) {
    throw new TeamsRequestError(
      `This machine is logged in to ${other}, not ${new URL(teamsUrl).origin}, and a login is only ` +
      `ever sent over the scheme it was issued on.\n` +
      `  Use the https address instead, or — if this install really is served over http — ` +
      `log in there explicitly first: ` +
      `lazy login ${new URL(teamsUrl).origin}`,
    );
  }
  const approved = await approveLogin(teamsUrl, deviceName, device);
  return { token: approved.token, fresh: true, coversGit: approved.coversGit };
}

/** `lazy login <url>` outside any repository: the machine only. */
async function runMachineLogin(urlArg: string, options: LoginOptions): Promise<void> {
  const teamsUrl = parseUrlOrExit(urlArg);
  if ((await listMachineLogins()).includes(new URL(teamsUrl).origin)) {
    console.log(theme.warning(`This machine is already logged in to ${new URL(teamsUrl).origin}. Logging in replaces that.`));
  }
  const approved = await approveLogin(teamsUrl, options.deviceName ?? defaultDeviceName(null), !!options.device);
  await guardFreshToken(teamsUrl, true, () => storeMachineLogin(teamsUrl, approved.token, approved.coversGit));
  console.log('');
  console.log(`  Clone a hosted project with:  ${theme.label(`git clone ${gitAuthOrigin(teamsUrl)}/git/<team>/<project>.git`)}`);
  console.log(theme.separator(`  or clone and bind in one step:  lazy clone ${gitAuthOrigin(teamsUrl)}/git/<team>/<project>.git`));
}

/** `lazy login <url>` inside a clone: the machine, and this clone's project binding. */
async function runLogin(root: string, urlArg: string, options: LoginOptions): Promise<void> {
  const wantedProject = options.project;
  const teamsUrl = parseUrlOrExit(urlArg);

  // Refuse the guess BEFORE anything is created on the server. A login that
  // minted a token and then died on a missing flag would leave a live credential
  // nobody holds.
  if (!isTTY() && typeof wantedProject !== 'string') {
    console.error(
      'Error: `lazy login` inside a clone needs --project <team/project> when there is no terminal to ask.\n' +
      '  The project is never inferred from the git remote: two clones of one repository can\n' +
      '  belong to different projects, so lazy will not choose for you.',
    );
    process.exit(1);
  }

  const existing = await readTeamsLogin(root);
  if (existing) {
    console.log(theme.warning(
      `This clone is already bound to ${existing.binding.project} on ${existing.binding.teams_url}. ` +
      `Logging in replaces that.`,
    ));
  }

  const approved = await approveLogin(teamsUrl, options.deviceName ?? defaultDeviceName(root), !!options.device);
  await guardFreshToken(teamsUrl, true, async () => {
    const projects = await fetchProjects(teamsUrl, approved.token);
    const project = await chooseProject(projects, wantedProject, teamsUrl, true);
    await bindClone(root, teamsUrl, approved.token, project);
    await storeMachineLogin(teamsUrl, approved.token, approved.coversGit);
    printBound(teamsUrl, project.slug);
  });
}

async function chooseProject(
  projects: TeamsProject[],
  wanted: string | undefined,
  teamsUrl: string,
  fresh: boolean,
): Promise<TeamsProject> {
  if (projects.length === 0) {
    console.error(
      `Error: you are not a member of any project on ${teamsUrl}, so there is ` +
      `nothing to bind this clone to.\n` +
      `  Ask a team admin to add you, then run \`lazy login\` again.`,
    );
    if (fresh) console.error(orphanedTokenNote(teamsUrl));
    process.exit(1);
  }
  return typeof wanted === 'string'
    ? selectByFlag(projects, wanted, teamsUrl, fresh)
    : projects[await promptChoice('  Which project is this clone?', projects.map((p) => p.slug))];
}

async function bindClone(root: string, teamsUrl: string, token: string, project: TeamsProject): Promise<void> {
  await writeTeamsLogin(root, { teamsUrl, token, project: project.slug, projectId: project.id });
  // Git auth is machine-level now. A clone-local Bearer include an earlier
  // proxy login left would be sent alongside it, so it goes.
  await removeCloneGitBearer(root);
}

async function runLoopbackLogin(teamsUrl: string, deviceName: string): Promise<{ token: string; email: string }> {
  return await loopbackLogin({
    teamsUrl,
    deviceName,
    onReady: async (approvalUrl) => {
      console.log('');
      const decision = decideBrowserOpen({ platform: process.platform, isTty: isTTY(), env: process.env });
      const opened = decision.open && await openInBrowser(approvalUrl);
      console.log(opened
        ? `  Opening your browser to approve this login. If it does not open, go to:`
        : `  Open this address to approve this login (${decision.open ? 'the browser did not open' : decision.reason}):`);
      console.log(`  ${theme.label(approvalUrl)}`);
      console.log('');
      console.log(theme.separator(`  Waiting for approval as "${deviceName}" — sign in there if asked, then approve.`));
    },
  });
}

async function runDeviceLogin(teamsUrl: string, deviceName: string): Promise<{ token: string; email: string; scopes?: string[] }> {
  const grant = await requestDeviceCode(teamsUrl, deviceName);
  // A look-alike could hand out the real install's approval page and a code it
  // got there, then collect the token itself. Only ever send someone to the
  // address they typed.
  assertVerificationUriOn(grant.verificationUri, teamsUrl);
  if (grant.verificationUriComplete) assertVerificationUriOn(grant.verificationUriComplete, teamsUrl);

  console.log('');
  // The PLAIN address and the typed code are the instruction; the prefilled link
  // is offered second, which is RFC 8628 §5.3's own guidance. A completed URL is
  // the phishing shape of this flow — someone else starts a login with a
  // reassuring device name and sends you the one-click link — and a person who
  // has typed the code themselves is a person who knows which request they are
  // approving.
  console.log(`  Open ${theme.label(grant.verificationUri)} and enter:  ${theme.label(grant.userCode)}`);
  if (grant.verificationUriComplete) {
    console.log(theme.separator(`  (or, with the code already in it: ${grant.verificationUriComplete})`));
  }
  console.log('');
  console.log(theme.separator(`  Waiting for approval as "${deviceName}" — this code expires in ${Math.round(grant.expiresIn / 60)} minutes.`));

  const approved = await waitForApproval(teamsUrl, grant.deviceCode, grant.interval, grant.expiresIn);

  return approved;
}

function printBound(teamsUrl: string, slug: string): void {
  console.log('');
  console.log(theme.success(`  Bound to ${slug} on ${new URL(teamsUrl).host}.`));
  console.log(theme.separator(`  This clone now drives that project through ${teamsUrl}.`));
  console.log(theme.separator('  lazy logout unbinds it; revoking at Settings → API tokens is what ends access.'));
}

/**
 * Poll until a human answers, the code expires, or the install refuses.
 *
 * Exits the process on every ending that is not an approval, because there is
 * nothing for a caller to do with a half-finished login — and each ending has a
 * DIFFERENT remedy, which is why the server's own sentence is printed rather
 * than a generic failure.
 */
/** Never wait longer than this between polls, however often we are slowed. */
const MAX_POLL_WAIT_MS = 60_000;

/**
 * The next wait after the server said `slow_down`.
 *
 * Adopting the interval the server NAMES is not backing off: that interval is
 * the same one the client was already using, so a client told to slow down kept
 * polling at exactly the same rate. Where the limit is keyed by ADDRESS, several
 * people logging in from one office, VPN or CI egress then exhaust it together,
 * every poll is refused, nobody thins out, and each of them is eventually told
 * "nobody approved this login" — which is false and points at the wrong remedy.
 *
 * So: double, bounded, and never below what the server asked for — a server that
 * names a LARGER interval still wins, because it knows something we do not.
 */
export function backedOffWaitMs(currentWaitMs: number, serverIntervalMs: number): number {
  return Math.max(serverIntervalMs, Math.min(currentWaitMs * 2, MAX_POLL_WAIT_MS));
}

async function waitForApproval(
  teamsUrl: string,
  deviceCode: string,
  interval: number,
  expiresIn: number,
): Promise<{ token: string; email: string; scopes?: string[] }> {
  const deadline = Date.now() + expiresIn * 1000;
  let waitMs = interval * 1000;

  while (Date.now() < deadline) {
    await sleep(waitMs);
    const outcome = await pollDeviceToken(teamsUrl, deviceCode);

    if (outcome.status === 'approved') return { token: outcome.token, email: outcome.email, scopes: outcome.scopes };
    if (outcome.status === 'refused') {
      console.error(`\nError: ${outcome.reason}`);
      process.exit(1);
    }
    // The server sets the pace, and a client that ignores it gets slowed down —
    // so honour what it asked, AND actually back off on top of it.
    if (outcome.status === 'slow_down') waitMs = backedOffWaitMs(waitMs, outcome.interval * 1000);
  }

  console.error(
    `\nError: nobody approved this login before the code expired.\n` +
    `  Run \`lazy login ${teamsUrl}\` again for a fresh code.`,
  );
  process.exit(1);
}

export async function commandLogin(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'project', aliases: ['p'], takesValue: true },
    { name: 'device-name', takesValue: true },
    { name: 'device', takesValue: false },
  ], 'login');

  const project = parsed.flags.get('project');
  const deviceName = parsed.flags.get('device-name');
  const options: LoginOptions = {
    project: typeof project === 'string' ? project : undefined,
    deviceName: typeof deviceName === 'string' ? deviceName : undefined,
    device: parsed.flags.get('device') === true,
  };
  const url = parsed.positional[0];
  const root = findGitRoot();

  try {
    await retireLeakingGitAuth();
    if (!url) {
      // A bare `lazy login` REPORTS; it never starts one. Someone who typed it
      // to see where they are pointed must not find themselves mid-login.
      await printStatus(root);
      return;
    }
    if (!root) {
      if (options.project) {
        console.error(
          'Error: --project binds a CLONE, and this directory is not in a git repository.\n' +
          `  Clone and bind in one step: lazy clone ${url}/git/${options.project}.git\n` +
          `  or log this machine in only:  lazy login ${url}`,
        );
        process.exit(1);
      }
      await runMachineLogin(url, options);
      return;
    }
    await runLogin(root, url, options);
  } catch (err) {
    if (err instanceof TeamsRequestError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

/** End this machine's login to one install: the stored token and the git config entry. */
async function logoutMachine(teamsUrl: string): Promise<boolean> {
  const host = new URL(teamsUrl).origin;
  const gitConfigFile = await removeMachineGitAuth(teamsUrl);
  const removed = await deleteMachineLogin(teamsUrl);
  if (!removed && !gitConfigFile) return false;
  console.log(theme.success(`Logged this machine out of ${host}.`));
  if (gitConfigFile) {
    console.log(theme.separator(`  Removed its include.path entry from your user-level git config (${gitConfigFile}).`));
  }
  return true;
}

export async function commandLogout(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [], 'logout');
  const url = parsed.positional[0];

  try {
    await retireLeakingGitAuth();
    if (url) {
      const teamsUrl = parseUrlOrExit(url);
      if (!(await logoutMachine(teamsUrl))) {
        console.log(`This machine is not logged in to ${new URL(teamsUrl).host}.`);
        return;
      }
      printRevokeNote();
      const root = findGitRoot();
      const bound = root ? await readTeamsLogin(root) : null;
      if (bound && new URL(bound.binding.teams_url).origin === new URL(teamsUrl).origin) {
        console.log(theme.separator(`  This clone is still bound to ${bound.binding.project}; a bare \`lazy logout\` here unbinds it.`));
      }
      return;
    }

    const root = findGitRoot();
    if (!root) {
      // Outside any clone, a bare logout means the machine: every install.
      const installs = await listMachineLogins();
      if (installs.length === 0) {
        console.log('This machine is not logged in to a Lazy Teams install.');
        return;
      }
      for (const origin of installs) await logoutMachine(origin);
      printRevokeNote();
      return;
    }

    // The clone-local git auth include (if this clone had one) goes with the login, found or not.
    await removeCloneGitBearer(root);
    const removed = await clearTeamsLogin(root);
    if (!removed) {
      console.log('This clone is not logged in to a Lazy Teams install.');
      return;
    }

    console.log(theme.success(
      `This clone is unbound from ${removed.binding.project} on ${new URL(removed.binding.teams_url).host}.`,
    ));
    if (removed.removedCount > 1) {
      // A store that held more than one login is a state every other command
      // REFUSES to act on, so say plainly that this command just cleared it.
      console.log(theme.separator(
        `  This clone held ${removed.removedCount} logins; all of them were removed.`,
      ));
    }
    if ((await listMachineLogins()).includes(new URL(removed.binding.teams_url).origin)) {
      console.log(theme.separator(
        `  This machine is still logged in there (git included); \`lazy logout ${removed.binding.teams_url}\` ends that.`,
      ));
    }
    printRevokeNote();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * Deleting a record stops THIS machine using the token; it does not retire the
 * token. Say which of the two just happened.
 */
function printRevokeNote(): void {
  console.log(theme.separator(
    `  The API token still exists on that install — revoke it at Settings → API tokens ` +
    `to actually end access.`,
  ));
}

// ---------------------------------------------------------------------------
// lazy clone <clone-url> [dir]
// ---------------------------------------------------------------------------

const PROJECT_PATH = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const CLONE_FORM = `  lazy clone https://<install>/git/<team>/<project>.git [dir]`;

/** Positionals only: the value after `--device-name` (the form's one value-taking flag) is not one. */
function clonePositionals(args: string[]): string[] {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--device-name') { i++; continue; }
    if (!args[i].startsWith('-')) positional.push(args[i]);
  }
  return positional;
}

const FULL_CLONE_URL = /^(https?:\/\/[^/\s?#]+)\/git\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i;

/** Does a lone argument look like an address rather than a task id? A task id never has `:` or `/`. */
function looksLikeAddress(arg: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(arg) || /^[^/\s]*[.:][^/\s]*\//.test(arg);
}

export interface InstallCloneArgs { install: string; project: string; dir?: string }

/**
 * Split a repository `lazy clone` into install, project and directory. ONE
 * form: a full clone URL `<scheme>://<host>/git/<team>/<project>[.git] [dir]`.
 * Null means the task form (`lazy clone <task_id>`). An address-looking first
 * argument that is not a valid clone URL — including the retired
 * `<install> <team>/<project>` pair — throws a usage error naming the URL
 * form, so it can never fall through to the task form's "run lazy init" error.
 */
export function parseInstallCloneArgs(args: string[]): InstallCloneArgs | null {
  const positional = clonePositionals(args);
  if (positional.length === 0) return null;
  const [first, second] = positional;
  const full = FULL_CLONE_URL.exec(first);
  if (full) return { install: full[1], project: full[2], dir: second };
  const pair = positional.length >= 2 && /[.:]/.test(first) && PROJECT_PATH.test(second.replace(/\.git$/, ''));
  if (looksLikeAddress(first) || pair) {
    throw new Error(`'${first}' is not a clone URL for a Lazy Teams project. Use:\n${CLONE_FORM}`);
  }
  return null;
}

/** Is this `lazy clone` the repository form rather than the task form? Decided by SHAPE. */
export function isInstallCloneArgs(args: string[]): boolean {
  try {
    return parseInstallCloneArgs(args) !== null;
  } catch {
    return true; // the usage error is reported by commandInstallClone
  }
}

/** The project a clone URL names: by the address stored on it (a renamed project still matches), else by slug. */
function selectByCloneUrl(projects: TeamsProject[], slug: string, teamsUrl: string): TeamsProject {
  const path = `/git/${slug}`.toLowerCase();
  const byUrl = projects.find((p) => {
    if (!p.hostedRepoUrl) return false;
    try {
      return new URL(p.hostedRepoUrl).pathname.replace(/\.git\/?$/, '').toLowerCase() === path;
    } catch {
      return false;
    }
  });
  return byUrl ?? selectByFlag(projects, slug, teamsUrl, false);
}

/**
 * The clone URL for a project: the TYPED origin plus the path the install
 * stored for it. The stored host is never used — an install is reachable at
 * several addresses (localhost, a tailnet name, its public name) and the
 * person is logged in at the one they typed. Git therefore only ever talks to
 * the origin this machine's login configured, so an install can never steer
 * git (or the token) to another host.
 */
export function typedCloneUrl(stored: URL, teamsUrl: string): string {
  return `${gitAuthOrigin(teamsUrl)}${stored.pathname}`;
}

/**
 * Where to clone a project from. The install's answer identifies the project
 * (by the path stored on it, so a renamed project still clones); an older
 * install that does not say gets the conventional `/git/<team>/<project>.git`.
 */
function hostedCloneUrl(teamsUrl: string, project: TeamsProject): string {
  const origin = gitAuthOrigin(teamsUrl);
  if (project.hostedRepoUrl === undefined) return `${origin}/git/${project.slug}.git`;
  if (project.hostedRepoUrl === null) {
    console.error(
      `Error: ${project.slug} is not hosted on ${new URL(teamsUrl).host} — its repository lives on a forge.\n` +
      `  Clone it from there, then run \`lazy login ${teamsUrl} -p ${project.slug}\` inside the clone.`,
    );
    process.exit(1);
  }
  let named: URL;
  try {
    named = new URL(project.hostedRepoUrl);
  } catch {
    console.error(`Error: ${new URL(teamsUrl).host} named an unusable repository address for ${project.slug}.`);
    process.exit(1);
  }
  return typedCloneUrl(named, teamsUrl);
}

export async function commandInstallClone(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'device-name', takesValue: true },
    { name: 'device', takesValue: false },
  ], 'clone');
  let split: InstallCloneArgs | null;
  try {
    split = parseInstallCloneArgs(args);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (!split) {
    console.error(`Error: not a repository clone. Use:\n${CLONE_FORM}`);
    process.exit(1);
  }
  const { project: slug, dir: dirArg } = split;
  const teamsUrl = parseUrlOrExit(split.install);
  const dir = resolve(dirArg ?? slug.split('/')[1]);
  await retireLeakingGitAuth();

  // Every check that can fail runs BEFORE a login is approved, so a refusal
  // never leaves a freshly minted token behind.
  if (await stat(dir).then(() => true, () => false)) {
    console.error(`Error: ${dir} already exists. Name another directory: lazy clone ${teamsUrl}/git/${slug}.git <dir>`);
    process.exit(1);
  }

  const deviceName = typeof parsed.flags.get('device-name') === 'string'
    ? parsed.flags.get('device-name') as string
    : defaultDeviceName(null);

  try {
    const got = await machineToken(teamsUrl, deviceName, parsed.flags.get('device') === true, true);
    await guardFreshToken(teamsUrl, got.fresh, async () => {
      if (got.fresh) await storeMachineLogin(teamsUrl, got.token, got.coversGit);
      else if (got.coversGit) await configureMachineGitAuth(teamsUrl, got.token);

      const projects = got.projects ?? await fetchProjects(teamsUrl, got.token);
      // Membership is checked before cloning, so a typo fails without a clone to clean up.
      const project = selectByCloneUrl(projects, slug, teamsUrl);

      const cloneUrl = hostedCloneUrl(teamsUrl, project);
      console.log('');
      if (!got.coversGit) {
        console.log(theme.separator(`  This machine's login does not cover git; git may ask for a Git token as its password.`));
      }
      console.log(`  git clone ${cloneUrl} ${dir}`);
      const cloned = spawnSyncInteractive(['git', 'clone', cloneUrl, dir]);
      if (cloned.exitCode !== 0) {
        console.error(
          `Error: git clone failed (exit ${cloned.exitCode}). This machine stays logged in to ` +
          `${new URL(teamsUrl).host}; nothing was bound.`,
        );
        process.exit(cloned.exitCode ?? 1);
      }

      // Bound under the path git itself will report from inside the clone.
      // realpath first: the clone's own commands resolve the real path (cwd),
      // so a symlinked <dir> (macOS /tmp) must not be what gets bound.
      const realDir = await realpath(dir);
      const root = findGitRoot(realDir) ?? realDir;
      await bindClone(root, teamsUrl, got.token, project);
      printBound(teamsUrl, project.slug);
    });
  } catch (err) {
    if (err instanceof TeamsRequestError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

export function loginUsage(): void {
  console.log(`Usage: lazy login [<teams-url>] [--project <team/project>] [--device] [--device-name <name>]

Log this machine in to a Lazy Teams install. Inside a clone, also bind that
clone to one project.

After it, git over HTTPS to that install works in any directory, like GitHub
after \`gh auth login\`:

  git clone https://teams.example.com/git/acme/api-server.git

lazy adds ONE include.path entry to your user-level git config (it says which
file) pointing at a 0600 file of its own. That file sends the token to that
exact address only — never another host, never across a redirect — and no
repository's .git/config ever holds it.

Run it with no arguments to print which installs this machine is logged in to,
and where this clone points.

If the install sits behind an authenticating proxy (it says so itself), lazy opens
your browser: you pass the proxy's sign-in, approve the machine, and the browser
hands the token to a listener on 127.0.0.1 here. Otherwise lazy prints a short code
and a URL to approve in a browser that is already signed in. Nothing secret is
typed, pasted or shown.

Options:
  --project, -p <team/project>
                     Inside a clone: which project it is, e.g. acme/api-server.
                     Without it you are asked; with no terminal to ask, it is
                     REQUIRED. The git remote is never consulted.
  --device           Use the code-and-URL flow even when the install asks for the browser one.
  --device-name <name>
                     What the approval page calls this machine. The token is
                     named after it at Settings → API tokens.

One clone, one project: logging in again replaces the binding.

Tokens live in lazy's credential store: the OS keychain (or libsecret, or a 0600
file).

Examples:
  lazy login                                       # where am I logged in?
  lazy login https://teams.example.com             # this machine (outside a clone)
  lazy login teams.example.com -p acme/api-server  # inside a clone: bind it, no prompt
  lazy clone https://teams.example.com/git/acme/api-server.git  # clone and bind in one step
  lazy logout teams.example.com                    # log this machine out of an install

Human/CLI-only — an agent must never log a machine in, so there is no MCP tool.`);
}

export function logoutUsage(): void {
  console.log(`Usage: lazy logout [<teams-url>]

  lazy logout <teams-url>   Log this machine out of that install: delete its
                            token and remove the git config entry lazy login added.
  lazy logout               Inside a clone: unbind the clone from its project.
                            Outside one: log this machine out of every install.

This stops THIS machine using the token; it does not retire the token. To end
access altogether, revoke it at Settings → API tokens on the install.`);
}
