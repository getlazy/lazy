/**
 * The Teams proxy's per-command body-key allowlist (`CliRpcCommand::BODY_KEYS`),
 * checked against the request bodies lazy's own CLI actually sends.
 *
 * The proxy refuses any body key a command does not list, because some keys
 * are authority the browser never grants: `callerTaskId` ("I am this task's
 * own running agent") let a member self-sync a WORKING task and accept into a
 * parent whose agent was mid-turn, and accept's gate-skipping flags got past
 * gates the browser's accept enforces. A refuse-by-default list needs a
 * parity check in BOTH directions, or it drifts:
 *
 *   - a key the CLI sends that the list neither admits nor classifies below
 *     fails — otherwise an ordinary command 403s in a bound clone the first
 *     time someone uses the flag;
 *   - an admitted key nothing sends fails — admitted surface nobody needs is
 *     exactly how a key like `callerTaskId` gets through;
 *   - a register entry the list now admits fails, so the register cannot rot.
 *
 * The CLI's bodies are read EXACTLY (`test/helpers/cli-rpc-bodies.ts`), not
 * as a union of every `key:` in the enclosing function: for an allowlist, a
 * key collected by accident is a key admitted by accident.
 */

import { describe, test, expect } from 'bun:test';
import { loadRailsPolicyTables } from '../helpers/rails-policy-tables';
import { cliRpcBodies } from '../helpers/cli-rpc-bodies';

/**
 * Keys the CLI's request bodies can carry that the proxy refuses on purpose,
 * as `command.key`. Each is a refusal a member meets in a bound clone, or —
 * for `callerTaskId` — a key only lazy's own MCP boundary ever sets.
 */
const REFUSED_BY_DESIGN: Readonly<Record<string, string>> = {
  'syncTask.callerTaskId': 'MCP-only proof that the caller is the task\'s own agent; lets a WORKING task self-sync.',
  'acceptTask.callerTaskId': 'MCP-only; lets a child merge into a parent whose agent is still working.',
  'acceptTask.allowBroken': '--allow-broken skips the accept check; the browser\'s accept never sends it.',
  'acceptTask.allowReviewIssues': '--allow-review-issues skips the review-issues gate; the browser never sends it.',
  'acceptTask.acceptDirtyWorktree': 'skips the dirty-worktree gate; the browser\'s accept never sends it.',
  'acceptTaskPreflight.allowReviewIssues': 'the preflight twin of the accept flag above.',
  'acceptTaskPreflight.acceptDirtyWorktree': 'the preflight twin of the accept flag above.',
  'startTask.forceLocal': 'offline-mode start; the browser has no such control.',
  'startTask.retargetOrphan': 'retargets an orphaned child — a reparent by another door.',
  'startTask.reviewOverrides': 'per-task review settings; no browser page sets them.',
  'unblockTask.agentOverride': 'switches the task\'s agent on unblock; the browser\'s feedback form cannot.',
  'unblockTask.permissionMode': 'runs the turn in a different permission mode; the browser never sends it.',
  'unblockTask.retargetOrphan': 'retargets an orphaned child — a reparent by another door.',
  'reviewTask.autoFix': 'the browser\'s review button sends only the effort.',
  'reviewTask.modelOverride': 'the browser\'s review button sends only the effort.',
  'cloneTask.base': 'pins a clone to an arbitrary commit; the browser\'s copy form offers only the source\'s own start commit (sameBase).',
  'cloneTask.defaultParent': 'makes the clone top-level; the browser\'s copy always lands beside the source.',
};

/**
 * Whole COMMANDS the CLI sends that the proxy refuses on purpose (unmapped in
 * `CliRpcCommand::COMMANDS`). A command the CLI sends must be either mapped or
 * classified here, so a new one cannot land mapped-by-accident or refused
 * without anyone deciding — and so a refusal like `describeLinkedTask`'s
 * cannot be quietly undone by re-mapping it.
 */
