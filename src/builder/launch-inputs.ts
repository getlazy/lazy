/**
 * The per-launch inputs of a builder: project config and the system prompt.
 *
 * `lazy builder` is a long-lived host process; its relaunch loop re-executes the
 * child after an upgrade, possibly days after the first start. Anything derived
 * from lazy.toml (model, profile, credential, effort, sandbox posture) or from
 * the prompt assembly (memory, messages, config-dependent sections) must be
 * re-read for every launch, or the relaunched builder runs whatever was current
 * when the command first started.
 */

export interface BuilderLaunchInputs<C> {
  config: C;
  systemPrompt: string;
}

export interface LaunchInputSources<C> {
  loadConfig: () => Promise<C>;
  buildSystemPrompt: () => Promise<string>;
}

/** Read the current config and rebuild the prompt. Never cached. */
export async function resolveBuilderLaunchInputs<C>(
  sources: LaunchInputSources<C>,
): Promise<BuilderLaunchInputs<C>> {
  const config = await sources.loadConfig();
  const systemPrompt = await sources.buildSystemPrompt();
  return { config, systemPrompt };
}
