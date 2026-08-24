/**
 * `lazy system agent` — see agent readiness and switch the project default.
 *
 * Subcommands:
 *   status (default)   readiness view: installed + version + auth + container
 *                      capability per registered agent, current default marked
 *   set <id>           switch [agent] agent_id in lazy.toml (comment-preserving
 *                      text edit via src/config/toml-edit.ts — the `lazy
 *                      protect` precedent). The daemon re-reads config on every
 *                      launch, so the switch takes effect on the very next task
 *                      launch with NO daemon restart.
 *   set-key <id>       store the agent's API key per-project in the daemon
 *                      state dir (~/.lazy/daemon/<slug>/agent-credentials.json,
 *                      0600) — never under the project root, which every task
 *                      container mounts read-only. Read from a masked prompt or
 *                      piped stdin ONLY; there is deliberately no argv form,
 *                      because a key on the command line lands in shell history
 *                      and in every `ps` on the machine. Also picked up on the
 *                      next launch — never restart the daemon.
 *   clear-key <id>     remove a stored key.
 *
 * DELIBERATE ASYMMETRY: none of this has an MCP counterpart. Switching the
 * project default and writing credentials are human decisions; agents must
 * never write credentials. See public-docs/surface-asymmetries.md.
 */

import { join } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { requireLazyRoot } from '../helpers';
import { loadConfig } from '../../config/loader';
import { listAgents, getAgentPackaging } from '../../agent/registry';
import {
  agentSupportsApiKey,
  resolveAgentApiKey,
  writeAgentApiKey,
  clearAgentApiKey,
  credentialsPath,
  AGENT_KEY_ENV,
} from '../../agent/credentials';
import { setSectionString, TomlEditError } from '../../config/toml-edit';
import { spawnSyncUnsupervised } from '../../utils/spawn';
import { isTTY, promptSecret } from '../editor';
import { theme } from '../theme';

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

/** One agent's auth summary line, resolved from every source lazy knows. */
async function describeAuth(root: string, agentId: string, installed: boolean): Promise<string> {
  if (agentId === 'claude-code') {
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return 'env: CLAUDE_CODE_OAUTH_TOKEN';
    if (process.env.ANTHROPIC_API_KEY) return 'env: ANTHROPIC_API_KEY';
    return 'no env credential (a `claude` login session may still apply)';
  }

  if (agentSupportsApiKey(agentId)) {
    const parts: string[] = [];
    const key = await resolveAgentApiKey(root, agentId);
    if (key) {
      parts.push(key.source === 'env'
        ? `env: ${AGENT_KEY_ENV[agentId]}`
        : `project key (${credentialsPath(root)})`);
    }
    // Cursor also has its own login session on the host — report it.
    if (agentId === 'cursor' && installed) {
      try {
        const status = spawnSyncUnsupervised(['cursor-agent', 'status'], {
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 10_000,
        });
        const text = status.stdout.toString().trim();
        if (status.exitCode === 0 && text && !/not logged in/i.test(text)) {
          parts.push(`logged in (${text.split('\n')[0]})`);
        }
      } catch {
        // status probe failure is not an auth verdict — installed says enough
      }
    }
    if (parts.length === 0) {
      return `NOT AUTHENTICATED — run \`lazy system agent set-key ${agentId}\` (or \`${getAgentPackaging(agentId).binaryName()} login\` for host runs)`;
    }
    return parts.join(' + ');
  }

  return 'n/a';
}

