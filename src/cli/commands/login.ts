/**
 * `lazy login` / `lazy logout` — bind this clone to one project on a Lazy Teams
 * install, without anybody pasting a secret (design doc §4.2–4.4).
 *
 * THE SHAPE, AND WHY EACH PART OF IT IS THE WAY IT IS.
 *
 * DEVICE AUTHORIZATION, not a pasted token: a pasted token lives in a shell
 * history and on a screen share. Not a local callback server either — the CLI
 * may be on a machine whose browser is somewhere else, which is the whole point
 * of a remote client. So the CLI prints a code that authorizes nothing, and the
 * human approves it in a browser that is already signed in.
 *
 * THE PROJECT IS CHOSEN, NEVER INFERRED. The origin URL is not consulted, and
 * there is deliberately no flag to make it be: two clones of one repository can
 * belong to different Teams projects, and a command that quietly picked one
 * because a remote matched is not a command that did what it said. Interactively
 * that is a pick-list; non-interactively `--project` is REQUIRED, because a
 * script that guessed would be guessing about somebody's infrastructure.
 *
 * ONE CLONE, ONE PROJECT. No `lazy use`, no `--local`. A person working against
 * two projects has two clones — which they have anyway, because a clone is a
 * checkout of one repository. Logging in again replaces the record, and says so.
 *
 * THE ANCHOR IS THE GIT ROOT, not `resolveLazyRoot()`. A bound clone has no local
 * daemon and no local store (§4.4), so requiring `lazy init` to have run first
 * would contradict the model this command exists to set up. Wherever a lazy root
 * DOES exist the two are the same directory — `findLazyRoot` returns the git root
 * — so this is one rule rather than a second one that can disagree.
 */

import { hostname } from 'os';
import { basename } from 'path';
import { findGitRoot } from '../../project-paths';
import { parseFlags } from '../helpers';
import { isTTY, promptChoice } from '../editor';
import { theme } from '../../render/theme';
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

/** What a login was asked to do, once the arguments have been read. */
interface LoginOptions {
  project?: string;
  deviceName?: string;
}

/**
 * Where the login record goes.
 *
 * Git root rather than lazy root — see the module header. The failure is its own
 * message because "not in a lazy project, run `lazy init`" would be exactly the
 * wrong instruction here: a bound clone never runs `lazy init`.
 */
function requireCloneRoot(): string {
  const root = findGitRoot();
  if (!root) {
    console.error(
      'Error: `lazy login` binds a CLONE to a project, and this directory is not in a git ' +
      'repository.\n' +
      '  Clone the project first, then run `lazy login <teams-url>` inside it.',
    );
    process.exit(1);
  }
  return root;
}

/** What the approval page will name this machine. */
function defaultDeviceName(root: string): string {
  const host = hostname().split('.')[0] || 'unknown-host';
  return `${host} (${basename(root)})`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A bare `lazy login`: where does this clone point? */
async function printBinding(root: string): Promise<void> {
  const login = await readTeamsLogin(root);
  if (!login) {
    console.log('This clone is not logged in to a Lazy Teams install.');
    console.log(theme.separator('  Bind it with: lazy login <teams-url>'));
    return;
  }

  const { binding } = login;
  console.log(`Bound to ${theme.label(binding.project)} on ${binding.teams_url}`);
  console.log(theme.separator(`  bound ${new Date(binding.bound_at).toLocaleString()}`));
  console.log(theme.separator('  lazy logout unbinds this clone'));
}

/**
 * Which project this clone is.
 *
 * `--project` matches the qualified slug (`acme/api-server`), and matching is
 * exact: a prefix match would make an ambiguous argument silently pick one.
 */
function selectByFlag(projects: TeamsProject[], wanted: string, teamsUrl: string): TeamsProject {
  const match = projects.find((p) => p.slug === wanted);
  if (match) return match;

  console.error(
    `Error: no project '${wanted}' on this install, or you are not a member of it.\n` +
    `  You can bind this clone to:\n` +
    projects.map((p) => `    ${p.slug}`).join('\n'),
  );
  console.error(orphanedTokenNote(teamsUrl));
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
    `that this clone did not keep.\n` +
    `  Revoke it at Settings → API tokens, then run \`lazy login ${teamsUrl}\` again.`
  );
}

