/**
 * Which RPC commands WRITE TO THE STORE, and which only read it.
 *
 * One consumer today: the identity gate (src/daemon/rpc-handlers.ts). A row in
 * the store carries who wrote it, so a store write that nobody can be
 * attributed to is refused the way git refuses a commit it cannot sign. A READ
 * is never refused — `lazy list`, `lazy show`, `lazy diff`, the dashboard and
 * `lazy doctor` keep working with no identity configured, which matters
 * because looking at something is the most likely moment to discover the
 * problem.
 *
 * WHAT IS GATED, exactly: a command that produces an ATTRIBUTED ROW, plus a
 * command that LAUNCHES A TURN. The first because the row carries a person and
 * there is none to write; the second because a turn nobody can be attributed to
 * should not start in the first place — it will write rows of its own, and by
 * then the caller is gone.
 *
 * Everything else that merely changes the ENVIRONMENT is NOT gated, because
 * refusing it takes away the tools someone needs to recover from the very setup
 * being diagnosed: a daemon limit (`concurrency`), minting or revoking a token
 * (`mintActorToken`, `revokeActorToken`), pushing a credential
 * (`putUserCredential`, `revokeUserCredential`), a doctor remedy. On a fresh
 * machine with no `~/.gitconfig` those all still work. Git draws the same line:
 * it refuses `git commit` without an identity, not `git checkout`.
 *
 * THE PARTITION IS ENFORCED, not assumed. `test/unit/rpc-command-kinds.test.ts`
 * scans the dispatch table's `case` labels and fails when a command is in
 * neither set — a command added later must be classified by the person adding
 * it, because the alternative is finding out from a store full of rows that
 * name nobody. At runtime the default is the safe one: anything not named as a
 * read is treated as a store write.
 */

/**
 * Commands that never write an attributed row.
 *
 * Reads of tasks, turns, diffs, regions, reviews and settings; the long-polls
 * that wait for someone else's work; credential and doctor introspection; and
 * `identity` itself, which must be answerable precisely when the answer is
 * "nobody" — it is what the CLI preflight and doctor ask.
 *
 * It also holds the ENVIRONMENT-ONLY writes, which are not reads at all and are
 * here because the gate must not refuse them (see the module comment). Each is
 * marked below with what it changes and why no row of it names a person.
 */
export const READ_ONLY_RPC_COMMANDS: ReadonlySet<string> = new Set([
  'list',
  'loops',
  // The same read as 'loops' under the name every human surface now uses; the
  // wire keeps 'loops' too while Teams still reads it.
  'clusters',
  'blocked',
  'active',
  'show',
  'search',
  // Builder scratch, read-only (src/builder/scratch-view.ts).
  'scratchList',
  // The injected-context answer for a memory surface (src/memory/context-status.ts).
  'memoryStatus',
  'scratchShow',
  'scratchSearch',
  'scratchMentions',
  'navCounts',
  'diff',
  'fileLines',
  'regions',
  // Discovery for the session attach route: resolves which session and where
  // to upgrade, and checks the container is up. Writes nothing.
  'attachSession',
  // Normalizes a walkthrough and resolves its directory/glob items against the
  // task's own diff range. Reads the task and the range and answers; nothing is
  // stored, so there is no row for a person to be on.
  'expandPresentation',
  'wait',
  'awaitClaimedTurn',
  'watchProxyActivity',
  'servePorts',
  'serve.getStartServicesCmd',
  'taskProgress',
  'taskStats',
  'submitTaskPreflight',
  'getTaskUpstreamStatus',
  'listReparentTargets',
  'taskEnv',
  'describeLinkedTask',
  'getProjectSettings',
  'listUserCredentials',
  'checkUserCredential',
  'getAuthEnv',
  'getCredentialState',
  'reviewQueue',
  'reviewDiff',
  'reviewPresentations',
  'reviewProseAnchors',
  'reviewVerify',
  'reviewRegions',
  'reviewLineAttribution',
  'reviewFileLines',
  'reviewComments',
  'reviewGetDraft',
  'identity',
  // Latest proxy usage-limit reading per credential — an in-memory read.
  'usageLimits',
  // Doctor is the surface that EXPLAINS an unconfigured identity (the
  // single-warning-surface rule), so it must run while unconfigured — remedies
  // included, since a remedy repairs the environment and writes no attributed
  // row.
  'doctor.run',
  'doctor.report',
  // `lazy daemon health`: reports the daemon's loops, sweeps, proxy, store,
  // runner and tasks and changes none of them — like doctor, it has to answer
  // precisely when something (identity included) is wrong.
  'daemonHealth',
  'doctor.previewRemedy',
  'doctor.applyRemedy',
  // `lazy system repair-commits`: recomputes a task's recorded commit list and
  // removes/adds commit rows. Like a doctor remedy it repairs bookkeeping and
  // writes no row that carries a person (commit rows have no actor column),
  // so the identity gate must not refuse it.
  'repairCommits',

  // --- Environment-only writes: not rows, and needed while unconfigured ---

  // A daemon-wide limit held in the daemon's own memory/state, not a task row.
  // Refusing it on a fresh machine would mean somebody could not turn
  // concurrency down while fixing whatever made them want to.
  'concurrency',
  // The one-shot [usage_pause] override and the pause state: daemon memory plus
  // a read of the proxy's readings, no task row. Same reasoning as concurrency.
  'usagePause',
  // Credentials the operator hands the daemon, keyed by the identity they
  // belong to and attributed to nobody. `mintActorToken` with `kind: 'control'`
  // is a legitimate unmanaged operation — it is how a second client on this
  // machine is given access — and the `kind: 'user'` half refuses on its own
  // terms outside managed mode, in the handler, with a reason of its own.
  'mintActorToken',
  'revokeActorToken',
  'putUserCredential',
  'revokeUserCredential',
]);

