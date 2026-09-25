/**
 * `lazy system agent` — see agent PROFILE readiness and switch the project
 * default.
 *
 * The unit here is the profile (`[agents.<name>]`), not the harness: a profile
 * is what `--agent` selects and what a launch grant carries, so "is this ready"
 * is four questions about a profile — is its harness installed, does it name a
 * model, is its upstream reachable, and is its credential present. Two profiles
 * on the same harness can differ on all but the first.
 *
 * Subcommands:
 *   status (default)   readiness view per profile, current default marked
 *   set <name>         switch [agent] agent_id in lazy.toml (comment-preserving
 *                      text edit via src/config/toml-edit.ts — the `lazy
 *                      protect` precedent). The daemon re-reads config on every
 *                      launch, so the switch takes effect on the very next task
 *                      launch with NO daemon restart.
 *   set-key <name>     store the API key the profile's CREDENTIAL slot bills,
 *                      in the same OS-protected credential store `lazy auth set`
 *                      writes — so the launch check and the proxy read one
 *                      place. Read from a masked prompt or piped stdin ONLY;
 *                      there is deliberately no argv form, because a key on the
 *                      command line lands in shell history and in every `ps` on
 *                      the machine. Picked up on the next launch — never restart
 *                      the daemon.
 *   clear-key <name>   remove that stored key.
 *
 * DELIBERATE ASYMMETRY: none of this has an MCP counterpart. Switching the
 * project default and writing credentials are human decisions; agents must
 * never write credentials. See public-docs/surface-asymmetries.md.
 */

import { join } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { requireLazyRoot } from '../helpers';
import { loadConfig } from '../../config/loader';
import { getAgentPackaging } from '../../agent/registry';
import {
  agentSupportsApiKey,
  agentCredentialProvider,
  resolveProfileCredential,
  clearAgentApiKey,
  credentialsPath,
  AGENT_KEY_ENV,
} from '../../agent/credentials';
import { credentialPresence, setCredential, deleteCredential } from '../../credentials/store';
import {
  credentialKinds,
  credentialLabel,
  credentialSetupCommand,
  envVarsFor,
  envVarFor,
} from '../../credentials/providers';
import { BACKEND_DESCRIPTIONS } from '../../credentials/backends';
import { getCredentialsPath } from '../../daemon/paths';
import {
  agentProfilesFor,
  selectableAgentProfileNames,
  profileNameForAgent,
  NO_CREDENTIAL,
  type AgentProfile,
} from '../../config/agent-profiles';
import { addCredentialToProfileAdvice, addProfileAdvice, defineProfileAdvice } from '../../config/agent-profile-advice';
import { setSectionString, TomlEditError } from '../../config/toml-edit';
import { spawnSyncUnsupervised } from '../../utils/spawn';
import { isTTY, promptSecret } from '../editor';
import { theme } from '../../render/theme';

/** Profiles for this project, keyed by name. */
async function loadProfiles(root: string): Promise<Map<string, AgentProfile>> {
  return agentProfilesFor(await loadConfig(root));
}

/** Fail with the same vocabulary every other selection surface uses. */
function unknownProfile(profiles: Map<string, AgentProfile>, name: string): never {
  console.error(
    `Unknown agent "${name}". Available profiles: ${selectableAgentProfileNames(profiles).join(', ')}.\n` +
    defineProfileAdvice(name),
  );
  process.exit(1);
}

/** Probe a binary's version; null when it is not installed / not runnable. */
function probeVersion(binaryName: string): string | null {
  try {
    const result = spawnSyncUnsupervised([binaryName, '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10_000,
    });
    if (result.exitCode !== 0) return null;
    const line = result.stdout.toString().trim().split('\n')[0] ?? '';
    return line || '(installed)';
  } catch {
    return null;
  }
}

/**
 * Is an upstream answering at all?
 *
 * ANY HTTP response counts as reachable — 401 and 404 are what a bare GET on an
 * API base URL is supposed to return, and turning those into "unreachable"
 * would report every correctly-configured hosted endpoint as broken. Only a
 * transport failure (DNS, refused connection, timeout) is a verdict, because
 * that is the one this view exists to catch: a profile pointed at an Ollama
 * that is not running.
 */
