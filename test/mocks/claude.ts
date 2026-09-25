/**
 * Mock implementation of src/capture/claude.ts for e2e tests.
 *
 * Reads mock response from LAZY_MOCK_CLAUDE_RESPONSE env var.
 * Optionally makes real git commits when LAZY_MOCK_SHOULD_COMMIT=1.
 *
 * Must export every symbol that source files import from capture/claude.
 */

import type { AgentResponse, TokenUsage } from '../../src/types';
// Imported, not restated: this module REPLACES src/capture/claude.ts, and a mock
// that invents its own tag shape keeps passing after the real one changes.
// src/capture/image-tag.ts is a separate module, so importing it here is not
// circular — the preload only aliases capture/claude.
import { IMAGE_TAG, IMAGE_NAME, IMAGE_MAX_AGE_DAYS, IMAGE_MAX_AGE_MS } from '../../src/capture/image-tag';
import { AGENT_SELFCHECK_SENTINEL } from '../../src/agent/binary-identity';
import { getMockResponse } from './mock-response';
import { listUncommittedPaths } from '../../src/git/operations';
// Same reasoning as image-tag above: the placeholder SHAPE and the launch env
// SHAPE are production's to define, so the mock borrows both rather than
// inventing look-alikes that would drift. None of these modules imports
// capture/claude, so the preload alias cannot make them circular.
import { placeholderValueFor } from '../../src/proxy/credential-broker';
import { isCredentialEnvKey } from '../../src/utils/redact';
import {
  targetEnvVars,
  ANTHROPIC_DEFAULT_TARGET,
  LOCAL_BACKEND_CREDS,
  usesSyntheticCreds,
  type ProxyAuditHints,
  type LaunchSurface,
} from '../../src/utils/role-target';
import type { LaunchIdentity } from '../../src/proxy/placeholder-env';
import type { RoleTarget } from '../../src/config/types';
// The wrap-up's present step is PROMPTED from the real md template (static, no
// placeholders) — the mock records it verbatim on the supervised response,
// exactly what the real supervisor sends, so e2e can assert the §6.2 prompt
// content. maintain/react keep hand-written prompts because theirs interpolate
// entries.
import presentRegionsTemplate from '../../src/prompts/present-regions.md' with { type: 'text' };
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdir, writeFile } from 'fs/promises';
// Sync, because the symbol it serves (isContainerRunning) is sync. Test-harness
// code, so the no-sync-fs rule for src/ does not reach it.
import { existsSync } from 'fs';

export { IMAGE_TAG, IMAGE_MAX_AGE_DAYS, IMAGE_MAX_AGE_MS };
const MOCK_IMAGE_REF = `${IMAGE_NAME}:${IMAGE_TAG}`;

export interface SandboxConfig {
  worktreePath: string;
  sandboxPath: string;
}

export function checkDocker(): void {
  // No-op in tests
}

export async function ensureImage(
  _binary?: string,
  options?: { pinnedImage?: string },
): Promise<string> {
  // Honor a task pin when present so e2e paths that thread metadata still see
  // the pinned ref (fail-loud for a missing pin is covered by unit tests
  // against the real ensureImage + fake docker).
  if (options?.pinnedImage) return options.pinnedImage;
  return MOCK_IMAGE_REF;
}

export async function localImageExists(_ref: string, _binary?: string): Promise<boolean> {
  // E2e mock: treat every ref as present so CLI "already pinned" skips do not
  // re-offer. Missing-image fail-loud is unit-tested against real ensureImage.
  return true;
}

export async function buildImageFromDockerfilePath(
  _lazyRoot: string,
  dockerfilePath: string,
  _options?: { binary?: string; noCache?: boolean; timeoutMs?: number },
): Promise<{ imageName: string; contentHash: string; contextDir: string }> {
  const { dirname } = await import('path');
  return {
    imageName: `lazy-custom-testhash12:${IMAGE_TAG}`,
    contentHash: 'a'.repeat(64),
    // The build context is the directory holding the consented Dockerfile.
    contextDir: dirname(dockerfilePath),
  };
}

/**
 * Mock of `buildLazyRunnerImage` that records its options to
 * `LAZY_MOCK_BUILD_LOG` (a file path) when set, so tests can verify that
 * `--no-cache` and similar flags were passed through correctly.
 */
export async function buildLazyRunnerImage(
  options: { binary?: string; noCache?: boolean; timeoutMs?: number } = {}
): Promise<string[]> {
  const logPath = process.env.LAZY_MOCK_BUILD_LOG;
  if (logPath) {
    const { appendFile } = await import('fs/promises');
    await appendFile(
      logPath,
      JSON.stringify({ binary: options.binary ?? 'docker', noCache: options.noCache ?? false, timeoutMs: options.timeoutMs ?? 0 }) + '\n'
    );
  }
  return [MOCK_IMAGE_REF, 'lazy-runner:latest'];
}

export function resolveImageName(_lazyRoot: string): string {
  return MOCK_IMAGE_REF;
}

/**
 * Mirrors the real module's upgrade-rebuild decision. There is no container
 * runtime here to inspect, so the mock always says "rebuild" — the same answer
 * the real function gives when it cannot read an image, and the answer that
 * keeps e2e exercising the full upgrade path without an interactive question.
 * Suites that need the ASK branch cover it against the real function.
 */
export async function evaluateUpgradeRebuild(
  _lazyRoot: string,
  _binary?: string,
  _agentId?: string,
): Promise<{ verdict: 'rebuild' | 'ask'; reason: string; imageName: string; builtAgo?: string }> {
  return { verdict: 'rebuild', reason: `${MOCK_IMAGE_REF} is not built on this host`, imageName: MOCK_IMAGE_REF };
}

/**
 * Mirrors the real module's upgrade-build latch: off unless the command under
 * test is `lazy upgrade`. Soft-pin vs path-resolve for daemon adoption depends
 * on this; without the export, upgrade e2e would die with "not a function".
 */
let upgradeImageBuildEnabled = false;

export function enableUpgradeImageBuild(): void {
  upgradeImageBuildEnabled = true;
}

export function resetUpgradeImageBuild(): void {
  upgradeImageBuildEnabled = false;
}

export function isUpgradeImageBuild(): boolean {
  return upgradeImageBuildEnabled;
}

/**
 * Mirrors the real resolution: a valid daemon-adopted worktree Dockerfile ONLY
 * while the upgrade-build latch is on, else [docker].dockerfile. Routine
 * launches soft-pin adoption in ensureImage and must not resolve the worktree
 * path here.
 */
export async function resolveCustomDockerfile(lazyRoot: string): Promise<string | null> {
  if (upgradeImageBuildEnabled) {
    const { resolveAdoptedDockerfileSnapshot } = await import('../../src/daemon/adopted-image');
    const snapshot = await resolveAdoptedDockerfileSnapshot(lazyRoot);
    if (snapshot) return snapshot;
  }
  const { loadConfig } = await import('../../src/config/loader');
  const config = await loadConfig(lazyRoot);
  if (!config.docker.dockerfile) return null;
  return join(lazyRoot, config.docker.dockerfile);
}

export async function isAdoptedDockerfile(
  lazyRoot: string,
  dockerfilePath: string | null,
): Promise<boolean> {
  if (!dockerfilePath) return false;
  if (!upgradeImageBuildEnabled) return false;
  const { getAdoptedDockerfilePath } = await import('../../src/daemon/paths');
  const { loadValidAdoptedImage } = await import('../../src/daemon/adopted-image');
  const adopted = await loadValidAdoptedImage(lazyRoot);
  if (!adopted) return false;
  return dockerfilePath === getAdoptedDockerfilePath(lazyRoot);
}

export function resolveImageRepository(_lazyRoot: string): { repository: string; isCustom: boolean } {
  return { repository: 'lazy-runner', isCustom: false };
}

export async function resolveImageBuildTags(_lazyRoot: string): Promise<string[]> {
  return [MOCK_IMAGE_REF, 'lazy-runner:latest'];
}

/**
 * Mock of the staged image build used by `lazy upgrade`'s background rebuild.
 * Records its options to LAZY_MOCK_BUILD_LOG (same channel as
 * buildLazyRunnerImage) so tests can assert the staging tag and --no-cache.
 */