/**
 * Commands that write the store, or launch a turn that will.
 *
 * Listed rather than derived so the enumeration test can see them: the runtime
 * treats "not a read" as a write already, and this set exists to make the
 * classification a decision somebody made rather than a default nobody noticed.
 *
 * A few entries are here for reasons worth stating:
 *   - `acceptTaskPreflight` is not read-only: `--approve-file` records
 *     approvals and reverts protected files (see src/cli/commands/accept.ts).
 *   - `ensureTaskContainer`, `getDaemonMcpConfig`, `builderSlot` and
 *     `mintDashboardTicket` write no row themselves — they are the second half
 *     of the rule: each exists only to put an agent or a session in front of
 *     the store, and a turn nobody can be attributed to should not start in the
 *     first place, because the rows it writes arrive after the caller is gone.
 */
export const STORE_WRITING_RPC_COMMANDS: ReadonlySet<string> = new Set([
  'regionOverlay',
  'startTask',
  'editTask',
  'unblockTask',
  'askTask',
  'reviewTask',
  'acceptTaskPreflight',
  'acceptTask',
  'rejectTask',
  'closeTask',
  'stopTask',
  'reopenTask',
  // Rewrites a comment the agent has not seen, and stamps its editor.
  'editComment',
  'ensureTaskContainer',
  'serve.setStartServicesCmd',
  'serve.clearStartServicesCmd',
  'submitTask',
  'createTask',
  'cloneTask',
  'redoTask',
  'resumeTask',
  'syncTask',
  'syncTaskFromRemote',
  'reparentTask',
  'linkTask',
  'setProjectSettings',
  'builderSlot',
  'getDaemonMcpConfig',
  'revokeDaemonMcpToken',
  'mintDashboardTicket',
  // A builder session is registered under the ATTACHING MEMBER's own email
  // (§5.5 of the design) — unlike ensureTaskContainer/builderSlot/
  // getDaemonMcpConfig above, whose rows name nobody, this row's memberEmail
  // really is the person who asked, so attributing it to them is not a lie.
  'startBuilderSession',
  'stopBuilderSession',
  'endBuilderSession',
  'reviewPostComment',
  'reviewAsk',
  'reviewRetryAsk',
  'reviewPromoteDiscussion',
  'conversationPromote',
  'reviewWithdrawComment',
  'reviewUnblock',
  'reviewAccept',
  'reviewSync',
  'reviewViolationDecision',
  'reviewResolveRaised',
  'reviewUnresolveRaised',
  'reviewFlagRaised',
  'reviewPromoteRaised',
  'reviewSaveDraft',
  'runOneshot',
  'saveMemoryRecord',
  'deleteMemoryRecord',
  'compactMemory',
  'clearMemoryCompact',
  'storage',
]);

