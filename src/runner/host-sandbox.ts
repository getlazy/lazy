/**
 * Host permission posture — single source of truth for how host-executed
 * Claude Code processes (agents and the builder) are confined.
 *
 * Background
 * ----------
 * On the host runner, lazy used to launch every Claude Code process with
 * `--dangerously-skip-permissions` and nothing else: no filesystem or network
 * boundary at all. This module replaces that default with Claude Code's own
 * OS-level sandbox (Seatbelt on macOS, bubblewrap on Linux/WSL2), while keeping
 * full bypass reachable as an explicit opt-in.
 *
 * Two postures, selected by `[runner] permission_mode` in lazy.toml:
 *   - 'sandbox' (default): the OS sandbox is the hard security boundary.
 *   - 'bypass'            : `--dangerously-skip-permissions`, no sandbox — the
 *                           previous behavior, now opt-in only.
 *
 * Why the sandbox is the boundary, not a permission classifier
 * ------------------------------------------------------------
 * The spike (SPIKE-host-first-runner.md) established that Claude Code's
 * `--permission-mode auto` (the server-side classifier) ABORTS a headless `-p`
 * session after repeated denials and requires capable Claude models. It is
 * therefore unusable for headless agents — especially agents on open-weight
 * models. The only combination that never blocks interactively AND enforces a
 * real boundary is: OS sandbox + a permission layer that never prompts.
 *
 * Two boundaries, two mechanisms (verified on macOS, Claude Code v2.1.170)
 * -----------------------------------------------------------------------
 * The OS sandbox governs **Bash and its children ONLY**. The Read/Edit/Write
 * file tools do NOT go through the OS sandbox — they go through Claude Code's
 * permission system, which `--dangerously-skip-permissions` bypasses. So under
 * the headless agent posture (sandbox + bypass), `sandbox.filesystem.denyRead`
 * protects the Bash path but leaves the file tools wide open: a non-refusing
 * (e.g. open-weight) agent could `Read` ~/.ssh or `Write` outside the worktree
 * with the Read/Write tools and nothing would stop it. This was verified empirically.
 *
 * The fix, also verified: `permissions.deny` rules in the SAME `--settings` JSON
 * ARE honored even under `--dangerously-skip-permissions` and hard-block the file
 * tools (enforcement, not model alignment). So we confine the file tools with
 * `permissions.deny` (Read/Write/Edit) exactly as the OS sandbox confines Bash.
 * See buildSandboxSettings below and the parent task `host-sandbox-perms`.
 *
 * Network is NOT a hard boundary here — read this honestly
 * --------------------------------------------------------
 * Under sandbox + bypass, `sandbox.network.allowedDomains` is "pre-approve these
 * domains so Bash doesn't prompt", NOT "deny everything else". Verified: a
 * non-allowlisted domain (e.g. example.com) is REACHABLE under bypass — a
 * non-allowed domain merely *prompts*, and bypass auto-approves the prompt.
 * `allowManagedDomainsOnly` (the real "allowlist is a wall" switch) is honored
 * ONLY in managed settings, not when passed via `--settings`. Real network
 * confinement would require managed settings or the `--permission-mode auto`
 * classifier (unusable for headless agents, see above). It is therefore OUT OF
 * SCOPE here and deliberately left open; do not describe `sandbox_allowed_domains`
 * as a security boundary. It only reduces prompts on the interactive builder.
 *
 * Per-surface posture (sandbox mode)
 * ----------------------------------
 * Headless AGENTS (work turns, push-back):
 *   sandbox.enabled + `--dangerously-skip-permissions` (bypassPermissions).
 *   - bypass means Claude never shows a permission prompt, so a headless `-p`
 *     session can never hang waiting for one.
 *   - the OS sandbox still confines every Bash subprocess: a write outside the
 *     worktree or a connection to a non-allowlisted domain fails with a tool
 *     error the agent can react to — it is NOT a prompt.
 *   - `allowUnsandboxedCommands: false` removes the `dangerouslyDisableSandbox`
 *     escape hatch, so a headless agent can never retry a denied command
 *     OUTSIDE the sandbox. The sandbox is the SOLE hard boundary.
 *   - `--dangerously-skip-permissions`'s usual root refusal is waived by Claude
 *     Code when a recognized sandbox is active, so this also works under the
 *     daemon / CI where lazy may run as root.
 *
 * Interactive BUILDER:
 *   sandbox.enabled, plus bypass whenever the builder is autonomous — which it
 *   is BY DEFAULT (`lazy builder --no-autonomous` is the opt-out).
 *   - autonomous (default): the headless agent posture above (sandbox + bypass),
 *     so the builder never hangs on a prompt.
 *   - `--no-autonomous`: sandbox + the DEFAULT permission mode (prompts). The
 *     builder has a human at the terminal, so a sandbox-escape prompt is
 *     answerable; `allowUnsandboxedCommands: true` lets the human approve an
 *     escape via the `dangerouslyDisableSandbox` retry.
 *   This function takes `autonomous` as a parameter and does not know the CLI
 *   default — `lazy pair --autonomous` is still opt-in and passes false.
 *
 * INVARIANT: headless agents NEVER hang on an interactive permission prompt.
 * The OS sandbox (Bash) and `permissions.deny` (file tools) — not a prompt — are
 * the hard boundaries. See test/e2e/host-sandbox-posture.test.ts and the unit
 * contract in test/unit/host-sandbox-posture.test.ts. The deny-rule enforcement
 * under bypass is a Claude Code behavior we depend on but do not control; the
 * committed `scripts/host-sandbox-probe.sh --guard` re-verifies it on a real host
 * and trips loudly if a CC upgrade ever makes a file tool escape the rules.
 *
 * Unexplored alternatives (need a real host to evaluate — see follow-ups):
 *   - `--permission-mode dontAsk` (CC v2.1.170+): if it means "never prompt; deny
 *     anything that would prompt", it could enforce allow/deny rules WITHOUT
 *     --dangerously-skip-permissions, closing the network gap too. Untested.
 *   - Managed settings (`allowManagedDomainsOnly`): the only known way to make the
 *     domain allowlist a hard network wall. Not reachable via `--settings`.
 *
 * Schema note: the Claude Code settings schema nests the domain allowlist at
 * `sandbox.network.allowedDomains` (NOT top-level `sandbox.allowedDomains`).
 * See https://code.claude.com/docs/en/sandboxing and the settings schema at
 * https://www.schemastore.org/claude-code-settings.json.
 */

