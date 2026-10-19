/**
 * The MACHINE's login to a Teams install — the half of `lazy login` that is not
 * about any one clone, and what lets a plain `git clone` of a hosted repository
 * work before there is a clone to bind.
 *
 * It lives in lazy's credential store like every other secret (OS keychain,
 * libsecret or a 0600 file), in a store of its own that belongs to no project:
 * the store is keyed by a directory, and this one is a fixed per-user path that
 * is never a project. One record per install ORIGIN (`teams:https://<host>`), with no binding —
 * a machine can be logged in to several installs; a CLONE is still bound to
 * exactly one project (./login.ts).
 */

import { join } from 'path';
import { getHome } from '../utils/home';
import { deleteCredential, getStoredCredential, readCredentialIndex, setCredential } from '../credentials/store';
import {
  TEAMS_CREDENTIAL_PREFIX,
  legacyTeamsCredentialName,
  originOfTeamsCredentialName,
  teamsCredentialName,
} from './login';
import { legacyLoginScheme } from './git-bearer';

/** The pseudo project root the machine-level store is keyed by. Never a real project. */
export function machineLoginRoot(): string {
  return join(getHome(), '.lazy', 'teams-machine-login');
}

export async function writeMachineLogin(teamsUrl: string, token: string): Promise<void> {
  await setCredential(machineLoginRoot(), {
    provider: teamsCredentialName(teamsUrl),
    kind: 'api-key',
    secret: token,
  });
  // Save first, then retire the host-keyed record this one replaces. Only an
  // HTTPS write retires it: the record always answers https (below), so an
  // http migration must leave it standing or the https login would vanish.
  if (isHttps(teamsUrl)) await deleteCredential(machineLoginRoot(), legacyTeamsCredentialName(teamsUrl));
}

const isHttps = (teamsUrl: string) => new URL(teamsUrl).protocol === 'https:';

/**
 * Does a legacy host-keyed record answer for this origin? Always for https —
 * using it there leaks nothing whichever scheme it was issued on, and an older
 * `lazy clone http://…` rewrote https logins' includes to http, so an http
 * include does NOT prove an http login. Additionally for http when the
 * include it wrote was used over http (./git-bearer.ts `legacyLoginScheme`),
 * which is what keeps an http-only install's login from vanishing.
 */
async function legacyAnswersFor(teamsUrl: string): Promise<boolean> {
  return isHttps(teamsUrl) || (await legacyLoginScheme(new URL(teamsUrl).host)) === 'http';
}

/** The token stored for exactly this origin, origin-keyed records only. Never migrates. */
export async function storedOriginToken(teamsUrl: string): Promise<string | null> {
  return (await getStoredCredential(machineLoginRoot(), teamsCredentialName(teamsUrl)))?.value ?? null;
}

/**
 * This machine's token for exactly this origin, or null. A legacy host-keyed
 * record answers per `legacyAnswersFor`, and is copied to its origin-keyed
 * name on read (and retired once an https copy exists).
 */
export async function readMachineToken(teamsUrl: string): Promise<string | null> {
  const stored = await getStoredCredential(machineLoginRoot(), teamsCredentialName(teamsUrl));
  if (stored) return stored.value;
  if (!(await legacyAnswersFor(teamsUrl))) return null;
  const legacy = await getStoredCredential(machineLoginRoot(), legacyTeamsCredentialName(teamsUrl));
  if (!legacy) return null;
  await writeMachineLogin(teamsUrl, legacy.value);
  return legacy.value;
}

/** Every install this machine is logged in to, as an origin (`https://host[:port]`). */
export async function listMachineLogins(): Promise<string[]> {
  const entries = await readCredentialIndex(machineLoginRoot());
  const origins = entries
    .filter((e) => e.provider.startsWith(TEAMS_CREDENTIAL_PREFIX))
    .map((e) => originOfTeamsCredentialName(e.provider));
  return [...new Set(origins)];
}

/**
 * The origin of a login this machine holds for the same host on the OTHER
 * scheme, or null. Lets a command refuse to reuse it — and say why — instead of
 * either sending it over the wrong scheme or silently starting a new login.
 */
export async function machineLoginOnOtherScheme(teamsUrl: string): Promise<string | null> {
  const url = new URL(teamsUrl);
  const other = `${url.protocol === 'https:' ? 'http:' : 'https:'}//${url.host}`;
  return (await listMachineLogins()).includes(other) ? other : null;
}

export async function deleteMachineLogin(teamsUrl: string): Promise<boolean> {
  const removed = await deleteCredential(machineLoginRoot(), teamsCredentialName(teamsUrl));
  // Logout of either scheme ends the host-keyed record it may have answered from.
  const legacy = (await legacyAnswersFor(teamsUrl))
    ? await deleteCredential(machineLoginRoot(), legacyTeamsCredentialName(teamsUrl))
    : false;
  return removed || legacy;
}
