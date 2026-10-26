/**
 * Which agent profile a builder session runs on.
 *
 * The builder ROLE has a configured profile (`[models.roles.builder] agent`,
 * default `claude-code`). A session may name another one — `lazy builder
 * --agent codex-subscription` on a laptop, the profile a Teams member picks on
 * the Builders page — and from then on that session's whole life runs on it:
 * the launch, every in-place relaunch after a daemon restart, and the
 * credential it bills. The choice is recorded on the session's MCP token at
 * mint (src/daemon/actor-tokens.ts) so the daemon, not the container, answers
 * "which profile" on every refresh.
 *
 * Only two harnesses can drive an interactive builder: Claude Code and Codex.
 * Every other profile is refused here with the reason, before anything is
 * minted or launched.
 */

import type { ResolvedConfig, RoleTarget } from '../config/types';
import { profileForAgentNameOrNull, agentProfilesFor } from '../config/agent-profiles';
import { resolveRoleTarget } from '../utils/role-target';

/** Harnesses that can run an interactive builder session. */
export const BUILDER_HARNESSES = ['claude-code', 'codex'] as const;

export function isBuilderHarness(harness: string): boolean {
  return (BUILDER_HARNESSES as readonly string[]).includes(harness);
}

/**
 * Validate a requested builder profile name and return it, or the role's
 * configured profile when none was requested. Throws an Error whose message is
 * written for the person who asked (CLI and Teams both show it verbatim).
 */
export function resolveBuilderProfileName(config: ResolvedConfig, requested?: string | null): string {
  const name = requested?.trim();
  if (!name) return config.models.roles.builder.profile;
  const profile = profileForAgentNameOrNull(config, name);
  if (!profile) {
    const known = [...agentProfilesFor(config).values()]
      .filter((p) => isBuilderHarness(p.harness))
      .map((p) => p.name);
    throw new Error(
      `No agent profile named "${name}" in this project. Builder-capable profiles: ${known.join(', ') || '(none)'}.`,
    );
  }
  // The role's OWN profile is the project's existing choice and launched
  // before this check existed; only an explicitly picked profile is refused.
  if (!isBuilderHarness(profile.harness) && profile.name !== config.models.roles.builder.profile) {
    throw new Error(
      `The "${name}" agent profile runs ${profile.harness}, which cannot run the builder. ` +
      `The builder runs on Claude Code or Codex: pick a profile whose harness is one of ${BUILDER_HARNESSES.join(', ')}.`,
    );
  }
  return profile.name;
}

/**
 * The builder's role target for `profileName` (null → the role's configured
 * one). The role's own profile keeps its configured target exactly — tiers and
 * all — so naming it explicitly changes nothing.
 */
export function builderTargetForProfile(
  config: ResolvedConfig,
  profileName: string | null | undefined,
  opts?: { overrideModel?: string | null },
): RoleTarget {
  if (!profileName || profileName === config.models.roles.builder.profile) {
    return resolveRoleTarget('builder', config, opts);
  }
  const profile = profileForAgentNameOrNull(config, profileName);
  if (!profile) {
    throw new Error(
      `This builder session runs on the "${profileName}" agent profile, which lazy.toml no longer defines. ` +
      `Start a new builder.`,
    );
  }
  return resolveRoleTarget('builder', config, { ...opts, profile });
}