import type { HostPermissionMode } from '../config/types';
import { isAbsolute, resolve } from 'path';
import { expandTilde } from '../utils/home';
import { getScratchBaseDir } from '../builder/scratch';
import { getDaemonBaseDir } from '../daemon/paths';

export type { HostPermissionMode };

/** Resolved host permission posture, sourced from `[runner]` in lazy.toml. */
export interface HostPermissionConfig {
  /** 'sandbox' (default) or 'bypass'. */
  mode: HostPermissionMode;
  /** Network allowlist for the sandbox proxy (default ['*.anthropic.com']). */
  allowedDomains: string[];
  /**
   * Allow Claude Code's weaker nested sandbox so bubblewrap can run inside an
   * unprivileged container (no user namespaces). Considerably weakens
   * isolation — opt-in only, for environments that already provide an outer
   * boundary. Has no effect on macOS (Seatbelt).
   */
  allowWeakerNested: boolean;
  /**
   * User-supplied EXTRA paths to deny the Read tool (merged with
   * {@link DEFAULT_SENSITIVE_PATHS}, never replacing them). From
   * `[runner] sandbox_deny_read`.
   */
  denyRead: string[];
  /**
   * User-supplied EXTRA paths to deny the Write/Edit tools (merged with
   * {@link DEFAULT_SENSITIVE_PATHS}, never replacing them). From
   * `[runner] sandbox_deny_write`.
   */
  denyWrite: string[];
  /**
   * The project's `[storage] external_path` as an absolute path, when set.
   * Denied to AGENTS only (see {@link agentDenies}).
   */
  storePath?: string;
}

/**
 * Credential and config stores that must be confined regardless of agent
 * behavior: reading them is exfiltration, writing/editing them is tampering
 * or persistence (e.g. dropping a payload in a shell rc).
 *
 * These paths feed TWO independent boundaries, because they protect against
 * two different escape vectors (see the module header):
 *   - Bash + children:  `sandbox.filesystem.denyRead` (the OS sandbox).
 *   - Read/Edit/Write tools: `permissions.deny` rules — the file tools bypass
 *     the OS sandbox, so the OS sandbox's denyRead does NOT cover them.
 *
 * `~/.claude*` from the task spec is expressed concretely as `~/.claude` and
 * `~/.claude.json` so the entries are also valid `sandbox.filesystem.denyRead`
 * paths (which take literal paths, not gitignore globs).
 */
const DEFAULT_SENSITIVE_PATHS = [
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/.config/gh',
  '~/.config/glab',
  '~/.bashrc',
  '~/.zshrc',
  '~/.profile',
  '~/.claude',
  '~/.claude.json',
];

