/**
 * How the demo drives a SECOND lazy: its own project, its own daemon, its own
 * agent binary.
 *
 * WHY SUBPROCESSES. Everywhere else in lazy, spawning the CLI is a violation —
 * the daemon owns business logic and the CLI is a client. This module is the
 * documented exception, and for a structural reason rather than convenience:
 * the demo daemon is a SEPARATE PROCESS serving a DIFFERENT PROJECT, started
 * with an environment this process does not have and must not adopt (a fake
 * agent on PATH, `LAZY_ALLOW_HOST_RUNNER=1`, a deliberately fake credential,
 * a redirected daemon base dir). None of that can be expressed in-process. It
 * is the same shape `lazy-teams`' LocalSupervisor and lazy's own fake-binary
 * e2e harness use, for the same reason.
 *
 * Once that daemon is up, everything the demo asks of it goes over its RPC via
 * {@link demoRpc} — a client talking to a daemon, which is the normal
 * architecture. Nothing here opens the demo's Storage.
 *
 * TWO STANDING RULES, from the engineer (2026-09-20), after a fleet demo shipped
 * that force-pushed a generated fixture to a repository the human named:
 *
 *  1. **Nothing under `src/demo/` ever runs `git push` — to any remote, forced
 *     or not.** The demo is disposable and everything it makes lives under its
 *     root; a remote is never its to write. If a future demo needs a remote, it
 *     is a URL the human gives, READ-ONLY, and nothing else (`--repo` is that).
 *  2. **No demo subprocess runs outside the demo's environment allowlist**
 *     ({@link allowlistedEnv} plus explicit, named additions). Borrowing the
 *     human's ambient environment — a spread of `process.env`, or a spawn with
 *     no `env` at all — is how a demo picks up their git credentials, their
 *     proxy, their real Claude token. Reads of single named variables
 *     (`process.env.HOME`) into an explicit env are fine; the whole object is
 *     not.
 *
 * `test/unit/demo-no-push-no-ambient-env.test.ts` scans `src/demo/**` for both
 * and fails naming the line. Removing an offending code path is not enough; the
 * guard is what keeps the next one from being written.
 */

import { join } from 'path';
import { chmod, mkdir, writeFile } from 'fs/promises';
import { spawn } from '../utils/spawn';
import { DaemonClient } from '../daemon/client';
import type { DemoPaths } from './paths';

/** How to invoke lazy as a subprocess. */
export interface LazyInvocation {
  /** argv prefix, e.g. `['/usr/local/bin/bun', 'run', '/src/index.ts']`. */
  argv: string[];
  /** The entry point recorded in the manifest, for humans and for `status`. */
  entry: string;
}

/**
 * Work out how to re-invoke lazy for the demo's own project.
 *
 * Two shapes: running from source under bun (`bun run src/index.ts`), which is
 * the only shape that can seed turns at all — see the note on the host-runner
 * gate in `up.ts` — and a compiled single-file binary, where `process.execPath`
 * IS lazy.
 */
export function resolveLazyInvocation(): LazyInvocation {
  const entry = process.argv[1];
  // Running from source: argv[1] is the .ts entry and execPath is bun.
  if (entry && (entry.endsWith('.ts') || entry.endsWith('.js'))) {
    return { argv: [process.execPath, 'run', entry], entry };
  }
  // Compiled binary: bun embeds the sources, so execPath is the whole command.
  return { argv: [process.execPath], entry: process.execPath };
}

/** Result of one demo subprocess. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The environment every demo subprocess runs with.
 *
 * `ANTHROPIC_API_KEY` is a deliberately fake, obviously-labelled value and the
 * demo NEVER inherits the human's real credential. The daemon's credential gate
 * only checks that one is present; the fake agent never dials out, so nothing
 * is ever spent. Inheriting the real one would put a live credential behind a
 * throwaway daemon for no benefit at all.
 *
 * `CLAUDE_CODE_OAUTH_TOKEN` is blanked rather than left alone for the same
 * reason: the surrounding agent container usually has one, and a set-but-unused
 * real token is exactly the leak this function exists to prevent.
 */
