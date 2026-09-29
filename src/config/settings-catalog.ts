/**
 * The settings catalogue: what a person editing a project's lazy.toml in a
 * browser needs to know about each key a control plane may set — which group
 * it belongs to, what it does in plain words, what shape its value takes, and
 * WHEN a saved change is picked up.
 *
 * It describes; it does not decide. Which keys a managed project may set is
 * MANAGED_POLICY's (src/config/managed.ts, via `editableConfigKeys`), whether a
 * value is valid is the resolver's (`validateProjectConfigText`), and what needs
 * a restart is the proxy fingerprint's. `test/unit/settings-catalog.test.ts`
 * fails when an editable key has no entry here, so the next key added to the
 * policy has to explain itself.
 *
 * WHEN A CHANGE TAKES EFFECT. The daemon caches no config: every operation
 * calls `loadConfig` at the project root and reads the file afresh (see
 * src/daemon/project-config.ts). So "when" is simply "the next time the
 * operation that reads this key runs" — and that operation differs per key,
 * which is what {@link SettingEffect} names. A setting with no turn in its path
 * must never be described in terms of turns.
 */

import { DEFAULT_CONFIG } from './loader';
import { editableConfigKeys } from './project-config';
import { VALID_CHATTINESS_LEVELS, VALID_EFFORT_LEVELS, VALID_LFS_CHECK_MODES } from './types';
import { REVIEW_GATES, REVIEW_MODES } from '../review/mode';
import { DEFAULT_UPSTREAM_TIMEOUT_SECONDS } from '../proxy/upstream-defaults';
import {
  TomlEditError,
  removeSectionKey,
  setSectionBoolean,
  setSectionNumber,
  setSectionString,
} from './toml-edit';

/** Which operation re-reads a key — and so when a saved change is picked up. */
export type SettingEffect =
  | 'next-turn'
  | 'turn-end'
  | 'review'
  | 'accept'
  | 'builder'
  | 'background'
  | 'on-use'
  | 'services'
  | 'restart';

/** The words a page shows for each effect. No "next turn" where no turn reads it. */
export const SETTING_EFFECTS: Record<SettingEffect, string> = {
  'next-turn':
    'Read when a turn starts. Turns already running keep the value they started with; the next turn to start — whether a person or lazy starts it — uses the new one.',
  'turn-end':
    'Read when a turn finishes. The next turn to finish uses it — including one that is running now.',
  review:
    'Read when a task declares its work finished and a review is set up. Reviews already under way are not affected.',
  accept:
    'Read when a task is accepted. The next accept uses it; nothing else is affected.',
  builder:
    'Read when a builder session starts. A builder session already open keeps the value it started with.',
  background:
    'Read by the project\'s background checks, which run about once a minute. It takes effect within a minute, with no turn involved.',
  'on-use':
    'Read every time lazy needs it, so it takes effect straight away — no turn and no restart.',
  services:
    'Read when a task\'s services are started. Services already running keep the old value until they are restarted.',
  restart:
    'Needs the project to restart. Saving restarts it for you, which pauses any work in progress and then resumes it.',
};

/** The same, as a short phrase a settings row shows beside the key. */
export const SETTING_EFFECT_LABELS: Record<SettingEffect, string> = {
  'next-turn': 'from the next turn that starts',
  'turn-end': 'from the next turn that finishes',
  review: 'from the next review',
  accept: 'from the next accept',
  builder: 'from the next builder session',
  background: 'within a minute (background checks)',
  'on-use': 'immediately',
  services: 'when services next start',
  restart: 'after a project restart (automatic)',
};

export type SettingKind = 'boolean' | 'integer' | 'number' | 'string' | 'choice' | 'list' | 'table';

export interface SettingGroup {
  id: string;
  title: string;
  summary: string;
}