export async function buildProjectImageToTag(
  _lazyRoot: string,
  tag: string,
  options: { binary?: string; noCache?: boolean; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  const logPath = process.env.LAZY_MOCK_BUILD_LOG;
  if (logPath) {
    const { appendFileSync } = await import('fs');
    appendFileSync(
      logPath,
      JSON.stringify({ stagedTag: tag, binary: options.binary ?? 'docker', noCache: options.noCache ?? false, timeoutMs: options.timeoutMs ?? 0 }) + '\n'
    );
  }
  const stdout = process.env.LAZY_MOCK_BUILD_STDOUT;
  if (stdout) {
    for (const line of stdout.split('\n')) {
      if (line.length > 0) console.log(line);
    }
  }
  const delayMs = parseInt(process.env.LAZY_MOCK_BUILD_DELAY_MS ?? '0', 10);
  if (delayMs > 0) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return `lazy-runner:${tag}`;
}

export async function tagImage(_sourceRef: string, _targetRefs: string[], _binary?: string): Promise<void> {
  // No-op in tests — no real images exist to tag.
}

export async function removeImageTag(_ref: string, _binary?: string): Promise<boolean> {
  return true;
}

/** Mirrors the real LazyImageInfo, which src/cli/commands/doctor.ts imports as a type. */
export interface LazyImageInfo {
  ref: string;
  repository: string;
  tag: string;
  id: string;
  size: string;
}

export async function listLazyImages(): Promise<LazyImageInfo[]> {
  // Tests never have real images; doctor's stale-image report is exercised
  // against the real implementation in test/e2e/image-version-tag.test.ts.
  return [];
}

export async function removeLazyImage(
  _ref: string,
  _binary?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Never reached under the module mock: listLazyImages returns nothing, so
  // `lazy doctor --clean-docker-images` has nothing to remove. Present because
  // the mock must export everything src/capture/claude.ts does.
  return { ok: true };
}

/**
 * A stand-in for the real agent binary that PASSES verifyAgentBinary().
 *
 * This used to return a path that did not exist. Callers only ever passed it to
 * Docker as a bind-mount source, so nothing noticed — until `lazy upgrade` began
 * verifying what it had just installed, at which point every upgrade test failed
 * on a file the mock had never created. The mock must produce something that
 * looks like the compiled agent (ELF magic + the selfcheck sentinel), because
 * that is what the real one produces.
 */
export async function ensureAgentBinary(): Promise<string> {
  const dir = join(tmpdir(), 'lazy-test-agent-binary');
  const path = join(dir, 'lazy-agent');
  await mkdir(dir, { recursive: true });
  const head = '\u007fELF' /* ELF magic */ + AGENT_SELFCHECK_SENTINEL + ' 0.0.0-test';
  await writeFile(path, head + 'x'.repeat(4096 - head.length), { mode: 0o755 });
  return path;
}

export function getLastSourceBuildProvenance(): null {
  return null;
}

export function hasAuthEnv(): boolean {
  return !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY);
}

export function getAuthEnvVars(): Array<{ key: string; value: string }> {
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauthToken) {
    return [{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: oauthToken }];
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    return [{ key: 'ANTHROPIC_API_KEY', value: apiKey }];
  }
  throw new Error(
    'Authentication required. Set CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token`) or ANTHROPIC_API_KEY.'
  );
}

/**
 * Mock of the JIT-credential launch path.
 *
 * The real one mints a per-launch grant against the daemon's registry and hands
 * the launched process a PLACEHOLDER that the proxy resolves upstream. There is
 * no daemon or proxy behind the module mock, so this mints nothing — but it
 * still placeholder-izes, because the property the production function exists
 * to guarantee is 'nothing handed to a launch carries a real secret', and a
 * mock that returned the real credential would let a test assert launch env
 * that production never produces.
 *
 * It runs the result through targetEnvVars for the same reason: the address a
 * launch is handed is the proxy's, never a profile's own endpoint
 * (src/proxy/agent-upstreams.ts), and a mock that skipped that step would let a
 * test assert a base URL production cannot emit.
 *
 * injectedCreds mirrors the real parameter: a runner holding its own agent
 * instance passes that agent's credential rather than the module-level default.
 * A profile with the `none` credential slot has no real credential to pass — it
 * carries the same synthetic one production uses, so the proxy still gets a
 * grant to route by.
 */
export async function getLaunchAuthEnvVars(
  _identity: LaunchIdentity,
  target?: RoleTarget,
  hints?: ProxyAuditHints,
  surface: LaunchSurface = 'container',
  injectedCreds?: Array<{ key: string; value: string }>,
): Promise<Array<{ key: string; value: string }>> {
  const resolved = target ?? ANTHROPIC_DEFAULT_TARGET;
  const real = usesSyntheticCreds(resolved)
    ? LOCAL_BACKEND_CREDS
    : (injectedCreds ?? getAuthEnvVars());
  const placeholders = real.map(v =>
    isCredentialEnvKey(v.key) ? { key: v.key, value: placeholderValueFor(v.key) } : v
  );
  return targetEnvVars(resolved, placeholders, surface, hints);
}

async function maybeCommit(worktreePath: string, label: string): Promise<void> {
  if (process.env.LAZY_MOCK_SHOULD_COMMIT === '1') {
    const { writeFileSync, mkdirSync } = await import('fs');
    const { join, dirname } = await import('path');
    const timestamp = Date.now();

    // If LAZY_MOCK_FILES is set, create those specific files instead of the default
    const mockFiles = process.env.LAZY_MOCK_FILES;
    if (mockFiles) {
      const files = JSON.parse(mockFiles) as Array<{ path: string; content: string; action?: 'create' | 'modify' | 'delete' }>;
      for (const file of files) {
        const fullPath = join(worktreePath, file.path);
        if (file.action === 'delete') {
          Bun.spawnSync(['git', 'rm', file.path], { cwd: worktreePath });
        } else {
          mkdirSync(dirname(fullPath), { recursive: true });
          writeFileSync(fullPath, file.content);
          Bun.spawnSync(['git', 'add', file.path], { cwd: worktreePath });
        }
      }
    } else {
      const filename = `agent-output-${timestamp}.txt`;
      writeFileSync(join(worktreePath, filename), `Mock agent output (${label})\n`);
      Bun.spawnSync(['git', 'add', filename], { cwd: worktreePath });
    }
    Bun.spawnSync(['git', 'commit', '-m', `Mock agent commit (${label})`], { cwd: worktreePath });
  }
}

/**
 * Write files into the worktree and DO NOT commit them
 * (`LAZY_MOCK_LEAVE_UNCOMMITTED=a.md,b.txt`).
 *
 * This simulates the AGENT, not lazy: writing a file during an end-of-turn
 * check and never committing it is exactly what four tasks did, and the seam
 * exists so a test can drive that behaviour rather than assert it from mock
 * bookkeeping. Everything downstream — the turn record, `lazy show`, the accept
 * refusal — then runs for real against a genuinely dirty worktree.
 */
async function maybeLeaveUncommitted(worktreePath: string): Promise<void> {
  const spec = process.env.LAZY_MOCK_LEAVE_UNCOMMITTED;
  if (!spec) return;
  const { writeFileSync, mkdirSync } = await import('fs');
  const { join, dirname } = await import('path');
  for (const path of spec.split(',').map(p => p.trim()).filter(Boolean)) {
    const fullPath = join(worktreePath, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, `Left uncommitted by the mock agent (${path})\n`);
  }
}

// --- Synchronous (legacy) API ---

export async function runClaude(
  prompt: string,
  sandbox: SandboxConfig,
  verbose: boolean = false,
  debug: boolean = false,
  model?: string,
): Promise<AgentResponse> {
  await maybeCommit(sandbox.worktreePath, 'start');
  return getMockResponse();
}


export async function resumeClaude(
  claudeSessionId: string,
  prompt: string,
  sandbox: SandboxConfig,
  verbose: boolean = false,
  debug: boolean = false,
  model?: string,
): Promise<AgentResponse> {
  await maybeCommit(sandbox.worktreePath, 'resume');
  return getMockResponse();
}

// --- Async (detached container) API ---

export async function launchClaudeAsync(
  prompt: string,
  sandbox: SandboxConfig,
  containerName: string,
  debug: boolean = false,
  model?: string,
): Promise<void> {
  // In mock mode, we do the work synchronously (make commits if requested)
  // since there's no actual container to poll
  await maybeCommit(sandbox.worktreePath, 'async-start');
}

export async function resumeClaudeAsync(
  claudeSessionId: string,
  prompt: string,
  sandbox: SandboxConfig,
  containerName: string,
  debug: boolean = false,
  model?: string,
): Promise<void> {
  await maybeCommit(sandbox.worktreePath, 'async-resume');
}

// --- Supervisor API ---