export function demoEnv(opts: {
  paths: DemoPaths;
  extra?: Record<string, string>;
}): Record<string, string> {
  return {
    ...allowlistedEnv(),
    ...demoEnvOverrides(opts.paths),
    ...(opts.extra ?? {}),
  };
}

/**
 * The ambient environment, filtered to the allowlist plus any extra keys a
 * particular child genuinely needs.
 *
 * Shared so every demo subprocess — the daemon, the CLI calls, the Teams
 * server — is built the same way. A second call site with its own spread is
 * exactly how the promise and the code came apart the first time.
 */
export function allowlistedEnv(extraKeys: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [...INHERITED_ENV_KEYS, ...extraKeys]) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * The ONLY ambient variables a demo subprocess inherits.
 *
 * An allowlist rather than a spread of `process.env`, because the demo's
 * printed output and its documentation both say your real credential is not
 * inherited — and a spread with two overrides made that a promise rather than a
 * property. A shell that exports a Cursor key, a proxy token or an
 * `ANTHROPIC_BASE_URL` pointing at a real gateway handed all of them to the
 * demo's daemon and its stand-in agent. Nothing dialled out, so nothing leaked;
 * the claim was still stronger than the code.
 *
 * Everything here is needed to run a process at all (find binaries, resolve a
 * home directory, write temporary files) or to render output a human reads.
 * Anything that looks like a credential, an endpoint or a provider setting is
 * deliberately absent — including the ones lazy itself understands, since the
 * demo supplies its own.
 */
const INHERITED_ENV_KEYS = [
  // NOTE: `HOME` is deliberately ABSENT. It is always set explicitly to a
  // directory under the demo root — see `demoEnvOverrides` — because inheriting
  // it lets demo turns rewrite the machine's own Claude Code config. Adding it
  // back here would silently restore that, since the ambient value would then
  // be present for any caller that does not pass an override.
  'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL',
  'TERM', 'COLORTERM', 'TZ',
] as const;

/**
 * What the demo sets on top of the inherited keys.
 *
 * Exported because `lazy playground up` and `lazy playground status` PRINT this block for a
 * human to paste: the documented "drive it from the CLI" recipe needs every one
 * of these, and a recipe that carried only the daemon base dir could run
 * `lazy list` and `lazy diff` and then be refused on exactly the interesting
 * half — unblocking and accepting, which is what the demo exists to let people
 * exercise. Printing what the demo's own subprocesses use means the two cannot
 * drift.
 */
export function demoEnvOverrides(paths: DemoPaths): Record<string, string> {
  return {
    // The stand-in agent has to be found before any real `claude` on PATH.
    PATH: `${agentBinDir(paths.agent)}:${process.env.PATH ?? ''}`,
    // A HOME under the demo root. Every agent launch writes an MCP config to
    // `$HOME/.claude.json` and a tool allowlist to `$HOME/.claude/settings.json`,
    // and the host-process runner keeps session state under `$HOME/.claude/
    // projects/`. Pointed at the real home, five seeded turns per `up` rewrote
    // the machine's own Claude Code config to reference the demo's worktree,
    // which teardown then deleted — and Claude Code reads one MCP config per
    // home, so on a machine with an agent working that is its live tool channel
    // being repointed at a directory that no longer exists. This is a known
    // incident in this repo, recorded in docs/testing-harness.md; the demo must
    // not reproduce it deliberately.
    HOME: paths.home,
    LAZY_DAEMON_BASE_DIR: paths.daemonBase,
    // The host-process runner is a test-harness seam, gated here and compiled
    // out of release builds (src/runner/host-runner-gate.ts). There is no
    // Docker inside an agent container, so it is the only way a demo turn can
    // run at all.
    LAZY_ALLOW_HOST_RUNNER: '1',
    ANTHROPIC_API_KEY: DEMO_FAKE_CREDENTIAL,
    CLAUDE_CODE_OAUTH_TOKEN: '',
    // The demo drives a real daemon; nothing here may take the in-process
    // storage bypass the unit harness uses.
    LAZY_TEST: '',
  };
}

