/**
 * Rewrite a pre-profile lazy.toml into the agent-profile form.
 *
 * The three removed spellings — `[models.roles.<role>] backend/model/endpoint`,
 * the `[ollama]` block, and `[proxy] openai_upstream` — all fail the config
 * load with the replacement printed (see `refuseRoleBackendKeys` /
 * `refuseOllamaBlock` in loader.ts). This module is the other half of that
 * bargain: `lazy doctor --fix agents` applies the very block those errors print,
 * so the user does not have to hand-edit a file lazy already knows how to fix.
 *
 * Two rules the planner will not bend, both for the same reason the load refuses
 * in the first place — a config that says one thing and launches another is the
 * failure mode being removed:
 *
 *  - It never INVENTS a value. A pinned endpoint needs a model, and model names
 *    belong to the server, so a rewrite that would have to guess one becomes a
 *    blocker with the missing key named rather than a placeholder written into
 *    the user's file.
 *  - It never writes a file it has not re-validated. The plan resolves its own
 *    output through {@link resolveAgentProfiles} before offering it, so a
 *    rewrite that would still fail to load is reported as a blocker instead.
 *
 * Everything else in lazy.toml — comments, key order, blank lines — survives,
 * because the edit is textual (src/config/toml-edit.ts), never a parse and
 * re-render.
 */

import {
  removeSection,
  removeSectionKey,
  setSectionString,
  TomlEditError,
} from './toml-edit';
import {
  BUILDER_PROFILE_NAME,
  DEFAULT_AGENT_PROFILE_NAME,
  HARNESS_WIRES,
  resolveAgentProfiles,
  type AgentProfileConfig,
} from './agent-profiles';
import { DEFAULT_OPENAI_UPSTREAM } from '../utils/openai-compat';

/**
 * The endpoint the removed `[ollama]` block and `backend = "ollama"` defaulted
 * to. Nothing resolves through it any more: it exists so a config that RELIED on
 * that default still migrates to a complete, explicit profile instead of one
 * with a hole where the upstream used to be implied.
 */
export const LEGACY_OLLAMA_ENDPOINT = 'http://localhost:11434';

/** Roles a legacy `[models.roles.<role>]` block could carry a backend for. */
const ROLES = ['agent', 'builder'] as const;
type Role = (typeof ROLES)[number];

/** The legacy keys a role is no longer allowed to carry. */
const LEGACY_ROLE_KEYS = ['backend', 'model', 'endpoint'] as const;

export interface MigrationStep {
  /** The legacy spelling found, e.g. `[models.roles.agent] backend = "ollama"`. */
  found: string;
  /** The lines it becomes, already in their final form. */
  becomes: string[];
}

export interface AgentMigrationPlan {
  /** True when the file uses at least one removed spelling. */
  needed: boolean;
  /** One entry per legacy spelling found, in the order they are rewritten. */
  steps: MigrationStep[];
  /**
   * Reasons the rewrite cannot be applied. Non-empty means NOTHING is written:
   * a partial rewrite of a config that still fails to load leaves the user worse
   * off than the error they started with.
   */
  blockers: string[];
  /** The rewritten file. Equal to the input when `needed` is false. */
  updated: string;
}

