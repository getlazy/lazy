/**
 * What lazy tells a reader to DO about an agent profile — in one place, because
 * the right answer depends on who the reader is and every surface kept getting
 * it wrong separately.
 *
 * ## The trap this module exists to close
 *
 * `[agents.<name>]` is how you configure an agent, and every surface said so:
 * "define a new one with an `[agents.<name>]` block", "add your own", "change
 * `[agents.<name>]` in lazy.toml". On an ordinary project that is the fix.
 *
 * On a MANAGED host it is worse than useless. `agents.*.endpoint` and
 * `agents.*.credential` carry `disposition: 'refused'` in `./managed`, and a
 * refusal is not "the key is ignored": `ManagedConfigRefusedError` fails the
 * config load, so a member who followed the advice would commit a key that
 * stops the whole project loading — a strictly worse state than the one they
 * were trying to get out of, reached by doing exactly what lazy told them.
 *
 * That is not hypothetical. lazy's built-in `pi` profile points at the machine's
 * own Ollama, so on an installation with no local model server every Pi task
 * refuses to launch, and this advice was the only sentence the member was given
 * (`fix-teams-pi-agent-launch`).
 *
 * ## The rule
 *
 * Never write the words `[agents.` into a message from a template literal at
 * the call site. Ask this module, and it decides from
 * {@link isManagedMode} whether to name the key or name the operator.
 * `test/unit/agent-profile-advice-coverage.test.ts` is a source scan that holds
 * every surface to it, because the drift does not arrive as one reviewable
 * violation — it arrives as the next person writing the obvious sentence.
 *
 * ## What the managed wording may and may not say
 *
 * It must not imply the reader did something wrong (they picked a legitimate
 * agent from a list lazy offered), it must not send them to a key their host
 * refuses, and it must name who CAN change it. It deliberately does not promise
 * the operator has a way to do so today — they do not; that gap is its own
 * piece of work (`fleet-agent-profiles`), and a message must not describe a
 * mechanism that does not exist.
 */

import { isManagedMode } from './managed-mode';

/**
 * How to get a profile that does not exist — the tail of "Unknown agent
 * profile X. Available profiles: …".
 */
export function defineProfileAdvice(name: string): string {
  if (!isManagedMode()) {
    return `Define a new one with an [agents.${name}] block in lazy.toml.`;
  }
  return (
    `This installation manages agent configuration, so an [agents.${name}] block in the ` +
    `repository's lazy.toml would be refused — ask whoever runs it to offer that agent.`
  );
}

/**
 * How to get MORE profiles than the ones just listed — the footer under a
 * listing, where no particular name is in question.
 */
export function addProfileAdvice(): string {
  if (!isManagedMode()) {
    return 'Add your own with an [agents.<name>] block in lazy.toml (harness, model, endpoint, credential).';
  }
  return (
    'This installation manages agent configuration: an [agents.<name>] block in the repository\'s ' +
    'lazy.toml would be refused, so these are the agents available here.'
  );
}

/**
 * How to change WHERE an existing profile's traffic goes, when its upstream did
 * not answer. The endpoint is the half a managed host refuses most firmly — it
 * is the key that would receive the installation's model credential.
 */
export function changeProfileEndpointAdvice(profile: string): string {
  if (!isManagedMode()) {
    return `Fix it, or change [agents.${profile}] in lazy.toml.`;
  }
  return (
    `This installation manages agent configuration: setting [agents.${profile}] endpoint in the ` +
    `repository's lazy.toml is refused there and would stop the project loading at all. ` +
    `Ask whoever runs this installation to make that upstream reachable from the host running ` +
    `this project's daemon, or choose an agent whose upstream it already provides.`
  );
}

/**
 * How to point the BUILDER at a model lazy does not recognize — the tail of
 * `lazy builder --model <something unknown>`.
 *
 * Its own function rather than {@link defineProfileAdvice} because the unmanaged
 * answer needs a second half the others do not have: defining the profile is
 * only useful together with the `[models.roles.builder]` line that selects it.
 */
