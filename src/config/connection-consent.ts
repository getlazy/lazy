/**
 * The project's endpoints and agent profiles as a control plane's admin has to
 * CONFIRM them — the consent path beside the managed rules, never a weakening
 * of them.
 *
 * A repository's `[endpoints.*]` url/credential and `[agents.*]`
 * endpoint/credential are credential redirection when the repository sets them
 * (./managed), so imported text is judged by repository rules and those parts
 * are withheld (./managed-withhold). The same keys are the project's own once a
 * person who may decide confirms them: the control plane then records a version
 * of the text judged by `control-plane` rules, naming who confirmed it.
 *
 * This module only ANSWERS: for a given text and the rules it is judged by,
 * which endpoints and profiles are usable, which wait for that confirmation
 * (withheld now, honoured once confirmed), and which stay withheld either way.
 * It also names the blocks the repository's lazy.toml defines that the text
 * does not — a project imported before they were added — with their text, so
 * confirming can bring them in. It writes nothing.
 */

import { withholdRefused } from './managed-withhold';
import type { ManagedConfigOrigin } from './managed';

export type ConnectionStatus = 'usable' | 'awaiting-confirmation' | 'withheld';

export interface EndpointConnection {
  name: string;
  url: string | null;
  credential: string | null;
  /** The profiles that route through it (inline `named_endpoint` or a tier). */
  usedBy: string[];
  status: ConnectionStatus;
  /** Why it is not usable now, or null when it is. */
  reason: string | null;
}

export interface ProfileConnection {
  name: string;
  harness: string | null;
  model: string | null;
  /** An inline `endpoint` URL. */
  endpoint: string | null;
  /** The named endpoints it routes through. */
  namedEndpoints: string[];
  /** The credential the profile itself names (not its endpoints'). */
  credential: string | null;
  status: ConnectionStatus;
  reason: string | null;
}

export interface SettingConnection {
  key: string;
  reason: string;
}

export interface ConnectionsRead {
  endpoints: EndpointConnection[];
  profiles: ProfileConnection[];
  /** Other settings confirming would make take effect, so the admin sees everything it does. */
  settings: SettingConnection[];
  /** True when confirming would change what is usable. */
  confirmable: boolean;
  /**
   * Blocks the repository's lazy.toml defines that the text does not, with the
   * text that would be appended to bring them in. `toml` is empty when there
   * are none.
   */
  fromRepository: { endpoints: string[]; profiles: string[]; skipped: SettingConnection[]; toml: string };
}

type Table = Record<string, unknown>;