/**
 * The launch settings the host asked for, echoed onto a response exactly as the
 * real supervisor does (`launchSettings` in src/supervisor/index.ts): `model` is
 * the resolved value the host put in the command, `effort` the resolved effort.
 *
 * Deliberately NO `model_id`. This seam runs no agent, so nothing here ever
 * learns a concrete model id — emitting a synthetic one would let a test pass on
 * a value production never produces. Concrete-id coverage belongs to the fake-
 * binary seam, where a real agent process reports it.
 */
function launchSettingsFromCommand(cmd: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(typeof cmd.model_id === 'string' && cmd.model_id ? { model: cmd.model_id } : {}),
    ...(typeof cmd.effort === 'string' && cmd.effort ? { effort: cmd.effort } : {}),
  };
}

/**
 * Write `response.json` with the originating command's correlation id echoed
 * back — the mock's stand-in for the real supervisor's
 * `writeCorrelatedResponse` (src/supervisor/index.ts), which every response it
 * emits goes through.
 *
 * Load-bearing, not cosmetic. The daemon correlates a synchronous turn's
 * answer by `command_id` (`inFlightResponseCorrelates`), and for an ASK an
 * uncorrelated response is never that turn's answer — an ask has no other
 * payload discriminator, so the settle is a deliberate no-op. A mock that
 * dropped the id therefore left every ask polling until its supervisor was
 * declared dead, which is exactly how the review surface's ask round-trip
 * tests went red while the product path (a real supervisor, which always
 * echoes) was fine.
 */
async function writeMockResponse(
  protocolDir: string,
  response: Record<string, unknown>,
  cmd: Record<string, unknown>,
): Promise<void> {
  const { writeFileSync } = await import('fs');
  const { join } = await import('path');
  const commandId = typeof cmd.command_id === 'string' ? cmd.command_id : undefined;
  const correlated = commandId ? { ...response, command_id: commandId } : response;
  writeFileSync(join(protocolDir, 'response.json'), JSON.stringify(correlated, null, 2));
}

/** Read the command the host wrote, or `{}` when there is none to read. */
async function readCommand(protocolDir: string): Promise<Record<string, unknown>> {
  const { readFileSync, existsSync } = await import('fs');
  const { join } = await import('path');
  const commandPath = join(protocolDir, 'command.json');
  if (!existsSync(commandPath)) return {};
  try {
    return JSON.parse(readFileSync(commandPath, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`mock supervisor: failed to parse ${commandPath}: ${(err as Error).message}`);
  }
}

// --- Wrap-up step simulations ---
//
// The real supervisor runs the SAME step implementations in both places —
// runWrapUpSteps executes the wrap-up steps for a final-declared work turn and
// for the dedicated wrap-up turn alike. The mock mirrors that: one simulation
// per step over a shared state bag, so the two mock paths cannot drift. Every
// simulation THROWS on failure; the caller decides what a failure means (the
// work path degrades — its per-step catch skips the step — the wrap-up turn
// fails with an ErrorResponse, exactly as the two real paths differ).

const SUPERVISED_USAGE = {
  input_tokens: 50, output_tokens: 20,
  cache_creation_input_tokens: 30, cache_read_input_tokens: 40,
};

/** HEAD, or the fallback when git rev-parse fails (mirrors the real supervisor's 'unknown'). */
function headShaOr(worktreePath: string, fallback: string): string {
  const r = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: worktreePath, stdout: 'pipe', stderr: 'pipe',
  });
  return r.exitCode === 0 && r.stdout.toString().trim()
    ? r.stdout.toString().trim()
    : fallback;
}

/** Mutable state the step simulations carry across the chain. */
interface WrapUpStepState {
  supervised: Array<Record<string, unknown>>;
  lastSha: string;
  finalViolations: Array<{ file: string; base_sha: string; status: string }>;
  pushbackTriggered: boolean;
}

interface WrapUpStepCtx {
  sandbox: SandboxConfig;
  protocolDir: string;
  launchSettings: Record<string, unknown>;
  state: WrapUpStepState;
  /** §3.4 — the TASK's own range start (base_sha when carried, else the turn's). */
  scanStart: string;
  /** The parsed launch command — each step reads its own entries off it. */
  command: Record<string, unknown>;
  /** Whether the turn declared `lazy_final` — only the present step reads it. */
  declaredFinal?: boolean;
  /** HEAD the walkthrough on record was declared at, from the plan. */
  presentedSha?: string;
}

/**
 * The permission push-back step: detect protected-file violations over
 * scanStart..endSha, give the agent one chance to self-correct, re-detect, and
 * record the FULL response with the FINAL violation set (empty when resolved).
 * No-op when nothing is protected or nothing violates.
 */
async function simulatePermissionPushback(ctx: WrapUpStepCtx, endSha: string): Promise<void> {
  if (ctx.scanStart === 'unknown') return;
  const patterns = ctx.command.protected_patterns as string[] | undefined;
  if (!patterns || patterns.length === 0) return;
  const { detectViolations, ViolationScanError } = await import('../../src/supervisor/permissions');

  // Branch point exactly as the real supervisor (src/supervisor/index.ts):
  // merge-base with the parent branch, cmd.branch_point_sha as the fallback.
  // Files that did not exist at that point were created by the task and are
  // EXEMPT from violations — omitting it makes the mock flag task-created
  // files the real supervisor exempts.
  let branchPointSha: string | undefined = ctx.command.branch_point_sha as string | undefined;
  const parentBranch = ctx.command.parent_branch as string | undefined;
  if (parentBranch) {
    const mergeBase = Bun.spawnSync(['git', 'merge-base', parentBranch, 'HEAD'], {
      cwd: ctx.sandbox.worktreePath, stdout: 'pipe', stderr: 'pipe',
    });
    if (mergeBase.exitCode === 0 && mergeBase.stdout.toString().trim()) {
      branchPointSha = mergeBase.stdout.toString().trim();
    }
  }

  const detected = await detectViolations(ctx.sandbox.worktreePath, ctx.scanStart, endSha, patterns, branchPointSha);
  if (detected.length === 0) return;
  ctx.state.pushbackTriggered = true;

  // Simulate push-back: give the agent one chance to self-correct.
  // LAZY_MOCK_PUSHBACK_REVERTS: JSON array of file paths the agent "reverts".
  const pushbackReverts = process.env.LAZY_MOCK_PUSHBACK_REVERTS;
  if (pushbackReverts) {
    const revertFiles = JSON.parse(pushbackReverts) as string[];
    for (const filePath of revertFiles) {
      Bun.spawnSync(['git', 'checkout', ctx.scanStart, '--', filePath], { cwd: ctx.sandbox.worktreePath });
    }
    if (revertFiles.length > 0) {
      Bun.spawnSync(['git', 'commit', '-m', 'Push-back: revert unnecessary file changes'], { cwd: ctx.sandbox.worktreePath });
    }
  }

  // Re-detect violations after push-back (agent may have reverted some files).
  const postPushbackSha = headShaOr(ctx.sandbox.worktreePath, endSha);

  // A failed scan must NOT invent [] (same fail-closed rule as production).
  try {
    ctx.state.finalViolations = await detectViolations(ctx.sandbox.worktreePath, ctx.scanStart, postPushbackSha, patterns, branchPointSha);
  } catch (scanErr) {
    if (!(scanErr instanceof ViolationScanError)) throw scanErr;
    // Keep the pre-push-back `detected` set rather than writing [].
    ctx.state.finalViolations = detected;
  }

  // The push-back is a FULL response: its own SHA window + usage + the FINAL
  // violation set. LAZY_MOCK_PUSHBACK_RESPONSE supplies the agent's
  // justification text.
  const pushbackResponse = process.env.LAZY_MOCK_PUSHBACK_RESPONSE
    ?? 'Mock agent: reviewed the protected-file changes.';
  ctx.state.supervised.push({
    status: 'completed',
    result: pushbackResponse,
    session_id: 'mock-sess-pushback',
    usage: { ...SUPERVISED_USAGE },
    start_sha_work: ctx.state.lastSha,
    end_sha_work: postPushbackSha,
    violations: ctx.state.finalViolations,
    ...ctx.launchSettings,
    supervised: { kind: 'permission_pushback', prompt: 'Mock push-back prompt: you modified protected file(s). Revert or justify.' },
  });
  ctx.state.lastSha = postPushbackSha;
}

/**
 * The maintained-files step: detect skipped maintained groups over
 * scanStart..endSha and record the nudge + follow-up as one response. No-op
 * when nothing is configured or nothing was skipped.
 */
