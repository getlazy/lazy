/**
 * Named agent profiles: resolution and validation.
 *
 * The load-bearing property here is that a profile's WIRE and CREDENTIAL are
 * derived, not configured. The wire selects the proxy's path-allowlist tier and
 * which usage extractor may read a body, so a user-settable wire would be a
 * user-settable security boundary; the credential decides whose key travels to
 * an upstream. Both are covered below, including the two cases that used to go
 * the other way (a local endpoint receiving a real hosted key, and a harness
 * pointed at an endpoint speaking a protocol it cannot speak).
 */
import { describe, test, expect } from 'bun:test';
import {
  resolveAgentProfiles,
  agentProfileOrThrow,
  agentProfileNames,
  selectableAgentProfiles,
  agentProfileSummary,
  defaultCredentialFor,
  knownEndpointWires,
  wireForProfile,
  HARNESS_WIRES,
  BUILTIN_PROFILE_NAMES,
  BUILTIN_PROFILES,
  NO_CREDENTIAL,
  DEFAULT_AGENT_PROFILE_NAME,
} from '../../src/config/agent-profiles';
import { listAgents } from '../../src/agent/registry';
import { CHATGPT_CODEX_UPSTREAM, DEFAULT_OPENAI_UPSTREAM } from '../../src/utils/openai-compat';
import {
  DEFAULT_LOCAL_OLLAMA_ENDPOINT,
  DEFAULT_LOCAL_OLLAMA_MODEL,
} from '../../src/utils/ollama';

/** Resolve without letting the endpoint-rewrite warning reach the console. */
function resolve(raw?: Record<string, Record<string, string>>) {
  const warnings: string[] = [];
  const profiles = resolveAgentProfiles(raw as never, (m) => warnings.push(m));
  return { profiles, warnings };
}

