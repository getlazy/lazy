/**
 * Host permission posture — the contract that keeps headless host agents safe.
 *
 * These tests encode the design decision from SPIKE-host-first-runner.md and the
 * task "Host execution defaults to Claude's OS sandbox + auto-approval":
 * host agents and the host builder default to Claude Code's OS sandbox instead of
 * the old hardcoded `--dangerously-skip-permissions`, and full bypass remains an
 * explicit opt-in.
 *
 * Because Claude Code's OS sandbox cannot be exercised end-to-end in CI (it needs
 * bubblewrap + unprivileged user namespaces on Linux, or Seatbelt on macOS, plus a
 * live Claude session), these tests verify the *arguments* lazy hands to Claude —
 * the verifiable contract. The runtime deny-vs-hang behavior is documented in the
 * task summary and must be confirmed on a real host.
 */

import { describe, test, expect } from 'bun:test';
import {
  buildSandboxSettings,
  buildAgentSandboxArgs,
  buildBuilderPermissionArgs,
  type HostPermissionConfig,
} from '../../src/runner/host-sandbox';
import { ClaudeCodeAgent } from '../../src/agent/claude-code';
import { commonCommandFields } from '../../src/protocol/io';
import { DEFAULT_CONFIG } from '../../src/config/loader';
import type { ResolvedConfig } from '../../src/config/types';

const SANDBOX: HostPermissionConfig = {
  mode: 'sandbox',
  allowedDomains: ['*.anthropic.com'],
  allowWeakerNested: false,
  denyRead: [],
  denyWrite: [],
};
const BYPASS: HostPermissionConfig = {
  mode: 'bypass',
  allowedDomains: ['*.anthropic.com'],
  allowWeakerNested: false,
  denyRead: [],
  denyWrite: [],
};

/** Parse the JSON that follows a `--settings` flag in an arg list. */
function settingsFrom(args: string[]): any {
  const i = args.indexOf('--settings');
  expect(i).toBeGreaterThanOrEqual(0);
  return JSON.parse(args[i + 1]);
}