/**
 * Build the `permissions.deny` rules that confine a single file tool to keep it
 * out of `path`. Two rules per path — the path itself and everything under it —
 * because gitignore-style `dir/**` does NOT match `dir`.
 *
 * Path syntax for Read/Edit/Write rules differs from `sandbox.filesystem.*`: a
 * leading `//abs` means "absolute from filesystem root", `/projrel` means
 * "project-relative". We expand `~` to an absolute path and prefix one extra
 * `/`, yielding the `//abs` form. Verified honored under
 * `--dangerously-skip-permissions` on Claude Code v2.1.170.
 */
function fileToolDenyRules(tool: 'Read' | 'Write' | 'Edit', path: string): string[] {
  const abs = expandTilde(path);
  const base = `/${abs}`; // '/home/u/.ssh' -> '//home/u/.ssh'
  return [`${tool}(${base})`, `${tool}(${base}/**)`];
}

/**
 * Build the Claude Code `sandbox` settings object (the value passed via
 * `--settings`). `interactive` selects the builder vs. headless-agent posture
 * (see the module header).
 */
export function buildSandboxSettings(
  cfg: HostPermissionConfig,
  interactive: boolean,
): { sandbox: Record<string, unknown>; permissions: { deny: string[] } } {
  // Default sensitive paths apply to every tool; user entries extend (not
  // replace) them. dedupe keeps the JSON tidy when a user re-lists a default.
  const dedupe = (xs: string[]) => [...new Set(xs)];
  const readPaths = dedupe([...DEFAULT_SENSITIVE_PATHS, ...cfg.denyRead]);
  const writePaths = dedupe([...DEFAULT_SENSITIVE_PATHS, ...cfg.denyWrite]);

  const sandbox: Record<string, unknown> = {
    enabled: true,
    // Auto-approve Bash commands that run inside the sandbox so we don't fall
    // back to per-command prompts (which would hang a headless agent).
    autoAllowBashIfSandboxed: true,
    // Fail hard if the OS sandbox can't initialize (bubblewrap/socat missing,
    // unsupported platform) instead of silently running unsandboxed. Matches
    // CLAUDE.md's "no silent fallbacks" rule.
    failIfUnavailable: true,
    // Headless agents must never escape the sandbox; an interactive builder may
    // approve an escape via the dangerouslyDisableSandbox retry prompt.
    allowUnsandboxedCommands: interactive,
    network: {
      // NOT a hard boundary under bypass — only pre-approves these domains to
      // avoid Bash prompts. Non-allowlisted domains are still reachable. See the
      // module header "Network is NOT a hard boundary here".
      allowedDomains: cfg.allowedDomains,
    },
    filesystem: {
      // Confines the BASH path only (the OS sandbox governs Bash + children).
      // The file tools are confined separately via permissions.deny below —
      // sandbox.filesystem.denyRead does NOT govern the Read/Edit/Write tools.
      denyRead: readPaths,
    },
  };
  if (cfg.allowWeakerNested) {
    sandbox.enableWeakerNestedSandbox = true;
  }

  // File-tool boundary. Read/Edit/Write bypass the OS sandbox and are governed
  // by the permission system; permissions.deny is honored even under
  // --dangerously-skip-permissions (verified), so it is the only thing that
  // confines the file tools for a non-refusing headless agent. Read uses the
  // read denylist; Write and Edit use the write denylist.
  const deny = dedupe([
    ...readPaths.flatMap((p) => fileToolDenyRules('Read', p)),
    ...writePaths.flatMap((p) => fileToolDenyRules('Write', p)),
    ...writePaths.flatMap((p) => fileToolDenyRules('Edit', p)),
  ]);

  return { sandbox, permissions: { deny } };
}

/**
 * Extra `claude` CLI args for a headless AGENT turn under the configured
 * posture. Agents always also carry `--dangerously-skip-permissions` (added by
 * Agent.buildExecArgs); in sandbox mode we layer the OS sandbox on top via
 * `--settings`. In bypass mode there is nothing to add.
 */
export function buildAgentSandboxArgs(cfg: HostPermissionConfig): string[] {
  if (cfg.mode !== 'sandbox') return [];
  return ['--settings', JSON.stringify(buildSandboxSettings(agentDenies(cfg), /*interactive*/ false))];
}