describe('built-in profiles', () => {
  test('a project with no [agents] section gets exactly the built-ins', () => {
    const { profiles, warnings } = resolve(undefined);
    expect(agentProfileNames(profiles)).toEqual([...BUILTIN_PROFILE_NAMES].sort());
    expect(warnings).toEqual([]);
    for (const profile of profiles.values()) {
      expect(profile.builtin).toBe(true);
      // A built-in's harness comes from the built-in TABLE, not from its own
      // name. It used to be one profile per harness, named after it; codex now
      // has three (`codex`, `codex-api`, `codex-subscription`) because the same
      // binary bills two different accounts at two different services, and which
      // one a task uses must be selectable without writing a config block.
      expect(profile.harness).toBe(BUILTIN_PROFILES[profile.name]!.harness);
    }
    // Every HARNESS still has a profile of its own name: a task record or an
    // `[agent] agent_id` naming a harness has always resolved, and must keep
    // resolving.
    for (const harness of Object.keys(HARNESS_WIRES)) {
      expect(profiles.get(harness)?.harness).toBe(harness);
    }
  });

  // The default profile has to exist, or `[agent] agent_id`'s default names
  // nothing and every fresh project fails to launch.
  test('the default profile name is a built-in', () => {
    const { profiles } = resolve(undefined);
    expect(profiles.has(DEFAULT_AGENT_PROFILE_NAME)).toBe(true);
  });

  // INVARIANT: codex is OpenAI-wire, and the proxy's primary upstream is
  // Anthropic-wire — so codex must carry a concrete default endpoint rather
  // than inheriting the primary one. This built-in is what replaced the removed
  // global `[proxy] openai_upstream`.
  test('codex defaults to the OpenAI upstream; the other Anthropic-wire harnesses default to the primary', () => {
    const { profiles } = resolve(undefined);
    expect(profiles.get('codex')!.endpoint).toBe(DEFAULT_OPENAI_UPSTREAM);
    expect(profiles.get('codex')!.wire).toBe('openai');
    for (const name of ['claude-code', 'cursor']) {
      expect(profiles.get(name)!.endpoint).toBe('');
      expect(profiles.get(name)!.wire).toBe('anthropic');
    }
  });

  // INVARIANT (engineer, 2026-09-14): codex has a built-in profile per THING IT
  // BILLS, selectable by name with no config block. The same binary can spend a
  // metered OpenAI API key or a ChatGPT Plus/Pro subscription, and those are
  // different accounts at different services — so "which one am I about to
  // spend" must be answerable from the agent name a task carries, not inferred
  // from which credential happens to be stored.
  test('codex-api and codex-subscription are built-ins that bill different accounts', () => {
    const { profiles } = resolve(undefined);

    const api = profiles.get('codex-api')!;
    expect(api.harness).toBe('codex');
    expect(api.endpoint).toBe(DEFAULT_OPENAI_UPSTREAM);
    expect(api.credential).toBe('openai');

    const sub = profiles.get('codex-subscription')!;
    expect(sub.harness).toBe('codex');
    expect(sub.endpoint).toBe(CHATGPT_CODEX_UPSTREAM);
    // DERIVED from the endpoint's hostname, never listed in the built-in table —
    // so the endpoint stays the single statement of intent and the two cannot
    // drift into billing an account the name does not promise.
    expect(sub.credential).toBe('chatgpt');

    // Same wire, so the same proxy allowlist tier and usage extractor.
    expect(api.wire).toBe('openai');
    expect(sub.wire).toBe('openai');

    // NOT pinned: these endpoints are lazy's defaults, not a user's, so neither
    // profile demands a `model` the way a hand-pinned endpoint does — codex
    // picks its own default model.
    expect(api.endpointPinned).toBe(false);
    expect(sub.endpointPinned).toBe(false);
    expect(api.model).toBe('');
    expect(sub.model).toBe('');
  });

  // INVARIANT: `codex` keeps working and keeps meaning the API key. Tasks store
  // their profile name on the record and projects name one in `[agent]
  // agent_id`, so retiring the name would break every existing codex task.
  test('the older `codex` name still resolves, identically to codex-api', () => {
    const { profiles } = resolve(undefined);
    const codex = profiles.get('codex')!;
    const api = profiles.get('codex-api')!;
    expect(codex.harness).toBe(api.harness);
    expect(codex.endpoint).toBe(api.endpoint);
    expect(codex.credential).toBe(api.credential);
    expect(codex.wire).toBe(api.wire);
  });

  // A block of a built-in's name supplies only what it overrides. Without this,
  // adding `model = "…"` to codex-subscription would drop it back to the harness
  // default endpoint (api.openai.com) and silently bill a metered API key under a
  // profile whose name says "subscription".
  test('overriding codex-subscription keeps it on the subscription backend', () => {
    const { profiles } = resolve({ 'codex-subscription': { model: 'gpt-5.6-sol' } });
    const sub = profiles.get('codex-subscription')!;
    expect(sub.endpoint).toBe(CHATGPT_CODEX_UPSTREAM);
    expect(sub.credential).toBe('chatgpt');
    expect(sub.model).toBe('gpt-5.6-sol');
    expect(sub.builtin).toBe(false);
  });

  // ...but repurposing the NAME onto another harness is the user's explicit
  // choice, and lazy must not force its endpoint back on.
  test('a block that repurposes the name onto another harness is left alone', () => {
    const { profiles } = resolve({
      'codex-subscription': { harness: 'pi', model: 'qwen3.8:latest' },
    });
    const repurposed = profiles.get('codex-subscription')!;
    expect(repurposed.harness).toBe('pi');
    expect(repurposed.endpoint).toBe(DEFAULT_LOCAL_OLLAMA_ENDPOINT);
  });

  // INVARIANT (engineer, 2026-09-13): pi is lazy's LOCAL-model agent, so the
  // built-in profile runs the machine's own Ollama and spends no credential.
  // `--agent pi` must never quietly bill Anthropic; reaching Anthropic with pi
  // is a profile someone wrote on purpose. Endpoint and model are one pair —
  // a model name means nothing without the service that serves it — and the
  // endpoint is host-perspective because the PROXY dials it.
  test('pi defaults to the local Ollama, with its model, and no credential', () => {
    const { profiles } = resolve(undefined);
    const pi = profiles.get('pi')!;
    expect(pi.endpoint).toBe(DEFAULT_LOCAL_OLLAMA_ENDPOINT);
    expect(pi.model).toBe(DEFAULT_LOCAL_OLLAMA_MODEL);
    expect(pi.wire).toBe('anthropic');
    expect(pi.credential).toBe(NO_CREDENTIAL);
    // NOT pinned: the default is lazy's, not the user's, so a task-level model
    // still overrides it (see resolveRoleTarget).
    expect(pi.endpointPinned).toBe(false);
  });

  // INVARIANT: a profile that named an Anthropic model but no endpoint is WARNED
  // about, not silently repointed. Before pi's default moved, that block was the
  // documented way to run pi on Anthropic; it keeps its name and its model while
  // the service underneath it changes, which is the silent upstream substitution
  // the rest of the codebase refuses. Not a refusal: the engineer asked for this
  // default, and a project whose profile is genuinely fine must still load.
  test('a user pi profile naming an Anthropic model with no endpoint warns at load', () => {
    const { warnings } = resolve({ 'my-pi': { harness: 'pi', model: 'claude-opus-5' } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('[agents.my-pi]');
    expect(warnings[0]).toContain('claude-opus-5');
    expect(warnings[0]).toContain('http://localhost:11434');
    // Actionable: it names the line to add.
    expect(warnings[0]).toContain('endpoint = "https://api.anthropic.com"');
  });

  test('the warning stays silent where nothing moved', () => {
    // A local model on the default upstream — the intended shape.
    expect(resolve({ local: { harness: 'pi', model: 'qwen3.8:latest' } }).warnings).toHaveLength(0);
    // The profile pinned Anthropic itself, so nothing was substituted.
    expect(resolve({
      'ok-pi': { harness: 'pi', model: 'claude-opus-5', endpoint: 'https://api.anthropic.com' },
    }).warnings).toHaveLength(0);
    // The built-ins never warn about themselves.
    expect(resolve(undefined).warnings).toHaveLength(0);
    // claude-code has no default endpoint, so its Anthropic model is at home.
    expect(resolve({ 'my-cc': { harness: 'claude-code', model: 'claude-opus-5' } }).warnings).toHaveLength(0);
  });

  // INVARIANT: the default MODEL rides with the default ENDPOINT and nowhere
  // else. A profile that pins its own endpoint must still name its own model —
  // filling pi's Ollama default in there would send that model name to whatever
  // server the user chose, and would silently defeat the refusal below.
  test('a pi profile that pins an endpoint gets no default model, and is refused without one', () => {
    expect(() => resolve({ 'remote-pi': { harness: 'pi', endpoint: 'http://ollama.lan:11434' } }))
      .toThrow(/sets endpoint but no model/);
    const { profiles } = resolve({
      'anthropic-pi': { harness: 'pi', endpoint: 'https://api.anthropic.com', model: 'claude-opus-5' },
    });
    const pi = profiles.get('anthropic-pi')!;
    expect(pi.model).toBe('claude-opus-5');
    expect(pi.endpoint).toBe('https://api.anthropic.com');
    expect(pi.credential).toBe('anthropic');
  });

  test('a block of a built-in name replaces the built-in', () => {
    const { profiles } = resolve({ 'claude-code': { model: 'claude-opus-5' } });
    const profile = profiles.get('claude-code')!;
    expect(profile.builtin).toBe(false);
    expect(profile.harness).toBe('claude-code');
    expect(profile.model).toBe('claude-opus-5');
    // Still only the built-in names — an override adds nothing.
    expect(agentProfileNames(profiles)).toEqual([...BUILTIN_PROFILE_NAMES].sort());
  });

  // INVARIANT: every REGISTERED agent has a wire, or a task could name an agent
  // whose traffic the proxy cannot classify. This is the cross-check that keeps
  // HARNESS_WIRES from drifting behind the registry when a new agent lands.
  //
  // Over listAgents(), not listSelectableAgents(): HARNESS_WIRES is documented
  // as TOTAL over the registry, and the gap between the two lists is exactly
  // where a miss would hide. `qa-agent` is hidden from humans but real — the e2e
  // harness selects it by name, so its traffic gets classified like any other.
  test('every registered agent is a known harness', () => {
    for (const harness of listAgents()) {
      expect(Object.keys(HARNESS_WIRES)).toContain(harness);
    }
    // Both directions: a wire for a harness the registry dropped is dead config
    // that would keep a retired agent selectable in a profile.
    for (const harness of Object.keys(HARNESS_WIRES)) {
      expect(listAgents()).toContain(harness);
    }
  });
});

describe('harness resolution', () => {
  test('harness defaults to the profile name only when that name is a harness', () => {
    const { profiles } = resolve({ pi: { model: 'x' } });
    expect(profiles.get('pi')!.harness).toBe('pi');
  });

  test('a profile with a name of its own must say what runs it', () => {
    expect(() => resolve({ 'local-ollama-pi': { model: 'qwen3.8:latest' } })).toThrow(
      /does not set harness/,
    );
  });

  test('an unknown harness fails with the list of real ones', () => {
    let message = '';
    try {
      resolve({ mine: { harness: 'aider' } });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('Unknown harness "aider"');
    expect(message).toContain('claude-code');
    expect(message).toContain('codex');
  });
});

describe('wire derivation', () => {
  test('only hosts lazy knows by name imply a wire', () => {
    expect(knownEndpointWires('https://api.openai.com')).toEqual(['openai']);
    expect(knownEndpointWires('https://api.anthropic.com/v1')).toEqual(['anthropic']);
    // OpenRouter serves BOTH APIs from one hostname: its native OpenAI wire
    // first, its Anthropic Messages endpoint second.
    expect(knownEndpointWires('https://openrouter.ai/api')).toEqual(['openai', 'anthropic']);
    expect(knownEndpointWires('http://localhost:11434')).toEqual([]);
    expect(knownEndpointWires('https://gateway.example.com/v1')).toEqual([]);
    expect(knownEndpointWires('')).toEqual([]);
    expect(knownEndpointWires('not a url')).toEqual([]);
  });

  test('the harness picks the wire when the endpoint implies none', () => {
    expect(wireForProfile('pi', 'http://localhost:11434')).toEqual({ wire: 'anthropic' });
    expect(wireForProfile('pi', 'https://gateway.example.com/v1')).toEqual({ wire: 'anthropic' });
  });

  // INVARIANT: a host that speaks both wires is taken on its NATIVE wire by a
  // harness that can speak it, and on the other by a harness that cannot —
  // pi at OpenRouter is the OpenAI wire (Chat Completions, what pi's OpenAI
  // provider exists for), while claude-code at OpenRouter keeps the Anthropic
  // Messages endpoint it shipped with. Neither is a contradiction.
  test('a host speaking both wires: the harness takes its native wire when it can', () => {
    expect(wireForProfile('pi', 'https://openrouter.ai/api')).toEqual({ wire: 'openai' });
    expect(wireForProfile('codex', 'https://openrouter.ai/api')).toEqual({ wire: 'openai' });
    expect(wireForProfile('claude-code', 'https://openrouter.ai/api')).toEqual({ wire: 'anthropic' });
    expect(wireForProfile('cursor', 'https://openrouter.ai/api')).toEqual({ wire: 'anthropic' });
  });

  test('a pi profile at OpenRouter resolves the openai wire and the openrouter credential', () => {
    const { profiles } = resolve({
      'openrouter-pi': { harness: 'pi', model: 'anthropic/claude-sonnet-4.5', endpoint: 'https://openrouter.ai/api' },
    });
    const profile = profiles.get('openrouter-pi')!;
    // The wire the proxy routes by and the credential it bills come from the
    // same hostname rule, read once at config load.
    expect(profile.wire).toBe('openai');
    expect(profile.credential).toBe('openrouter');
    expect(profile.endpoint).toBe('https://openrouter.ai/api');
  });

  test('a claude-code profile at OpenRouter keeps its Anthropic-compatible route', () => {
    const { profiles } = resolve({
      'router-claude': { harness: 'claude-code', model: 'anthropic/claude-sonnet-4.5', endpoint: 'https://openrouter.ai/api' },
    });
    expect(profiles.get('router-claude')!.wire).toBe('anthropic');
    expect(profiles.get('router-claude')!.credential).toBe('openrouter');
  });

  test('an endpoint may only VETO the harness wire, never choose it', () => {
    const bad = wireForProfile('claude-code', 'https://api.openai.com');
    expect(bad).toHaveProperty('error');
    expect((bad as { error: string }).error).toContain('speaks the openai API');
    // ...and names a harness that would work.
    expect((bad as { error: string }).error).toContain('codex');
  });

  test('a contradicting endpoint fails at config load, naming the profile', () => {
    expect(() => resolve({ nope: { harness: 'codex', model: 'm', endpoint: 'https://api.anthropic.com' } })).toThrow(
      /\[agents\.nope\].*speaks the anthropic API/s,
    );
  });
});

describe('credential inference', () => {
  test('hostname decides which stored credential pays for the upstream', () => {
    expect(defaultCredentialFor('pi', 'anthropic', 'https://ollama.com')).toBe('ollama');
    expect(defaultCredentialFor('codex', 'openai', 'https://openrouter.ai/api')).toBe('openrouter');
    expect(defaultCredentialFor('claude-code', 'anthropic', 'https://openrouter.ai/api')).toBe('openrouter');
    expect(defaultCredentialFor('claude-code', 'anthropic', '')).toBe('anthropic');
    expect(defaultCredentialFor('codex', 'openai', '')).toBe('openai');
  });

  // BEHAVIOR CHANGE, deliberate: a role pinned at a LOCAL anthropic-compatible
  // endpoint used to receive the real Anthropic credential. A local model server
  // ignores auth, so that was a key handed to a process with no use for it.
  // Writing `credential = "anthropic"` restores the old behaviour explicitly.
  test('a local or LAN endpoint takes no credential', () => {
    for (const endpoint of [
      'http://localhost:11434',
      'http://127.0.0.1:11434',
      'http://192.168.1.40:11434',
      'http://10.0.0.5:8080',
      'http://172.16.3.9:8080',
      'http://host.docker.internal:11434',
      'http://box.local:11434',
    ]) {
      expect(defaultCredentialFor('pi', 'anthropic', endpoint)).toBe(NO_CREDENTIAL);
    }
    const { profiles } = resolve({
      'local-ollama-pi': { harness: 'pi', model: 'qwen3.8:latest', endpoint: 'http://localhost:11434' },
    });
    expect(profiles.get('local-ollama-pi')!.credential).toBe(NO_CREDENTIAL);
  });

  test('an explicit credential wins over inference', () => {
    const { profiles } = resolve({
      // A private host infers `none`; naming a credential overrides that and
      // sends the real key, which is the whole point of the key existing.
      'private-gateway': {
        harness: 'claude-code', model: 'claude-opus-5',
        endpoint: 'http://10.0.0.5:8080', credential: 'anthropic',
      },
    });
    expect(profiles.get('private-gateway')!.credential).toBe('anthropic');
  });

  // A credential name is a STORE KEY, and the store is keyed by whatever name
  // `lazy auth set <name>` was given — so a name outside the provider vocabulary
  // is ACCEPTED. This is what lets two profiles on the same provider be billed
  // to different accounts.
  test('a name outside the provider vocabulary is a valid credential', () => {
    const { profiles } = resolve({
      'work-codex': { harness: 'codex', model: 'gpt-5-codex', credential: 'work-openai' },
    });
    expect(profiles.get('work-codex')!.credential).toBe('work-openai');
  });

  // ...but the name still has to be a NAME. Shape is validated here because
  // this is the last point at which the user can see the file that is wrong;
  // downstream the store treats it as an opaque key and would just miss.
  test('a malformed credential name is refused', () => {
    expect(() => resolve({
      mine: { harness: 'codex', model: 'gpt-5-codex', credential: 'Work OpenAI' },
    })).toThrow(/credential/i);
  });

  test('cursor authenticates with its own key regardless of upstream', () => {
    const { profiles } = resolve(undefined);
    expect(profiles.get('cursor')!.credential).toBe('cursor');
  });

  // INVARIANT: cursor is the ONE harness where a named credential is refused.
  // cursor-agent's auth wire format is not one lazy has a contract for, so the
  // proxy substitutes a Cursor key exactly where the client put its own
  // placeholder. A name outside the provider vocabulary has no such
  // client-shaped placeholder, so honoring it would mean guessing where to put
  // the secret — refuse where the user can still read the file, rather than
  // sending their key somewhere invented.
  test('a named credential is refused for the cursor harness', () => {
    expect(() => resolve({
      'work-cursor': { harness: 'cursor', model: 'auto', credential: 'work-account' },
    })).toThrow(/not supported for the cursor harness/);
    // The refusal names both things that ARE accepted, so it is actionable.
    expect(() => resolve({
      'work-cursor': { harness: 'cursor', model: 'auto', credential: 'work-account' },
    })).toThrow(/lazy auth set cursor/);
  });

  // ...and `none` stays available for it: a cursor profile that authenticates
  // nobody is not a credential lazy has to place anywhere.
  test('cursor may still declare no credential at all', () => {
    const { profiles } = resolve({
      'free-cursor': { harness: 'cursor', model: 'auto', credential: 'none' },
    });
    expect(profiles.get('free-cursor')!.credential).toBe('none');
  });
});

describe('endpoint and model validation', () => {
  test('an endpoint without a model is refused rather than guessed', () => {
    expect(() => resolve({ mine: { harness: 'pi', endpoint: 'http://localhost:11434' } })).toThrow(
      /sets endpoint but no model/,
    );
  });

  test('a built-in needs no model — the harness has its own default', () => {
    const { profiles } = resolve(undefined);
    expect(profiles.get('claude-code')!.model).toBe('');
  });

  test('an endpoint with no scheme is refused', () => {
    // Note "localhost:11434" DOES parse as a URL — `localhost:` reads as the
    // scheme — so it is the protocol check, not the parse, that catches the
    // spelling a user is most likely to reach for.
    expect(() => resolve({ mine: { harness: 'pi', model: 'm', endpoint: 'localhost:11434' } })).toThrow(
      /http:\/\/ or https:\/\//,
    );
  });

  test('an unparseable endpoint fails with an example', () => {
    expect(() => resolve({ mine: { harness: 'pi', model: 'm', endpoint: 'http://[bad' } })).toThrow(
      /Invalid endpoint .*absolute URL/,
    );
  });

  test('a non-http scheme is refused', () => {
    expect(() => resolve({ mine: { harness: 'pi', model: 'm', endpoint: 'ftp://example.com' } })).toThrow(
      /http:\/\/ or https:\/\//,
    );
  });

  test('a trailing slash is stripped so upstreams compare equal', () => {
    const { profiles } = resolve({ mine: { harness: 'codex', model: 'm', endpoint: 'https://openrouter.ai/api/' } });
    expect(profiles.get('mine')!.endpoint).toBe('https://openrouter.ai/api');
  });

  // An endpoint is the upstream the PROXY dials, and the proxy runs on the
  // host — same rewrite (and same warning) role targets already get.
  test('a container-perspective endpoint is rewritten host-side, with a warning', () => {
    const { profiles, warnings } = resolve({
      mine: { harness: 'pi', model: 'm', endpoint: 'http://host.docker.internal:11434' },
    });
    expect(profiles.get('mine')!.endpoint).toBe('http://localhost:11434');
    expect(warnings.join('\n')).toContain('proxy runs on the host');
  });

  // ...and the negative half, carried from the role suite this replaces: an
  // endpoint that is ALREADY host-perspective is correct as written, so nothing
  // changes and nothing is printed. Warning on the correct spelling too would
  // train users to ignore the warning that matters.
  test('a host-perspective endpoint is untouched and silent', () => {
    const { profiles, warnings } = resolve({
      mine: { harness: 'pi', model: 'm', endpoint: 'http://localhost:11434' },
    });
    expect(profiles.get('mine')!.endpoint).toBe('http://localhost:11434');
    expect(warnings.join('\n')).not.toContain('host.docker.internal');
    expect(warnings.join('\n')).not.toContain('proxy runs on the host');
  });
});

describe('unknown keys and names', () => {
  // The design leaves a slot for alternative API shapes (bedrock, vertex) but
  // the proxy cannot speak one yet, so accepting the key would let a config
  // promise something no code delivers.
  test('api_shape is refused, and says why', () => {
    let message = '';
    try {
      resolve({ mine: { harness: 'codex', api_shape: 'bedrock' } });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('Unknown option "api_shape"');
    expect(message).toContain('not implemented yet');
  });

  test('the old role-target spelling gets pointed at the new keys', () => {
    expect(() => resolve({ mine: { backend: 'ollama' } })).toThrow(/use `harness`.*`endpoint`/s);
    expect(() => resolve({ mine: { harness: 'codex', wire: 'openai' } })).toThrow(/derived from harness \+ endpoint/);
  });

  test('a secret in lazy.toml is refused with the place it belongs', () => {
    expect(() => resolve({ mine: { harness: 'codex', api_key: 'sk-xxx' } })).toThrow(/lazy auth set/);
  });

  test('profile and credential names are restricted to a safe shape', () => {
    expect(() => resolve({ 'Work Codex': { harness: 'codex' } })).toThrow(/Invalid agent profile name/);
    expect(() => resolve({ mine: { harness: 'codex', credential: 'my key' } })).toThrow(/Invalid credential name/);
    // ...but the ordinary spellings all pass.
    const { profiles } = resolve({ 'work.codex-2_b': { harness: 'codex' } });
    expect(profiles.has('work.codex-2_b')).toBe(true);
  });
});

describe('selection', () => {
  test('an unknown profile name lists the available ones', () => {
    const { profiles } = resolve({ 'local-ollama-pi': { harness: 'pi', model: 'm' } });
    let message = '';
    try {
      agentProfileOrThrow(profiles, 'local-olama-pi', 'lazy start --agent');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('Unknown agent profile "local-olama-pi"');
    expect(message).toContain('lazy start --agent');
    expect(message).toContain('local-ollama-pi');
  });

  test('a known name resolves to its profile', () => {
    const { profiles } = resolve(undefined);
    expect(agentProfileOrThrow(profiles, 'codex').harness).toBe('codex');
  });
});

describe('picker order and summary', () => {
  test('the project\'s own profiles come before the built-ins', () => {
    const { profiles } = resolve({
      'work-codex': { harness: 'codex', model: 'gpt-5-codex' },
      'company-tokens-cursor': { harness: 'cursor', model: 'claude-sonnet-5' },
    });
    const names = selectableAgentProfiles(profiles).map(p => p.name);
    // INVARIANT: a picker offers CONFIGURED profiles first — choosing a
    // pre-configured combo is the first choice, the per-harness built-ins are
    // the fallback beneath it.
    expect(names.slice(0, 2)).toEqual(['company-tokens-cursor', 'work-codex']);
    expect(names.slice(2)).toEqual([...BUILTIN_PROFILE_NAMES].filter(n => n !== 'qa-agent').sort());
  });

  test('the summary says what the profile actually runs', () => {
    const { profiles } = resolve({
      'local-ollama-pi': { harness: 'pi', model: 'qwen3.8:latest', endpoint: 'http://localhost:11434' },
    });
    const summary = agentProfileSummary(profiles.get('local-ollama-pi')!);
    expect(summary).toContain('pi');
    expect(summary).toContain('qwen3.8:latest');
    expect(summary).toContain('http://localhost:11434');
    // A local endpoint takes no key; "none" is not a credential to advertise.
    expect(summary).not.toContain('key: none');

    // A built-in with no model of its own reads as the harness default rather
    // than as an empty field.
    expect(agentProfileSummary(profiles.get('claude-code')!)).toContain('claude-code default model');
  });
});