describe('buildSandboxSettings', () => {
  test('enables the OS sandbox and fails hard if it cannot start', () => {
    const { sandbox } = buildSandboxSettings(SANDBOX, /*interactive*/ false);
    expect(sandbox.enabled).toBe(true);
    // INVARIANT: no silent fallback to an unsandboxed agent (CLAUDE.md "no silent
    // fallbacks"). If bubblewrap/Seatbelt can't start, Claude must error out.
    expect(sandbox.failIfUnavailable).toBe(true);
    // Auto-approve sandboxed Bash so a headless agent is not stopped by per-command prompts.
    expect(sandbox.autoAllowBashIfSandboxed).toBe(true);
  });

  test('domain allowlist is nested at sandbox.network.allowedDomains (schema-correct)', () => {
    const { sandbox } = buildSandboxSettings(
      { ...SANDBOX, allowedDomains: ['*.anthropic.com', 'registry.npmjs.org'] },
      false,
    );
    // The Claude Code settings schema nests the allowlist under network — NOT a
    // top-level sandbox.allowedDomains (that key does nothing). Guard against the
    // spike's original mistake.
    expect((sandbox as any).network.allowedDomains).toEqual(['*.anthropic.com', 'registry.npmjs.org']);
    expect((sandbox as any).allowedDomains).toBeUndefined();
  });

  test('blocks Bash reads of credential stores', () => {
    const { sandbox } = buildSandboxSettings(SANDBOX, false);
    const denyRead: string[] = (sandbox as any).filesystem.denyRead;
    expect(denyRead).toContain('~/.ssh');
    expect(denyRead).toContain('~/.aws');
  });

  // INVARIANT: the Read/Edit/Write FILE TOOLS bypass the OS sandbox (it governs
  // only Bash + children) — verified on macOS, Claude Code v2.1.170. They are
  // confined separately via permissions.deny, which IS honored even under
  // --dangerously-skip-permissions. Without these rules a non-refusing headless
  // agent could Read ~/.ssh or Write outside the worktree with the file tools.
  // Runtime enforcement was verified manually on macOS (the OS sandbox cannot run
  // in the build container); these tests assert the --settings contract lazy emits.
  describe('file-tool boundary (permissions.deny)', () => {
    // Resolve ~ the same way the implementation does, so assertions match the
    // emitted absolute-path rules regardless of the test host's $HOME.
    const home = process.env.HOME || '';
    const abs = (p: string) => p.replace(/^~/, home);
    // Rules use the '//abs' form: an extra leading slash before the absolute path.
    const rule = (tool: string, p: string) => `${tool}(/${abs(p)})`;
    const ruleGlob = (tool: string, p: string) => `${tool}(/${abs(p)}/**)`;

    test('default sensitive paths are denied for Read, Write, and Edit', () => {
      const { permissions } = buildSandboxSettings(SANDBOX, false);
      const deny = permissions.deny;
      for (const tool of ['Read', 'Write', 'Edit']) {
        // ~/.ssh as a representative credential store; both the path and its subtree.
        expect(deny).toContain(rule(tool, '~/.ssh'));
        expect(deny).toContain(ruleGlob(tool, '~/.ssh'));
      }
      // Shell rc files and ~/.claude* are part of the baseline (tampering/persistence).
      expect(deny).toContain(rule('Write', '~/.bashrc'));
      expect(deny).toContain(rule('Edit', '~/.claude.json'));
    });

    test('the file-tool deny rules use the absolute //abs form, not a bare ~', () => {
      const { permissions } = buildSandboxSettings(SANDBOX, false);
      // ~ must be expanded — Claude Code's Read/Edit/Write path matcher does not
      // understand ~; a leftover tilde would silently match nothing.
      expect(permissions.deny.some((r) => r.includes('~'))).toBe(false);
      expect(permissions.deny.some((r) => r.startsWith('Read(//'))).toBe(true);
    });

    test('user deny_read/deny_write MERGE with the defaults, never replace them', () => {
      const { permissions } = buildSandboxSettings(
        { ...SANDBOX, denyRead: ['~/.kube'], denyWrite: ['/etc/secrets'] },
        false,
      );
      const deny = permissions.deny;
      // User extras are present...
      expect(deny).toContain(rule('Read', '~/.kube'));
      expect(deny).toContain(rule('Write', '/etc/secrets'));
      expect(deny).toContain(rule('Edit', '/etc/secrets'));
      // ...AND the built-in defaults survive (not replaced).
      expect(deny).toContain(rule('Read', '~/.ssh'));
      // deny_read does not leak into Write, and deny_write does not leak into Read.
      expect(deny).not.toContain(rule('Write', '~/.kube'));
      expect(deny).not.toContain(rule('Read', '/etc/secrets'));
    });

    test('the builder also carries the file-tool deny rules (defense in depth)', () => {
      // The interactive builder prompts, so the urgency is lower, but applying the
      // same baseline hard-denies the sensitive paths instead of prompting for them.
      const { permissions } = buildSandboxSettings(SANDBOX, /*interactive*/ true);
      expect(permissions.deny).toContain(rule('Read', '~/.ssh'));
    });
  });

  // INVARIANT: a HEADLESS agent must never be able to retry a denied command
  // OUTSIDE the sandbox. The OS sandbox is the SOLE hard boundary, so the
  // dangerouslyDisableSandbox escape hatch is disabled for agents.
  test('agents disable the unsandboxed escape hatch; the builder allows it', () => {
    const agentSb = buildSandboxSettings(SANDBOX, /*interactive*/ false).sandbox;
    expect(agentSb.allowUnsandboxedCommands).toBe(false);

    // The interactive builder has a human who can approve an escape via the prompt.
    const builderSb = buildSandboxSettings(SANDBOX, /*interactive*/ true).sandbox;
    expect(builderSb.allowUnsandboxedCommands).toBe(true);
  });

  test('weaker nested sandbox is opt-in only', () => {
    expect((buildSandboxSettings(SANDBOX, false).sandbox as any).enableWeakerNestedSandbox).toBeUndefined();
    const weaker = buildSandboxSettings({ ...SANDBOX, allowWeakerNested: true }, false).sandbox;
    expect((weaker as any).enableWeakerNestedSandbox).toBe(true);
  });
});

describe('buildAgentSandboxArgs (headless agents)', () => {
  test('sandbox mode layers --settings on top of bypass', () => {
    const args = buildAgentSandboxArgs(SANDBOX);
    expect(args[0]).toBe('--settings');
    expect(settingsFrom(args).sandbox.enabled).toBe(true);
  });

  // INVARIANT: "bypass" is the explicit full-bypass opt-in — no sandbox is added,
  // leaving only the --dangerously-skip-permissions that buildExecArgs already sets.
  test('bypass mode adds nothing', () => {
    expect(buildAgentSandboxArgs(BYPASS)).toEqual([]);
  });
});

