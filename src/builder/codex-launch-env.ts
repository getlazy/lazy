/**
 * The credential a single-user Codex builder launches with — daemon side.
 *
 * `getAuthEnv` answers in Claude Code's spelling (a profile's own key comes
 * back as `ANTHROPIC_AUTH_TOKEN`), which is right for every builder until now
 * and wrong for Codex, which reads its bearer from `OPENAI_API_KEY` through the
 * `env_key` of the provider block lazy writes (src/agent/codex-config.ts). So a
 * Codex builder gets what a Codex TASK turn gets (src/capture/claude.ts, the
 * non-claude branch): the profile's key is required to EXIST, then dropped —
 * the container is handed a placeholder grant bound to this builder session's
 * label and profile, and the proxy resolves the real key per request.
 *
 * Team mode never comes here: a member's builder is paid through its session
 * binding (src/daemon/builder-sessions.ts → getLaunchAuthEnvVars), which mints
 * the OPENAI_API_KEY grant against THAT member's credential for the profile.
 */

import type { ResolvedConfig, RoleTarget } from '../config/types';
import { profileForAgentName, NO_CREDENTIAL } from '../config/agent-profiles';
import { resolveProfileCredential, AGENT_KEY_ENV } from '../agent/credentials';
import { credentialSetupCommand } from '../credentials/providers';
import { mintCredentialGrant } from '../proxy/credential-broker';

export async function codexBuilderAuthEnv(
  projectRoot: string,
  config: ResolvedConfig,
  target: RoleTarget,
  label: string,
): Promise<Array<{ key: string; value: string }>> {
  const profile = profileForAgentName(config, target.profile, 'this builder session');
  // A local upstream that authenticates nobody: there is no key to require.
  if (profile.credential === NO_CREDENTIAL) return [];
  const envKey = AGENT_KEY_ENV[profile.harness];
  if (!envKey) throw new Error(`The ${profile.harness} harness reads no API key, so it cannot run a Codex builder.`);
  const key = await resolveProfileCredential(projectRoot, profile);
  if (!key) {
    const command = credentialSetupCommand(profile.credential, profile.name !== profile.harness ? profile.name : undefined);
    throw new Error(
      `No ${profile.credential} credential for the "${profile.name}" builder profile. ` +
      `Store one with \`lazy ${command}\`, then start the builder again.`,
    );
  }
  const placeholder = await mintCredentialGrant(projectRoot, {
    role: 'builder', taskId: null, label, profile: target.profile, envKey,
  });
  return [{ key: envKey, value: placeholder }];
}
