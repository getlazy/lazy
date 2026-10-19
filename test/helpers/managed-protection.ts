/**
 * Turn branch protection off in a managed (Teams) project's config.
 *
 * A managed daemon protects the default branch unless the config sets
 * `[protection] enabled` itself, and only a member's Accept in Teams then
 * approves a merge into it. Suites that accept into `main` for reasons that
 * have nothing to do with protection set the owner's off switch — the same key
 * the Configuration page writes — rather than routing around the gate.
 * `test/e2e/teams-protected-accept.test.ts` covers the gate itself.
 */
import { readFile, writeFile } from 'fs/promises';

export function withProtectionOff(toml: string): string {
  const out = toml.replace('[protection]\n', '[protection]\nenabled = false\n');
  if (out === toml) throw new Error('lazy.toml has no [protection] section to edit');
  return out;
}

/** Rewrite the config file at `path` in place with protection off. */
export async function turnProtectionOff(path: string): Promise<void> {
  await writeFile(path, withProtectionOff(await readFile(path, 'utf8')));
}