describe('headless agent launch (ClaudeCodeAgent + sandbox args)', () => {
  // INVARIANT: headless agents run sandbox + bypassPermissions. They ALWAYS keep
  // --dangerously-skip-permissions (so they never block on an interactive prompt)
  // AND, in sandbox mode, carry the OS-sandbox --settings (so they are confined).
  // This is the combination that can never hang a headless `-p` session.
  test('agent gets both --dangerously-skip-permissions and the sandbox --settings', () => {
    const agent = new ClaudeCodeAgent();
    const args = agent.buildExecArgs({
      prompt: 'do work',
      dangerouslySkipPermissions: true,
      extraArgs: buildAgentSandboxArgs(SANDBOX),
    });
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toContain('--settings');
    expect(settingsFrom(args).sandbox.enabled).toBe(true);
    // The interactive prompting mode `--permission-mode auto` is NEVER used for
    // headless agents — the spike found it aborts headless sessions.
    expect(args).not.toContain('auto');
  });
});

describe('buildBuilderPermissionArgs', () => {
  test('sandbox + interactive: sandbox settings, no bypass flag', () => {
    const args = buildBuilderPermissionArgs(SANDBOX, /*autonomous*/ false);
    expect(args).toContain('--settings');
    expect(args).not.toContain('--dangerously-skip-permissions');
    // Interactive builder can approve escapes.
    expect(settingsFrom(args).sandbox.allowUnsandboxedCommands).toBe(true);
  });

  test('sandbox + autonomous: sandbox settings AND bypass (never prompts)', () => {
    const args = buildBuilderPermissionArgs(SANDBOX, /*autonomous*/ true);
    expect(args).toContain('--settings');
    expect(args).toContain('--dangerously-skip-permissions');
    // No human to approve escapes → escape hatch disabled.
    expect(settingsFrom(args).sandbox.allowUnsandboxedCommands).toBe(false);
  });

  test('bypass + interactive: nothing (normal Claude prompts)', () => {
    expect(buildBuilderPermissionArgs(BYPASS, false)).toEqual([]);
  });

  test('bypass + autonomous: full bypass, no sandbox', () => {
    const args = buildBuilderPermissionArgs(BYPASS, true);
    expect(args).toEqual(['--dangerously-skip-permissions']);
  });
});

describe('commonCommandFields wires the posture into agent turns', () => {
  function cfg(over: Partial<ResolvedConfig['runner']>, agentId = 'claude-code'): ResolvedConfig {
    return {
      ...DEFAULT_CONFIG,
      agent: { ...DEFAULT_CONFIG.agent, agent_id: agentId },
      runner: { ...DEFAULT_CONFIG.runner, ...over },
    };
  }

  test('host + sandbox + claude-code: command carries sandbox --settings', () => {
    const fields = commonCommandFields(cfg({ type: 'dangerously-host-process-without-any-isolation', permission_mode: 'sandbox' }));
    expect(fields.agent_extra_args?.[0]).toBe('--settings');
    expect(settingsFrom(fields.agent_extra_args!).sandbox.enabled).toBe(true);
  });

  // INVARIANT: docker/podman commands stay unchanged — the container is the
  // boundary, and the in-container agent keeps plain --dangerously-skip-permissions.
  test('docker runner: no agent_extra_args', () => {
    expect(commonCommandFields(cfg({ type: 'docker' })).agent_extra_args).toBeUndefined();
  });

  test('host + bypass: no agent_extra_args (explicit full-bypass opt-in)', () => {
    expect(commonCommandFields(cfg({ type: 'dangerously-host-process-without-any-isolation', permission_mode: 'bypass' })).agent_extra_args).toBeUndefined();
  });

  // --settings is Claude-Code-specific; a non-Claude agent (cursor/qa) must not
  // receive it on its command line.
  test('host + sandbox + non-claude agent: no agent_extra_args', () => {
    expect(commonCommandFields(cfg({ type: 'dangerously-host-process-without-any-isolation', permission_mode: 'sandbox' }, 'cursor')).agent_extra_args).toBeUndefined();
  });

  test('the file-tool deny rules flow through into the command settings', () => {
    const fields = commonCommandFields(cfg({
      type: 'dangerously-host-process-without-any-isolation',
      permission_mode: 'sandbox',
    }));
    const settings = settingsFrom(fields.agent_extra_args!);
    expect(Array.isArray(settings.permissions.deny)).toBe(true);
    expect(settings.permissions.deny.some((r: string) => r.startsWith('Read(//'))).toBe(true);
  });

  test('custom allowlist flows through into the command settings', () => {
    const fields = commonCommandFields(cfg({
      type: 'dangerously-host-process-without-any-isolation',
      permission_mode: 'sandbox',
      sandbox_allowed_domains: ['*.anthropic.com', 'github.com'],
    }));
    expect(settingsFrom(fields.agent_extra_args!).sandbox.network.allowedDomains).toEqual(['*.anthropic.com', 'github.com']);
  });
});