function isTable(v: unknown): v is Table {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function namedEndpointsOf(profile: Table): string[] {
  const names: string[] = [];
  if (typeof profile.named_endpoint === 'string') names.push(profile.named_endpoint);
  if (Array.isArray(profile.tiers)) {
    for (const tier of profile.tiers) {
      if (isTable(tier) && typeof tier.endpoint === 'string' && !names.includes(tier.endpoint)) names.push(tier.endpoint);
    }
  }
  return names;
}

function parse(text: string): Table | null {
  try {
    return Bun.TOML.parse(text) as Table;
  } catch {
    return null;
  }
}

const HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;

/** A header's dotted path, unquoted: `agents."a.b".tiers` → ['agents', 'a.b', 'tiers']. */
function headerPath(inner: string): string[] {
  const parts: string[] = [];
  for (const m of inner.matchAll(/\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(?:\.|$)/g)) {
    parts.push(m[1] ?? m[2] ?? m[3]!);
  }
  return parts;
}

/**
 * The lines of `[section.name]` and its sub-tables in `text`, verbatim. A
 * block written any other way (an inline table, dotted keys under `[section]`)
 * is not found here, and the caller's reparse check then refuses to copy it.
 */
function extractBlock(text: string, section: string, name: string): string {
  const out: string[] = [];
  let inside = false;
  for (const line of text.split('\n')) {
    const m = HEADER.exec(line);
    if (m) {
      const path = headerPath(m[1]!);
      inside = path[0] === section && path[1] === name;
    }
    if (inside) out.push(line);
  }
  return out.join('\n').trimEnd();
}

function blocksMissing(text: Table | null, repo: Table | null, repoText: string): ConnectionsRead['fromRepository'] {
  const result: ConnectionsRead['fromRepository'] = { endpoints: [], profiles: [], skipped: [], toml: '' };
  if (!repo) return result;
  const pieces: string[] = [];
  for (const [section, list] of [['endpoints', result.endpoints], ['agents', result.profiles]] as const) {
    const have = isTable(text?.[section]) ? text![section] as Table : {};
    const theirs = isTable(repo[section]) ? repo[section] as Table : {};
    for (const [name, block] of Object.entries(theirs)) {
      if (name in have) continue;
      const piece = extractBlock(repoText, section, name);
      const reparsed = piece ? parse(piece) : null;
      const back = reparsed && isTable(reparsed[section]) ? (reparsed[section] as Table)[name] : undefined;
      if (back === undefined || !Bun.deepEquals(back, block)) {
        result.skipped.push({
          key: `${section}.${name}`,
          reason: "it is written in a form that cannot be copied on its own; copy it into lazy.toml on the Configuration page",
        });
        continue;
      }
      list.push(name);
      pieces.push(piece);
    }
  }
  if (pieces.length > 0) {
    result.toml = '# Copied from the repository\'s lazy.toml when its connections were confirmed.\n' + pieces.join('\n\n') + '\n';
  }
  return result;
}

/**
 * The connections `toml` defines, judged by `origin`'s rules, against what
 * confirming (judging the same text by `control-plane` rules) would honour.
 * `repositoryToml` is the repository's lazy.toml, or null when it has none.
 */
export function readConnections(
  toml: string,
  origin: ManagedConfigOrigin,
  repositoryToml: string | null,
  env: NodeJS.ProcessEnv = process.env,
): ConnectionsRead {
  const raw = parse(toml);
  const repo = repositoryToml === null ? null : parse(repositoryToml);
  const fromRepository = blocksMissing(raw, repo, repositoryToml ?? '');
  // What confirming would add is judged too: a copied block can be withheld
  // even when confirmed, and the admin must see that before confirming.
  const combined = fromRepository.toml ? parse(`${toml.trimEnd()}\n\n${fromRepository.toml}`) : raw;
  const all = combined ?? {};

  const key = (w: { kind: string; name: string }) => `${w.kind}:${w.name}`;
  const now = new Map(withholdRefused(all, env, origin).withheld.map((w) => [key(w), w]));
  const confirmed = new Map(withholdRefused(all, env, 'control-plane').withheld.map((w) => [key(w), w]));
  const statusOf = (kind: string, name: string): { status: ConnectionStatus; reason: string | null } => {
    const after = confirmed.get(`${kind}:${name}`);
    if (after) return { status: 'withheld', reason: after.reason };
    const before = now.get(`${kind}:${name}`);
    // A block only the repository has is not usable until it is copied in.
    const copied = (kind === 'endpoint' ? fromRepository.endpoints : fromRepository.profiles).includes(name);
    if (before || copied) {
      return { status: 'awaiting-confirmation', reason: before?.reason ?? 'it is only in the repository\'s lazy.toml' };
    }
    return { status: 'usable', reason: null };
  };

  const agents = isTable(all.agents) ? all.agents : {};
  const endpoints = isTable(all.endpoints) ? all.endpoints : {};
  const profiles: ProfileConnection[] = Object.entries(agents).map(([name, block]) => {
    const b = isTable(block) ? block : {};
    return {
      name,
      harness: str(b.harness),
      model: str(b.model),
      endpoint: str(b.endpoint),
      namedEndpoints: namedEndpointsOf(b),
      credential: str(b.credential),
      ...statusOf('profile', name),
    };
  });
  const endpointList: EndpointConnection[] = Object.entries(endpoints).map(([name, block]) => {
    const b = isTable(block) ? block : {};
    return {
      name,
      url: str(b.url),
      credential: str(b.credential),
      usedBy: profiles.filter((p) => p.namedEndpoints.includes(name)).map((p) => p.name),
      ...statusOf('endpoint', name),
    };
  });
  const settings = [...now.values()]
    .filter((w) => w.kind === 'setting' && !confirmed.has(key(w)))
    .map((w) => ({ key: w.name, reason: w.reason }));

  const confirmable = fromRepository.toml !== ''
    || [...profiles, ...endpointList].some((c) => c.status === 'awaiting-confirmation')
    || settings.length > 0;
  return { endpoints: endpointList, profiles, settings, confirmable, fromRepository };
}

/**
 * Profiles `withheld` (by the rules the text is judged by now) that confirming
 * would make usable — for "Unknown agent profile" to say the profile waits for
 * an admin rather than that it does not exist.
 */
export function profilesAwaitingConfirmation(raw: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): string[] {
  const now = withholdRefused(raw, env, 'repository').withheld.filter((w) => w.kind === 'profile').map((w) => w.name);
  const after = new Set(withholdRefused(raw, env, 'control-plane').withheld.filter((w) => w.kind === 'profile').map((w) => w.name));
  return now.filter((n) => !after.has(n));
}