export const SETTING_GROUPS: readonly SettingGroup[] = [
  { id: 'agents', title: 'Agents and models', summary: 'Which agent and model run a task, and how hard they think.' },
  { id: 'review', title: 'Review', summary: 'How finished work is reviewed before it can be accepted.' },
  { id: 'checks', title: 'Checks and automation', summary: 'Commands lazy runs around turns and accepts, and files agents must keep up to date.' },
  { id: 'protection', title: 'Protection', summary: 'Files and branches that need extra care before a change lands.' },
  { id: 'autonomy', title: 'Running on its own', summary: 'What lazy does without being asked: resuming interrupted work, reacting to CI and comments.' },
  { id: 'usage', title: 'Usage limits', summary: 'Stop starting new turns before a subscription window runs into paid overage.' },
  { id: 'remote', title: 'Remote repository', summary: 'How tasks reach the forge: pushing branches and opening pull requests.' },
  { id: 'workspace', title: 'Workspace and services', summary: 'What goes into a task\'s working copy and container, and the services it can serve.' },
  { id: 'proxy', title: 'Model traffic', summary: 'The proxy every agent request passes through.' },
  { id: 'general', title: 'General', summary: 'Output, logging and documentation.' },
];

export interface SettingEntry {
  group: string;
  label: string;
  summary: string;
  kind: SettingKind;
  effect: SettingEffect;
  choices?: readonly string[];
  /** Shown as the default when the resolved default cannot be read off DEFAULT_CONFIG. */
  default?: string;
  /** An older spelling kept working; a form shows it only when a file still sets it. */
  deprecated?: boolean;
  /**
   * Not a key a file can set: a field lazy RESOLVES (a role's harness comes
   * from its profile) or a spelling the loader refuses. Covered here so the
   * coverage test sees it, never offered on a settings page.
   */
  notAFileKey?: boolean;
  /** When this key's timing is more specific than its effect's words. */
  effectText?: string;
  effectLabel?: string;
}

const USAGE_PAUSE_EFFECT =
  'Checked each time a turn is about to start, whether a person or lazy starts it; a turn already running is never stopped. Starts lazy was holding because of a pause are let through within about a minute once the new value allows them.';

const EFFORTS = VALID_EFFORT_LEVELS;
const CHATTINESS = VALID_CHATTINESS_LEVELS;