async function simulateMaintain(ctx: WrapUpStepCtx, endSha: string): Promise<void> {
  if (ctx.scanStart === 'unknown') return;
  const maintain = ctx.command.maintain as Array<{ title: string; pattern: string; instructions: string }> | undefined;
  if (!maintain || maintain.length === 0) return;
  const { detectSkippedMaintainEntries } = await import('../../src/supervisor/maintain');
  const { skipped } = await detectSkippedMaintainEntries(ctx.sandbox.worktreePath, ctx.scanStart, endSha, maintain);
  if (skipped.length === 0) return;

  // Optional: simulate the maintain follow-up committing files (e.g. a docs
  // update that also matches a react pattern). Used by the maintain→react
  // ordering invariant test.
  const maintainFiles = process.env.LAZY_MOCK_MAINTAIN_FILES;
  if (maintainFiles) {
    const files = JSON.parse(maintainFiles) as Array<{ path: string; content: string }>;
    const { mkdirSync: mk, writeFileSync: wf } = await import('fs');
    const { dirname } = await import('path');
    for (const f of files) {
      mk(dirname(join(ctx.sandbox.worktreePath, f.path)), { recursive: true });
      wf(join(ctx.sandbox.worktreePath, f.path), f.content);
    }
    Bun.spawnSync(['git', 'add', '-A'], { cwd: ctx.sandbox.worktreePath });
    Bun.spawnSync(['git', 'commit', '-m', 'Mock maintain follow-up commit'], {
      cwd: ctx.sandbox.worktreePath,
    });
  }
  const postMaintainSha = headShaOr(ctx.sandbox.worktreePath, endSha);
  const response = process.env.LAZY_MOCK_MAINTAIN_RESPONSE
    ?? 'Mock agent: reviewed the skipped maintained files.';
  ctx.state.supervised.push({
    status: 'completed',
    result: response,
    session_id: 'mock-sess-maintain',
    usage: { ...SUPERVISED_USAGE },
    start_sha_work: ctx.state.lastSha,
    end_sha_work: postMaintainSha,
    ...ctx.launchSettings,
    supervised: { kind: 'maintain', prompt: `Mock maintain nudge: you skipped ${skipped.map(s => s.title).join(', ')}. Update or justify.` },
  });
  ctx.state.lastSha = postMaintainSha;
}

/**
 * The reactive-automation step: detect matched groups over scanStart..endSha
 * and record the follow-up as one response. After the follow-up, re-detect
 * protected-file violations so the reconciler's "last response with violations
 * wins" rule matches production. No-op when nothing is configured or nothing
 * matched.
 */
async function simulateReact(ctx: WrapUpStepCtx, endSha: string): Promise<void> {
  if (ctx.scanStart === 'unknown') return;
  const react = ctx.command.react as Array<{ title: string; pattern: string; instructions: string }> | undefined;
  if (!react || react.length === 0) return;
  const { detectMatchedReactEntries } = await import('../../src/supervisor/react');
  const { matched } = await detectMatchedReactEntries(ctx.sandbox.worktreePath, ctx.scanStart, endSha, react);
  if (matched.length === 0) return;
  const response = process.env.LAZY_MOCK_REACT_RESPONSE
    ?? 'Mock agent: followed the reactive automation instructions.';

  // Optional: simulate the react follow-up committing more files (e.g.
  // screenshots that also touch a protected path).
  const reactFiles = process.env.LAZY_MOCK_REACT_FILES;
  if (reactFiles) {
    const files = JSON.parse(reactFiles) as Array<{ path: string; content: string }>;
    const { mkdirSync: mk, writeFileSync: wf } = await import('fs');
    const { dirname } = await import('path');
    for (const f of files) {
      mk(dirname(join(ctx.sandbox.worktreePath, f.path)), { recursive: true });
      wf(join(ctx.sandbox.worktreePath, f.path), f.content);
    }
    Bun.spawnSync(['git', 'add', '-A'], { cwd: ctx.sandbox.worktreePath });
    Bun.spawnSync(['git', 'commit', '-m', 'Mock react follow-up commit'], {
      cwd: ctx.sandbox.worktreePath,
    });
  }
  const postReactSha = headShaOr(ctx.sandbox.worktreePath, endSha);

  // Re-detect over the full range — same as the real supervisor. Successful
  // scan (including []) is attached; failed scan omits the field.
  const patterns = ctx.command.protected_patterns as string[] | undefined;
  let reactViolations: typeof ctx.state.finalViolations | undefined;
  if (patterns && patterns.length > 0) {
    const { detectViolations, ViolationScanError } = await import('../../src/supervisor/permissions');
    let branchPointSha: string | undefined = ctx.command.branch_point_sha as string | undefined;
    const parentBranch = ctx.command.parent_branch as string | undefined;
    if (parentBranch) {
      const mergeBase = Bun.spawnSync(['git', 'merge-base', parentBranch, 'HEAD'], {
        cwd: ctx.sandbox.worktreePath, stdout: 'pipe', stderr: 'pipe',
      });
      if (mergeBase.exitCode === 0 && mergeBase.stdout.toString().trim()) {
        branchPointSha = mergeBase.stdout.toString().trim();
      }
    }
    try {
      reactViolations = await detectViolations(
        ctx.sandbox.worktreePath,
        ctx.scanStart,
        postReactSha,
        patterns,
        branchPointSha,
      );
      ctx.state.finalViolations = reactViolations;
    } catch (scanErr) {
      if (!(scanErr instanceof ViolationScanError)) throw scanErr;
      // Omit violations on the react response — do not clear prior pending.
      reactViolations = undefined;
    }
  } else {
    // No protected patterns configured — attach the empty set we already hold
    // so reconciler behavior matches "checked, nothing protected".
    reactViolations = ctx.state.finalViolations;
  }

  ctx.state.supervised.push({
    status: 'completed',
    result: response,
    session_id: 'mock-sess-react',
    usage: { ...SUPERVISED_USAGE },
    start_sha_work: ctx.state.lastSha,
    end_sha_work: postReactSha,
    ...(reactViolations !== undefined ? { violations: reactViolations } : {}),
    ...ctx.launchSettings,
    supervised: { kind: 'react', prompt: `Mock react nudge: you touched ${matched.map(s => s.title).join(', ')}. Follow instructions.` },
  });
  ctx.state.lastSha = postReactSha;
}

/**
 * The uncommitted-work step: read the WORKING TREE (not a committed range),
 * and when something is loose record the nudge + follow-up as one response.
 * No-op on a clean worktree, exactly like the real step.
 *
 * `LAZY_MOCK_LEFTOVERS_COMMIT=1` makes the simulated agent do what the nudge
 * asks — `git add -A && git commit` — which is what exercises the interesting
 * half downstream: a commit attributed to the leftovers turn, and a protected
 * path that first reaches the branch HERE. Without it the mock agent is one
 * that was asked and declined, and the paths stay loose.
 *
 * Violations are re-detected afterwards for the same reason react does it, and
 * with more force: this is the last step that can add a commit, so its set is
 * the one the reconciler's "last response with violations wins" rule reads.
 */