/** Name of the wrapper the demo installs for driving it by hand. */
export const DEMO_WRAPPER_NAME = 'lazy-playground';

/**
 * Install `<root>/bin/lazy-playground` — a lazy that is bound to THIS demo.
 *
 * WHY A WRAPPER RATHER THAN EXPORTS. The obvious thing is to print a block of
 * `export` lines for someone to paste. It is also a trap, and a bad one for the
 * audience this command has: `LAZY_ALLOW_HOST_RUNNER=1` and a fake
 * `ANTHROPIC_API_KEY` survive the `cd` out of the demo and then apply to every
 * later `lazy` command in every other project in that shell — turning a real
 * project's turns into ones with a bogus credential, and quietly re-enabling a
 * runner that is supposed to be unavailable. A demo that teaches its users to
 * poison their own shell is not a good demo.
 *
 * So the variables are bound to the invocation instead. The wrapper sets them
 * for one child process and execs lazy; nothing survives it.
 */
export async function installDemoWrapper(opts: {
  paths: DemoPaths;
  lazyCmd: LazyInvocation;
}): Promise<string> {
  const binDir = join(opts.paths.root, 'bin');
  await mkdir(binDir, { recursive: true });
  const wrapperPath = join(binDir, DEMO_WRAPPER_NAME);

  const overrides = demoEnvOverrides(opts.paths);
  // `env -u` for the empty ones: exporting `CLAUDE_CODE_OAUTH_TOKEN=""` and
  // unsetting it are different things to lazy, which treats a set-but-blank
  // credential as absent but still present in the environment.
  const assignments = Object.entries(overrides)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(' \\\n  ');
  const unsets = Object.entries(overrides)
    .filter(([, value]) => value === '')
    .map(([key]) => `-u ${key}`)
    .join(' ');

  await writeFile(wrapperPath, [
    '#!/bin/sh',
    '# lazy, bound to this playground.',
    '#',
    '# Generated by `lazy playground up`. Everything this playground needs is set for ONE',
    '# child process and nothing else: run it from anywhere, and your own shell',
    '# keeps its own environment. That is the point — the variables a playground turn',
    '# needs (a stand-in agent on PATH, the host-runner allowance, a fake',
    '# credential) would be actively harmful left exported in a shell you then',
    '# use on a real project.',
    '',
    `cd ${shellQuote(opts.paths.repo)} || exit 1`,
    `exec env ${unsets} \\`,
    `  ${assignments} \\`,
    `  ${opts.lazyCmd.argv.map(shellQuote).join(' ')} "$@"`,
    '',
  ].join('\n'));
  await chmod(wrapperPath, 0o755);

  return wrapperPath;
}

/** Single-quote a value for /bin/sh, the only form with no escapes inside it. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The demo's stand-in credential.
 *
 * Spelled so that anyone who finds it in a log, a process listing or a proxy
 * audit line can tell instantly that it is not a real key.
 *
 * Deliberately carries NO provider prefix. It used to start with `sk-ant-`,
 * which is the shape secret scanners match — and this repo has already produced
 * GitGuardian alerts on exactly that, from proxy placeholder tokens. A literal
 * in the source that trips a scanner costs somebody a triage every time it is
 * seen, and buys nothing: the daemon's credential gate only checks that a
 * credential is present and non-blank (`credentialFromEnv` in
 * `src/daemon/credential-gate.ts`), so the prefix is not load-bearing for
 * anything.
 */
export const DEMO_FAKE_CREDENTIAL = 'lazy-demo-not-a-real-credential-never-spent';

