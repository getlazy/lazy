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
import { expandTilde } from '../utils/home';
import { getScratchBaseDir } from '../builder/scratch';

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
 * Caveat, stated honestly: this covers `permission_mode = "sandbox"`. Under
 * `"bypass"` the host runner has no boundary of any kind (that is what the mode
 * means, and the builder warns about it at launch), so nothing here applies.
 */
function agentDenies(cfg: HostPermissionConfig): HostPermissionConfig {
  const scratchBase = getScratchBaseDir();
  return {
    ...cfg,
    denyRead: [...cfg.denyRead, scratchBase],
    denyWrite: [...cfg.denyWrite, scratchBase],
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