/**
 * Mutating commands A HUMAN INITIATES — the ones that, on a managed host, must
 * go out on that human's own token.
 *
 * WHY THIS SET EXISTS. On a shared host nothing about the environment names a
 * person, so identity rides the caller's token. A control token names the
 * CONTROL PLANE, not anybody in particular — and until now it could name any
 * actor on any verb, which is how five verbs came to be attributed and the rest
 * not. In managed mode a control token presenting one of these is refused with
 * a 403 naming the remedy (mint a user token for the acting member), because
 * the alternative is a store full of rows that say a machine did it.
 * Unmanaged, this set is inert: there is no control plane, identity is the
 * daemon's own git config, and a control caller IS the machine's owner.
 *
 * IT LIVES HERE, IN THE DAEMON, and not in the control plane, for the reason
 * the design gives (docs/design/actor-identity-and-remote-clients.md §3.6): a
 * verb added later is invisible to an enforcement list kept in Rails. It sits
 * beside `TURN_LAUNCHING_COMMANDS` (src/daemon/rpc-handlers.ts) in purpose —
 * both answer "what kind of act is this command" — and in this module because
 * this is where a command's classification is enforced rather than assumed.
 *
 * WHAT IS IN IT: every mutating command a person reaches for. Task lifecycle
 * (start, edit, unblock, ask, review, accept, reject, close, stop, reopen,
 * submit, clone, redo, resume, sync, reparent, link), the review surface a
 * person drives from a browser, a region sign-off, and the shared-memory
 * writes somebody curates.
 *
 * {@link CONTROL_PLANE_RPC_COMMANDS} holds the rest, with a reason each, and
 * `test/unit/rpc-command-kinds.test.ts` fails when a mutating command is in
 * neither — so the next verb added has to say which it is.
 */
export const HUMAN_INITIATED_RPC_COMMANDS: ReadonlySet<string> = new Set([
  'startTask',
  'editTask',
  'unblockTask',
  'askTask',
  'reviewTask',
  'acceptTaskPreflight',
  'acceptTask',
  'rejectTask',
  'closeTask',
  'stopTask',
  'reopenTask',
  'editComment',
  'submitTask',
  'createTask',
  'cloneTask',
  'redoTask',
  'resumeTask',
  'syncTask',
  'syncTaskFromRemote',
  'reparentTask',
  'linkTask',
  // A builder session names the attaching member — see the comment beside
  // these in STORE_WRITING_RPC_COMMANDS above.
  'startBuilderSession',
  'stopBuilderSession',
  'endBuilderSession',
  // A region's owner and sign-off: an approval, and the row a reviewer most
  // needs a name on.
  'regionOverlay',
  // The review surface. Every one of these is a person in a browser pressing
  // something — posting a comment, asking the agent, resolving a raised item,
  // typing into a draft.
  'reviewPostComment',
  'reviewAsk',
  'reviewRetryAsk',
  'reviewPromoteDiscussion',
  'conversationPromote',
  'reviewWithdrawComment',
  'reviewUnblock',
  'reviewAccept',
  'reviewSync',
  'reviewViolationDecision',
  'reviewResolveRaised',
  'reviewUnresolveRaised',
  'reviewFlagRaised',
  'reviewPromoteRaised',
  'reviewSaveDraft',
  // Shared memory is curated by people, and its history is actor-attributed.
  'saveMemoryRecord',
  'deleteMemoryRecord',
  'compactMemory',
  'clearMemoryCompact',
  // `storage` is method-dependent — see isHumanInitiatedRpc. Listed so the
  // enumeration test sees it classified rather than defaulted.
  'storage',
]);