export function builderProfileAdvice(): string {
  if (!isManagedMode()) {
    return (
      'define an [agents.<name>] profile with the endpoint that serves it and point ' +
      'the builder at it: [models.roles.builder] agent = "<name>".'
    );
  }
  return (
    'use a model this installation serves — it manages agent configuration, so an ' +
    '[agents.<name>] block in the repository\'s lazy.toml would be refused.'
  );
}

/**
 * The worked `[agents.<name>]` examples Pi's unsupported-provider error carries.
 *
 * They live here rather than in `agent/pi.ts` for the one reason this module
 * exists: they are four profile blocks with endpoints in them, and a managed
 * reader who copies one stops their project loading. The examples are
 * genuinely useful off a managed host, so they are kept rather than deleted.
 */
export function piUpstreamExamples(): string {
  if (!isManagedMode()) {
    return (
      'A pi agent profile that names no endpoint runs the local Ollama pi defaults to; one with ' +
      'an "endpoint" runs that upstream — over the Anthropic wire, e.g. ' +
      '[agents.anthropic-pi] harness = "pi", model = "claude-opus-5", ' +
      'endpoint = "https://api.anthropic.com", or [agents.remote-ollama-pi] harness = "pi", ' +
      'model = "…", endpoint = "http://ollama.lan:11434", or over the OpenAI wire when the ' +
      'endpoint is OpenAI\'s or OpenRouter\'s, e.g. [agents.openai-pi] harness = "pi", ' +
      'model = "gpt-5.2", endpoint = "https://api.openai.com" or [agents.openrouter-pi] ' +
      'harness = "pi", model = "anthropic/claude-sonnet-4.5", endpoint = "https://openrouter.ai/api".'
    );
  }
  return (
    'Which upstream a pi profile runs is not something a repository chooses on this installation, ' +
    'which manages agent configuration — ask whoever runs it.'
  );
}

/**
 * The remedy attached to a config section lazy has REMOVED — `[ollama]`,
 * `[models.roles.<role>] endpoint`, `[proxy] openai_upstream`.
 *
 * These are the worst instance of the trap, because they hand a managed reader
 * TWO dead ends in one message: a paste-ready `[agents.<name>]` block carrying
 * the `endpoint` such a host refuses, and then "run `lazy doctor --fix agents`",
 * which now refuses outright there. Between them they turn "this section is
 * obsolete" — recoverable by deleting three lines — into "this project will not
 * load", by doing exactly what lazy said.
 *
 * `block` is the paste-ready TOML and `tail` whatever follows it; both are
 * DROPPED on a managed host rather than reworded, because the only honest
 * managed instruction is the deletion, and a profile to replace it with is not
 * the repository's to write.
 */
export function replaceWithProfileAdvice(block: string, tail: string): string {
  if (!isManagedMode()) {
    return `Replace it with:\n\n${block}\n\n${tail}`;
  }
  return (
    'Delete it. This installation manages agent configuration, so the profile that replaces it ' +
    'is not the repository\'s to write — and `lazy doctor --fix agents` will not migrate it here ' +
    'either, for the same reason. Ask whoever runs this installation which agents it offers.'
  );
}

/**
 * How to give a profile a credential — `lazy system agent set-key` on a profile
 * whose upstream authenticates nobody.
 *
 * `agents.*.credential` is refused on a managed host for any name outside the
 * fleet's own providers, which is exactly the `"<name>"` placeholder this used
 * to print.
 */
export function addCredentialToProfileAdvice(profile: string): string {
  if (!isManagedMode()) {
    return (
      'Give the profile a credential in lazy.toml if that upstream does need one:\n' +
      `  [agents.${profile}]\n  credential = "<name>"`
    );
  }
  return (
    'Which credential a profile bills is not something a repository chooses on this installation, ' +
    'which manages agent configuration — ask whoever runs it.'
  );
}