/** Keyed by the dotted policy key (`*` for a user-chosen name). */
export const SETTINGS_CATALOG: Record<string, SettingEntry> = {
  // ── Agents and models ────────────────────────────────────────────────────
  'models.default': { group: 'agents', label: 'Default model', summary: 'The model a task runs on when nothing more specific picks one.', kind: 'string', effect: 'next-turn' },
  'models.roles.*.agent': { group: 'agents', label: 'Agent profile per role', summary: 'Which agent profile the builder or task agents use by default.', kind: 'table', effect: 'next-turn' },
  'models.roles.*.model': { group: 'agents', label: 'Model per role', summary: 'A model for one role (builder or agent).', kind: 'table', effect: 'next-turn', notAFileKey: true },
  'models.roles.*.harness': { group: 'agents', label: 'Role harness', summary: 'Resolved from the role\'s agent profile.', kind: 'table', effect: 'next-turn', notAFileKey: true },
  'models.roles.*.credential': { group: 'agents', label: 'Role credential', summary: 'Resolved from the role\'s agent profile.', kind: 'table', effect: 'next-turn', notAFileKey: true },
  'models.roles.*.wire': { group: 'agents', label: 'Role wire format', summary: 'Resolved from the role\'s agent profile.', kind: 'table', effect: 'next-turn', notAFileKey: true },
  'models.roles.*.pinned': { group: 'agents', label: 'Role pinned', summary: 'Resolved from the role\'s agent profile.', kind: 'table', effect: 'next-turn', notAFileKey: true },
  'models.roles.*.profile': { group: 'agents', label: 'Role profile', summary: 'Resolved from the role\'s agent profile.', kind: 'table', effect: 'next-turn', notAFileKey: true },
  'agents.*.harness': { group: 'agents', label: 'Profile harness', summary: 'Which agent program a named profile runs (claude-code, codex, cursor, pi).', kind: 'table', effect: 'next-turn' },
  'agents.*.model': { group: 'agents', label: 'Profile model', summary: 'The model a named profile asks for.', kind: 'table', effect: 'next-turn' },
  'agents.*.description': { group: 'agents', label: 'Profile description', summary: 'When to choose a named profile, shown beside every agent picker. Never selects one by itself.', kind: 'table', effect: 'on-use' },
  'agents.*.endpoint': { group: 'agents', label: 'Profile endpoint', summary: 'Where a named profile\'s requests are sent. Paid by the credential each member connects for that profile.', kind: 'table', effect: 'restart' },
  'agents.*.credential': { group: 'agents', label: 'Profile credential', summary: 'Which of each member\'s credentials pays for a named profile.', kind: 'table', effect: 'restart' },
  'agent.agent_id': { group: 'agents', label: 'Default agent profile', summary: 'The agent profile a task uses when it does not pick one.', kind: 'string', effect: 'next-turn', default: 'claude-code' },
  'agent.by_type': { group: 'agents', label: 'Agent profile per task type', summary: 'A different default agent profile for particular task types (fix, spike, …).', kind: 'table', effect: 'next-turn' },
  'agent.effort': { group: 'agents', label: 'Effort', summary: 'How much thinking a task agent does per step. Higher is slower and costs more.', kind: 'choice', choices: EFFORTS, effect: 'next-turn' },
  'agent.watchdog_output_timeout_ms': { group: 'agents', label: 'Silence limit (ms)', summary: 'Stop an agent that has produced no output for this long; 0 turns the check off.', kind: 'integer', effect: 'next-turn' },
  'agent.wind_down_timeout_ms': { group: 'agents', label: 'Wind-down time (ms)', summary: 'How long an agent that was asked to stop gets to finish cleanly.', kind: 'integer', effect: 'next-turn' },
  'agent.graceful_exit_timeout_ms': { group: 'agents', label: 'Wind-down time (old name)', summary: 'The older spelling of the wind-down time.', kind: 'integer', effect: 'next-turn', deprecated: true },
  'agent.low_high_loop': { group: 'review', label: 'Self-review loop (old setting)', summary: 'Replaced by the review mode; still honoured.', kind: 'boolean', effect: 'review', deprecated: true },
  'agent.low_high_loop_draft_effort': { group: 'review', label: 'Self-review draft effort (old setting)', summary: 'Replaced by the review draft effort.', kind: 'choice', choices: EFFORTS, effect: 'review', deprecated: true },
  'agent.low_high_loop_review_effort': { group: 'review', label: 'Self-review effort (old setting)', summary: 'Replaced by the review effort.', kind: 'choice', choices: EFFORTS, effect: 'review', deprecated: true },
  'builder.effort': { group: 'agents', label: 'Builder effort', summary: 'How much thinking the builder does per step.', kind: 'choice', choices: EFFORTS, effect: 'builder' },
  'chattiness.default': { group: 'agents', label: 'Chattiness', summary: 'How much agents and builders explain when they talk to a person.', kind: 'choice', choices: CHATTINESS, effect: 'next-turn', default: 'normal' },
  'chattiness.builder': { group: 'agents', label: 'Builder chattiness', summary: 'Chattiness for the builder only.', kind: 'choice', choices: CHATTINESS, effect: 'builder', default: 'the general chattiness' },
  'chattiness.agent': { group: 'agents', label: 'Agent chattiness', summary: 'Chattiness for task agents only.', kind: 'choice', choices: CHATTINESS, effect: 'next-turn', default: 'the general chattiness' },
  'session.verbose': { group: 'general', label: 'Verbose agent logs', summary: 'Record more detail about each agent session.', kind: 'boolean', effect: 'next-turn' },
  'session.debug': { group: 'general', label: 'Debug agent logs', summary: 'Record debugging detail about each agent session.', kind: 'boolean', effect: 'next-turn' },
  'session.auto_commit_instructions': { group: 'agents', label: 'Tell agents to commit', summary: 'Include the instruction to commit finished work in every agent\'s prompt.', kind: 'boolean', effect: 'next-turn' },
  'limits.max_turns_without_human': { group: 'autonomy', label: 'Turns without a person', summary: 'How many turns in a row lazy may start on a task before a person has to step in; 0 means no limit.', kind: 'integer', effect: 'next-turn' },
  'cluster.max_child_fix_rounds': { group: 'autonomy', label: 'Fix rounds per cluster subtask', summary: 'How many times a cluster sends one subtask back to fix review findings before deciding itself.', kind: 'integer', effect: 'next-turn' },
  'loop.max_child_fix_rounds': { group: 'autonomy', label: 'Fix rounds (old name)', summary: 'The older spelling of the cluster fix-round limit.', kind: 'integer', effect: 'next-turn', default: '3', deprecated: true },

  // ── Review ───────────────────────────────────────────────────────────────
  'review.mode': { group: 'review', label: 'Review mode', summary: 'off: no automatic review. low_high: the agent reviews its own draft at higher effort. separate: a second agent reviews it.', kind: 'choice', choices: REVIEW_MODES, effect: 'review' },
  'review.auto_fix': { group: 'review', label: 'Fix review findings automatically', summary: 'Send findings straight back to the agent to fix, without waiting for a person.', kind: 'boolean', effect: 'review' },
  'review.gate': { group: 'review', label: 'Review gate', summary: 'Whether open review findings block an accept: auto (the mode decides), always, or never.', kind: 'choice', choices: REVIEW_GATES, effect: 'accept' },
  'review.draft_effort': { group: 'review', label: 'Draft effort', summary: 'Effort for the draft pass of a self-review.', kind: 'choice', choices: EFFORTS, effect: 'review' },
  'review.review_effort': { group: 'review', label: 'Review effort', summary: 'Effort for the reviewing pass.', kind: 'choice', choices: EFFORTS, effect: 'review' },

  // ── Checks and automation ────────────────────────────────────────────────
  'automation.pre_turn': { group: 'checks', label: 'Before each turn', summary: 'A command run in the task\'s working copy before every turn.', kind: 'string', effect: 'next-turn' },
  'automation.pre_turn_timeout': { group: 'checks', label: 'Before-turn time limit (s)', summary: 'How long the before-turn command may run.', kind: 'integer', effect: 'next-turn' },
  'automation.pre_turn_required': { group: 'checks', label: 'Before-turn must pass', summary: 'Refuse to start the turn when the before-turn command fails.', kind: 'boolean', effect: 'next-turn' },
  'automation.post_turn': { group: 'checks', label: 'After each turn', summary: 'A check command run when a turn finishes; its result is shown with the turn.', kind: 'string', effect: 'turn-end' },
  'automation.post_turn_timeout': { group: 'checks', label: 'After-turn time limit (s)', summary: 'How long the after-turn check may run.', kind: 'integer', effect: 'turn-end' },
  'checks.post_turn': { group: 'checks', label: 'After each turn (old name)', summary: 'The older spelling of the after-turn check.', kind: 'string', effect: 'turn-end', deprecated: true },
  'checks.post_turn_timeout': { group: 'checks', label: 'After-turn time limit (old name)', summary: 'The older spelling of the after-turn time limit.', kind: 'integer', effect: 'turn-end', deprecated: true },
  'automation.accept_check': { group: 'checks', label: 'Before accepting', summary: 'A command that must pass before a task is accepted.', kind: 'string', effect: 'accept' },
  'automation.accept_check_timeout': { group: 'checks', label: 'Accept check time limit (s)', summary: 'How long the accept check may run.', kind: 'integer', effect: 'accept' },
  'automation.pre_accept': { group: 'checks', label: 'Pre-accept gate', summary: 'Commands run before an accept, in the task\'s working copy.', kind: 'table', effect: 'accept' },
  'automation.pre_accept.commands': { group: 'checks', label: 'Pre-accept commands', summary: 'The commands the pre-accept gate runs.', kind: 'list', effect: 'accept' },
  'automation.pre_accept.enabled': { group: 'checks', label: 'Pre-accept gate on', summary: 'Run the pre-accept commands before every accept.', kind: 'boolean', effect: 'accept', default: 'false' },
  'automation.pre_accept.timeout': { group: 'checks', label: 'Pre-accept time limit (s)', summary: 'How long the pre-accept commands may run.', kind: 'integer', effect: 'accept' },
  'automation.maintain': { group: 'checks', label: 'Maintained files', summary: 'Groups of files agents are asked to keep up to date as they work (docs, changelog).', kind: 'table', effect: 'turn-end' },
  'automation.react': { group: 'autonomy', label: 'Reactions', summary: 'Automatic follow-up turns when something matching a pattern happens.', kind: 'table', effect: 'background' },

  // ── Protection ───────────────────────────────────────────────────────────
  'permissions.protected': { group: 'protection', label: 'Protected files', summary: 'Files an agent may not change without a person approving it at accept.', kind: 'list', effect: 'turn-end' },
  'protection.enabled': { group: 'protection', label: 'Protection on', summary: 'Require a passphrase to accept into protected branches and tasks.', kind: 'boolean', effect: 'accept' },
  'protection.gate_default_branch': { group: 'protection', label: 'Protect the default branch', summary: 'Treat the repository\'s default branch as protected.', kind: 'boolean', effect: 'accept' },
  'protection.protected_branches': { group: 'protection', label: 'Protected branches', summary: 'Branches that need the passphrase to accept into.', kind: 'list', effect: 'accept' },
  'protection.protected_tasks': { group: 'protection', label: 'Protected tasks', summary: 'Tasks that need the passphrase to accept into.', kind: 'list', effect: 'accept' },

  // ── Running on its own ───────────────────────────────────────────────────
  'daemon.auto_resume': { group: 'autonomy', label: 'Resume interrupted work', summary: 'Restart a task whose turn was interrupted (for example by a crash).', kind: 'boolean', effect: 'background' },
  'daemon.auto_resume_interval_minutes': { group: 'autonomy', label: 'Resume interval (minutes)', summary: 'How often interrupted tasks are looked at.', kind: 'integer', effect: 'background' },
  'daemon.auto_resume_gap_minutes': { group: 'autonomy', label: 'Resume gap (minutes)', summary: 'How long to wait after an interruption before resuming.', kind: 'integer', effect: 'background' },
  'daemon.auto_resume_max_attempts': { group: 'autonomy', label: 'Resume attempts', summary: 'How many times one task is resumed before lazy gives up and waits for a person.', kind: 'integer', effect: 'background' },
  'daemon.auto_react_ci': { group: 'autonomy', label: 'React to CI failures', summary: 'Start a turn when a task\'s CI fails.', kind: 'boolean', effect: 'background' },
  'daemon.auto_react_comments': { group: 'autonomy', label: 'React to pull request comments', summary: 'Start a turn when someone comments on a task\'s pull request.', kind: 'boolean', effect: 'background' },
  'daemon.auto_react_max_retries': { group: 'autonomy', label: 'Reaction retries', summary: 'How many times a failed reaction is retried.', kind: 'integer', effect: 'background' },
  'daemon.auto_react_backoff': { group: 'autonomy', label: 'Reaction back-off', summary: 'How the wait between retries grows.', kind: 'choice', choices: ['none', 'linear', 'exponential'], effect: 'background' },
  'daemon.auto_react_daily_budget': { group: 'autonomy', label: 'Reactions per day', summary: 'The most reaction turns lazy starts in one day.', kind: 'integer', effect: 'background' },
  'daemon.max_auto_turns': { group: 'autonomy', label: 'Automatic turns per task', summary: 'The most turns lazy starts on one task by itself before waiting for a person.', kind: 'integer', effect: 'background' },

  // ── Usage limits ─────────────────────────────────────────────────────────
  'usage_pause.threshold_percent': { group: 'usage', label: 'Pause at (% of window used)', summary: 'Stop starting turns once a subscription usage window is this full. 0 or unset means never pause.', kind: 'number', effect: 'next-turn', effectText: USAGE_PAUSE_EFFECT, effectLabel: 'from the next turn that starts (held starts within a minute)' },
  'usage_pause.credentials': { group: 'usage', label: 'Pause per credential', summary: 'A different pause threshold for particular credentials.', kind: 'table', effect: 'next-turn', effectText: USAGE_PAUSE_EFFECT },

  // ── Remote repository ────────────────────────────────────────────────────
  'remote.driver': { group: 'remote', label: 'Forge', summary: 'local keeps everything in this repository; github or gitlab push branches and open pull requests there.', kind: 'choice', choices: ['local', 'github', 'gitlab'], effect: 'on-use' },
  'remote.git_remote': { group: 'remote', label: 'Git remote name', summary: 'The name of the git remote lazy pushes to and fetches from.', kind: 'string', effect: 'on-use', default: 'origin' },
  'remote.offline': { group: 'remote', label: 'Offline', summary: 'Never contact the forge.', kind: 'boolean', effect: 'on-use' },
  'remote.auto_approve': { group: 'remote', label: 'Approve pull requests on accept', summary: 'Submit an approving review when accepting into a protected branch that requires one.', kind: 'boolean', effect: 'accept' },
  'remote.github_auto_push': { group: 'remote', label: 'Push to GitHub automatically', summary: 'Push task branches after each turn.', kind: 'boolean', effect: 'on-use' },
  'remote.gitlab_auto_push': { group: 'remote', label: 'Push to GitLab automatically', summary: 'Push task branches after each turn.', kind: 'boolean', effect: 'on-use' },
  'git.default_branch_prefix': { group: 'remote', label: 'Branch prefix', summary: 'The prefix of every task branch\'s name. Existing tasks keep their branches.', kind: 'string', effect: 'on-use' },
  'git.lfs_check': { group: 'remote', label: 'Git LFS check', summary: 'What to do when the repository uses Git LFS but it is not set up: refuse, warn, or off.', kind: 'choice', choices: VALID_LFS_CHECK_MODES, effect: 'on-use' },
  'git.coauthor_trailer': { group: 'remote', label: 'Lazy co-author trailer', summary: 'Add "Co-Authored-By: Lazy" to the commits lazy makes for a task.', kind: 'boolean', effect: 'on-use' },

  // ── Workspace and services ───────────────────────────────────────────────
  'worktree.include': { group: 'workspace', label: 'Copy into new working copies', summary: 'Untracked files (like .env) copied into each new task\'s working copy.', kind: 'list', effect: 'on-use' },
  'docker.dockerfile': { group: 'workspace', label: 'Container image', summary: 'A Dockerfile, relative to the repository root, for the image tasks run in.', kind: 'string', effect: 'next-turn' },
  'docker.build_inputs': { group: 'workspace', label: 'Image build inputs', summary: 'Files whose change rebuilds the container image.', kind: 'list', effect: 'next-turn' },
  'serve.ports': { group: 'workspace', label: 'Served ports', summary: 'Ports a task\'s app listens on, reachable from the task page.', kind: 'list', effect: 'services' },
  'serve.services': { group: 'workspace', label: 'Named services', summary: 'Named ports a task\'s app serves.', kind: 'table', effect: 'services' },
  'serve.start_services_cmd': { group: 'workspace', label: 'Start services command', summary: 'The command that starts a task\'s services.', kind: 'string', effect: 'services' },
  'documents.path': { group: 'workspace', label: 'Documents folder', summary: 'Where lazy looks for project documents.', kind: 'string', effect: 'on-use' },

  // ── Model traffic ────────────────────────────────────────────────────────
  'proxy.retry_after_threshold': { group: 'proxy', label: 'Retry-after threshold (s)', summary: 'Wait and retry a rate-limited request when the provider asks for at most this many seconds.', kind: 'integer', effect: 'restart', default: '5' },
  'proxy.upstream_timeout': { group: 'proxy', label: 'Upstream timeout (s)', summary: 'How long a model request may take before it is given up.', kind: 'integer', effect: 'restart', default: String(DEFAULT_UPSTREAM_TIMEOUT_SECONDS) },
  'proxy.policy.deny_path_globs': { group: 'proxy', label: 'Extra denied paths', summary: 'Paths agents may not read or write, on top of the installation\'s own list.', kind: 'list', effect: 'restart' },

  // ── General ──────────────────────────────────────────────────────────────
  'output.shortid_length': { group: 'general', label: 'Short id length', summary: 'How many characters of a task id are shown.', kind: 'integer', effect: 'on-use' },
  'memory.warn_bytes': { group: 'general', label: 'Memory size warning (bytes)', summary: 'Warn when shared memory grows past this size.', kind: 'integer', effect: 'on-use' },
  'docs.url': { group: 'general', label: 'Documentation address', summary: 'Where links to lazy\'s documentation point.', kind: 'string', effect: 'on-use' },
};