/**
 * Mutating commands that legitimately stay CONTROL-ONLY, each with why no row
 * of it names a person (docs/design/actor-identity-and-remote-clients.md §3.6).
 *
 * The test above this one is "would attributing this to a member be a lie?".
 * Minting somebody a credential is not that person acting; pushing a secret the
 * control plane holds is not either; operating a project or a container is the
 * operator acting on infrastructure, which the control plane audits as its own
 * admin action.
 */
export const CONTROL_PLANE_RPC_COMMANDS: ReadonlySet<string> = new Set([
  // Session and container plumbing: each exists to put an agent or a session in
  // front of the store, on the control plane's own behalf. WHO the resulting
  // turn belongs to is the turn owner, recorded from the token that asked for
  // the turn (src/daemon/turn-credentials.ts), not from these.
  'ensureTaskContainer',
  'getDaemonMcpConfig',
  'builderSlot',
  'revokeDaemonMcpToken',
  'mintDashboardTicket',
  // Operator configuration of a project, not an act on a task.
  'setProjectSettings',
  'serve.setStartServicesCmd',
  'serve.clearStartServicesCmd',
  // A throwaway container the control plane runs; writes no task row.
  'runOneshot',
  // --- The environment-only writes, which are also in READ_ONLY_RPC_COMMANDS
  // because the identity gate must not refuse them. Named here too so the
  // partition is complete and a reader does not have to infer it. ---
  'concurrency',
  'usagePause',
  'mintActorToken',
  'revokeActorToken',
  'putUserCredential',
  'revokeUserCredential',
]);

/**
 * Is this call one a human initiates — so that in managed mode it may not ride
 * the control token?
 *
 * `storage` is the one command whose answer depends on its arguments, exactly
 * as in {@link isStoreWritingRpc} — and it answers with the SAME question:
 * every WRITE through the proxy is somebody's act, whether or not the row it
 * writes has a person column.
 *
 * Deliberately not "only the methods that can carry a person". The proxy is the
 * widest mutating surface there is, and `lazy edit` does its whole job through
 * writers that carry no actor at all (`updateTaskModel`, `updateTaskGoal`,
 * `updateTaskPrompt`, `updateTaskTarget`). Gating on person-carrying methods
 * alone would refuse `editTask` while leaving the identical change one
 * `storage` call away — an enforcement with a hole exactly where the verb it
 * guards lives.
 *
 * The runtime default is the PERMISSIVE one here, and deliberately the opposite
 * of the identity gate's: an unclassified command is not refused. A gate that
 * refused by default would turn every new control-plane RPC into a production
 * outage on a fleet host, and the enumeration test is what keeps the set
 * honest instead — a missing classification fails a test, not a member's
 * request.
 */
export function isHumanInitiatedRpc(command: string, params: Record<string, unknown>): boolean {
  if (command === 'storage') {
    const method = params.method;
    // A malformed call with no method is not a human action — the handler's own
    // 400 is the better error, and the write gate already refuses it.
    if (typeof method !== 'string') return false;
    if (TELEMETRY_STORAGE_METHODS.has(method)) return false;
    return !READ_ONLY_STORAGE_METHODS.has(method);
  }
  return HUMAN_INITIATED_RPC_COMMANDS.has(command);
}

/**
 * Storage-proxy methods that only READ.
 *
 * An allowlist, not a partition, and for a different reason than above: the
 * `storage` command's method table is enumerable at runtime, so a rename cannot
 * hide here — `test/unit/rpc-command-kinds.test.ts` fails on a name this set
 * has and `STORAGE_METHODS` does not. Anything absent is treated as a write,
 * which is the failure that costs the least: a mis-refused read is visible
 * immediately, a silently unattributed write is not.
 */