async function simulateCommitLeftovers(ctx: WrapUpStepCtx, endSha: string): Promise<void> {
  const { listUncommittedPaths } = await import('../../src/git/operations');
  const before = await listUncommittedPaths(ctx.sandbox.worktreePath);
  if (before === null || before.length === 0) return;

  if (process.env.LAZY_MOCK_LEFTOVERS_COMMIT === '1') {
    Bun.spawnSync(['git', 'add', '-A'], { cwd: ctx.sandbox.worktreePath });
    Bun.spawnSync(['git', 'commit', '-m', 'Mock leftovers follow-up commit'], {
      cwd: ctx.sandbox.worktreePath,
    });
  }
  const postLeftoversSha = headShaOr(ctx.sandbox.worktreePath, endSha);
  const response = process.env.LAZY_MOCK_LEFTOVERS_RESPONSE
    ?? 'Mock agent: handled the uncommitted work.';

  // Same re-detect the real step performs, with the same two rules: a
  // successful scan attaches the set (including []), a failed one omits the
  // field so a prior pending set is never cleared by a scan that could not look.
  const patterns = ctx.command.protected_patterns as string[] | undefined;
  let leftoverViolations: typeof ctx.state.finalViolations | undefined;
  if (patterns && patterns.length > 0 && ctx.scanStart !== 'unknown') {
    const { detectViolations, ViolationScanError } = await import('../../src/supervisor/permissions');
    let branchPointSha: string | undefined = ctx.command.branch_point_sha as string | undefined;
    const parentBranch = ctx.command.parent_branch as string | undefined;
    if (parentBranch) {
      const mergeBase = Bun.spawnSync(['git', 'merge-base', parentBranch, 'HEAD'], {
        cwd: ctx.sandbox.worktreePath, stdout: 'pipe', stderr: 'pipe',
      });
      if (mergeBase.exitCode === 0 && mergeBase.stdout.toString().trim()) {
        branchPointSha = mergeBase.stdout.toString().trim();
      }
    }
    try {
      leftoverViolations = await detectViolations(
        ctx.sandbox.worktreePath,
        ctx.scanStart,
        postLeftoversSha,
        patterns,
        branchPointSha,
      );
      ctx.state.finalViolations = leftoverViolations;
    } catch (scanErr) {
      if (!(scanErr instanceof ViolationScanError)) throw scanErr;
      leftoverViolations = undefined;
    }
  } else {
    leftoverViolations = ctx.state.finalViolations;
  }

  ctx.state.supervised.push({
    status: 'completed',
    result: response,
    session_id: 'mock-sess-leftovers',
    usage: { ...SUPERVISED_USAGE },
    start_sha_work: ctx.state.lastSha,
    end_sha_work: postLeftoversSha,
    ...(leftoverViolations !== undefined ? { violations: leftoverViolations } : {}),
    ...ctx.launchSettings,
    supervised: {
      kind: 'commit_leftovers',
      prompt: `Mock leftovers nudge: ${before.length} uncommitted path(s) — commit or discard them.`,
    },
  });
  ctx.state.lastSha = postLeftoversSha;
}

/** The enforcement error message — byte-identical on both real paths. */
const PRESENT_ENFORCEMENT_ERROR =
  'Presentation step did not complete: no presentation was declared via lazy_report — send the report again with its presentation groups';

/**
 * The presentation step (§6.2), both sides of it:
 *   * supervisor's side — skip entirely when the walkthrough on record was
 *     declared at the current HEAD; otherwise clear the declaration marker
 *     before the invocation, check it after, and on an absent marker THROW on
 *     a FINAL (the caller turns that into the turn's ErrorResponse and skips
 *     the rest of the chain) or carry on quietly on a park;
 *   * agent's side — the daemon executes the agent's `lazy_report` MCP call and
 *     echoes the declaration into the protocol dir as `presentation.json`. A
 *     mock invocation has no MCP tools, so the mock performs that daemon-side
 *     effect directly by default; LAZY_MOCK_PRESENT_SKIP=1 withholds it to
 *     exercise the enforcement.
 */
async function simulatePresent(ctx: WrapUpStepCtx): Promise<void> {
  // The head-not-moved skip, read off the plan exactly as the real executor
  // does — no response at all, so a suite can assert the step did not run.
  if (ctx.presentedSha && ctx.presentedSha === headShaOr(ctx.sandbox.worktreePath, 'unknown')) {
    return;
  }
  const { clearPresentationMarker, readPresentationMarker, writePresentationMarker } =
    await import('../../src/protocol/presentation-marker');
  await clearPresentationMarker(ctx.protocolDir);
  if (process.env.LAZY_MOCK_PRESENT_SKIP !== '1') {
    await writePresentationMarker(ctx.protocolDir);
  }
  const declared = await readPresentationMarker(ctx.protocolDir);
  // Enforcement is FINAL-ONLY, same as the real executor: a park with no
  // walkthrough carries on and still records the invocation (its tokens were
  // spent) rather than failing the turn.
  if (!declared && ctx.declaredFinal) throw new Error(PRESENT_ENFORCEMENT_ERROR);
  ctx.state.supervised.push({
    status: 'completed',
    result: 'Mock agent: authored the report and declared the presentation via lazy_report.',
    session_id: 'mock-sess-present',
    usage: { ...SUPERVISED_USAGE },
    start_sha_work: ctx.state.lastSha,
    end_sha_work: ctx.state.lastSha,
    ...ctx.launchSettings,
    // The real present step substitutes the §6.4 hint section (empty when the
    // carve yields nothing, as in a test sandbox) — mimic that, never ship the
    // raw placeholder.
    supervised: { kind: 'present', prompt: presentRegionsTemplate.replace("{{provenance_hint}}", "") },
  });
}

/**
 * Mock of the supervisor's acceptance-gate handler
 * (src/supervisor/index.ts#handleAcceptGateCommand).
 *
 * MECHANICAL, like the real handler: no agent runs, no commit, no session.
 * The mock runs the configured gate commands in the worktree (one
 * `sh -c` each, in order, stopping at the first failure — the same shape the
 * real handler's runAcceptanceGate gives) and writes ONE CompletedResponse
 * carrying the `accept_gate` outcome. The daemon's gate wait reads it straight
 * from the gate's dedicated protocol dir; no turn is recorded from it.
 *
 * LAZY_MOCK_ACCEPT_GATE_SUPERVISOR_DIES: return without writing anything at
 * all — the gate supervisor that vanished before answering. Combined with
 * `isContainerRunning` (always false) this is the fast-abort dead-supervisor
 * path. Scoped to the gate so other turns in the same suite still respond.
 *
 * LAZY_MOCK_ACCEPT_GATE_FOREIGN_RESPONSE: write a completed response with NO
 * `accept_gate` block — the response.json the gate wait finds when something
 * other than the gate wrote it. The real supervisor never emits this shape for
 * a gate command; the point is that the DAEMON must not merge on it.
 */
async function handleMockAcceptGate(
  sandbox: SandboxConfig,
  protocolDir: string,
  cmd: Record<string, unknown>,
): Promise<void> {
  const { writeFileSync, mkdirSync } = await import('fs');
  const { join } = await import('path');
  const { truncateLog } = await import('../../src/utils/log-truncate');

  if (process.env.LAZY_MOCK_ACCEPT_GATE_SUPERVISOR_DIES) return;

  mkdirSync(protocolDir, { recursive: true });
  writeFileSync(join(protocolDir, 'status.json'), JSON.stringify({
    phase: 'accept_gate',
    task_id: cmd.task_id ?? 'mock-task',
    command_type: 'accept_gate',
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pid: process.pid,
  }, null, 2));

  // Run each configured command in order in the worktree, stop at first failure.
  const commands = (cmd.accept_gate_commands as string[] | undefined) ?? [];
  let acceptGate: Record<string, unknown> = { passed: true };
  for (const command of commands) {
    const r = Bun.spawnSync(['sh', '-c', command], {
      cwd: sandbox.worktreePath, stdout: 'pipe', stderr: 'pipe',
    });
    if (r.exitCode !== 0) {
      const out = (r.stderr?.toString() ?? '') + (r.stdout?.toString() ?? '');
      acceptGate = { passed: false, failed_command: command, exit_code: r.exitCode, output: truncateLog(out) };
      break;
    }
  }

  const response: Record<string, unknown> = {
    status: 'completed',
    result: acceptGate.passed
      ? `Acceptance gate passed (${commands.length} command(s)).`
      : `Acceptance gate failed: ${(acceptGate as { failed_command?: string }).failed_command}`,
    // Mechanical sentinel, mirroring the real handler: no agent ran, but the
    // response shape requires a session id and usage.
    session_id: 'mechanical-gate',
    usage: { input_tokens: 0, output_tokens: 0 },
    // LAZY_MOCK_ACCEPT_GATE_FOREIGN_RESPONSE — see the doc comment above.
    ...(process.env.LAZY_MOCK_ACCEPT_GATE_FOREIGN_RESPONSE ? {} : { accept_gate: acceptGate }),
  };
  await writeMockResponse(protocolDir, response, cmd);
}

/**
 * Mock of the supervisor's ask handler (src/supervisor/index.ts#handleAskCommand).
 *
 * An ask is READ-ONLY: plan mode, no commits, no violation detection, no
 * post-turn check — and its answer is a bare CompletedResponse, not the
 * work-turn bundle. Handling it here rather than falling through to the work
 * path is what keeps the mock honest about that: the work path commits when
 * LAZY_MOCK_SHOULD_COMMIT is set, which no real ask ever does.
 */
