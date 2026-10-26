/**
 * The argv a Codex builder session is launched with.
 *
 * Every builder launch path — `lazy builder` on either runner, a Teams
 * builder, a continuity relaunch after a daemon restart — composes ONE
 * argv tail in Claude Code's spelling (`--resume`, `--model`, `--effort`,
 * `--add-dir`, `--dangerously-skip-permissions`, the host sandbox's
 * `--settings`), and the daemon's launch directive rewrites the model/effort
 * in that same spelling (src/builder/launch-directive.ts). For a Codex
 * builder the supervisor translates that tail here, at the last moment, so
 * nothing upstream needs a second shape.
 *
 * The base argv — `codex` or `codex resume <id>`, the sandbox bypass, `-m` —
 * comes from the Codex agent's own interactive argv (`buildInteractiveArgs`,
 * the same one `lazy pair` uses), so pairing and the builder cannot drift.
 * Flags checked against codex-cli 0.164.0 `codex --help` / `codex resume
 * --help`: both accept `-c`, `-m`, `-s`, `-a`, `--add-dir` and
 * `--dangerously-bypass-approvals-and-sandbox`.
 *
 * The builder prompt is NOT on the argv: it goes into the managed
 * config.toml as `developer_instructions` (src/agent/codex-config.ts), which
 * has no argv length limit.
 */

import { getAgent } from '../agent/registry';
import { codexEffort } from '../agent/codex';

/** The `--resume <id>` a composed builder argv tail carries, or null. */
export function builderResumeIdFromArgs(args: readonly string[] | undefined): string | null {
  if (!args) return null;
  const i = args.indexOf('--resume');
  const id = i >= 0 ? args[i + 1] : undefined;
  return id && !id.startsWith('-') ? id : null;
}

export interface CodexBuilderArgsInput {
  /** The Claude-spelled argv tail, after the launch directive was applied. */
  claudeArgs: readonly string[];
  /**
   * True inside a builder container: the container is the boundary, exactly
   * as for a task turn, and Codex's own (bubblewrap) sandbox cannot start
   * there. False on the host-process runner, where Codex's native sandbox is
   * the only thing between the builder and the machine.
   */
  externallySandboxed: boolean;
}

/** Translate a builder argv tail into the full `codex` argv. Throws on a flag Codex has no counterpart for. */
export function composeCodexBuilderArgs(input: CodexBuilderArgsInput): string[] {
  let resumeId: string | null = null;
  let model: string | null = null;
  let effort: string | null = null;
  let skipPermissions = false;
  let hostSandboxed = false;
  const addDirs: string[] = [];

  const args = input.claudeArgs;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = (): string => {
      const v = args[i + 1];
      if (v === undefined) throw new Error(`Builder argument ${arg} has no value.`);
      i++;
      return v;
    };
    switch (arg) {
      case '--resume': resumeId = value(); break;
      case '--model': model = value(); break;
      case '--effort': effort = value(); break;
      case '--add-dir': addDirs.push(value()); break;
      case '--dangerously-skip-permissions': skipPermissions = true; break;
      // The host runner's OS-sandbox settings for Claude Code. Codex has its
      // own sandbox, selected below; the JSON itself means nothing to it.
      case '--settings': value(); hostSandboxed = true; break;
      default:
        throw new Error(
          `The Codex builder cannot translate the argument "${arg}" — it is a Claude Code flag with no Codex counterpart.`,
        );
    }
  }

  const bypass = input.externallySandboxed ? skipPermissions : (skipPermissions && !hostSandboxed);
  const out = getAgent('codex').buildInteractiveArgs({
    sessionId: resumeId,
    modelId: model,
    dangerouslySkipPermissions: bypass,
  });
  if (!out) throw new Error('The Codex agent reports no interactive mode; it cannot run the builder.');

  if (!bypass) {
    if (input.externallySandboxed || hostSandboxed) {
      // Pair's interactive argv chooses a container sandbox. The builder may
      // need a different one, so replace that choice rather than adding one.
      const sandboxIndex = out.indexOf('--sandbox');
      if (sandboxIndex < 0) throw new Error('The Codex interactive argv has no sandbox choice to replace.');
      out.splice(sandboxIndex, 2);
    }
    if (input.externallySandboxed) {
      // --no-autonomous in a container: no nested sandbox (it cannot start
      // there), but Codex asks before acting.
      out.push('-s', 'danger-full-access', '-a', 'on-request');
    } else if (hostSandboxed) {
      // Host runner, permission_mode = "sandbox": Codex's own sandbox confines
      // writes to the workspace (+ --add-dir); autonomous never prompts.
      out.push('-s', 'workspace-write', '-a', skipPermissions ? 'never' : 'on-request');
    }
    // Host runner in bypass mode without --autonomous: Codex's own defaults.
  }
  if (effort) {
    const mapped = codexEffort(effort);
    // -c values are TOML; the quotes make it a string literal.
    if (mapped) out.push('-c', `model_reasoning_effort="${mapped}"`);
  }
  for (const dir of addDirs) out.push('--add-dir', dir);
  return out;
}

/**
 * Refuse a headless (one-shot) builder turn on Codex — the builder that answers
 * in a review conversation. That path runs `claude -p` and reads Claude Code's
 * JSON result; it has not learned Codex, and launching Claude Code under a
 * Codex profile would bill the wrong credential. Said plainly instead.
 */
export function assertHeadlessBuilderHarness(harness: string, profile: string): void {
  if (harness !== 'claude-code') {
    throw new Error(
      `Builder replies in review conversations run on Claude Code only, but the builder role's profile ` +
      `"${profile}" runs ${harness}. Point [models.roles.builder] at a Claude Code profile to use review ` +
      `conversations, or run Codex as an interactive builder (lazy builder --agent ${profile}).`,
    );
  }
}