export const READ_ONLY_STORAGE_METHODS: ReadonlySet<string> = new Set([
  'getStoragePath',
  'getTaskDir',
  'getTask',
  'resolveTask',
  'listTasks',
  'listTasksWithOptions',
  'listTaskCodes',
  'countDescendants',
  'getTaskMetadata',
  'getPromptHistory',
  'getPromptVersion',
  'getSession',
  'getSessionByTaskId',
  'listSessions',
  'getSessionTurns',
  'getNextTurnSequence',
  'getTurnCountByTaskId',
  'getSessionCommits',
  'getCommitReviews',
  'getLatestWorktreeSnapshot',
  'getWorktreeSnapshotForTurn',
  'getChildTasks',
  'getRootTask',
  'getTaskAncestry',
  'getTaskTree',
  'getTaskComments',
  'getTaskJournal',
  'getTaskFollowUps',
  'listFollowUps',
  'getTaskRaisedItems',
  'listRaisedItems',
  'getTaskTurnReports',
  'getTurnReportBySession',
  'getTaskFileDecisions',
  'listTaskArtifacts',
  'getTaskArtifact',
  'getRegionCover',
  'getRegionOverlays',
  'listHunkApprovals',
  'getTaskReviewComments',
  'getReviewSessionByTaskId',
  'listReviewSessionMessages',
  'loadConversation',
  'listConversations',
  'listConversationSummaries',
  'isConversationImported',
  'getAgentSessionLog',
  'getProjectSettings',
  'listBuilderResumeIntents',
  'getBuilderSession',
  'getActiveBuilderSessionForMember',
  'listBuilderSessions',
  'getTagHistory',
  'getScratchFile',
  'listScratchFiles',
  'getMemory',
  'listMemories',
  'getMemoryHistory',
  'getMemoryCompact',
  'listSystemMessages',
  'getSystemMessage',
  'getStatusHistory',
  'getToolStats',
  'search',
  'readTraceSpans',
  'readWaitIntervals',
]);

/**
 * Storage-proxy methods that are pure TELEMETRY: writes with no person column
 * and no effect on any domain decision.
 *
 * These are exempt from the managed-mode human-action gate: the gate exists so
 * a mutating act on a managed host is recorded against the member who took it,
 * and there is nothing here a member took. Each of these rows is emitted by
 * whatever process happens to be running — a CLI persisting its own trace
 * spans on the way out, the daemon's wait registry, the proxy tallying tool
 * calls — not reached for by a person, and none of them carries an `actor` the
 * row would name. Attributing one to the caller would be a LIE (test part a);
 * refusing it on the control token would close no hole, because there is no
 * `lazy edit`-shaped domain change one storage call away from a trace span
 * (test part b).
 *
 * An allowlist, like {@link READ_ONLY_STORAGE_METHODS}, for the same reason:
 * `test/unit/rpc-command-kinds.test.ts` fails on a name this set has and
 * `STORAGE_METHODS` does not, so a rename or removal is caught at test time
 * rather than leaving a stale name silently exempting nothing — or silently
 * exempting a method that has since grown a person column.
 */
export const TELEMETRY_STORAGE_METHODS: ReadonlySet<string> = new Set([
  // Trace spans and wait intervals are emitted by whichever process is running,
  // read back only for latency/usage analysis.
  'appendTraceSpans',
  'recordWaitStart',
  'recordWaitEnd',
  // Per-task tool stats: the proxy writes them as requests flow through it,
  // daemon-side, for the task-stats surfaces. Analytics, not domain state.
  'saveToolStats',
]);

/**
 * Storage-proxy methods whose actor is an `ActorInput` — the writers that can
 * carry a PERSON as well as a role — and WHERE each one carries it.
 *
 * WHY AN ALLOWLIST AND NOT "every writer": most of Storage takes a bare `Actor`
 * role (`createTaskArtifact`, `saveScratchFile`,
 * `dismissSystemMessage`, `promoteConversation` …) and the rows they write have
 * no person columns at all. Handing one of those an `{ role, email }` object
 * does not attribute it — the object lands in the row's `actor` field verbatim,
 * which is a corrupt record that renders as an object where a role should be.
 * Silence is the failure here, so the default is to leave the role alone.
 *
 * WHY A PATH AND NOT A FLAT NAME: the proxy's argument shapes are not uniform.
 * `createTurn` and `promoteRaisedItem` carry their actor inside an `options`
 * bag, `resolveRaisedItem` inside `resolution`, and the legacy `triageFollowUp`
 * inside `triage`. The first version of this walked three fixed containers and
 * therefore neither stamped NOR rejected the deeper ones — so a request could
 * name `resolved_by_email` itself, which is the one thing this whole change
 * exists to make impossible. The locations are declared here, once, and both
 * halves read them from here.
 *
 * (The rejection half does NOT rely on this table being complete — it walks the
 * request for any `actor` naming a person, wherever it sits. This table decides
 * only where the daemon's own identity is STAMPED.)
 */
