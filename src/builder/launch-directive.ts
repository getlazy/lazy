/**
 * The builder's model/effort, decided by the DAEMON at every (re)launch.
 *
 * A builder container's claude argv is composed once by the host `lazy builder`
 * and survives every in-place relaunch across a daemon restart or upgrade, so a
 * model lazy.toml dropped days ago kept running. The daemon now serves the
 * builder role's CURRENT model and effort with the launch env, and the
 * supervisor substitutes them into the argv tail — except where a person typed
 * `--model` / `--effort` on `lazy builder`: the host marks those with the two
 * sentinel flags below and the supervisor leaves the typed value alone.
 */

import type { ResolvedConfig } from '../config/types';
import { resolveBuilderModel } from '../agent/agent-model';
import { resolveRoleTarget } from '../utils/role-target';

/** Host → supervisor markers: the value that follows was TYPED, not resolved. */
export const MODEL_OVERRIDE_FLAG = '--lazy-model-override';
export const EFFORT_OVERRIDE_FLAG = '--lazy-effort-override';

export interface BuilderLaunchDirective {
  /** Resolved builder model — always a concrete model (the builder default when no profile names one). */
  model: string;
  effort: string;
}

/**
 * Daemon side: what a fresh `lazy builder` would launch with now (no typed overrides).
 * Resolved through `resolveBuilderModel`, exactly as `lazy builder` does, so a relaunch with
 * no profile model lands on the builder default and never omits `--model`.
 */
export function resolveBuilderLaunchDirective(config: ResolvedConfig): BuilderLaunchDirective {
  const target = resolveRoleTarget('builder', config);
  return {
    model: resolveBuilderModel(config, { harness: target.harness, model: target.model }),
    effort: config.builder.effort,
  };
}

function dropFlagWithValue(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) { i++; continue; }
    out.push(args[i]);
  }
  return out;
}

/**
 * Supervisor side: rewrite the argv tail the host composed. Sentinels are always
 * stripped (claude must never see them); a value is replaced by the daemon's
 * unless its sentinel says a person typed it. `directive` undefined (an older
 * daemon) leaves the argv as composed.
 */
export function applyLaunchDirective(
  extraArgs: string[],
  directive: Partial<BuilderLaunchDirective> | undefined,
): string[] {
  const modelTyped = extraArgs.includes(MODEL_OVERRIDE_FLAG);
  const effortTyped = extraArgs.includes(EFFORT_OVERRIDE_FLAG);
  let args = extraArgs.filter(a => a !== MODEL_OVERRIDE_FLAG && a !== EFFORT_OVERRIDE_FLAG);
  if (!directive) return args;
  if (!modelTyped && directive.model !== undefined) {
    args = dropFlagWithValue(args, '--model');
    if (directive.model) args.push('--model', directive.model);
  }
  if (!effortTyped && directive.effort) {
    args = dropFlagWithValue(args, '--effort');
    args.push('--effort', directive.effort);
  }
  return args;
}