/**
 * Agent-only additions to the deny lists.
 *
 * The builder scratch dir is the builder's writable exchange area with the
 * HUMAN — deliberately not a channel to agents (see src/builder/scratch.ts).
 * Container agents can't reach it at all (nothing mounts it), but a host-runner
 * agent shares the filesystem with the builder, so it is denied explicitly:
 * without this, `~/.lazy/scratch` would be as readable to an agent as any other
 * path outside the worktree, and the boundary would hold only under Docker.
 *
 * Denies the whole scratch BASE dir, not this project's subdir: an agent has no
 * business in any project's scratch.
 *
 * The lazy daemon BASE dir (`~/.lazy/daemon`, or `LAZY_DAEMON_BASE_DIR`) and
 * the project's external store are denied for the same reason: the daemon dir
 * holds per-task env values, the credential index, file-backend model
 * credentials and every task's MCP tool-access token; the store holds every
 * task's record. They are agent-only rather than in DEFAULT_SENSITIVE_PATHS
 * because the BUILDER's Bash runs the `lazy` CLI, which reads the daemon dir's
 * token and port files to reach the daemon. The agent's own MCP config
 * (`<daemon dir>/<slug>/mcp/`) needs no carve-out: it is read by the `claude`
 * process and the MCP servers it spawns, neither of which runs under the Bash
 * sandbox or goes through the Read tool.
 *
 * Caveat, stated honestly: this covers `permission_mode = "sandbox"`. Under
 * `"bypass"` the host runner has no boundary of any kind (that is what the mode
 * means, and the builder warns about it at launch), so nothing here applies.
 */
function agentDenies(cfg: HostPermissionConfig): HostPermissionConfig {
  const lazyPaths = [getScratchBaseDir(), resolve(getDaemonBaseDir())];
  if (cfg.storePath) lazyPaths.push(cfg.storePath);
  return {
    ...cfg,
    denyRead: [...cfg.denyRead, ...lazyPaths],
    denyWrite: [...cfg.denyWrite, ...lazyPaths],
  };
}

/**
 * Leading permission/sandbox args for the BUILDER launch under the configured
 * posture. Returns the full set of permission-related flags (the caller appends
 * --resume/--model/--effort after these).
 *
 * - sandbox mode, interactive: `--settings <sandbox>` (default prompt mode).
 * - sandbox mode, autonomous : `--settings <sandbox>` + `--dangerously-skip-permissions`.
 * - bypass mode, interactive : `[]` (Claude Code's normal interactive prompts).
 * - bypass mode, autonomous  : `--dangerously-skip-permissions` (full bypass).
 */
export function buildBuilderPermissionArgs(
  cfg: HostPermissionConfig,
  autonomous: boolean,
): string[] {
  if (cfg.mode === 'sandbox') {
    const settings = JSON.stringify(buildSandboxSettings(cfg, /*interactive*/ !autonomous));
    return autonomous
      ? ['--settings', settings, '--dangerously-skip-permissions']
      : ['--settings', settings];
  }
  // bypass mode — previous behavior: only autonomous skips permissions.
  return autonomous ? ['--dangerously-skip-permissions'] : [];
}

/**
 * The absolute store path to deny host agents, from `[storage] external_path`,
 * normalized (`~` expanded, trailing slashes stripped) so the file-tool rules
 * come out as `Read(//abs)` / `Read(//abs/**)` and never `//abs//**`.
 *
 * Two gaps, stated honestly:
 * - A RELATIVE path is skipped rather than resolved. The supervisor-side
 *   caller has no project root, and both callers must build byte-identical
 *   settings (the boundary guard fingerprints what the runner builds).
 * - An EMPTY path means the store is the derived default `~/.lazy/<project>`,
 *   whose name needs an async git lookup this synchronous settings builder
 *   cannot make — so it is not denied here. `lazy init` writes an explicit
 *   external_path, which is the common case.
 */
export function hostSandboxStorePath(
  config: { storage?: { external_path?: string } },
): string | undefined {
  const raw = config.storage?.external_path;
  if (!raw) return undefined;
  const expanded = expandTilde(raw);
  return isAbsolute(expanded) ? resolve(expanded) : undefined;
}

