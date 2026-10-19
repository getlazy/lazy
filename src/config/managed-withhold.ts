/**
 * What a managed daemon HONOURS of a control plane's lazy.toml.
 *
 * The control plane imports a repository's lazy.toml VERBATIM (engineer,
 * 2026-10-06: "Import shouldn't refuse anything. It should import as-is, and
 * then Teams can let operators know what is and isn't supported"). The managed
 * rules (./managed) then decide only what the daemon RUNS on, never what is
 * kept: every refused setting is WITHHELD from the text before it is resolved,
 * and reported back by name with the reason.
 *
 * Withholding is coarse on purpose. A refused key inside `[agents.<name>]`
 * withholds the whole PROFILE, never just that key — a profile with its
 * `endpoint` stripped would silently route to a different upstream under the
 * same name. A refused key inside `[endpoints.<name>]` withholds the endpoint
 * and every profile that uses it. A refused setting elsewhere is dropped, so
 * the fleet's value or lazy's default applies — the safe direction by
 * construction, since those are what an unmanaged-by-the-repository host runs.
 * Defaults that NAME a withheld profile (`[agent] agent_id`, `[agent.by_type]`)
 * are dropped too, so the daemon falls back to its own default instead of
 * failing to load.
 *
 * Nothing here ever HONOURS a refused key: the evaluation is the same
 * `evaluateManagedConfig` the strict path throws on.
 */

import { evaluateManagedConfig, type ManagedConfigOrigin, type ManagedRefusal } from './managed';

export interface WithheldSetting {
  /** `profile`: an [agents.<name>] block; `endpoint`: an [endpoints.<name>] block; `setting`: any other key. */
  kind: 'profile' | 'endpoint' | 'setting';
  /** The profile or endpoint name, or the setting's dotted key. */
  name: string;
  /** Why the daemon does not run it, in words a project owner can act on. */
  reason: string;
}

export interface WithholdResult {
  /** A copy of the input with every withheld part removed. */
  raw: Record<string, unknown>;
  withheld: WithheldSetting[];
}

type Table = Record<string, unknown>;

function isTable(v: unknown): v is Table {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function describe(refusals: ManagedRefusal[]): string {
  return refusals.map((r) => `${r.key.replace(/^(agents|endpoints)\.\*\./, '')}: ${r.why}`).join('; ');
}

/** The named endpoints a profile block routes through. */
function endpointsOf(profile: Table): string[] {
  const names: string[] = [];
  if (typeof profile.named_endpoint === 'string') names.push(profile.named_endpoint);
  if (Array.isArray(profile.tiers)) {
    for (const tier of profile.tiers) {
      if (isTable(tier) && typeof tier.endpoint === 'string') names.push(tier.endpoint);
    }
  }
  return names;
}

/**
 * Delete a dotted policy key (`proxy.upstream`; `proxy.fallback[].upstream` →
 * the whole `proxy.fallback`). A `*` segment (`models.roles.*.endpoint`)
 * stands for every name at that level, so each one is visited.
 */
function deletePath(raw: Table, key: string): void {
  const parts = key.split('[]')[0]!.split('.');
  const walk = (node: unknown, depth: number): void => {
    if (!isTable(node)) return;
    const part = parts[depth]!;
    const names = part === '*' ? Object.keys(node) : [part];
    for (const name of names) {
      if (depth === parts.length - 1) delete node[name];
      else walk(node[name], depth + 1);
    }
  };
  walk(raw, 0);
  // Top-level backward-compat `runner = "…"` is evaluated as `runner.type`.
  if (key === 'runner.type' && typeof raw.runner === 'string') delete raw.runner;
}

export function withholdRefused(
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  origin: ManagedConfigOrigin = 'control-plane',
): WithholdResult {
  const raw = structuredClone(input) as Table;
  const withheld: WithheldSetting[] = [];

  // Endpoints first: a profile can be withheld because of one.
  const goneEndpoints = new Set<string>();
  if (isTable(raw.endpoints)) {
    for (const [name, block] of Object.entries(raw.endpoints)) {
      const { refusals } = evaluateManagedConfig({ endpoints: { [name]: block } }, env, origin);
      if (refusals.length === 0) continue;
      goneEndpoints.add(name);
      delete raw.endpoints[name];
      withheld.push({ kind: 'endpoint', name, reason: describe(refusals) });
    }
  }

  const goneProfiles = new Set<string>();
  if (isTable(raw.agents)) {
    for (const [name, block] of Object.entries(raw.agents)) {
      const { refusals } = evaluateManagedConfig({ agents: { [name]: block } }, env, origin);
      const missing = isTable(block) ? endpointsOf(block).filter((e) => goneEndpoints.has(e)) : [];
      if (refusals.length === 0 && missing.length === 0) continue;
      goneProfiles.add(name);
      delete raw.agents[name];
      const reasons = [
        ...(refusals.length > 0 ? [describe(refusals)] : []),
        ...missing.map((e) => `it uses endpoint "${e}", which is not honoured`),
      ];
      withheld.push({ kind: 'profile', name, reason: reasons.join('; ') });
    }
  }

  // Every other refused setting.
  const rest: Table = { ...raw };
  delete rest.agents;
  delete rest.endpoints;
  for (const refusal of evaluateManagedConfig(rest, env, origin).refusals) {
    deletePath(raw, refusal.key);
    withheld.push({ kind: 'setting', name: refusal.key, reason: refusal.why });
  }

  // Defaults that name a withheld profile.
  const agent = raw.agent;
  if (isTable(agent)) {
    if (typeof agent.agent_id === 'string' && goneProfiles.has(agent.agent_id)) {
      withheld.push({ kind: 'setting', name: 'agent.agent_id', reason: `it names profile "${agent.agent_id}", which is not honoured` });
      delete agent.agent_id;
    }
    if (isTable(agent.by_type)) {
      for (const [type, name] of Object.entries(agent.by_type)) {
        if (typeof name === 'string' && goneProfiles.has(name)) {
          withheld.push({ kind: 'setting', name: `agent.by_type.${type}`, reason: `it names profile "${name}", which is not honoured` });
          delete agent.by_type[type];
        }
      }
    }
  }

  // A role pinned to a withheld profile falls back to the role's default.
  const roles = isTable(raw.models) && isTable(raw.models.roles) ? raw.models.roles : null;
  if (roles) {
    for (const [role, block] of Object.entries(roles)) {
      // `agent` is the lazy.toml key (`[models.roles.builder] agent = "…"`);
      // `profile` is only a resolved field.
      if (isTable(block) && typeof block.agent === 'string' && goneProfiles.has(block.agent)) {
        withheld.push({ kind: 'setting', name: `models.roles.${role}.agent`, reason: `it names profile "${block.agent}", which is not honoured` });
        delete block.agent;
      }
    }
  }

  return { raw, withheld };
}
