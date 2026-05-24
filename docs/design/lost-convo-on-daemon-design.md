● Now I have the full picture. Here are my findings and recommendations:

  ---
  v0.11 Daemon Release — Analysis & Recommendations

  What's already built

  The daemon foundation is solid:
  - Skeleton: PID file, unix socket, auth token, auto-start, lifecycle management
  - CLI pass-through: Read-only commands route through daemon with direct-mode fallback
  - Reconcile loop: Daemon tracks projects, reconciles every 5s
  - Project routing: Multi-project support via X-Lazy-Project header

  The builder-in-runner pattern (src/builder/server.ts + src/builder/client.ts) is the exact template for daemon MCP proxy — it already does HTTP-over-TCP MCP tool proxying with bearer auth. 50 lines of client, 137 lines of server. Clean and
  proven.

  On your question: daemon-push-branches after daemon-web-dashboard

  Yes, it can. daemon-push-branches needs the daemon to be the place where state changes happen — which is already true after CLI pass-through. It doesn't technically need the web dashboard. But the web dashboard brings the sync loop into the
  daemon, which is a natural companion. The two are independent — push-branches watches state changes (accept, turn completion), while the web dashboard adds background sync + web UI. Either can go first.

  However, push-branches has a subtle dependency: right now CLI write commands (start, accept, unblock) still run direct — they don't go through the daemon. So the daemon doesn't "see" these state changes happening. For push-branches to work,
  either:
  1. Write commands also route through daemon (a bigger change), or
  2. The daemon's reconcile loop detects branches that are ahead of remote and pushes them (simpler, polling-based)

  Option 2 is pragmatic and works now. Option 1 is the right long-term answer and comes naturally with daemon MCP proxy.

  Ideas and gaps I noticed

  1. Daemon MCP proxy should consolidate the builder server

  The builder server (src/builder/server.ts) is a separate TCP server per builder session. Once the daemon has /mcp/* routes, the builder should use those too — not spin up its own server. This eliminates a whole server lifecycle, port
  management, and config file dance. The daemon is already running; the builder just needs to know the socket path and token.

  Recommendation: Add a note to daemon-mcp-proxy that it should subsume the builder server pattern, not just copy it.

  2. Task-scoped MCP tools

  The daemon MCP proxy needs to scope tool execution per task. Today's MCP tools have a McpToolContext with taskId and worktreePath. When the daemon serves MCP for multiple agents simultaneously, each request must carry the task ID and the
  daemon must enforce that the agent can only access its own worktree. The builder server doesn't have this problem (it's one server per builder session) but the daemon does.

  The daemon already has project-level scoping via X-Lazy-Project. Task-level scoping adds X-Lazy-Task (or it's part of the URL path like /mcp/:taskId/:toolName). The RPC handler opens storage once, validates the task exists and belongs to the
  project, and creates a McpToolContext scoped to that task's worktree.

  3. Custom daemon-only MCP tools

  This is where your Dockerfile.lazy idea gets really interesting. Once the daemon is the MCP server, you can add tools that ONLY make sense on the host:

  - mcp_docker_build — build a Dockerfile, return logs
  - mcp_run_tests — run the project's test suite on the host
  - mcp_check_ci — query CI status for the current branch
  - mcp_git_log — richer git history than what's available in the container

  These don't exist today because the MCP server runs inside the container. The daemon unlocks a whole new category of tools. Worth creating a task to catalog and prioritize these.

  4. Event plane: the spike is ready but has open questions you should decide

  The spike has 4 explicit questions for you that haven't been answered:

  1. Transport: File-based (Option A) vs TCP notification (Option B). Spike recommends file-based for Phase 1. But with the daemon already running, Option B is nearly free — the daemon can hold SSE connections to supervisors. Worth
  reconsidering.
  2. Auto-delivery policy: Should task.completed auto-unblock the parent? Spike says no (context injection only). Your vision says yes ("self-advancing"). This is a cost vs speed tradeoff.
  3. target_task_id vs parent_task_id: Keep general for future peer signaling? Spike recommends yes.
  4. Testament timing: 60s delay on accept acceptable? Spike asks but doesn't decide.

  My take: with the daemon, Option B (TCP/SSE) is the right choice from the start. The daemon already has an HTTP server — adding an SSE /events endpoint is minimal work. File-based events are a step backward from the daemon architecture. Events
   should flow through the daemon, not through files the daemon has to poll.

  5. The "Phase 4: Replace file-based protocol" question

  The spike designs a Phase 4 where the supervisor calls the daemon over HTTP instead of using the file-based protocol. This is actually MORE important than it sounds — it's what makes mid-turn events possible. Today:

  Supervisor writes response.json → host polls for it → reconcile detects it

  With daemon HTTP:
  Supervisor POSTs to daemon → daemon processes immediately → can push events to other tasks

  This eliminates the 5s reconcile polling latency for ALL state transitions, not just events. It makes the system genuinely real-time. And it's architecturally clean — the supervisor becomes a thin HTTP client, the daemon owns all state.

  I'd argue this should come RIGHT AFTER daemon MCP proxy, not as a separate later phase. They use the same transport (HTTP to daemon), same auth (bearer token), same container networking. Building one without the other means the supervisor
  talks to the daemon for MCP but uses files for protocol — that's two communication channels for one process.

  6. Missing task: daemon SSE endpoint for real-time UI

  The web dashboard currently polls. With the daemon, it should get real-time updates via SSE. This is also what lazy watch (if we ever build it) would use. And it's the same transport the supervisor uses for event delivery. One SSE
  infrastructure, three consumers (web dashboard, CLI watch, supervisor events).

  7. Cost control for auto-reactions

  Both daemon-auto-react and add-event-auto-deliver trigger agent turns automatically. Each turn costs money. The system needs a budget mechanism:

  - Per-task auto-unblock limit (already in daemon-auto-react as auto_react_max_retries)
  - Global daily/hourly budget cap across all projects
  - Exponential backoff on repeated CI failures (flaky pipeline protection)
  - A way to see how much auto-triggered work cost vs human-triggered work (ties into add-model-stats-tool!)

  Suggested additional tasks

  ┌──────────────────────────────┬─────────────────────────────────────────────────────────────────────────────────┬────────────────────────────────────────────────────────────────┐
  │             Code             │                                      Goal                                       │                              Why                               │
  ├──────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────┤
  │ add-daemon-mcp-tools         │ Catalog and implement daemon-only MCP tools (docker_build, run_tests, check_ci) │ Unlocked by daemon MCP proxy, needed for Dockerfile onboarding │
  ├──────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────┤
  │ daemon-sse-events            │ SSE endpoint on daemon for real-time updates to web dashboard and CLI           │ Foundation for real-time UI and event delivery                 │
  ├──────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────┤
  │ daemon-replace-file-protocol │ Supervisor calls daemon over HTTP instead of file-based protocol                │ Eliminates polling latency, enables mid-turn events            │
  ├──────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────┤
  │ add-auto-react-budget        │ Budget controls for auto-triggered agent turns                                  │ Safety mechanism for daemon-auto-react and event auto-delivery │
  └──────────────────────────────┴─────────────────────────────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────────┘

  Want me to create any of these? And I'd recommend reading the event plane spike answers carefully before morning — the transport question (file vs SSE via daemon) is the one decision that shapes everything downstream.

✻ Baked for 2m 27s

❯ I will read the spike now. Here are my first reactions:

> Custom daemon-only MCP tools

Yes, cataloguing, good but for example mcp_run_tests opens the user to prompt injection. So that I would not do. Dockefile doesn't have this problem as all it's doing is isolated to the docker. Query CI has to be used carefuly - query yes,
changes no (same reason).

Re "richer git history than what's available in the container" - I don't see how. Container has the whole git repo and git - what more can host offer?

But either way, yes, we want to ideate on this provided it's always safe.

Re event plane, the biggest question for me is what kind of store it is? It must be a queue store but is it persistent? If deamon crashes, does it go away or it stays around? I think it stays around but that introduces a host of other issues:
what if daemon is down for a few days and the rest of the world has moved on? Rest being other developers, agents, CI, etc. How is *this* reconcilliation then done?

Ephemeral is easier and surely "more right" for v1. You can "go into" persistent if needed but it's hard to "go back" to ephemeral. But either way, reconcilliaton must be done - daemon restarts, sees the empty plane and... now what? How do
tasks "re-suscribe"? Should they even be allowed to subscribe? If daemon owns subscriptions based on the graph of tasks then tasks are inert and it is active and can figure out where do signals go. Is subscription then even a useful concept?
It's not like agents are subscribing and getting signals - it's daemon that is collecting signals and routing them where it sees fit. That makes most sense to me right now.

Re file or TCP, consider that daemons can be stopped without agents stopping. So agents would have to reconnect for daemon to know about them. I think it's better for each supervisor to keep the queue and that it can be fed to it through other
IPC mechanisms. For example, if docker runner supervisor can get new events from deamon with "docker exec <container> lazy-agent supervisor new-event <json>", then it can include that event to its queue which can then... well there's the answer
 right: queues are *not* in daemon but in supervisors and if supervisor dies well tough shit - it missed some events but events are mostly there (at least for now) to kick off another turn so not a biggie, same as today. And if daemon dies,
well queueing stops and we are where we are today, not worse off.

We could do SSE as well. It has automatic reconnection and that does seem better than builder figuring out which agents are alive. *But* importantly, builder should also be tasked with that - with booting containers/processes of agents that
have crashed. So it's different than normal server client relationship. SSE still seems plausible here. The file based queuing or push-to-supervisor queuing cannot work when containers are down either so maybe SSE is cleaner.

Re  Replace file-based protocol" question

This must happen. And the reason for this is that daemon will have to monitor the changes on the lazy store as well. What if multiple folks are working on the same parent task with their subtasks and person A starts the task... should person B
also be able to start the same task? I would say "no in a perfect world" but "yes in a messy world" (e.g. I left on PTO with that task started - somebody should be able to start it again on their own machine!)

Agreed on cost control - the system must not be in a runaway state, ever. So circuitbreakers are needed. We know how many turns any task is taking and under what circumstances. We should be able to account for that and adjust accordingly. But
notice that automatic work mostly pulls the cost rather than increasing the costs: the same work must happen regardless, triggered by human/builder or triggered by the system.

● These are really sharp observations. Let me engage with each:

  Prompt injection via daemon MCP tools

  You're right — mcp_run_tests is dangerous because test output flows back into the agent's context, and a malicious test (or dependency) could inject instructions. mcp_docker_build is safe because Docker build is isolated — the output is build
  logs, not executable context that could manipulate the agent. mcp_check_ci is safe for reads (status, logs) but not writes (trigger pipeline, approve deployment). The principle is: daemon MCP tools can only do things where the output cannot be
   crafted by an attacker to manipulate the agent. Docker builds, CI status reads, and storage queries are fine. Running arbitrary code whose output feeds back to the agent is not.

  And you're right on git — the container has the full repo. I was wrong there.

  Event plane: ephemeral vs persistent, and who owns subscriptions

  Your thinking here is clearer than the spike. Let me trace the logic:

  Daemon owns routing based on the task graph — not subscriptions. This is the key insight. The daemon knows the task tree. When task.accepted happens, the daemon looks at the tree, finds the parent, finds siblings, and routes signals. No agent
  needs to "subscribe" to anything. The routing is deterministic from the graph structure. Subscriptions are a solution to a problem that doesn't exist when the daemon has the full picture.

  Queues live in supervisors, not the daemon. This solves the persistence question elegantly:

  - Daemon detects event (CI failed, child completed, upstream changed)
  - Daemon looks at task graph, determines who needs to know
  - Daemon pushes to supervisor via SSE / docker exec / whatever IPC is available
  - Supervisor queues it locally, delivers to agent at next turn boundary
  - If supervisor is dead → event is lost, but that's fine because:
    - When supervisor restarts, daemon reconciles and can re-derive the current state
    - Events are about notifications, not state — the state is in storage

  If daemon crashes and restarts with empty event plane: It doesn't need to "replay" events. It reconciles from storage — looks at tasks, their statuses, their branches, the git graph — and re-derives what signals need to go where. This is the
  same reconciliation it already does! The difference is that now reconciliation can also emit events, not just fix statuses.

  For example: daemon restarts, reconciles, sees that task A was accepted while it was down (storage says status: complete), sees task A's parent B is blocked, sees B has pending children — daemon can emit task.accepted to B's supervisor right
  now. The event is "late" but still useful.

  This means events are not durable entities in storage at all for v1. They're transient signals that flow through the daemon. The daemon is a router, not a store. The spike's Event { id, delivered_at, consumed_at } storage model is
  over-engineered for v1. What you need is:

  Daemon reconcile loop:
    for each project:
      check for state changes since last check
      for each change:
        determine routing from task graph
        push to live supervisors via SSE
        (dead supervisors miss it — they'll catch up on reconnect)

  This is dramatically simpler than adding an Event entity to Storage. And it's the right v1 because you can always add persistence later if "catch up on reconnect" isn't sufficient.

  SSE vs file-based vs push-to-supervisor

  SSE wins for the reasons you identified:
  - Auto-reconnection is built into the protocol
  - Supervisor connects to daemon on startup, gets events as they happen
  - If daemon restarts, supervisor reconnects and daemon can push a "here's what you missed" catchup based on current state (not event replay — state reconciliation)
  - If supervisor restarts, it reconnects and gets current state
  - No file polling, no docker exec complexity

  The daemon already has an HTTP server on a unix socket. Adding an SSE endpoint (GET /events/stream?task_id=<id>) is minimal. The supervisor connects on startup and stays connected. The daemon pushes events as they happen.

  For containers: the supervisor inside Docker connects to the daemon via host.docker.internal:<port> (TCP) or mounted unix socket. This is the same transport as daemon MCP proxy — one connection, two purposes (tool calls + event stream).

  Replace file-based protocol + multi-user

  Your PTO example is important. The file-based protocol is local — .lazy/protocol/<task-id>/. If person B clones the repo and starts the same task, they get a separate local protocol directory. But with the daemon, the protocol goes through
  HTTP — which means the daemon needs to handle "this task has a supervisor on machine A, now machine B also wants to run it."

  For v1, the answer is probably: one active supervisor per task, enforced by storage. If Alice's supervisor is running, Bob can't start the same task (storage says status: working, session has container_name). If Alice is on PTO and her daemon
  crashed, Bob's daemon reconciles, sees the stale session, moves task to interrupted, and Bob can restart it.

  The multi-machine case (Alice and Bob's daemons both watching the same storage backend like Postgres) is a separate feature. For v1 with FileStorage, it's single-machine and the current locking is sufficient.

  Cost control: pulls cost, doesn't increase it

  Good reframe. Auto-reactions don't create NEW work — they accelerate work that would happen anyway. The CI failure still needs fixing whether a human triggers it or the daemon does. The cost is the same; the human time is less.

  The circuit breaker is still needed though — not for normal operation but for pathological cases. A flaky test that fails 50% of the time could trigger infinite fix→fail→fix→fail loops. The breaker detects "this task has been auto-unblocked 3
  times for CI failure and keeps failing" and escalates to human review instead of retrying.

  Revised v0.11 architecture based on this discussion

  The event plane design simplifies significantly:

  1. Events are transient, not stored. Daemon routes them based on task graph.
  2. Daemon owns routing. No subscriptions. Graph structure determines signal flow.
  3. SSE for delivery. Supervisor connects to daemon, receives events in real-time.
  4. Reconciliation on reconnect. No replay — daemon derives current state from storage.
  5. Circuit breakers for auto-reactions. Track per-task auto-unblock count, escalate on threshold.

  This changes add-event-storage significantly — it's no longer about adding an Event entity to Storage. It's about adding event routing logic to the daemon's reconcile loop and an SSE endpoint. Much simpler.

  Want me to update the add-event-storage task description to reflect this, or wait until after you've read the full spike and decided?

✻ Churned for 51s