/** Keys a form can edit directly; the rest are edited as TOML. */
const FORM_KINDS: ReadonlySet<SettingKind> = new Set(['boolean', 'integer', 'number', 'string', 'choice']);

export interface SettingDescription extends SettingEntry {
  key: string;
  /** Whether a form control can edit it; false → edit it in the TOML text. */
  formEditable: boolean;
  /** Lazy's value when the file does not set it, as text. */
  defaultText: string;
  effectText: string;
  effectLabel: string;
}

export interface SettingsCatalogRead {
  groups: readonly SettingGroup[];
  effects: Record<SettingEffect, string>;
  settings: SettingDescription[];
}

function defaultOf(key: string, entry: SettingEntry): string {
  if (entry.default !== undefined) return entry.default;
  let value: unknown = DEFAULT_CONFIG;
  for (const part of key.split('.')) {
    if (!value || typeof value !== 'object') return '';
    value = (value as Record<string, unknown>)[part];
  }
  if (value === undefined || value === null || value === '') return '';
  if (Array.isArray(value)) return value.length === 0 ? '' : value.join(', ');
  if (typeof value === 'object') return '';
  return String(value);
}

/** The catalogue restricted to what this project may set, in group order. */
export function settingsCatalog(): SettingsCatalogRead {
  const settings = editableConfigKeys()
    .filter((key) => SETTINGS_CATALOG[key] && !SETTINGS_CATALOG[key]!.notAFileKey)
    .map((key) => {
      const entry = SETTINGS_CATALOG[key]!;
      return {
        key,
        ...entry,
        formEditable: FORM_KINDS.has(entry.kind) && !key.includes('*'),
        defaultText: defaultOf(key, entry),
        effectText: entry.effectText ?? SETTING_EFFECTS[entry.effect],
        effectLabel: entry.effectLabel ?? SETTING_EFFECT_LABELS[entry.effect],
      };
    });
  const order = new Map(SETTING_GROUPS.map((g, i) => [g.id, i]));
  settings.sort((a, b) => (order.get(a.group)! - order.get(b.group)!));
  return { groups: SETTING_GROUPS, effects: SETTING_EFFECTS, settings };
}

