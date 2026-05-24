# Event Data Plane for Agent/Supervisor Signaling

**Spike:** `spike-event-plane`
**Date:** 2026-02-28
**Status:** Proposed

## Problem

Agents work in isolation. When something happens that's relevant to another agent, nothing happens until a human notices and manually intervenes. The only signal a supervisor responds to today is the turn command (human feedback). This makes humans the bottleneck relay for all inter-agent coordination.

Examples of signals that should flow automatically:

- A daemon fetches new remote comments on a PR — the agent should hear about it immediately, not wait for a human to copy-paste
- An agent spawns subtasks — when the subtask finishes, the parent agent should get a signal that work is ready for review/integration
- When a subtask's work gets merged, we currently just kill the container — but the agent might have learned something worth preserving (a "testament" signal)
- Upstream branch gets new commits — agent should auto-sync instead of waiting for human to trigger it

### Key insight from codebase analysis

Most "events" in this system are already **detectable** by the host. `task.completed` is detected by reconciliation. `upstream.updated` is detected by git. `task.accepted` is triggered by `lazy accept`. What's missing isn't event detection — it's **automated routing and delivery**. The human/builder currently serves as the manual event router.

## Current State

The system is entirely poll-based and file-driven:

- The supervisor protocol uses `command.json`/`response.json` in `~/.lazy/protocol/<task-id>/`
- The reconciliation loop polls for responses
- The builder server (`src/builder/server.ts`) uses TCP HTTP for MCP tool proxying
- There is no event system — all coordination flows through human-initiated `lazy unblock` commands

## Event Model

Events are structured, durable, routable records:

```typescript
Event {
  id: string                    // UUID
  type: EventType               // discriminated union
  source_task_id: string        // task that generated the event
  target_task_id: string        // task that should receive it
  payload: Record<string, any>  // event-type-specific data
  created_at: number            // when emitted
  delivered_at: number | null   // when included in a prompt
  consumed_at: number | null    // when the agent acknowledged it
}

EventType =
  | 'task.completed'     // subtask finished work (flows up)
  | 'task.accepted'      // subtask's work was merged (flows up)
  | 'task.failed'        // subtask errored/crashed (flows up)
  | 'upstream.updated'   // parent branch has new commits (flows down)
  | 'comment.added'      // new comment on a task (flows to task)
  | 'testament'          // agent's final learnings before destruction (flows up)
```

## Routing Rules: Tree Topology

Signals flow UP and DOWN the task tree — not peer-to-peer. This matches organizational hierarchy and keeps complexity manageable.

### Upward (child -> parent)

| Event | Target | Trigger |
|---|---|---|
| `task.completed` | `parent_task_id` | Reconciliation detects completed response |
| `task.accepted` | `parent_task_id` | `lazy accept` merges child branch |
| `task.failed` | `parent_task_id` | Agent errors out or crashes |
| `testament` | `parent_task_id` | Agent writes final learnings before destruction |

### Downward (parent -> children)

| Event | Target | Trigger |
|---|---|---|
| `upstream.updated` | Each active child task | Parent branch changes (sibling accepted, human commits) |

### Lateral (to self)

| Event | Target | Trigger |
|---|---|---|
| `comment.added` | Task itself | New comment added (remote PR comment, human note) |

Root tasks (no parent) emit upward events into the void — they're stored but have no target. The builder can still see them via `lazy events`.

### Why tree, not mesh

Cross-agent peer-to-peer talk is how organizations fail: too many actors talking to too many other actors. A tree keeps the complexity manageable:

- All signals go through the parent/supervisor
- The parent decides what to propagate down
- This matches organizational hierarchy

**Future peer signaling**: The event schema uses a general `target_task_id` rather than restricting to `parent_task_id`. This means peer-to-peer routing can be added later without a schema migration. The routing logic just needs to learn new rules.

## Transport Options

### Option A: File-based event queue (RECOMMENDED for Phase 1-2)

Events stored in Storage (following the abstraction). Delivered by inclusion in the next turn's prompt. For between-turn delivery, specific event types trigger auto-unblock.