async function handleMockAsk(
  protocolDir: string,
  cmd: Record<string, unknown>,
): Promise<void> {
  const { writeFileSync, mkdirSync } = await import('fs');
  const { join } = await import('path');

  const mockResp = getMockResponse();
  const now = new Date().toISOString();
  mkdirSync(protocolDir, { recursive: true });
  writeFileSync(join(protocolDir, 'status.json'), JSON.stringify({
    phase: 'writing_response',
    task_id: cmd.task_id ?? 'mock-task',
    command_type: 'ask',
    started_at: now,
    updated_at: now,
    pid: process.pid,
  }, null, 2));

  await writeMockResponse(protocolDir, {
    status: 'completed',
    result: mockResp.result,
    session_id: mockResp.session_id,
    usage: mockResp.usage,
    agent_duration_ms: 1,
    ...launchSettingsFromCommand(cmd),
  }, cmd);
}

/**
 * Mock of the supervisor's sync handler (src/supervisor/index.ts
 * #handleSyncCommand). A sync is MERGES, not work: falling through to the work
 * path would commit the mock agent's file and write a plain work response, so
 * every e2e sync would report a success no merge produced — the same fidelity
 * lie the ask path is kept off the work path to avoid.
 *
 * It runs the REAL merge functions, in the real order — the task's own branch on
 * origin first (only when the host found commits there), then the parent — and
 * emits the same bundle shape: one announcement response per step, carrying
 * `sync: { merged, conflicts }`. Conflict RESOLUTION is not simulated: the agent
 * that would resolve it is this very mock, so a conflicted merge here reports
 * its conflicts and leaves the worktree settled, and conflict-resolution
 * behaviour is covered at the unit level against the real merge code.
 */
async function handleMockSync(
  sandbox: SandboxConfig,
  protocolDir: string,
  cmd: Record<string, unknown>,
  preTurnSha: string,
): Promise<void> {
  const { writeFileSync, mkdirSync } = await import('fs');
  const { join } = await import('path');
  const { runSyncWithRemote, runSyncWithUpstream } = await import('../../src/supervisor/merge');

  const responses: Array<Record<string, unknown>> = [];
  const sha8 = (sha: string) => sha.substring(0, 8);

  function pushStep(label: string, result: {
    merged: boolean; preMergeSha: string; postMergeSha: string; targetSha: string;
    conflicts: Array<{ path: string; content: string; merge_source?: string }>;
  }): void {
    responses.push({
      status: 'completed',
      result: result.merged
        ? (result.conflicts.length > 0
          ? `Merged ${label} @ ${sha8(result.targetSha)} with ${result.conflicts.length} resolved conflict(s). HEAD: ${sha8(result.preMergeSha)} → ${sha8(result.postMergeSha)}.`
          : `Merged ${label} @ ${sha8(result.targetSha)}. HEAD: ${sha8(result.preMergeSha)} → ${sha8(result.postMergeSha)}.`)
        : `Already up to date: HEAD (${sha8(result.preMergeSha)}) already contains ${label} @ ${sha8(result.targetSha)}. No merge performed.`,
      session_id: '',
      usage: { input_tokens: 0, output_tokens: 0 },
      sync: { merged: result.merged, conflicts: result.conflicts.length },
      ...(result.conflicts.length > 0 ? { merge_conflicts: result.conflicts } : {}),
      ...(result.merged && result.conflicts.length === 0
        ? { start_sha_work: result.preMergeSha, end_sha_work: result.postMergeSha }
        : {}),
    });
  }

  const now = new Date().toISOString();
  mkdirSync(protocolDir, { recursive: true });
  writeFileSync(join(protocolDir, 'status.json'), JSON.stringify({
    phase: 'merge_and_fix',
    task_id: cmd.task_id ?? 'mock-task',
    command_type: 'sync',
    started_at: now,
    updated_at: now,
    pre_turn_sha: preTurnSha,
    pid: process.pid,
  }, null, 2));

  if (typeof cmd.remote_branch === 'string' && cmd.remote_branch) {
    pushStep(cmd.remote_branch, await runSyncWithRemote(sandbox.worktreePath, cmd.remote_branch));
  }

  const parentBranch = typeof cmd.parent_branch === 'string' ? cmd.parent_branch : 'main';
  const target = typeof cmd.upstream_sha === 'string' && cmd.upstream_sha ? cmd.upstream_sha : parentBranch;

  // A CONFLICTED parent merge is resolved by the task's AGENT in the real
  // supervisor, which `runSyncWithUpstream` would spawn for real here and hang
  // on. Stand in for that agent: take the upstream side of every conflicted
  // file and conclude the merge, reporting the conflicts the way the real
  // resolution does. A clean merge still goes through the real merge code.
  const git = (...args: string[]) => Bun.spawnSync(['git', ...args], {
    cwd: sandbox.worktreePath, stdout: 'pipe', stderr: 'pipe',
  });
  const head = () => git('rev-parse', 'HEAD').stdout.toString().trim();
  const preMergeSha = head();
  // merge-tree answers "would this conflict" without touching the worktree.
  // Exit 0 = clean, 1 = conflicted; anything else (git < 2.38, bad ref) must
  // fail loudly rather than fall through to a REAL agent launch.
  const probe = git('merge-tree', '--write-tree', 'HEAD', target);
  if (probe.exitCode !== 0 && probe.exitCode !== 1) {
    throw new Error(`mock sync: git merge-tree exited ${probe.exitCode}: ${probe.stderr.toString()}`);
  }
  if (probe.exitCode === 1) {
    const trial = git('merge', '--no-ff', '--no-edit', target);
    const conflicted = git('diff', '--name-only', '--diff-filter=U').stdout.toString().split('\n').filter(Boolean);
    if (conflicted.length === 0) {
      git('merge', '--abort');
      throw new Error(`mock sync: merge of ${target} failed without conflicts: ${trial.stderr.toString()}`);
    }
    const conflicts = conflicted.map(path => ({ path, content: '' }));
    for (const step of [['checkout', '--theirs', '--', ...conflicted], ['add', '--', ...conflicted]]) {
      const r = git(...step);
      if (r.exitCode !== 0) throw new Error(`mock sync: git ${step[0]} failed: ${r.stderr.toString()}`);
    }
    const commit = git('commit', '--no-edit');
    if (commit.exitCode !== 0) throw new Error(`mock sync: could not conclude merge: ${commit.stderr.toString()}`);
    pushStep(parentBranch, {
      merged: true, preMergeSha, postMergeSha: head(),
      targetSha: git('rev-parse', target).stdout.toString().trim(), conflicts,
    });
    await writeMockResponse(protocolDir, { status: 'completed', responses }, cmd);
    return;
  }
  pushStep(parentBranch, await runSyncWithUpstream(
    sandbox.worktreePath, parentBranch, undefined, undefined,
    typeof cmd.upstream_sha === 'string' ? cmd.upstream_sha : undefined,
  ));

  await writeMockResponse(protocolDir, { status: 'completed', responses }, cmd);
}

