import type { RunnerType } from '../config/types';

/**
 * Build-time flag — see src/cli/editor.ts. Inline `typeof LAZY_RELEASE_BUILD`
 * at each use site so bun eliminates the test seam from release binaries.
 */
declare const LAZY_RELEASE_BUILD: boolean;

/**
 * Canonical runner type for host-process execution.
 *
 * Kept as an internal {@link RunnerType} value for the fake-binary e2e seam
 * (`setupTestLazy({ fakeClaude: true })`) and other test-only harnesses. It is
 * NOT a user-facing config choice — lazy.toml and per-task overrides that name
 * it are rejected unless {@link isHostRunnerConfigAllowed} is true.
 */
export const HOST_RUNNER_TYPE = 'dangerously-host-process-without-any-isolation' as const satisfies RunnerType;

/** User-typed aliases for the removed host runner — rejected before alias resolution. */
const REMOVED_HOST_RUNNER_INPUTS = new Set([
  'host',
  'host-process',
  HOST_RUNNER_TYPE,
]);

export function isHostRunnerType(type: string): type is typeof HOST_RUNNER_TYPE {
  return type === HOST_RUNNER_TYPE;
}

/**
 * Whether lazy.toml / per-task overrides may select the host-process runner.
 *
 * Set only by the test harness (`LAZY_ALLOW_HOST_RUNNER=1` in baseEnv, including
 * on the daemon for fake-binary suites). Production and normal e2e never set it.
 *
 * Separate from `LAZY_TEST` on purpose: daemon-backed e2e contexts pin
 * `LAZY_TEST=''` on every spawned process so the CLI talks to the real test
 * daemon instead of bypassing storage. A gate keyed on LAZY_TEST would never
 * reach that daemon and the fake-binary seam would break.
 *
 * Gated on `typeof LAZY_RELEASE_BUILD === 'undefined'` so a released binary
 * cannot re-enable a removed runner via env — same pattern as the prompt seams
 * in src/cli/editor.ts (must stay inline or bun stops eliminating it).
 */
export function isHostRunnerConfigAllowed(): boolean {
  return typeof LAZY_RELEASE_BUILD === 'undefined' && process.env.LAZY_ALLOW_HOST_RUNNER === '1';
}

/** Actionable error when a user-facing surface names the removed host runner. */
export function hostRunnerRemovedMessage(context?: string): string {
  const where = context ? ` (${context})` : '';
  return (
    `Host-process runner is no longer supported${where}. ` +
    `Lazy requires Docker (or Podman) to run agents in isolated containers. ` +
    `Set [runner] type = "docker" in lazy.toml and ensure Docker is running. ` +
    `Run \`lazy doctor\` for details.`
  );
}

export function hostRunnerRemovedError(context?: string): Error {
  return new Error(hostRunnerRemovedMessage(context));
}

/** Fail closed when config or overrides name the host-process runner outside tests. */
export function assertHostRunnerConfigAllowed(context?: string): void {
  if (!isHostRunnerConfigAllowed()) {
    throw hostRunnerRemovedError(context);
  }
}

/**
 * True when CLI/MCP `--runner` input names the removed host runner (including
 * legacy aliases). Call before {@link resolveRunnerType} so the error names
 * docker rather than "invalid runner".
 */
export function isRemovedHostRunnerInput(input: string): boolean {
  return REMOVED_HOST_RUNNER_INPUTS.has(input.trim().toLowerCase());
}
