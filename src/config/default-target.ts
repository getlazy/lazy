/**
 * The role target shape, and the one target that exists before any config does.
 *
 * This module has NO runtime imports, deliberately. Both `src/config/loader.ts`
 * (which needs `ANTHROPIC_DEFAULT_TARGET` at module scope, inside
 * `DEFAULT_CONFIG`) and `src/utils/role-target.ts` need these two values, and
 * role-target reaches the credential store, which reaches the loader. When the
 * loader was the one holding the constant that cycle was harmless; when
 * role-target held it, importing role-target FIRST evaluated the loader's module
 * body while role-target's own bindings were still in their temporal dead zone,
 * and `DEFAULT_CONFIG` threw at import time. A leaf with nothing to initialize
 * cannot be caught mid-initialization, so neither direction can fail.
 *
 * Type-only imports are fine here: they are erased and create no edge.
 */

import type { RoleTarget } from './types';
import type { AgentProfile } from './agent-profiles';

/**
 * Flatten a resolved profile into the role target a launch carries.
 *
 * One function so the config loader, the runner defaults and any test fixture
 * all produce the same shape from the same source — a role target that disagreed
 * with the profile it claims to run would route one way and launch another.
 */
export function roleTargetForProfile(profile: AgentProfile): RoleTarget {
  return {
    profile: profile.name,
    harness: profile.harness,
    model: profile.model,
    endpoint: profile.endpoint,
    pinned: profile.endpointPinned,
    wire: profile.wire,
    credential: profile.credential,
  };
}

/**
 * The default target: the built-in `claude-code` profile, i.e. "use the normal
 * Anthropic model chain". Used as the fallback for runners that have no per-role
 * targets set (the in-container supervisor's runner), preserving
 * credential-inheritance behavior.
 *
 * Spelled out rather than resolved through `agentProfilesFor` because profile
 * resolution reaches the agent registry, which this module must not import (see
 * above). The values are the built-in claude-code profile's, and
 * `test/unit/role-target.test.ts` asserts they stay in step with it.
 */
export const ANTHROPIC_DEFAULT_TARGET: RoleTarget = {
  profile: 'claude-code',
  harness: 'claude-code',
  model: '',
  endpoint: '',
  pinned: false,
  wire: 'anthropic',
  credential: 'anthropic',
};