async function runLogin(root: string, urlArg: string, options: LoginOptions): Promise<void> {
  const wantedProject = options.project;

  let teamsUrl: string;
  try {
    teamsUrl = normalizeTeamsUrl(urlArg);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Refuse the guess BEFORE anything is created on the server. A login that
  // minted a token and then died on a missing flag would leave a live credential
  // nobody holds.
  const interactive = isTTY();
  if (!interactive && typeof wantedProject !== 'string') {
    console.error(
      'Error: `lazy login` needs --project <team/project> when there is no terminal to ask.\n' +
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

  const deviceName = options.deviceName ?? defaultDeviceName(root);
  const grant = await requestDeviceCode(teamsUrl, deviceName);

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

  console.log('');
  console.log(theme.success(`  ✓ Approved as ${approved.email}`));
  console.log('');

  // From here on a real token exists on the install. Every way out that is not a
  // stored login says so — including the one nobody types a command for, an
  // interrupt at the pick-list.
  const onInterrupt = () => {
    console.error('');
    console.error('Error: login interrupted before this clone stored anything.');
    console.error(orphanedTokenNote(teamsUrl));
    process.exit(130);
  };
  process.on('SIGINT', onInterrupt);

  try {
    const projects = await fetchProjects(teamsUrl, approved.token);
    if (projects.length === 0) {
      console.error(
        `Error: ${approved.email} is not a member of any project on ${teamsUrl}, so there is ` +
        `nothing to bind this clone to.\n` +
        `  Ask a team admin to add you, then run \`lazy login\` again.`,
      );
      console.error(orphanedTokenNote(teamsUrl));
      process.exit(1);
    }

    const project = typeof wantedProject === 'string'
      ? selectByFlag(projects, wantedProject, teamsUrl)
      : projects[await promptChoice('  Which project is this clone?', projects.map((p) => p.slug))];

    await writeTeamsLogin(root, {
      teamsUrl,
      token: approved.token,
      project: project.slug,
      projectId: project.id,
    });

    printBound(teamsUrl, project.slug);
  } catch (err) {
    // A failure anywhere past approval — the project list, the keychain, the
    // index write — ends with a token nobody holds. Name it, then let the error
    // surface as it would have.
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    console.error(orphanedTokenNote(teamsUrl));
    process.exit(1);
  } finally {
    process.off('SIGINT', onInterrupt);
  }
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
): Promise<{ token: string; email: string }> {
  const deadline = Date.now() + expiresIn * 1000;
  let waitMs = interval * 1000;

  while (Date.now() < deadline) {
    await sleep(waitMs);
    const outcome = await pollDeviceToken(teamsUrl, deviceCode);

    if (outcome.status === 'approved') return { token: outcome.token, email: outcome.email };
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
  const root = requireCloneRoot();
  const parsed = parseFlags(args, [
    { name: 'project', aliases: ['p'], takesValue: true },
    { name: 'device-name', takesValue: true },
  ], 'login');

  const project = parsed.flags.get('project');
  const deviceName = parsed.flags.get('device-name');
  const options: LoginOptions = {
    project: typeof project === 'string' ? project : undefined,
    deviceName: typeof deviceName === 'string' ? deviceName : undefined,
  };
  const url = parsed.positional[0];

  try {
    if (!url) {
      // A bare `lazy login` REPORTS; it never starts one. Someone who typed it
      // to see where they are pointed must not find themselves mid-login.
      await printBinding(root);
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

export async function commandLogout(args: string[]): Promise<void> {
  parseFlags(args, [], 'logout');
  const root = requireCloneRoot();

  const removed = await clearTeamsLogin(root);
  if (!removed) {
    console.log('This clone is not logged in to a Lazy Teams install.');
    return;
  }

  console.log(theme.success(
    `Logged out of ${new URL(removed.binding.teams_url).host} and unbound from ${removed.binding.project}.`,
  ));
  if (removed.removedCount > 1) {
    // A store that held more than one login is a state every other command
    // REFUSES to act on, so say plainly that this command just cleared it.
    console.log(theme.separator(
      `  This clone held ${removed.removedCount} logins; all of them were removed.`,
    ));
  }
  // Deleting the record here stops THIS clone using the token; it does not
  // retire the token. Say which of the two just happened.
  console.log(theme.separator(
    `  The API token still exists on that install — revoke it at Settings → API tokens ` +
    `to actually end access.`,
  ));
}

export function loginUsage(): void {
  console.log(`Usage: lazy login [<teams-url>] [--project <team/project>] [--device-name <name>]

Log this machine in to a Lazy Teams install and bind this clone to one project.

Run it with no arguments to print where this clone currently points.

How it works: lazy prints a short code and a URL. You open that URL in a browser
that is already signed in to your install, see which machine is asking, and
approve it. Nothing secret is typed, pasted or shown — the token goes straight
from the install to this machine.

Options:
  --project, -p <team/project>
                     Which project this clone is, e.g. acme/api-server. Without
                     it you are asked; with no terminal to ask, it is REQUIRED.
                     The git remote is never consulted — two clones of one
                     repository can belong to different projects.
  --device-name <name>
                     What the approval page calls this machine. Defaults to the
                     hostname and the directory name. The token is named after
                     it at Settings → API tokens.

One clone, one project: logging in again replaces the binding. There is no
\`lazy use\` and no \`--local\` — a person working against two projects has two
clones, which they have anyway.

The login record lives in this project's credential store: the token in the OS
keychain (or libsecret, or a 0600 file), and the non-secret binding — install,
project, when — beside it in the index.

Examples:
  lazy login                                       # where does this clone point?
  lazy login https://teams.example.com             # pick the project from a list
  lazy login teams.example.com -p acme/api-server  # no prompt
  lazy logout                                      # unbind this clone

Human/CLI-only — an agent must never log a machine in, so there is no MCP tool.`);
}

export function logoutUsage(): void {
  console.log(`Usage: lazy logout

Unbind this clone from its Lazy Teams project and delete the stored login.

This stops THIS machine using the token; it does not retire the token. To end
access altogether, revoke it at Settings → API tokens on the install.`);
}