/** Run a command, capturing both streams. Never throws on a non-zero exit. */
export async function run(
  cmd: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs?: number },
): Promise<RunResult> {
  const proc = spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: opts.timeoutMs ?? 120_000,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]);
  const code = await proc.exited;
  return { code: code ?? 1, stdout, stderr };
}

/**
 * Run a command and throw with BOTH streams when it fails.
 *
 * The streams are in the message on purpose: a demo failure is usually a lazy
 * subcommand refusing for a reason it already printed, and re-running by hand
 * to find out what that was is exactly the friction this command exists to
 * remove.
 */
export async function run$(
  what: string,
  cmd: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs?: number },
): Promise<RunResult> {
  const result = await run(cmd, opts);
  if (result.code !== 0) {
    throw new Error(
      `${what} failed (exit ${result.code})\n` +
      `  command: ${cmd.join(' ')}\n` +
      `  cwd:     ${opts.cwd}\n` +
      `${indent(result.stdout.trim(), '  stdout: ')}\n` +
      `${indent(result.stderr.trim(), '  stderr: ')}`,
    );
  }
  return result;
}

function indent(text: string, prefix: string): string {
  if (!text) return `${prefix}(empty)`;
  return text.split('\n').map(line => `${prefix}${line}`).join('\n');
}

/** Invoke a lazy subcommand against the demo project. */
export async function lazy(
  what: string,
  lazyCmd: LazyInvocation,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs?: number },
): Promise<RunResult> {
  return await run$(what, [...lazyCmd.argv, ...args], opts);
}

/** Same, but tolerating a non-zero exit (for probes such as `daemon status`). */
export async function lazyTry(
  lazyCmd: LazyInvocation,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs?: number },
): Promise<RunResult> {
  return await run([...lazyCmd.argv, ...args], opts);
}

/**
 * Call the DEMO daemon's RPC.
 *
 * `DaemonClient.create()` finds a daemon by reading the port marker and token
 * under the daemon base dir, which is resolved from `LAZY_DAEMON_BASE_DIR` at
 * call time. The demo command process pins that variable on itself during
 * `up`/`down`/`status` (see `withDemoDaemonBase`) so this client reaches the
 * DEMO daemon and never the daemon of whatever project the human happens to be
 * standing in.
 */
export async function demoRpc<T>(
  repoPath: string,
  command: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const client = await DaemonClient.create(repoPath);
  if (!client) {
    throw new Error(
      `The playground daemon is not reachable at ${repoPath}.\n` +
      `Check it with: lazy playground status`,
    );
  }
  return await client.rpc(command, repoPath, params) as T;
}

/**
 * Call one Storage method on the demo daemon.
 *
 * Storage methods are not top-level RPC commands — they ride the `storage`
 * command, which names the method and allowlists it daemon-side. Going through
 * the daemon rather than opening the demo's FileStorage is the point: the demo
 * is a CLIENT of its daemon, exactly like every other lazy surface.
 */
export async function demoStorage<T>(
  repoPath: string,
  method: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return await demoRpc<T>(repoPath, 'storage', { method, args });
}

/**
 * Run `fn` with this process's daemon base dir pinned at the demo's.
 *
 * Pinning process env is normally a smell. Here it is the narrow alternative to
 * threading a base dir through `DaemonClient` and every path helper beneath it,
 * and its blast radius is one short-lived CLI process that exists only to
 * manage the demo. It is always restored, including on failure.
 */
export async function withDemoDaemonBase<T>(daemonBase: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.LAZY_DAEMON_BASE_DIR;
  process.env.LAZY_DAEMON_BASE_DIR = daemonBase;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
    else process.env.LAZY_DAEMON_BASE_DIR = previous;
  }
}

/** The fake agent's bin directory inside a demo agent state dir. */
export function agentBinDir(agentDir: string): string {
  return join(agentDir, 'bin');
}