const REFUSED_COMMANDS: Readonly<Record<string, string>> = {
  describeLinkedTask: 'looks like a read, but runs a model one-shot (spends tokens) and rewrites the task\'s prompt and goal — with force, over a hand edit. The browser has no describe action.',
  taskEnv: 'its action can set/unset/clear a task\'s agent environment (secrets included); the browser has no such surface.',
  submitTask: 'no browser equivalent.',
  submitTaskPreflight: 'looks like a read, but unwedges a task stuck in merging (status, metadata, a comment); submitTask is refused, so it precedes nothing.',
  reparentTask: 'no browser equivalent.',
  linkTask: 'no browser equivalent.',
  repairCommits: 'store repair — a local operator act, not a member one.',
  concurrency: 'control-plane.',
  usageLimits: 'control-plane — every member\'s usage-limit readings; the daemon refuses it to a user token, like listUserCredentials.',
  usagePause: 'control-plane: the one-shot usage-pause override, and every member\'s paused credential (the daemon refuses user tokens too).',
  builderSlot: 'control-plane (builder admission).',
  ensureTaskContainer: 'container plumbing on the daemon host.',
  getDaemonMcpConfig: 'mints an MCP session token — control-plane.',
  revokeDaemonMcpToken: 'control-plane.',
  setProjectSettings: 'the settings page is its own admin surface; not relayed for the CLI.',
  conversationPromote: 'not yet classified for the proxy.',
  expandPresentation: 'writes the review presentation; not yet classified for the proxy.',
  regionOverlay: 'writes a region overlay; not yet classified for the proxy.',
  reviewAccept: 'review-surface write; not yet classified for the proxy (lazy accept is the mapped route).',
  reviewUnblock: 'review-surface write; not yet classified for the proxy (lazy unblock is the mapped route).',
  reviewSync: 'review-surface write; not yet classified for the proxy.',
  reviewGetDraft: 'review drafts are per-client; not yet classified for the proxy.',
  reviewSaveDraft: 'review drafts are per-client; not yet classified for the proxy.',
  reviewFlagRaised: 'review-surface write; not yet classified for the proxy.',
  reviewResolveRaised: 'review-surface write; not yet classified for the proxy.',
  reviewUnresolveRaised: 'review-surface write; not yet classified for the proxy.',
  reviewPromoteRaised: 'review-surface write; not yet classified for the proxy.',
  reviewPromoteDiscussion: 'review-surface write; not yet classified for the proxy.',
  reviewRetryAsk: 'review-surface write (launches an ask); not yet classified for the proxy.',
  reviewWithdrawComment: 'review-surface write; not yet classified for the proxy.',
  reviewViolationDecision: 'review-surface write; not yet classified for the proxy.',
};

/**
 * Mapped commands lazy's CLI does not send through a scanned call site,
 * and why their lists are what they are.
 */
const NOT_SENT_BY_THE_CLI: Readonly<Record<string, string>> = {
  editTask: 'dormant — lazy edit writes through storage; the list is the browser\'s TaskEdit fields.',
  storage: 'sent by RemoteStorage as { method, args }; its args are StorageMethodPolicy\'s question.',
};