export const PERSON_ATTRIBUTED_STORAGE_ACTORS: ReadonlyMap<string, readonly string[]> = new Map([
  ['createTask', ['actor']],
  ['updateTaskStatus', ['actor']],
  ['abandonTask', ['actor']],
  ['reopenTask', ['actor']],
  ['createComment', ['actor']],
  // The editor of a comment's content, stamped as edited_by_email / _name.
  ['updateComment', ['actor']],
  // A journal entry is the durable record of WHY something was decided, and on
  // a task several people touch, "who wrote this" is half of what makes it
  // readable. It is also where a task EDIT is attributed (src/daemon/edit-task.ts):
  // the Task record itself carries no actor, so the change to a task's model,
  // effort or goal is recorded as an entry naming whoever made it.
  ['appendJournalEntry', ['actor']],
  // A REPLY on a raised item. The item is what gates an accept, so its
  // conversation is the human-written record a reviewer reads right beside the
  // attributed resolution — and it named nobody on either surface until this
  // entry existed: a managed host's user token had nowhere to pin, and the
  // daemon's own stamping path (which reads this same map) left a laptop's
  // reply unattributed too.
  ['addRaisedItemComment', ['actor']],
  ['unresolveRaisedItem', ['actor']],
  ['setRaisedItemBlocking', ['actor']],
  ['addTaskTag', ['actor']],
  ['removeTaskTag', ['actor']],
  ['createTurn', ['options', 'actor']],
  ['promoteRaisedItem', ['options', 'actor']],
  // A raised-item DECISION: the one that gates an accept, and the one a
  // reviewer most needs a name on. Its `resolution` bag reaches
  // `FileStorage.resolveRaisedItem`, which writes `resolved_by_email` /
  // `resolved_by_name` from it.
  ['resolveRaisedItem', ['resolution', 'actor']],
  // The two DEPRECATED follow-up adapters (kept for Lazy Teams until it is
  // ported to raised items). Neither is declared on the Storage interface —
  // each is an adapter in the proxy table that forwards to `resolveRaisedItem`
  // / `promoteRaisedItem` above, which is where the ActorInput really lives.
  ['triageFollowUp', ['triage', 'actor']],
  ['promoteFollowUp', ['options', 'actor']],
  // Shared memory is curated by people and injected into every future prompt,
  // so its append-only history is exactly where "who wrote this" matters. The
  // record carries `created_by_email` / `updated_by_email` / `deleted_by_email`
  // and each history event `actor_email`, and the compact `generated_by_email`
  // (src/storage/file-storage.ts). The daemon's own memory COMMANDS
  // (`saveMemoryRecord` & co.) are attributed through their top-level `actor`.
  ['saveMemory', ['actor']],
  ['deleteMemory', ['actor']],
  ['saveMemoryCompact', ['actor']],
]);

/** The method names of {@link PERSON_ATTRIBUTED_STORAGE_ACTORS}. */
export const PERSON_ATTRIBUTED_STORAGE_METHODS: ReadonlySet<string> =
  new Set(PERSON_ATTRIBUTED_STORAGE_ACTORS.keys());

/**
 * Does this RPC call write the store?
 *
 * `storage` is the one command whose answer depends on its parameters — it is
 * a proxy for the whole Storage interface — so the method name decides. A
 * malformed `storage` call with no method is treated as a write and refused
 * here; the handler's own 400 is the better error, but only for a caller that
 * is allowed to reach it.
 */
export function isStoreWritingRpc(command: string, params: Record<string, unknown>): boolean {
  if (command === 'storage') {
    const method = params.method;
    return typeof method !== 'string' || !READ_ONLY_STORAGE_METHODS.has(method);
  }
  return !READ_ONLY_RPC_COMMANDS.has(command);
}