function asTable(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringAt(table: Record<string, unknown> | null, key: string): string {
  const value = table?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** A profile block, rendered as the lines the fix will add. */
interface ProfileDraft {
  name: string;
  harness: string;
  model: string;
  endpoint: string;
}

// A key the legacy config did not set is OMITTED, never written as `""`. An
// unpinned `[models.roles.builder] backend = "anthropic"` names no model, and
// `model = ""` in the file the fix hands back reads like a value the user is
// supposed to fill in — while meaning "no model override", exactly what leaving
// the key out already means. Only `endpoint` was guarded this way before.
function draftLines(draft: ProfileDraft): string[] {
  return [
    `[agents.${draft.name}]`,
    `harness = ${JSON.stringify(draft.harness)}`,
    ...(draft.model ? [`model = ${JSON.stringify(draft.model)}`] : []),
    ...(draft.endpoint ? [`endpoint = ${JSON.stringify(draft.endpoint)}`] : []),
  ];
}

function applyDraft(content: string, draft: ProfileDraft): string {
  const section = `agents.${draft.name}`;
  let updated = setSectionString(content, section, 'harness', draft.harness);
  if (draft.model) updated = setSectionString(updated, section, 'model', draft.model);
  if (draft.endpoint) updated = setSectionString(updated, section, 'endpoint', draft.endpoint);
  return updated;
}

/**
 * Plan the rewrite of one lazy.toml. Pure: takes the file's text, returns the
 * text it would become plus everything a caller needs to explain the change.
 */
export function planAgentMigration(content: string): AgentMigrationPlan {
  const unchanged = (blockers: string[]): AgentMigrationPlan =>
    ({ needed: blockers.length > 0, steps: [], blockers, updated: content });

  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(content) as Record<string, unknown>;
  } catch (err) {
    return unchanged([
      `lazy.toml does not parse, so it cannot be rewritten automatically: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    ]);
  }

  const roles = asTable(asTable(parsed.models)?.roles);
  const proxy = asTable(parsed.proxy);
  const hasOpenaiUpstream = proxy !== null && 'openai_upstream' in proxy;

  // A legacy section written as something other than a plain table — `[[ollama]]`
  // (an array of tables), or a scalar — is a BLOCKER, never a rewrite.
  //
  // `asTable(...) ?? {}` used to coerce it to an empty table, which read as
  // "the section configured nothing" and planned a deletion; the section-header
  // regex in toml-edit matches `[[ollama]]` too, so `--fix agents` then deleted
  // a real model and endpoint the user had written. The loader refuses these
  // shapes outright (refuseMalformedLegacySection), so the planner must say the
  // same thing rather than report "nothing to do" for a config that will not
  // load.
  const malformed: string[] = [];
  const legacyTable = (path: string, raw: unknown): Record<string, unknown> | null => {
    if (raw === undefined) return null;
    const table = asTable(raw);
    if (table) return table;
    malformed.push(
      `[${path}] is written as ${Array.isArray(raw) ? 'an array of tables' : `a ${typeof raw} value`}, ` +
      `not a table, so lazy cannot tell what it configures and will not rewrite it. ` +
      `Write it as a single \`[${path}]\` header (not \`[[${path}]]\`), or delete it, then re-run.`,
    );
    return null;
  };

  const ollama = legacyTable('ollama', parsed.ollama);
  for (const role of ROLES) {
    if (roles && role in roles) legacyTable(`models.roles.${role}`, roles[role]);
  }
  if (malformed.length > 0) return unchanged(malformed);

  const steps: MigrationStep[] = [];
  const blockers: string[] = [];
  let updated = content;

  // ── roles ───────────────────────────────────────────────────────────────
  //
  // The replacement is a NAMED profile plus a role pointer, never an override of
  // the built-in profile of the same name — `[agents.claude-code]` would also
  // capture every claude-code TASK, which a user migrating their role config has
  // not asked for. Same shape the load error prints.
  for (const role of ROLES) {
    const table = asTable(roles?.[role]);
    const found = LEGACY_ROLE_KEYS.filter(k => table !== null && k in table);
    if (found.length === 0) continue;

    const backend = stringAt(table, 'backend') || 'anthropic';
    const model = stringAt(table, 'model');
    const endpoint = stringAt(table, 'endpoint')
      || (backend === 'ollama' ? LEGACY_OLLAMA_ENDPOINT : '')
      || (backend === 'openai' ? DEFAULT_OPENAI_UPSTREAM : '');
    // A backend never chose a harness — `[agent] agent_id` did — so the harness
    // stays whatever the project already runs.
    const harness = role === 'builder' ? BUILDER_PROFILE_NAME : agentHarness(parsed);
    const name = `${role}-${backend}`;

    if (endpoint && !model) {
      blockers.push(
        `[models.roles.${role}] pins the upstream ${endpoint} but names no model, and model names ` +
        `belong to the server — lazy will not guess one. Add \`model = "<the model that server ` +
        `serves>"\` to [models.roles.${role}] and re-run, or write the [agents.${name}] block by hand.`,
      );
      continue;
    }

    const draft: ProfileDraft = { name, harness, model, endpoint };
    steps.push({
      found: `[models.roles.${role}] ${found.map(k => `${k} = ${JSON.stringify(stringAt(table, k))}`).join(', ')}`,
      becomes: [...draftLines(draft), '', `[models.roles.${role}]`, `agent = ${JSON.stringify(name)}`],
    });

    try {
      updated = applyDraft(updated, draft);
      updated = setSectionString(updated, `models.roles.${role}`, 'agent', name);
      for (const key of LEGACY_ROLE_KEYS) {
        updated = removeSectionKey(updated, `models.roles.${role}`, key);
      }
    } catch (err) {
      blockers.push(editFailure(err));
    }
  }

  // ── [ollama] ────────────────────────────────────────────────────────────
  //
  // It set BOTH roles at once, so it becomes ONE profile plus the project
  // default pointing at it — the closest thing to "every task, that server".
  if (ollama !== null) {
    const model = stringAt(ollama, 'model');
    const endpoint = stringAt(ollama, 'endpoint') || LEGACY_OLLAMA_ENDPOINT;
    const harness = agentHarness(parsed);
    const name = 'local-ollama';

    if (Object.keys(ollama).length === 0) {
      // A header with every line commented out — the shape a lazy.toml written
      // from the example file has. It configured nothing before profiles, so
      // there is no server to name and nothing to carry over: the migration is
      // simply to remove it. Manufacturing an `[agents.local-ollama]` here would
      // invent an upstream the project never had.
      steps.push({
        found: '[ollama] (no keys set)',
        becomes: ['# section removed — it configured nothing'],
      });
      try {
        updated = removeSection(updated, 'ollama');
      } catch (err) {
        blockers.push(editFailure(err));
      }
    } else if (!model) {
      blockers.push(
        `[ollama] names no model, and an Ollama server's model names are its own — lazy will not ` +
        `guess one. Add \`model = "<the model that server serves>"\` to [ollama] and re-run, or ` +
        `write the [agents.${name}] block by hand.`,
      );
    } else {
      const draft: ProfileDraft = { name, harness, model, endpoint };
      steps.push({
        found: `[ollama] endpoint = ${JSON.stringify(endpoint)}`,
        becomes: [...draftLines(draft), '', '[agent]', `agent_id = ${JSON.stringify(name)}`],
      });
      try {
        updated = applyDraft(updated, draft);
        updated = setSectionString(updated, 'agent', 'agent_id', name);
        updated = removeSection(updated, 'ollama');
      } catch (err) {
        blockers.push(editFailure(err));
      }
    }
  }

  // ── [proxy] openai_upstream ─────────────────────────────────────────────
  //
  // It was one upstream for every OPENAI_API_KEY-granted caller. The codex
  // profile's own endpoint replaces it — and when it named codex's default
  // upstream anyway, the key simply goes, because the profile already says that.
  if (hasOpenaiUpstream) {
    const raw = proxy!.openai_upstream;
    const value = (typeof raw === 'string' ? raw.trim() : '') || DEFAULT_OPENAI_UPSTREAM;
    const existing = asTable(asTable(parsed.agents)?.codex);
    const model = stringAt(existing, 'model');

    if (value.replace(/\/$/, '') === DEFAULT_OPENAI_UPSTREAM) {
      steps.push({
        found: `[proxy] openai_upstream = ${JSON.stringify(value)}`,
        becomes: ['(removed — it names the upstream the built-in `codex` profile already uses)'],
      });
      try {
        updated = removeSectionKey(updated, 'proxy', 'openai_upstream');
      } catch (err) {
        blockers.push(editFailure(err));
      }
    } else if (!model) {
      blockers.push(
        `[proxy] openai_upstream = ${JSON.stringify(value)} moves onto a codex profile, and a ` +
        `profile with a pinned endpoint must name the model that server serves — lazy will not ` +
        `guess one. Add this block to lazy.toml by hand and re-run:\n\n` +
        `  [agents.codex]\n  harness = "codex"\n  model = "<the model that server serves>"\n` +
        `  endpoint = ${JSON.stringify(value)}`,
      );
    } else {
      const draft: ProfileDraft = { name: 'codex', harness: 'codex', model, endpoint: value };
      steps.push({
        found: `[proxy] openai_upstream = ${JSON.stringify(value)}`,
        becomes: draftLines(draft),
      });
      try {
        updated = applyDraft(updated, draft);
        updated = removeSectionKey(updated, 'proxy', 'openai_upstream');
      } catch (err) {
        blockers.push(editFailure(err));
      }
    }
  }

  const needed = steps.length > 0 || blockers.length > 0;
  if (!needed) return { needed: false, steps: [], blockers: [], updated: content };
  if (blockers.length > 0) return { needed, steps, blockers, updated: content };

  // Never offer a rewrite that would not load. The profile resolver is the same
  // one loadConfig runs, so a failure here is exactly the error the user would
  // have hit after saving — reported before anything is written.
  const validation = validate(updated);
  if (validation) return { needed, steps, blockers: [validation], updated: content };

  return { needed, steps, blockers: [], updated };
}

/**
 * The harness a migrated profile runs. `[agent] agent_id` is the project's
 * existing choice of agent, and a backend never overrode it; falling back to the
 * built-in default matches what a project with no `agent_id` was already running.
 *
 * Exported because the LOAD-TIME refusals print the same block `--fix agents`
 * would write, and they used to hardcode the built-in name here: a project with
 * `agent_id = "pi"` was told to paste `harness = "claude-code"` while `--fix`
 * wrote `harness = "pi"`. An error that disagrees with the tool it recommends is
 * worse than either answer alone.
 */
export function agentHarness(parsed: Record<string, unknown>): string {
  const id = stringAt(asTable(parsed.agent), 'agent_id');
  return id && HARNESS_WIRES[id] ? id : DEFAULT_AGENT_PROFILE_NAME;
}

function editFailure(err: unknown): string {
  if (err instanceof TomlEditError) return err.message;
  return `lazy.toml could not be rewritten: ${err instanceof Error ? err.message : String(err)}`;
}

/** Resolve the rewritten file's profiles; returns the failure message, or null. */
function validate(updated: string): string | null {
  try {
    const parsed = Bun.TOML.parse(updated) as Record<string, unknown>;
    const agents = asTable(parsed.agents) as Record<string, AgentProfileConfig> | null;
    // Warnings (a container-perspective endpoint, say) are the load's to print,
    // not this planner's — it is deciding whether the file RESOLVES.
    resolveAgentProfiles(agents ?? undefined, () => {});
  } catch (err) {
    return (
      `the rewritten lazy.toml would still not load: ` +
      `${err instanceof Error ? err.message : String(err)}`
    );
  }
  return null;
}