async function probeEndpoint(endpoint: string): Promise<string> {
  try {
    const res = await fetch(endpoint, { method: 'GET', signal: AbortSignal.timeout(3000) });
    return `reachable (HTTP ${res.status})`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return theme.warning(`UNREACHABLE — ${message}`);
  }
}

/** Host login session for the harnesses that have one, or null. */
function describeHostLogin(harness: string, installed: boolean): string | null {
  // `cursor-agent status` and `codex login status` both print the account when
  // logged in and "Not logged in" otherwise (codex exits 1 on the latter,
  // verified against 0.152.1).
  const loginProbe: Record<string, string[]> = {
    cursor: ['cursor-agent', 'status'],
    codex: ['codex', 'login', 'status'],
  };
  const probe = loginProbe[harness];
  if (!probe || !installed) return null;
  try {
    const status = spawnSyncUnsupervised(probe, { stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
    const text = `${status.stdout.toString()}\n${status.stderr.toString()}`.trim();
    if (status.exitCode === 0 && text && !/not logged in/i.test(text)) {
      return `host login (${text.split('\n')[0]})`;
    }
  } catch {
    // A failed status probe is not an auth verdict — the credential line above
    // already says whether lazy itself can pay for a turn.
  }
  return null;
}

/**
 * The credential line for ONE profile.
 *
 * Keyed by the profile's credential slot, never by its harness: that is the
 * slot the proxy bills per request, so anything else would report readiness for
 * a key the turn is not sent with.
 */
async function describeCredential(root: string, profile: AgentProfile, installed: boolean): Promise<string> {
  const parts: string[] = [];
  if (profile.credential === NO_CREDENTIAL) {
    parts.push('none — this upstream authenticates nobody');
  } else {
    const key = await resolveProfileCredential(root, profile);
    // `set-key` only ever writes the harness's OWN api-key provider, so it is
    // offered only when that IS this profile's slot. A codex profile on the
    // ChatGPT subscription bills `chatgpt`, and pointing someone at the API-key
    // command there sends them storing the wrong kind of secret in the wrong
    // place — `credentialSetupCommand` names the one that works.
    const slotIsHarnessKey =
      agentSupportsApiKey(profile.harness) &&
      agentCredentialProvider(profile.harness) === profile.credential;
    if (!key) {
      const remedy = slotIsHarnessKey
        ? `run \`lazy system agent set-key ${profile.name}\` or \`lazy ${credentialSetupCommand(profile.credential)}\``
        : `run \`lazy ${credentialSetupCommand(profile.credential)}\``;
      parts.push(theme.warning(`${profile.credential} — NOT CONFIGURED`) + ` — ${remedy}`);
    } else if (key.source === 'env') {
      const envVar = envVarsFor(profile.credential).find(v => process.env[v]) ?? 'environment';
      parts.push(`${profile.credential} — env: ${envVar}`);
    } else if (key.source === 'store') {
      const stored = await credentialPresence(root, profile.credential);
      // The KIND is the answer to "am I on my subscription or burning API
      // credit?", which is the whole question this feature exists for and is not
      // otherwise visible on any surface a user checks before launching.
      const kind = stored ? `${stored.kind}, ` : '';
      parts.push(
        `${profile.credential} — credential store (${kind}${stored?.backend ?? 'stored'}) — see \`lazy auth list\``,
      );
    } else {
      parts.push(`${profile.credential} — project key (${credentialsPath(root)})`);
    }
  }
  const login = describeHostLogin(profile.harness, installed);
  if (login) parts.push(login);
  return parts.join(' + ');
}

async function statusView(root: string): Promise<void> {
  const config = await loadConfig(root);
  const profiles = await loadProfiles(root);
  const defaultName = profileNameForAgent(config.agent.agent_id);
  // Selectable profiles only — the built-in profile of lazy's internal QA
  // harness is not something a human picks, so it does not belong in a status
  // listing (a project that writes its own block on that harness gets it back).
  const names = selectableAgentProfileNames(profiles);

  console.log('Probing agent profiles...\n');

  // Probe every distinct upstream ONCE and in parallel: several profiles
  // commonly share one (two codex profiles on the same OpenAI base URL), and a
  // serial probe would add its timeout per profile to a command a human waits on.
  const endpoints = [...new Set(names.map(n => profiles.get(n)!.endpoint).filter(e => e !== ''))];
  const reachability = new Map(
    await Promise.all(endpoints.map(async e => [e, await probeEndpoint(e)] as const)),
  );

  const versions = new Map<string, string | null>();
  for (const name of names) {
    const profile = profiles.get(name)!;
    const pkg = getAgentPackaging(profile.harness);
    const binary = pkg.binaryName();
    if (!versions.has(binary)) versions.set(binary, probeVersion(binary));
    const version = versions.get(binary) ?? null;
    const installed = version !== null;

    const marker = name === defaultName ? theme.success('● default') : '  ';
    console.log(`${name}  ${marker}  ${theme.separator(profile.builtin ? '(built-in)' : '([agents] in lazy.toml)')}`);
    console.log(`  ${theme.label('Harness:')}    ${profile.harness} — ${binary} ${installed ? version : theme.warning('NOT INSTALLED')}`);
    console.log(`  ${theme.label('Model:')}      ${profile.model || `the ${profile.harness} default`}`);
    console.log(`  ${theme.label('Upstream:')}   ${profile.endpoint
      ? `${profile.endpoint} (${profile.wire} wire) — ${reachability.get(profile.endpoint)}`
      : `the ${profile.harness} default (${profile.wire} wire)`}`);
    console.log(`  ${theme.label('Credential:')} ${await describeCredential(root, profile, installed)}`);
    console.log(`  ${theme.label('Containers:')} ${pkg.supportsContainerRunner() ? 'yes (docker/podman + host)' : 'no (host-process only)'}`);
    console.log('');
  }
  console.log(`Default agent: ${theme.taskId(defaultName)} ([agent] agent_id in lazy.toml)`);
  console.log(`Switch with: lazy system agent set <name> — takes effect on the next task launch, no daemon restart.`);
  console.log(theme.separator(addProfileAdvice()));
}

async function setDefault(root: string, agentId: string): Promise<void> {
  const profiles = await loadProfiles(root);
  const profile = profiles.get(agentId);
  if (!profile) unknownProfile(profiles, agentId);

  const configPath = join(root, 'lazy.toml');
  let original: string;
  try {
    original = await readFile(configPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // No lazy.toml at all — start one rather than failing (protect precedent).
      original = '';
    } else {
      throw new Error(`Failed to read ${configPath}: ${err instanceof Error ? err.message : err}`);
    }
  }

  let updated: string;
  try {
    updated = setSectionString(original, 'agent', 'agent_id', agentId);
  } catch (err) {
    if (err instanceof TomlEditError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  await writeFile(configPath, updated, 'utf-8');

  console.log(theme.success(`Default agent is now "${agentId}".`));
  console.log(theme.separator(`  [agent].agent_id in ${configPath}`));
  console.log('Takes effect on the next task launch — the daemon re-reads config per launch, no restart needed.');
  console.log('Per-task override: lazy create/start --agent <name>.');
  if (agentSupportsApiKey(profile.harness) && profile.credential !== NO_CREDENTIAL) {
    const key = await resolveProfileCredential(root, profile);
    if (!key) {
      // Same rule as `describeCredential`: offer the per-agent `set-key` only
      // when the profile's slot IS the harness's own API key. A codex profile on
      // the ChatGPT subscription bills `chatgpt`, which `set-key` cannot write.
      const remedy = agentCredentialProvider(profile.harness) === profile.credential
        ? `lazy system agent set-key ${agentId}`
        : `lazy ${credentialSetupCommand(profile.credential)}`;
      console.log(theme.warning(
        `Note: no ${profile.credential} credential is configured. Container tasks will refuse to launch — ` +
        `set one with: ${remedy}`,
      ));
    }
  }
}

/**
 * Read the key from a masked interactive prompt or piped stdin.
 *
 * DELIBERATELY no argv form: a key passed as an argument lands in shell
 * history and is visible in `ps` to every user on the machine for as long as
 * the command runs. There is no way to make that safe, so it is not offered.
 */
async function obtainKey(agentId: string): Promise<string> {
  if (isTTY()) {
    return promptSecret(`API key for ${agentId}`);
  }
  // Piped stdin (e.g. `pass show cursor | lazy system agent set-key cursor`).
  const piped = (await new Response(process.stdin as unknown as ReadableStream).text()).split('\n')[0] ?? '';
  return piped.trim();
}

async function setKey(root: string, agentId: string | undefined, extraArgs: string[]): Promise<void> {
  if (!agentId) {
    console.error('Usage: lazy system agent set-key <agent>');
    process.exit(1);
  }
  // The removed argv form (`set-key <id> <key>`) failed CLOSED once it was
  // dropped — the extra word was ignored and the masked prompt ran — but a user
  // who typed their key there has already put it in shell history and in `ps`.
  // Silently ignoring it would leave them believing it was stored AND leave the
  // key exposed, so say both things outright.
  if (extraArgs.length > 0) {
    console.error(
      `lazy system agent set-key takes no key argument — the key is read from a masked ` +
      `prompt or piped stdin only.\n` +
      `A key on the command line is recorded in your shell history and is visible in \`ps\` ` +
      `to every user on this machine, which is why the form was removed.\n` +
      `Nothing was stored. If what you typed was a real key, ROTATE IT, then run:\n` +
      `  lazy system agent set-key ${agentId}\n` +
      `  # or: pass show ${agentId} | lazy system agent set-key ${agentId}`,
    );
    process.exit(1);
  }

  const profiles = await loadProfiles(root);
  const profile = profiles.get(agentId);
  if (!profile) unknownProfile(profiles, agentId);

  if (profile.credential === NO_CREDENTIAL) {
    console.error(
      `Agent "${agentId}" points at ${profile.endpoint || 'an upstream'} that authenticates nobody ` +
      `(credential = "none"), so there is no API key to store.\n` +
      addCredentialToProfileAdvice(agentId),
    );
    process.exit(1);
  }
  // The refusal is about the HARNESS, not the credential: cursor and codex read
  // a key out of their own config, while claude-code and pi are handed one by
  // lazy's proxy — so for those there is nothing per-agent to write here, and
  // `lazy auth set <credential>` is the surface that does the same job for every
  // profile billing that slot.
  if (!agentSupportsApiKey(profile.harness)) {
    console.error(
      `Agent "${agentId}" does not use an API key lazy can store per-agent — the "${profile.harness}" ` +
      `harness is handed lazy's ${credentialLabel(profile.credential)} credential through the proxy.\n` +
      `Store that credential instead:  lazy auth set ${profile.credential}\n` +
      `Key-capable harnesses: ${Object.keys(AGENT_KEY_ENV).join(', ')}`,
    );
    process.exit(1);
  }

  // A ChatGPT subscription has no API key to type — its credential is the
  // multi-field session `codex login` wrote. Refuse BEFORE the masked prompt:
  // whatever the user pasted would be stored as a valid-looking oauth entry and
  // only fail at the first turn, hours later, as an unexplained 401.
  if (profile.credential === 'chatgpt') {
    console.error(
      `Agent "${agentId}" bills a ChatGPT subscription, which issues no API key — its credential is ` +
      `the login session \`codex login\` writes.\n` +
      `Store it with:\n` +
      `  codex login                 # or: codex login --device-auth, on a headless host\n` +
      `  lazy auth import chatgpt\n` +
      `For a metered OpenAI API key instead, point the profile at api.openai.com (or set ` +
      `credential = "openai") and re-run this command.`,
    );
    process.exit(1);
  }

  const key = await obtainKey(agentId);
  if (!key.trim()) {
    console.error('No key provided. Type it at the masked prompt, or pipe it in ' +
      '(e.g. `pass show cursor | lazy system agent set-key cursor`).');
    process.exit(1);
  }

  // ONE store, under the PROFILE's credential name. `lazy auth set` writes the
  // same place, the proxy bills the same slot per request, and the launch check
  // reads it — so a key set here cannot diverge from the key a turn is sent
  // with, which is exactly what a second per-agent file used to allow.
  const kind = credentialKinds(profile.credential)[0]!;
  const entry = await setCredential(root, { provider: profile.credential, kind, secret: key });
  console.log(theme.success(`Stored ${agentId} API key as the "${profile.credential}" credential.`));
  console.log(theme.separator(`  ${BACKEND_DESCRIPTIONS[entry.backend]}`));
  if (entry.backend === 'file') {
    // SECURITY: never under the project root. Every task container mounts the
    // repo read-only, so an in-repo key is readable by every agent of every
    // task — 0600 stops other host users, not the container.
    console.log(theme.separator(`  ${getCredentialsPath(root)}`));
  }
  console.log('Takes effect on the next task launch — no daemon restart needed.');
  const envVar = envVarFor(profile.credential, kind);
  if (envVar) {
    console.log(`The ${envVar} environment variable, when set, overrides this key.`);
  }
  if (AGENT_KEY_ENV[profile.harness]) {
    console.log(theme.separator(
      `  The container still reads it from ${AGENT_KEY_ENV[profile.harness]} — as a placeholder the proxy swaps for the real key.`,
    ));
  }
}

async function clearKey(root: string, agentId: string | undefined): Promise<void> {
  if (!agentId) {
    console.error('Usage: lazy system agent clear-key <agent>');
    process.exit(1);
  }
  const profiles = await loadProfiles(root);
  const profile = profiles.get(agentId);
  if (!profile) unknownProfile(profiles, agentId);

  const removed = profile.credential === NO_CREDENTIAL
    ? false
    : await deleteCredential(root, profile.credential);
  // Also drop any key the pre-store `set-key` left in the per-agent file:
  // "removed" must mean the next launch finds nothing, and that file is still a
  // resolution source (see resolveProfileCredential).
  const legacy = await clearAgentApiKey(root, profile.harness);

  console.log(removed || legacy
    ? theme.success(`Removed the stored ${agentId} API key.`)
    : `No stored key for "${agentId}".`);
  if (removed && legacy) {
    console.log(theme.separator(`  Cleared both the "${profile.credential}" credential and the older per-agent key.`));
  }
}

export async function commandSystemAgent(args: string[]): Promise<void> {
  const root = requireLazyRoot();
  const sub = args[0];

  switch (sub) {
    case undefined:
    case 'status':
      await statusView(root);
      break;
    case 'set':
      if (!args[1]) {
        console.error('Usage: lazy system agent set <agent>');
        process.exit(1);
      }
      await setDefault(root, args[1]);
      break;
    case 'set-key':
      await setKey(root, args[1], args.slice(2));
      break;
    case 'clear-key':
      await clearKey(root, args[1]);
      break;
    default:
      console.error(`Unknown subcommand: system agent ${sub}`);
      systemAgentUsage();
      process.exit(1);
  }
}

export function systemAgentUsage(): void {
  console.log(`Usage: lazy system agent [status|set <agent>|set-key <agent>|clear-key <agent>]

See which agent PROFILES are ready and switch the project's default.

An agent is a profile — a harness, a model, an upstream and a credential. The
built-ins (claude-code, codex, cursor, pi) are joined by any [agents.<name>]
block in lazy.toml, and every <agent> below is one of those names.

Subcommands:
  status (default)      Readiness per profile: harness binary + version, model,
                        upstream (probed for reachability), credential, and
                        container capability. Marks the current default.
  set <agent>           Switch the project default ([agent] agent_id in
                        lazy.toml, comments preserved). Takes effect on the
                        next task launch — no daemon restart.
  set-key <agent>       Store the API key the profile's credential slot bills,
                        in the same store \`lazy auth set\` writes (OS keychain
                        where available, else a 0600 file in the per-project
                        daemon dir). Kept OUT of the project root: task
                        containers mount the repo read-only, so an in-repo key
                        is readable by every agent on the project. Reads the key
                        from an interactive masked prompt or piped stdin — never
                        from an argument, which would land in shell history.
                        Also picked up on the next launch. Human/CLI-only — no
                        MCP counterpart.
  clear-key <agent>     Remove that stored key.

Examples:
  lazy system agent                       # readiness view
  lazy system agent set cursor            # tasks default to the Cursor CLI
  lazy system agent set cheap-codex       # ... or to a profile this project configures
  lazy system agent set-key cursor        # prompt for the key (masked)
  lazy system agent set-key codex         # store an OpenAI API key for Codex tasks
  pass show cursor | lazy system agent set-key cursor   # piped stdin`);
}