/**
 * What will make a stored credential nothing reads — `lazy auth import` /
 * `lazy auth set` into a slot no profile bills yet.
 *
 * The inverse shape of `addCredentialToProfileAdvice`: there the profile is
 * known and the credential is the `"<name>"` placeholder, here the credential
 * is known and the PROFILE is the placeholder. Same refused key either way,
 * so the same rule applies — unmanaged, naming the block is the answer; on a
 * managed host the repository does not choose which agents exist or what they
 * bill, so telling the reader to write one would hand them a config their
 * installation refuses.
 *
 * Returns the clause that completes "…so nothing will read this session",
 * ending the sentence, so the caller keeps its own opening and its own hints.
 */
export function unreferencedCredentialAdvice(credential: string): string {
  if (!isManagedMode()) {
    return `until an [agents.<name>] block names it as credential = "${credential}".`;
  }
  return (
    'until an agent here bills it — and which agents this installation offers, ' +
    'along with what each one bills, is not the repository\'s to set, so ask whoever runs it.'
  );
}

/**
 * How to point lazy at a local model server, in the daemon's
 * no-credential-found refusal.
 *
 * Reachable on a managed host whenever the fleet has not given the daemon a
 * credential, which is precisely when somebody is casting about for a way to
 * make it start — the worst moment to be handed a key their host refuses.
 */
export function localModelProfileAdvice(): string {
  if (!isManagedMode()) {
    return (
      '(If you use a local model, give it an agent profile — [agents.<name>] with an\n' +
      '`endpoint` pointing at your server — and name that profile in [agent] agent_id.)'
    );
  }
  return (
    '(This installation manages agent configuration, so the credential is its to supply\n' +
    'and a local-model profile is not the repository\'s to add — ask whoever runs it.)'
  );
}

/**
 * How to keep a profile that declares an Anthropic model ON Anthropic — the
 * warning a profile gets when its model and its default upstream disagree.
 *
 * The only advice in this module that names no `[agents.` table header at all:
 * it says "Add endpoint = …" about a profile already under discussion, which is
 * why the guard scan has to look for a refused KEY and not only for the header.
 */
export function keepProfileOnEndpointAdvice(endpoint: string, servedBy: string): string {
  if (!isManagedMode()) {
    return (
      `Add endpoint = ${JSON.stringify(endpoint)} to keep this profile on that upstream, ` +
      `or set a model ${servedBy} serves.`
    );
  }
  return (
    `Set a model ${servedBy} serves. Which upstream a profile runs is not something a repository ` +
    'chooses on this installation, which manages agent configuration — ask whoever runs it.'
  );
}

/**
 * The commented `[agents.<name>]` examples `lazy init` writes into a new
 * lazy.toml.
 *
 * Inert as TOML, but it is the most-read description of the profile shape there
 * is, and the fleet runs `lazy init` for every project it provisions — so on a
 * managed host it would ship every project a commented-out block that stops the
 * project loading the moment somebody uncomments it.
 */
export function generatedConfigProfileExamples(): string {
  if (!isManagedMode()) {
    return (
      '# [agents.local-ollama]\n' +
      '# harness = "claude-code"\n' +
      '# model = "qwen3.5:35b-a3b-coding-nvfp4"\n' +
      '# endpoint = "http://localhost:11434"\n' +
      '#\n' +
      '# [agents.work-codex]\n' +
      '# harness = "codex"\n' +
      '# model = "gpt-5-codex"'
    );
  }
  return (
    '# This installation manages agent configuration: an [agents.<name>] block here\n' +
    '# naming an endpoint or a credential is refused, and the project will not load\n' +
    '# with one. Ask whoever runs the installation which agents it offers.'
  );
}

/**
 * Why a task cannot be created on this agent at all — the create-time refusal.
 *
 * Only ever reached on a managed host (see `daemon/agent-profile-check.ts`), so
 * unlike its neighbours this one has no unmanaged branch: off a managed host the
 * upstream is the reader's own to start, and refusing their create would be
 * wrong.
 */
export function unrunnableProfileRefusal(profile: string, endpoint: string): string {
  return (
    `Agent "${profile}" cannot run on this installation: its model upstream (${endpoint}) is not ` +
    `answering, and a project cannot point it elsewhere here — this installation manages agent ` +
    `configuration. Choose an agent it already runs, or ask whoever runs it to provide that upstream.`
  );
}