/**
 * The file tools' write boundary on the project root: everything under a task's
 * project root is denied to Write/Edit EXCEPT that task's own worktree and the
 * shared `.git` dir (docs/design/git-pointer-boundary.md, "Project root").
 * Without it an agent's file tools could rewrite the ROOT `lazy.toml` — the one
 * config lazy reads, so the rules of its own next turn — the main checkout, and
 * other tasks' worktrees. Bash needs nothing: the OS sandbox already confines
 * its writes to the worktree (and the git dir Claude Code binds for it).
 *
 * WHY A COMPLEMENT, NOT DENY + ALLOW. Measured on Claude Code 2.1.282 with a
 * fake Messages API (see the design doc):
 *   - deny beats allow, so `allow Edit(<worktree>/**)` cannot carve the
 *     worktree out of `deny Edit(<root>/**)`;
 *   - negated classes (`[!x]`, `[^x]`) are NOT negation, but ranges work;
 *   - matching is CASE-INSENSITIVE (`[.-v]*` matches `wt` through `W`);
 *   - `*` matches a directory and so everything beneath it;
 *   - the Write tool ignores `Write(...)` rules and obeys `Edit(...)` ones.
 * So each directory level on the way down to a kept path gets rules matching
 * every entry name EXCEPT the kept ones — built character by character from
 * ranges that skip both cases of the next kept character — which also covers
 * entries created after launch. Both `Edit` and `Write` rules are emitted:
 * `Write` costs nothing and holds if a later version starts honouring it.
 *
 * Case-insensitivity means a sibling differing from a kept name only in case
 * (`.LAZY`, a worktree `WT`) is not denied. Lazy creates neither, and nothing
 * lazy reads lives there.
 */
export interface ProjectRootWriteScope {
  /** The project root, in every spelling (as lazy knows it, and its realpath). */
  projectRoots: string[];
  /** The data dir name under the root (`.lazy`, or legacy `.workshop`). */
  dataDir: string;
  /** The task worktree's directory name under `<dataDir>/worktrees/`. */
  worktreeName: string;
  /**
   * The user's home dir, in every spelling. When given, everything under it is
   * denied too, except the way down to each project root (and Claude Code's
   * own Bash log dir, {@link HOME_KEEP}). Without it, the Write tool could
   * write `~/.gitconfig`, `~/.zshenv` or `~/Library/LaunchAgents`, each of
   * which runs code outside the sandbox: the fixed sensitive-path list names
   * only a few of those.
   */
  homeDirs?: string[];
}

/**
 * Kept under home besides the project root: `~/.npm/_logs` is one of the
 * few paths Claude Code's macOS sandbox lets Bash write, and an Edit deny
 * there would become a Seatbelt deny that breaks npm inside Bash.
 */
const HOME_KEEP: KeepTree = { '.npm': { _logs: true } };

function mergeKeep(a: KeepTree | true, b: KeepTree | true): KeepTree | true {
  if (a === true || b === true) return true;
  const out: KeepTree = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = out[k] === undefined ? v : mergeKeep(out[k]!, v);
  return out;
}

/** Nested names that stay writable; `true` = the whole subtree. */
type KeepTree = { [name: string]: KeepTree | true };