describe('the proxy\'s body-key allowlist against the bodies the CLI sends', () => {
  const tables = loadRailsPolicyTables();
  const bodies = cliRpcBodies();

  test('the scan itself is sound — it sees the known call sites and their keys', () => {
    // An empty or blind scan would make every assertion below vacuous.
    expect(bodies.get('acceptTask')?.keys.has('callerTaskId')).toBe(true);
    expect(bodies.get('acceptTask')?.keys.has('allowBroken')).toBe(true);
    expect(bodies.get('syncTask')?.keys.has('callerTaskId')).toBe(true);
    expect(bodies.get('reviewFileLines')?.keys.has('path')).toBe(true);
    expect(bodies.get('cloneTask')?.keys.has('parent')).toBe(true);
    expect(bodies.size).toBeGreaterThanOrEqual(40);
  });

  test('every mapped command has a body-key list, and every list names a mapped command', () => {
    const mapped = [ ...tables.cliCommands, 'storage' ].sort();
    expect([ ...tables.bodyKeys.keys() ].sort()).toEqual(mapped);
  });

  // INVARIANT: a key the CLI sends for a mapped command is either admitted or
  // refused on purpose — never refused by accident.
  test('every key the CLI sends is admitted or on the refused-by-design register', () => {
    const missing: string[] = [];
    for (const [ command, allowed ] of tables.bodyKeys) {
      const body = bodies.get(command);
      if (!body) continue;
      for (const key of body.keys) {
        if (allowed.has(key) || Object.hasOwn(REFUSED_BY_DESIGN, `${command}.${key}`)) continue;
        missing.push(`${command}.${key} (sent from ${body.sites[0]})`);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        'The CLI sends body keys CliRpcCommand::BODY_KEYS does not admit and this register does not classify.\n' +
        'Admit the key in lazy-teams/app/models/cli_rpc_command.rb only if the browser can send it too; otherwise add it to REFUSED_BY_DESIGN here with a reason.\n' +
        'Missing: ' + missing.join(', '),
      );
    }
  });

  // INVARIANT: the admitted lists are derived from what the CLI sends, never
  // widened on speculation.
  test('every admitted key is one the CLI actually sends', () => {
    const unsent: string[] = [];
    for (const [ command, allowed ] of tables.bodyKeys) {
      const body = bodies.get(command);
      if (!body) {
        if (!Object.hasOwn(NOT_SENT_BY_THE_CLI, command)) unsent.push(`${command} (no CLI call site at all)`);
        continue;
      }
      for (const key of allowed) if (!body.keys.has(key)) unsent.push(`${command}.${key}`);
    }
    expect(unsent).toEqual([]);
  });

  test('every register entry is a key the CLI sends and the proxy still refuses', () => {
    const stale: string[] = [];
    for (const entry of Object.keys(REFUSED_BY_DESIGN)) {
      const [ command, key ] = entry.split('.');
      if (!bodies.get(command)?.keys.has(key)) stale.push(`${entry} (no longer sent)`);
      if (tables.bodyKeys.get(command)?.has(key)) stale.push(`${entry} (now admitted)`);
    }
    expect(stale).toEqual([]);
  });

  // INVARIANT: every command the CLI sends is either mapped or refused on
  // purpose. `READ_ONLY_RPC_COMMANDS` answers "writes no attributed row", not
  // "is a read" — `taskEnv` and `describeLinkedTask` were both admitted at the
  // read bar on that confusion — so classification is a decision made here, by
  // name, never inferred.
  test('every command the CLI sends is mapped or on the refused-commands register', () => {
    const unclassified = [ ...bodies.keys() ]
      .filter((c) => !tables.cliCommands.has(c) && !Object.hasOwn(REFUSED_COMMANDS, c))
      .sort();
    expect(unclassified).toEqual([]);
  });

  test('every refused command is still unmapped and still sent by the CLI', () => {
    const stale = Object.keys(REFUSED_COMMANDS).filter((c) => tables.cliCommands.has(c) || !bodies.has(c));
    expect(stale).toEqual([]);
  });

  test('describeLinkedTask is not mapped — it spends tokens and rewrites a prompt', () => {
    expect(tables.cliCommands.has('describeLinkedTask')).toBe(false);
    expect(tables.bodyKeys.has('describeLinkedTask')).toBe(false);
  });

  test('callerTaskId is admitted on no command at all', () => {
    // The pin the whole list exists for, stated on its own so pruning the
    // register above cannot quietly remove it.
    const admitting = [ ...tables.bodyKeys ].filter(([ , keys ]) => keys.has('callerTaskId')).map(([ c ]) => c);
    expect(admitting).toEqual([]);
  });
});