export async function launchSupervisorAsync(
  sandbox: SandboxConfig,
  containerName: string,
  protocolDir: string,
  debug: boolean = false,
): Promise<void> {
  const { writeFileSync, mkdirSync } = await import('fs');
  const { join } = await import('path');

  // Capture pre-turn SHA (HEAD before any work)
  const preTurnShaResult = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: sandbox.worktreePath, stdout: 'pipe', stderr: 'pipe',
  });
  const preTurnSha = preTurnShaResult.exitCode === 0
    ? preTurnShaResult.stdout.toString().trim()
    : 'unknown';

  // Launch settings the host asked for — echoed onto every response this
  // invocation writes, exactly as the real supervisor does.
  const launchSettings = launchSettingsFromCommand(await readCommand(protocolDir));

  {
    const cmd = await readCommand(protocolDir);
    // Ask turn: read-only, single bare response — see handleMockAsk.
    if (cmd.type === 'ask') {
      await handleMockAsk(protocolDir, cmd);
      return;
    }
    // Sync turn: merges, not work — see handleMockSync.
    if (cmd.type === 'sync') {
      await handleMockSync(sandbox, protocolDir, cmd, preTurnSha);
      return;
    }
    // Acceptance gate: mechanical commands, no agent — see handleMockAcceptGate.
    if (cmd.type === 'accept_gate') {
      await handleMockAcceptGate(sandbox, protocolDir, cmd);
      return;
    }
  }

  // In mock mode, simulate the supervisor: make commits, then write response.json
  await maybeCommit(sandbox.worktreePath, 'supervisor');
  await maybeLeaveUncommitted(sandbox.worktreePath);

  // Capture post-work SHA (HEAD after agent's work, before any post-turn sync)
  const postWorkShaResult = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: sandbox.worktreePath, stdout: 'pipe', stderr: 'pipe',
  });
  const postWorkSha = postWorkShaResult.exitCode === 0
    ? postWorkShaResult.stdout.toString().trim()
    : undefined;

  // If LAZY_MOCK_PLAN_CONTENT is set, simulate Claude Code writing a plan file
  // to the sandbox's .claude/plans/ directory (as Claude Code does in plan mode)
  const planContent = process.env.LAZY_MOCK_PLAN_CONTENT;
  if (planContent) {
    const plansDir = join(sandbox.sandboxPath, '.claude', 'plans');
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, 'plan.md'), planContent);
  }

  // Write supervisor status with SHAs so reconciliation can record per-turn diffs
  mkdirSync(protocolDir, { recursive: true });
  const status: Record<string, unknown> = {
    phase: 'work_done',
    task_id: 'mock-task',
    command_type: 'start',
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pre_turn_sha: preTurnSha,
    post_work_sha: postWorkSha,
    pid: process.pid,
  };
  writeFileSync(join(protocolDir, 'status.json'), JSON.stringify(status, null, 2));

  // Per-invocation responses for the bundle. responses[0] is the WORK response;
  // supervised follow-ups (push-back, maintain) append after it as FULL responses
  // with their own SHA window + usage (incl. cache) + (for push-back) violation set.
  // Mirrors src/supervisor/index.ts. Synthetic non-zero cache tokens on supervised
  // responses let tests assert cache usage lands per supervised turn.
  // THE WRAP-UP GATE (mirrors the wrap-up branch in src/supervisor/index.ts).
  // HOW THE TURN ENDED picks the step list: a turn that declared final runs
  // `wrap_up.steps` (the full chain), one that parked without a final runs
  // `wrap_up.park_steps` (the presentation alone). Never in plan mode.
  // LAZY_MOCK_FINAL is read HERE, before the chain blocks — the real supervisor
  // captures the declaration before the wrap-up decision, and a mock that read
  // it only at bundle assembly would pick the wrong list.
  //
  // `LAZY_MOCK_FINAL` names a FILE whose EXISTENCE means "this turn declared
  // final"; its contents, if any, are the agent's note. File-based rather than
  // a plain env value for the same reason `LAZY_MOCK_RUNNING_CONTAINERS` is: a
  // withDaemon suite cannot re-env the long-lived daemon between turns, so
  // turn 1 declaring and turn 2 not (which is what un-finalling looks like)
  // is only expressible through a file the test creates and removes.
  const finalFile = process.env.LAZY_MOCK_FINAL;
  let finalDeclaration: Record<string, unknown> | undefined;
  let wrapUpSteps: string[] = [];
  let cmdPermissionMode: string | undefined;
  let cmdBaseSha: string | undefined;
  let cmdPresentedSha: string | undefined;
  // The parsed launch command, shared by every step simulation below.
  let workCmd: Record<string, unknown> | undefined;
  try {
    const { readFileSync: readFs, existsSync: existsFs } = await import('fs');
    const commandPath = join(protocolDir, 'command.json');
    if (existsFs(commandPath)) {
      workCmd = JSON.parse(readFs(commandPath, 'utf-8')) as Record<string, unknown>;
      cmdPermissionMode = workCmd.permission_mode as string | undefined;
      cmdBaseSha = workCmd.base_sha as string | undefined;
      cmdPresentedSha = (workCmd.wrap_up as { presented_sha?: string } | undefined)?.presented_sha;
    }
    if (finalFile && postWorkSha && existsFs(finalFile)) {
      const note = readFs(finalFile, 'utf-8').trim();
      finalDeclaration = {
        sha: postWorkSha,
        declared_at: new Date().toISOString(),
        ...(note ? { note } : {}),
      };
    }
    const plan = workCmd?.wrap_up as { steps?: string[]; park_steps?: string[] } | undefined;
    wrapUpSteps = ((finalDeclaration !== undefined ? plan?.steps : plan?.park_steps) ?? []) as string[];
  } catch {
    // Non-fatal: degrade to a turn with no wrap-up chain if the reads fail
  }
  const declaredFinal = finalDeclaration !== undefined;
  const wrapUpRuns = wrapUpSteps.length > 0 && cmdPermissionMode !== 'plan';

  // §3.4: the wrap-up scans run over the TASK's own range (base_sha..HEAD) when
  // the command carries its diff base — the same range the reviewer is shown —
  // falling back to the turn window exactly as the real supervisor does.
  const scanStart = cmdBaseSha ?? preTurnSha;

  const state: WrapUpStepState = {
    supervised: [],
    lastSha: postWorkSha ?? preTurnSha,
    // Final remaining violations across the exchange (set by push-back re-detection).
    finalViolations: [],
    pushbackTriggered: false,
  };
  const stepCtx: WrapUpStepCtx = {
    sandbox,
    protocolDir,
    launchSettings,
    state,
    scanStart,
    command: workCmd ?? {},
    declaredFinal,
    presentedSha: cmdPresentedSha,
  };

  // Detect file permission violations, via the shared step simulation.
  // INVARIANT: status.post_work_sha stays pinned at the WORK end — NOT advanced
  // past push-back commits (no double-count on the work turn) — so the FIRST
  // detection window ends there, before any push-back commit exists. The
  // re-detection after the push-back commit lands is what advances the
  // violation set. No work, no scan — the turn window is empty.
  try {
    if (wrapUpRuns && wrapUpSteps.includes('permission_pushback') && preTurnSha !== 'unknown' && postWorkSha && preTurnSha !== postWorkSha) {
      await simulatePermissionPushback(stepCtx, postWorkSha);
    }
  } catch {
    // Non-fatal: skip violation detection if it fails in tests
  }

  // Maintained-file skip check, via the shared step simulation.
  // PRECEDENCE INVARIANT (maintain-nudge-violation-precedence): the maintain nudge
  // runs AFTER the push-back exchange and is INDEPENDENT of its outcome — it is NOT
  // gated on `state.finalViolations.length === 0`. It appends after the push-back response
  // (start_sha_work = state.lastSha, which advanced to the post-push-back SHA) and never
  // re-triggers push-back (push-back is single-shot above). The maintain response
  // carries NO `violations` field, so the reconciler's final-violation lookup still
  // reads the push-back set and a still-violating turn stays `conflict`.
  try {
    if (wrapUpRuns && wrapUpSteps.includes('maintain') && preTurnSha !== 'unknown') {
      await simulateMaintain(stepCtx, headShaOr(sandbox.worktreePath, postWorkSha ?? preTurnSha));
    }
  } catch {
    // Non-fatal: skip maintained-file check if it fails in tests
  }

  // Reactive-automation match check, via the shared step simulation.
  // Fires when the turn's commits TOUCH a configured pattern — inverse of
  // maintain. Runs after maintain so maintain commits are included in the scan.
  // After the follow-up, re-detect protected-file violations and attach them so
  // the reconciler's "last response with violations wins" rule matches production.
  try {
    if (wrapUpRuns && wrapUpSteps.includes('react') && preTurnSha !== 'unknown') {
      await simulateReact(stepCtx, headShaOr(sandbox.worktreePath, postWorkSha ?? preTurnSha));
    }
  } catch {
    // Non-fatal: skip reactive-automation check if it fails in tests
  }

  // The uncommitted-work check, via the shared step simulation. Runs after the
  // two nudges (they are what most often writes a file and forgets it) and
  // before present (a commit made here belongs in the walkthrough) — the same
  // position it holds in the real chain. Deliberately NOT guarded on
  // `preTurnSha !== 'unknown'`: this step reads the working tree, not a
  // committed range, so it has an answer even when the SHA window does not.
  try {
    if (wrapUpRuns && wrapUpSteps.includes('commit_leftovers')) {
      await simulateCommitLeftovers(stepCtx, headShaOr(sandbox.worktreePath, postWorkSha ?? preTurnSha));
    }
  } catch {
    // Non-fatal: skip the uncommitted-work check if it fails in tests
  }

  // The wrap-up's presentation step (§6.2), via the shared step simulation.
  // Mock fidelity, both sides of the present step, lives
  // in simulatePresent; the failure contract is the work path's here: an absent
  // marker (or any marker-mechanics failure) FAILS THE TURN with an ErrorResponse
  // instead of the completed bundle, skipping the rest of the turn (post-turn
  // check, response assembly) — exactly what the real executor's throw produces
  // via the error path in src/supervisor/index.ts. Marker-mechanics failures
  // degrade to "not declared" (readPresentationMarker → null), matching the real
  // executor's read semantics — enforcement fires. The catch mirrors the real
  // supervisor's: a throw out of the wrap-up phase reaches the error path, which
  // writes the ErrorResponse. Never silently continue — a mock that skipped the
  // present response would make every downstream assertion a fidelity lie.
  {
    const runPresent = wrapUpRuns && wrapUpSteps.includes('present');
    if (runPresent) {
      // The real error path computes `agent_had_no_effect` from git state at
      // failure time — the mock computes it the same way (guards on 'unknown'
      // SHAs included), because downstream tests assert it.
      const writeWorkPhaseError = async (cause: string): Promise<void> => {
        const currentSha = headShaOr(sandbox.worktreePath, 'unknown');
        const hasNewCommits = currentSha !== preTurnSha && preTurnSha !== 'unknown' && currentSha !== 'unknown';
        const statusResult = Bun.spawnSync(['git', 'status', '--porcelain'], {
          cwd: sandbox.worktreePath, stdout: 'pipe', stderr: 'pipe',
        });
        const hasUncommitted = statusResult.exitCode === 0 && statusResult.stdout.toString().trim().length > 0;
        const errorResponse: Record<string, unknown> = {
          status: 'error',
          error: `Work phase failed: ${cause}`,
          phase: 'work',
          ...launchSettings,
          // The real error path includes this whenever git detection succeeds —
          // false when the agent DID move the branch (e.g. a mock turn that
          // committed before failing the present check).
          agent_had_no_effect: !hasNewCommits && !hasUncommitted,
        };
        await writeMockResponse(protocolDir, errorResponse, await readCommand(protocolDir));
      };

      try {
        await simulatePresent(stepCtx);
      } catch (wrapUpErr) {
        await writeWorkPhaseError(
          wrapUpErr instanceof Error ? wrapUpErr.message : String(wrapUpErr),
        );
        return;
      }
    }
  }

  // Post-turn check: if the command has post_turn_check, run it and capture result
  let checkExitCode: number | undefined;
  let checkOutput: string | undefined;
  try {
    const { readFileSync: readFs, existsSync: existsFs } = await import('fs');
    const { truncateLog } = await import('../../src/utils/log-truncate');
    const commandPath = join(protocolDir, 'command.json');
    if (existsFs(commandPath)) {
      const cmd = JSON.parse(readFs(commandPath, 'utf-8'));
      const postTurnCheck = cmd.post_turn_check as string | undefined;
      if (postTurnCheck) {
        const checkResult = Bun.spawnSync(['sh', '-c', postTurnCheck], {
          cwd: sandbox.worktreePath,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        checkExitCode = checkResult.exitCode;
        const stderr = checkResult.stderr?.toString() ?? '';
        checkOutput = truncateLog(stderr);
      }
    }
  } catch {
    // Non-fatal: skip check execution if it fails in tests
  }

  // Build the completed bundle: work response (clean) + supervised follow-ups.
  // The work response carries turn-level outputs (post-turn check) and `pushed_back`
  // metadata but NOT violations — those live on the push-back response.
  const mockResp = getMockResponse();
  // PENCILS DOWN — `finalDeclaration` was captured above, before the wrap-up
  // chain: the real supervisor reads the declaration before deciding whether
  // the wrap-up runs, and carries the claim home on the work response whether
  // or not any step ran (including in plan mode). A mock that omitted it would
  // make every test downstream of it a fidelity lie — the same rule as
  // `command_id`.
  // What the turn left uncommitted, read from the real worktree exactly as the
  // supervisor reads it at the same point — after every wrap-up step. Written
  // only when non-empty and never on a failed scan, so the mock cannot report
  // "checked, clean" where production would report nothing at all.
  const leftovers = await listUncommittedPaths(sandbox.worktreePath);
  const workResponse: Record<string, unknown> = {
    status: 'completed',
    result: mockResp.result,
    session_id: mockResp.session_id,
    usage: mockResp.usage,
    ...launchSettings,
    ...(leftovers && leftovers.length > 0 ? { uncommitted: leftovers } : {}),
    ...(state.pushbackTriggered ? { pushed_back: true } : {}),
    ...(checkExitCode !== undefined ? { check_exit_code: checkExitCode } : {}),
    ...(checkOutput !== undefined ? { check_output: checkOutput } : {}),
    ...(finalDeclaration ? { final: finalDeclaration } : {}),
  };

  const bundle: Record<string, unknown> = {
    status: 'completed',
    responses: [workResponse, ...state.supervised],
  };
  await writeMockResponse(protocolDir, bundle, await readCommand(protocolDir));
}

// --- Container management ---

export interface ContainerInfo {
  running: boolean;
  exitCode: number;
  finishedAt: string | null;
}

/**
 * Containers are pretend here, so nothing is running — unless a suite says so.
 *
 * `LAZY_MOCK_RUNNING_CONTAINERS` names a file whose EXISTENCE means "the task's
 * container is up". It exists because this one hard-coded `false` used to put
 * the daemon's whole published-port path out of reach: `getTaskServeState` asks
 * the runner `isRunning()` first and reports `not-running` when it says no, so
 * no daemon-side test could reach a live service at all — and a live service is
 * most of what the serve subdomain proxy does.
 *
 * Only the RUNNING answer is faked. The port MAPPING still comes from a real
 * `docker port` (DockerRunner.getRunPortBindings is not mocked), so a suite
 * points this at the same state directory its fake `docker` reads and the two
 * cannot disagree.
 */
export function isContainerRunning(containerName: string): boolean {
  const runningFile = process.env.LAZY_MOCK_RUNNING_CONTAINERS;
  if (!runningFile) return false; // No containers in tests
  return existsSync(runningFile);
}

export function containerExists(containerName: string): boolean {
  return false;
}

export function getContainerExitCode(containerName: string): number | null {
  return 0; // Simulate successful exit
}

/**
 * Mock container info. When LAZY_MOCK_CRASHED_CONTAINERS is set to a comma-separated
 * list of container names, those containers are reported as crashed (stopped with exit 139).
 * When LAZY_MOCK_CONTAINER_EXIT_CODE is set, uses that exit code instead of 139.
 */
export function getContainerInfo(containerName: string): ContainerInfo | null {
  const crashedContainers = process.env.LAZY_MOCK_CRASHED_CONTAINERS;
  if (crashedContainers) {
    const names = crashedContainers.split(',').map(s => s.trim());
    if (names.includes(containerName)) {
      const exitCode = parseInt(process.env.LAZY_MOCK_CONTAINER_EXIT_CODE ?? '139', 10);
      return {
        running: false,
        exitCode,
        finishedAt: new Date(Date.now() - 37 * 60 * 1000).toISOString(), // 37 minutes ago
      };
    }
  }
  return null; // Container doesn't exist
}

export type ContainerProbe =
  | { kind: 'answered'; info: ContainerInfo | null }
  | { kind: 'no-answer'; reason: string };

/** The pretend runtime always answers, with exactly what `getContainerInfo` says. */
export async function probeContainerInfo(containerName: string): Promise<ContainerProbe> {
  return { kind: 'answered', info: getContainerInfo(containerName) };
}

export function getContainerLogs(containerName: string, tailLines: number = 50): string | null {
  return 'Mock container logs for testing';
}

export function removeContainer(containerName: string): void {
  // No-op in tests
}

export function containerNameForTask(taskShortId: string): string {
  return `lazy-${taskShortId}`;
}

// Mirrors the real name exactly: src/daemon/task-lifecycle.ts imports this
// statically, so a mock missing it kills every daemon subprocess at module
// evaluation with "Export named 'reviewContainerNameForTask' not found".
export function reviewContainerNameForTask(taskShortId: string): string {
  return `lazy-review-${taskShortId}`;
}

// Same static-import mirror as above: the acceptance gate's container name is
// imported by task-lifecycle.ts and must survive mock module evaluation.
export function acceptGateContainerNameForTask(taskShortId: string): string {
  return `lazy-gate-${taskShortId}`;
}

// --- Image identity hash ---

export function calculateImageInputsHash(_lazyRoot: string): string {
  return 'mock-dockerfile-hash';
}

export function calculateImageInputManifest(_lazyRoot: string): Record<string, string> {
  return { Dockerfile: 'mock-dockerfile-hash' };
}

export function describeInputChanges(): string | null {
  return null;
}

// Mirror the real module's re-export (consumed by `lazy system export-dockerfile`).
// The mock replaces capture/claude entirely under LAZY_TEST, so every symbol the
// source imports must be present here or module resolution fails CLI-wide.
export const DEFAULT_DOCKERFILE = '# mock Dockerfile\n';

// --- Token usage extraction ---

export function extractTokenUsage(response: AgentResponse): TokenUsage {
  return {
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
}