const GLOB_SPECIAL = /[*?[\]\\!#{}^]/;
const MAX_CODE_UNIT = 0xffff;
/**
 * Class members start at the space. On macOS Claude Code turns every glob
 * `Edit` deny into a Seatbelt `(regex "…")` for Bash, serializing the
 * regex with JSON.stringify, which writes a control character as a `\u00XX`
 * escape SBPL most likely does not read (inferred; the confirmed Mac breakage
 * was a bare `<dir>/.` rule, see namesExcept). Names starting with a control
 * character therefore escape the rules; lazy creates none and reads none.
 */
const MIN_CLASS_CHAR = 0x20;
/**
 * Characters that may END a range. Claude Code's glob-to-regex step for
 * Seatbelt rewrites `*` and `?` even inside a class and backslash-escapes
 * `.^$+{}()|\`, which turns an endpoint like `(` into `\(` and, in a
 * POSIX bracket, moves the range's end to the backslash. `-`, `[`, `]`,
 * `!` and `#` are class syntax in one matcher or another.
 */
const UNSAFE_ENDPOINT = new Set([...'*?[]\\.^$+{}()|-!#"']);
/**
 * Unsafe characters that are still worth matching, as single members at the
 * end of the class (`-` last, where it is literal): names like `.env` and
 * `-x`. The escaped `\.` adds a harmless backslash member in a POSIX bracket.
 */
const SAFE_SINGLES = ['.', '-'];

function assertGlobSafe(what: string, value: string): void {
  if (GLOB_SPECIAL.test(value)) {
    throw new Error(
      `Refusing to launch a host agent: the ${what} "${value}" contains a glob character (* ? [ ] \\ ! # { } ^), ` +
      `so the file-tool write boundary for the project root cannot be expressed exactly. ` +
      `Move the project to a path without those characters, or use the docker runner.`,
    );
  }
}

/**
 * A class matching any single character except `chars` in either case, from
 * the space up. Every range endpoint is a character both of Claude Code's
 * matchers (the file tools', and the Seatbelt regex it derives for Bash on
 * macOS) read literally; see {@link UNSAFE_ENDPOINT}. An unsafe character at
 * the edge of a run is dropped from the class unless it is a
 * {@link SAFE_SINGLES} member — so a name STARTING with, say, `(` right after
 * a kept prefix is not denied. Nothing lazy reads is named that way.
 */
export function anyCharExcept(chars: string[]): string {
  const excluded = new Set(chars.flatMap((c) => [c.toLowerCase(), c.toUpperCase(), c]).map((c) => c.charCodeAt(0)));
  const ranges: string[] = [];
  const singles = new Set<string>();
  const safe = (c: number) => !UNSAFE_ENDPOINT.has(String.fromCharCode(c));
  let c = MIN_CLASS_CHAR;
  while (c <= MAX_CODE_UNIT) {
    if (excluded.has(c)) { c++; continue; }
    let end = c;
    while (end + 1 <= MAX_CODE_UNIT && !excluded.has(end + 1)) end++;
    let lo = c;
    let hi = end;
    c = end + 1;
    for (; lo <= hi && !safe(lo); lo++) if (SAFE_SINGLES.includes(String.fromCharCode(lo))) singles.add(String.fromCharCode(lo));
    for (; hi >= lo && !safe(hi); hi--) if (SAFE_SINGLES.includes(String.fromCharCode(hi))) singles.add(String.fromCharCode(hi));
    if (lo > hi) continue;
    ranges.push(lo === hi ? String.fromCharCode(lo) : `${String.fromCharCode(lo)}-${String.fromCharCode(hi)}`);
  }
  const tail = SAFE_SINGLES.filter((x) => singles.has(x) && x !== '-');
  if (singles.has('-')) tail.push('-');
  return `[${ranges.join('')}${tail.join('')}]`;
}

/**
 * Glob patterns (relative to their directory) matching every entry name NOT in
 * `keep`. A character trie over the kept names: at each prefix, "prefix + any
 * other next character", the prefix itself unless it is kept, and past a kept
 * name, any longer name.
 */
/** `name` as a pattern matching only itself, with a class so it stays a glob. */
function asGlob(name: string): string {
  const last = name[name.length - 1]!;
  // `-` or `.` alone in a class is literal; the class syntax characters
  // (including `^`, which would make `[^]`) are refused by assertGlobSafe.
  return `${name.slice(0, -1)}[${last}]`;
}

function namesExcept(keep: string[]): string[] {
  const out: string[] = [];
  const walk = (prefix: string, names: string[]) => {
    const terminal = names.includes(prefix);
    const longer = names.filter((n) => n.length > prefix.length);
    // `.` and `..` are the directory itself (and its parent), never an entry.
    // Claude Code realpaths a non-glob rule, so `<dir>/.` became `<dir>`, and
    // on macOS a Seatbelt subpath deny on the whole dir: Bash could not write
    // its own worktree (`root / control` BLOCKED on a Mac).
    // Spelled with its last character as a one-character class, so it is a
    // GLOB to Claude Code: a non-glob rule is realpathed, and a symlink of that
    // name into a kept path would turn it into a subpath deny on its target.
    if (prefix && !terminal && prefix !== '.' && prefix !== '..') out.push(asGlob(prefix));
    const next = [...new Set(longer.map((n) => n[prefix.length]!))];
    if (next.length === 0) {
      out.push(`${prefix}?*`);
      return;
    }
    out.push(`${prefix}${anyCharExcept(next)}*`);
    // Case-fold the branches: the matcher does, so `W` and `w` are one branch.
    const byFold = new Map<string, string[]>();
    for (const n of longer) {
      const k = n[prefix.length]!.toLowerCase();
      byFold.set(k, [...(byFold.get(k) ?? []), n]);
    }
    for (const group of byFold.values()) walk(prefix + group[0]![prefix.length]!, group);
  };
  walk('', keep);
  return out;
}

function complementRules(dir: string, keep: KeepTree): string[] {
  const names = Object.keys(keep);
  const rules = namesExcept(names).map((p) => `${dir}/${p}`);
  for (const n of names) {
    const sub = keep[n]!;
    if (sub !== true) rules.push(...complementRules(`${dir}/${n}`, sub));
  }
  return rules;
}

/**
 * The `Edit(...)` / `Write(...)` deny rules for {@link ProjectRootWriteScope}.
 * Throws when a path or name contains a glob character (the rule would not
 * mean what it says) — the launch fails loudly rather than running unconfined.
 */
export function projectRootWriteDenyRules(scope: ProjectRootWriteScope): string[] {
  assertGlobSafe('worktree name', scope.worktreeName);
  assertGlobSafe('data dir name', scope.dataDir);
  const keep: KeepTree = { '.git': true, [scope.dataDir]: { worktrees: { [scope.worktreeName]: true } } };
  const rules: string[] = [];
  const roots = [...new Set(scope.projectRoots.map((r) => r.replace(/\/+$/, '')))];
  for (const home of [...new Set((scope.homeDirs ?? []).map((h) => h.replace(/\/+$/, '')))]) {
    if (!home) continue;
    assertGlobSafe('home directory', home);
    let homeKeep: KeepTree | true = HOME_KEEP;
    for (const root of roots) {
      if (root !== home && !root.startsWith(`${home}/`)) continue;
      let sub: KeepTree | true = keep;
      for (const seg of root.slice(home.length).split('/').filter(Boolean).reverse()) sub = { [seg]: sub };
      homeKeep = mergeKeep(homeKeep, sub);
    }
    if (homeKeep !== true) rules.push(...complementRules(`/${home}`, homeKeep).flatMap((p) => [`Edit(${p})`, `Write(${p})`]));
  }
  for (const root of roots) {
    assertGlobSafe('project root', root);
    // The shared git dir stays writable (Bash needs its index and objects for
    // `git add`), except the two files whose content makes the daemon's next
    // git run code: config (core.fsmonitor, hooksPath, sshCommand) and hooks.
    // Claude Code already ro-binds both for Bash (captured bwrap argv), so these
    // Edit denies cost Bash nothing.
    const gitExec = [`/${root}/.git/config`, `/${root}/.git/hooks`, `/${root}/.git/hooks/**`];
    for (const pattern of [...complementRules(`/${root}`, keep), ...gitExec]) {
      rules.push(`Edit(${pattern})`, `Write(${pattern})`);
    }
  }
  return [...new Set(rules)];
}

/**
 * Agent extra args with {@link projectRootWriteDenyRules} added to their
 * `--settings` deny list. Args with no `--settings` (container runners, bypass
 * mode) come back unchanged: there is no host sandbox posture to extend.
 */
export function withProjectRootWriteDenyArgs(
  extraArgs: string[] | undefined,
  scope: ProjectRootWriteScope,
): string[] | undefined {
  if (!extraArgs) return extraArgs;
  const i = extraArgs.indexOf('--settings');
  if (i < 0 || extraArgs[i + 1] === undefined) return extraArgs;
  const settings = JSON.parse(extraArgs[i + 1]!) as { permissions?: { deny?: string[] } };
  settings.permissions = {
    ...settings.permissions,
    deny: [...new Set([...(settings.permissions?.deny ?? []), ...projectRootWriteDenyRules(scope)])],
  };
  const out = [...extraArgs];
  out[i + 1] = JSON.stringify(settings);
  return out;
}

/**
 * Placeholder scope the boundary guard probes with. The probe script swaps
 * {@link PROBE_PROJECT_ROOT} for a real project root it builds, with a real
 * worktree named `worktreeName`, so the rules it tests are exactly the ones
 * {@link projectRootWriteDenyRules} emits, not a copy.
 */
export const PROBE_PROJECT_ROOT = '/__lazy_probe_home__/.lazy-boundary-probe';
/** Swapped by the probe for its `$HOME`; the probe root lives under it, as a real project root usually does. */
export const PROBE_HOME = '/__lazy_probe_home__';
export const PROBE_PROJECT_ROOT_SCOPE: ProjectRootWriteScope = {
  homeDirs: [PROBE_HOME],
  projectRoots: [PROBE_PROJECT_ROOT],
  dataDir: '.lazy',
  worktreeName: 'probe-wt',
};

/**
 * What a host agent must not write to keep the git-pointer boundary
 * (docs/design/git-pointer-boundary.md). A task container gets read-only
 * copies mounted over the pointers; the host runner has no mount namespace of
 * lazy's own, so they are denied to Claude Code's sandbox instead — per
 * WORKTREE, which is why they are applied to a finished `--settings` value
 * rather than living in {@link HostPermissionConfig}.
 */
export interface GitPointerDenyPaths {
  /**
   * Files and dirs whose content decides what the next git outside the
   * sandbox runs: this worktree's three pointers (every spelling), the common
   * `config` and `hooks`, and every OTHER task worktree's pointers. Denied to
   * Bash and to both file tools.
   */
  protectedPaths: string[];
  /**
   * The project's shared git dir (every spelling), denied to the Write tool as a whole — it
   * bypasses the OS sandbox and could otherwise create files anywhere in it.
   * Deliberately NOT an Edit or sandbox deny: Claude Code turns Edit denies
   * into read-only binds for Bash, and Bash must keep writing the index and
   * objects in there for `git add` (merge-conflict turns stage with it).
   */
  commonDirs: string[];
}

/**
 * Add the git-pointer denies to a settings object built by
 * {@link buildSandboxSettings}.
 *
 * Measured against Claude Code 2.1.282 on Linux (its real bwrap argv, captured
 * with a stub bwrap and a fake Messages API — see the design doc): for a
 * linked worktree it binds the worktree AND the common git dir writable, and
 * on its own ro-binds `<worktree>/.git`, `<gitdir>/commondir`, `<common>/config`
 * and `<common>/hooks` — but NOT `<gitdir>/gitdir`, and not the pointers of
 * any OTHER worktree under `<common>/worktrees`. So:
 *
 *   - `sandbox.filesystem.denyWrite` on {@link GitPointerDenyPaths.protectedPaths}
 *     closes the Bash gaps and keeps the native ones if a Claude Code version
 *     drops them.
 *   - Edit denies on the same paths, and a Write deny on the whole common dir,
 *     confine the file tools, which bypass the OS sandbox.
 *
 * `scripts/host-sandbox-probe.sh --guard` re-verifies against real sessions
 * ({@link PROBE_GIT_POINTERS}).
 */
export function applyGitPointerDenies(
  settings: { sandbox: Record<string, unknown>; permissions: { deny: string[] } },
  paths: GitPointerDenyPaths,
): void {
  const fs = (settings.sandbox.filesystem ??= {}) as Record<string, unknown>;
  const existing = Array.isArray(fs.denyWrite) ? (fs.denyWrite as string[]) : [];
  fs.denyWrite = [...new Set([...existing, ...paths.protectedPaths])];
  settings.permissions.deny = [...new Set([
    ...settings.permissions.deny,
    ...[...paths.protectedPaths, ...paths.commonDirs].flatMap((p) => fileToolDenyRules('Write', p)),
    ...paths.protectedPaths.flatMap((p) => fileToolDenyRules('Edit', p)),
  ])];
}

/** {@link applyGitPointerDenies} on a serialized `--settings` value. */
export function withGitPointerDenies(settingsJson: string, paths: GitPointerDenyPaths): string {
  const settings = JSON.parse(settingsJson) as { sandbox?: Record<string, unknown>; permissions?: { deny?: string[] } };
  if (!settings.sandbox || typeof settings.sandbox !== 'object') {
    throw new Error('the host agent --settings value has no sandbox object to add the git-pointer denies to');
  }
  const shaped = {
    ...settings,
    sandbox: settings.sandbox,
    permissions: { ...settings.permissions, deny: settings.permissions?.deny ?? [] },
  };
  applyGitPointerDenies(shaped, paths);
  return JSON.stringify(shaped);
}

/**
 * Agent extra args with the git-pointer denies added to their `--settings`.
 * Args with no `--settings` (docker/podman, bypass mode) come back unchanged:
 * there is no sandbox to add them to — a container has its own mount layer,
 * and bypass has no boundary by definition.
 */
export function withGitPointerDenyArgs(
  extraArgs: string[] | undefined,
  paths: GitPointerDenyPaths,
): string[] | undefined {
  if (!extraArgs) return extraArgs;
  const i = extraArgs.indexOf('--settings');
  if (i < 0 || extraArgs[i + 1] === undefined) return extraArgs;
  const out = [...extraArgs];
  out[i + 1] = withGitPointerDenies(extraArgs[i + 1]!, paths);
  return out;
}

/**
 * Placeholder paths the boundary guard probes with. The probe script rewrites
 * these prefixes to a real worktree it creates, so the rules it tests are the
 * ones {@link applyGitPointerDenies} emits, not a copy.
 */
export const PROBE_GIT_POINTERS: GitPointerDenyPaths = {
  protectedPaths: [
    '/__lazy_probe_worktree__/.git',
    '/__lazy_probe_gitdir__/commondir',
    '/__lazy_probe_gitdir__/gitdir',
    '/__lazy_probe_common__/config',
    '/__lazy_probe_common__/hooks',
  ],
  commonDirs: ['/__lazy_probe_common__'],
};