async function statusView(root: string): Promise<void> {
  const config = await loadConfig(root);
  const defaultAgent = config.agent.agent_id;

  console.log('Probing agents...\n');
  for (const agentId of listAgents()) {
    const pkg = getAgentPackaging(agentId);
    const version = probeVersion(pkg.binaryName());
    const installed = version !== null;
    const auth = await describeAuth(root, agentId, installed);

    const marker = agentId === defaultAgent ? theme.success('● default') : '  ';
    console.log(`${agentId}  ${marker}`);
    console.log(`  ${theme.label('Binary:')}     ${pkg.binaryName()} — ${installed ? version : `NOT INSTALLED`}`);
    console.log(`  ${theme.label('Auth:')}       ${auth}`);
    console.log(`  ${theme.label('Containers:')} ${pkg.supportsContainerRunner() ? 'yes (docker/podman + host)' : 'no (host-process only)'}`);
    console.log('');
  }
  console.log(`Default agent: ${theme.taskId(defaultAgent)} ([agent] agent_id in lazy.toml)`);
  console.log(`Switch with: lazy system agent set <id> — takes effect on the next task launch, no daemon restart.`);
}

async function setDefault(root: string, agentId: string): Promise<void> {
  const known = listAgents();
  if (!known.includes(agentId)) {
    console.error(`Unknown agent "${agentId}". Available agents: ${known.join(', ')}`);
    process.exit(1);
  }

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
  console.log('Per-task override: lazy create/start --agent <id>.');
  if (agentSupportsApiKey(agentId)) {
    const key = await resolveAgentApiKey(root, agentId);
    if (!key) {
      console.log(theme.warning(
        `Note: no ${agentId} API key is configured. Container tasks will refuse to launch — ` +
        `set one with: lazy system agent set-key ${agentId}`,
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
    console.error('Usage: lazy system agent set-key <agent_id>');
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
  if (!agentSupportsApiKey(agentId)) {
    console.error(
      `Agent "${agentId}" does not use an API key lazy can store. ` +
      `Key-capable agents: ${Object.keys(AGENT_KEY_ENV).join(', ')}`,
    );
    process.exit(1);
  }

  const key = await obtainKey(agentId);
  if (!key.trim()) {
    console.error('No key provided. Type it at the masked prompt, or pipe it in ' +
      '(e.g. `pass show cursor | lazy system agent set-key cursor`).');
    process.exit(1);
  }

  const path = await writeAgentApiKey(root, agentId, key);
  console.log(theme.success(`Stored ${agentId} API key.`));
  console.log(theme.separator(`  ${path} (0600, outside the repo — task containers cannot read it)`));
  console.log('Takes effect on the next task launch — no daemon restart needed.');
  console.log(`The ${AGENT_KEY_ENV[agentId]} environment variable, when set, overrides this key.`);
}

async function clearKey(root: string, agentId: string | undefined): Promise<void> {
  if (!agentId) {
    console.error('Usage: lazy system agent clear-key <agent_id>');
    process.exit(1);
  }
  const removed = await clearAgentApiKey(root, agentId);
  console.log(removed
    ? theme.success(`Removed the stored ${agentId} API key.`)
    : `No stored key for "${agentId}".`);
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
        console.error('Usage: lazy system agent set <agent_id>');
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
  console.log(`Usage: lazy system agent [status|set <agent_id>|set-key <agent_id>|clear-key <agent_id>]

See which agents are ready and switch the project's default agent.

Subcommands:
  status (default)      Readiness view: installed binary + version, auth state,
                        container capability, and the current default agent.
  set <agent_id>        Switch the project default ([agent] agent_id in
                        lazy.toml, comments preserved). Takes effect on the
                        next task launch — no daemon restart.
  set-key <agent_id>    Store the agent's API key per-project in
                        ~/.lazy/daemon/<slug>/agent-credentials.json (mode
                        0600). Kept OUT of the project root: task containers
                        mount the repo read-only, so an in-repo key is readable
                        by every agent on the project. Reads the key from an
                        interactive masked prompt or piped stdin — never from an
                        argument, which would land in shell history. Also picked
                        up on the next launch. Human/CLI-only — no MCP
                        counterpart.
  clear-key <agent_id>  Remove a stored key.

Examples:
  lazy system agent                       # readiness view
  lazy system agent set cursor            # tasks default to the Cursor CLI
  lazy system agent set-key cursor        # prompt for the key (masked)
  pass show cursor | lazy system agent set-key cursor   # piped stdin`);
}