```
Emit: storage.emitEvent(type, sourceId, targetId, payload)
       -> writes event to FileStorage

Deliver (between turns):
  reconcileTasks() detects task -> blocked with pending events
  -> for upstream.updated: auto-trigger unblock+sync
  -> for others: queue until next human-triggered unblock

Deliver (during unblock):
  launchFeedbackTurn() queries unconsumed events
  -> appends to prompt as structured context section
  -> marks events as delivered

Consume:
  handleCompletedResponse() marks delivered events as consumed
```

**Pros:** Simple, consistent with existing patterns, works with Docker Desktop, durable (events survive crashes), no new transport mechanism.

**Cons:** Polling latency (up to 5s for reconciliation sweep), events only delivered at turn boundaries.

### Option B: TCP notification channel

Each supervisor connects to a host-side HTTP server. Events delivered via SSE (Server-Sent Events) or long-poll.

```
Host starts EventServer on 127.0.0.1:<random-port>
Supervisor connects: GET /events/stream?task_id=<id>&since=<seq>
  -> SSE stream of events
  -> Supervisor interrupts current work or queues for next turn

Events still stored in Storage (durable)
TCP is just a notification channel (low-latency push)
```

**Pros:** Sub-second delivery, supports real-time interruption, proven pattern (builder server).

**Cons:** More complex, requires Docker networking (`host.docker.internal`), one more port per project, SSE handling in supervisor.

### Option C: Extend command protocol with event sidecar

Add `events.json` alongside `command.json` in the protocol directory. Supervisor polls for events during its command poll loop.

```
Host writes events to ~/.lazy/protocol/<task-id>/events.json
Supervisor polls alongside waitForCommand()
Events accumulated, delivered when supervisor next wakes up
```

**Pros:** Zero new infrastructure, works with existing Docker mounts.

**Cons:** Only works when supervisor is running (not between turns), adds polling overhead, doesn't help with sleeping agents.

### Recommendation

Start with **Option A**. It handles the 90% case (events between turns) with zero new infrastructure. Add Option B later if real-time mid-turn delivery becomes important.

## Delivery Policies

The design supports a spectrum of automation:

### Level 0 — Passive (visibility only)

Events are stored and visible via `lazy events <task>` and `lazy show <task>`. The human/builder decides what to do. This is the MVP.

### Level 1 — Context injection (soft delivery)

Unconsumed events are automatically included in the next unblock prompt. The agent sees them as structured context but doesn't get auto-woken.

### Level 2 — Deterministic auto-delivery (recommended default)

Specific event types trigger automatic actions:

- `upstream.updated` on a blocked task with a session -> auto-unblock with sync
- `task.failed` on a blocked parent -> auto-unblock with error context (so parent can decide what to do)

### Level 3 — Full automation (opt-in)

All events auto-deliver. `task.completed` auto-unblocks parent. Parent agent becomes fully autonomous coordinator. Dangerous for cost (many unnecessary turns) but powerful for speed.

### Recommendation

Ship Level 0+1 in Phase 1, add Level 2 in Phase 2, make Level 3 opt-in via config.

## The Rust/Ruby Integration Example

Parent task: "Build full-stack feature"
- Child A: "Implement Rust backend API"
- Child B: "Implement Ruby frontend"

**Flow with the proposed system:**

1. Both children started. Each gets a branch off the parent's branch.
2. Child A completes its turn -> reconciliation detects `response.json`
3. Reconciliation emits `task.completed` event -> `{ source: childA, target: parent, payload: { result: "Implemented REST API with /users and /products endpoints" } }`
4. Event stored in parent's event queue
5. **Level 1**: Next time parent is unblocked, event is in the prompt: "PENDING EVENTS: Your subtask 'Implement Rust backend API' completed."
6. **Level 2**: Parent auto-unblocked with event context. Parent reviews, accepts Child A.
7. `lazy accept childA` merges Child A's branch into parent's branch.
8. Accept emits `upstream.updated` -> `{ source: parent, target: childB, payload: { commits: [...], summary: "Merged Rust API implementation" } }`
9. `upstream.updated` auto-triggers unblock+sync for Child B (Level 2).
10. Child B wakes up, merges upstream (gets the Rust API code), adapts its frontend.

**The parent's role**: The parent agent decides *when* to accept and what to tell siblings. It's the coordinator, not a passive relay. This matches organizational hierarchy.

**What if the parent is sleeping?** Events queue. When the human unblocks the parent for any reason, all pending events are in the context. The parent can batch-process them.

## Testament Mechanism

When a task is accepted:

1. Accept command writes a `testament` command to the supervisor protocol
2. Supervisor runs Claude with `testament.md` prompt: "Your work has been accepted. Write a structured summary of what you learned."
3. Agent responds within 60s timeout with: `{ patterns: [...], gotchas: [...], insights: [...] }`
4. Supervisor writes testament response
5. Host stores testament as event targeting parent task
6. Container destroyed

### Design decisions

- **Best-effort**: If testament fails or times out, accept still proceeds
- **Structured content**: Not free-form, for machine consumption
- **Parent receives as event**: Can curate and propagate to siblings
- **Actionable learnings**: Prompt asks for actionable learnings, not narrative

### Composition at scale

Each level curates. A grandchild's testament goes to the child, which may summarize and include relevant parts in its own testament. Information naturally compresses as it flows up. At the top, the human sees a curated summary of what the whole tree learned.

## Agent Subscriptions: Deferred but Designed For

The current tree-based routing is deterministic: parent/child relationships determine who gets what. Subscriptions would allow agents to express interest in events from arbitrary tasks:

```typescript
// Hypothetical API -- NOT for Phase 1
storage.subscribe(taskId, { types: ['task.completed'], sourcePattern: 'code:rust-*' })
```

### Tradeoffs

- **Pro**: Ruby agent could subscribe to "any Rust API change" across the project
- **Con**: Information overload, coupling, hard to reason about
- **Con**: Subscription management adds complexity (who can subscribe to what? rate limits?)

### Recommendation

Don't implement subscriptions. The tree + builder combination covers the use cases. If the Ruby agent needs to know about Rust changes, the parent routes that information. If cross-tree signaling becomes necessary, add it as a targeted feature (explicit event forwarding) rather than a general subscription system.

## Phased Implementation Plan

### Phase 1: Event storage and visibility (1-2 tasks)

- Add Event entity to Storage interface + FileStorage implementation
- Add event emission hooks in `accept.ts`, `reconcile.ts`
- Add `lazy events <task>` CLI command
- Add events section to `lazy show <task>` output
- Include unconsumed events in unblock prompt context (Level 1 delivery)

### Phase 2: Deterministic auto-delivery (1-2 tasks)

- `upstream.updated` auto-triggers unblock+sync for blocked children
- `task.failed` auto-notifies parent
- Add `lazy_events` MCP tool for builder visibility
- Add event context formatting in prompts

### Phase 3: Testament and memory (1-2 tasks)

- Add testament command to supervisor protocol
- Testament prompt and structured response format
- Testament -> event -> parent context pipeline
- Memory trickle-up integration

### Phase 4: Evaluation and refinement (after real-world use)

- Evaluate whether auto-delivery policies are right
- Consider TCP notification channel if latency matters
- Consider Level 3 full automation as opt-in
- Evaluate whether subscriptions are needed

## Open Questions

### Mid-turn delivery

If an agent is running and an event arrives, it won't know until its turn completes. Option B (TCP) or an MCP polling tool could address this, but it's not needed for Phase 1.

### Event deduplication

If the same upstream change triggers multiple `upstream.updated` events (e.g., from multiple accepted siblings), the child gets multiple sync signals. Idempotent sync handles this, but it's wasteful.

### Event ordering

Events have `created_at` timestamps but no sequence numbers within a target. For most events this doesn't matter (each is independent), but for testament + accepted combinations, ordering could matter.

### Cost control

Auto-delivery (Level 2+) triggers agent turns automatically, which costs money. There should be a daily/hourly budget cap, but that's a separate concern.

### Auto-delivery policy for `task.completed`

Should `task.completed` auto-unblock the parent? Pro: faster iteration. Con: the parent might be in the middle of something, and auto-unblocking disrupts its flow (especially if it has multiple subtasks).

### Testament timing

The testament captures what the agent learned. Running before merge means the agent still has full context but the accept flow has to wait (up to 60s). Running after merge means context is gone. Is a 60-second delay on accept acceptable? Alternative: run testament asynchronously and don't block accept — but then the parent might not get the testament in time.

### Schema flexibility for peer signaling

Should the schema explicitly restrict to tree routing (`parent_task_id` instead of `target_task_id`), or keep the general `target_task_id` to support future peer signaling? Recommendation: keep `target_task_id` — same storage cost, enables future peer signaling without schema migration.