// ── What a file sets, and what changed between two ────────────────────────

function parse(toml: string): Record<string, unknown> | null {
  try {
    return Bun.TOML.parse(toml) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function display(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function isTable(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A catalogue key whose own children are catalogue keys (`automation.pre_accept`). */
function hasCatalogChildren(key: string): boolean {
  return Object.keys(SETTINGS_CATALOG).some((other) => other.startsWith(`${key}.`));
}

interface ResolvedValue {
  /** The catalogue key it is an instance of (`agents.*.model`). */
  catalogKey: string;
  text: string;
}

/**
 * Every catalogue key the file sets, resolved against the raw parse. A `*` is
 * expanded per name (`agents.work.model`), so two profiles never collapse
 * onto one entry; a table- or list-valued key is compared as its whole value,
 * so a change anywhere inside `[[automation.maintain]]` is a change to it.
 */
function resolveValues(raw: Record<string, unknown>): Map<string, ResolvedValue> {
  const out = new Map<string, ResolvedValue>();
  for (const [catalogKey, entry] of Object.entries(SETTINGS_CATALOG)) {
    if (entry.notAFileKey) continue;
    const walk = (node: unknown, parts: string[], path: string[]): void => {
      if (parts.length === 0) {
        if (node === undefined) return;
        // A table whose keys are themselves catalogue settings reports through them.
        if (isTable(node) && hasCatalogChildren(catalogKey)) return;
        out.set(path.join('.'), { catalogKey, text: display(node) });
        return;
      }
      if (!isTable(node)) return;
      const [head, ...rest] = parts;
      if (head === '*') {
        for (const [name, child] of Object.entries(node)) walk(child, rest, [...path, name]);
      } else {
        walk(node[head!], rest, [...path, head!]);
      }
    };
    walk(raw, catalogKey.split('.'), []);
  }
  return out;
}

/**
 * The value each catalogue key has in `toml`, as display text. Only keys the
 * file actually sets; an unparseable file sets nothing.
 */
export function settingValues(toml: string): Record<string, string> {
  const raw = parse(toml);
  if (!raw) return {};
  return Object.fromEntries([...resolveValues(raw)].map(([key, v]) => [key, v.text]));
}

export interface SettingChange {
  key: string;
  label: string;
  change: 'added' | 'removed' | 'changed';
  before: string | null;
  after: string | null;
  /** Lazy's value when unset, so "removed" can say what applies instead. */
  defaultText: string;
  effect: SettingEffect;
  effectText: string;
}

/**
 * What differs between two versions, key by key, each with WHEN it is picked
 * up — or null when either text does not parse, because then nothing can be
 * said about what it sets (not "everything was removed"). Only catalogue keys
 * are reported: an unknown key is never read.
 */
export function describeConfigChange(beforeToml: string, afterToml: string): SettingChange[] | null {
  const beforeRaw = parse(beforeToml);
  const afterRaw = parse(afterToml);
  if (!beforeRaw || !afterRaw) return null;
  const before = resolveValues(beforeRaw);
  const after = resolveValues(afterRaw);
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes: SettingChange[] = [];
  for (const key of keys) {
    const b = before.get(key);
    const a = after.get(key);
    if (b?.text === a?.text) continue;
    const catalogKey = (a ?? b)!.catalogKey;
    const entry = SETTINGS_CATALOG[catalogKey]!;
    const name = catalogKey.includes('*') ? key.split('.')[catalogKey.split('.').indexOf('*')] : null;
    changes.push({
      key,
      label: name ? `${entry.label} (${name})` : entry.label,
      change: b === undefined ? 'added' : a === undefined ? 'removed' : 'changed',
      before: b?.text ?? null,
      after: a?.text ?? null,
      defaultText: defaultOf(catalogKey, entry),
      effect: entry.effect,
      effectText: entry.effectText ?? SETTING_EFFECTS[entry.effect],
    });
  }
  return changes;
}

// ── Editing a file from form values ───────────────────────────────────────

export class SettingEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingEditError';
  }
}

/**
 * Apply form edits to `toml` as TEXT, so every comment and every key the form
 * does not show survives byte-for-byte (src/config/toml-edit.ts). `set` values
 * arrive as the strings a form posts and are typed by the catalogue; `unset`
 * removes a key so lazy's default applies. Validation is NOT done here — the
 * caller judges the result with `validateProjectConfigText` like any text.
 */
export function editConfigText(toml: string, set: Record<string, string>, unset: readonly string[]): string {
  let text = toml;
  const split = (key: string): [string, string] => {
    const entry = SETTINGS_CATALOG[key];
    if (!entry || !FORM_KINDS.has(entry.kind) || key.includes('*') || !editableConfigKeys().includes(key)) {
      throw new SettingEditError(`'${key}' cannot be set from the settings form; edit it in the lazy.toml text instead`);
    }
    const dot = key.lastIndexOf('.');
    return [key.slice(0, dot), key.slice(dot + 1)];
  };
  try {
    for (const key of unset) {
      const [section, leaf] = split(key);
      text = removeSectionKey(text, section, leaf);
    }
    for (const [key, raw] of Object.entries(set)) {
      const [section, leaf] = split(key);
      const entry = SETTINGS_CATALOG[key]!;
      const value = raw.trim();
      switch (entry.kind) {
        case 'boolean':
          if (value !== 'true' && value !== 'false') throw new SettingEditError(`${entry.label}: expected true or false, got "${raw}"`);
          text = setSectionBoolean(text, section, leaf, value === 'true');
          break;
        case 'integer':
          if (!/^-?\d+$/.test(value)) throw new SettingEditError(`${entry.label}: expected a whole number, got "${raw}"`);
          text = setSectionNumber(text, section, leaf, Number(value));
          break;
        case 'number':
          if (!/^-?\d+(\.\d+)?$/.test(value)) throw new SettingEditError(`${entry.label}: expected a number, got "${raw}"`);
          text = setSectionNumber(text, section, leaf, Number(value));
          break;
        case 'choice':
          if (!entry.choices!.includes(value)) {
            throw new SettingEditError(`${entry.label}: expected one of ${entry.choices!.join(', ')}, got "${raw}"`);
          }
          text = setSectionString(text, section, leaf, value);
          break;
        default:
          text = setSectionString(text, section, leaf, raw);
      }
    }
  } catch (err) {
    if (err instanceof TomlEditError) throw new SettingEditError(err.message);
    throw err;
  }
  return text;
}
