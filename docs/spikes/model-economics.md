# [SPIKE] Empirical Model Economics: Data-Driven Model Selection

## Summary

Design for how historical task performance data feeds into the builder's model selection
decisions. The goal: replace gut-feel model guidance ("Opus for code, Sonnet for mechanical")
with project-specific empirical data ("For feature tasks in this project, Opus averages
0.8 feedback rounds, Sonnet averages 2.3").

## 1. What Metrics Matter

### Available now (from existing storage)

All of these can be computed from current entities — no new storage needed.

| Metric | Source | Computation |
|--------|--------|-------------|
| **Feedback rounds** | Turns where `role='human'` AND `actor='human'` | Count per task |
| **Token usage** | `Session.total_usage` (aggregated) or per-turn `Turn.usage` | Sum input+output per task |
| **Accept rate** | Tasks with `status='complete'` vs `status='abandoned'` | % per model × task type |
| **Time to acceptance** | `Task.completed_at - Task.created_at` | Median per model × type |
| **First-pass quality** | Tasks accepted with 0 human feedback turns | % per model × type |
| **Rework ratio** | Human feedback turns / total turns | Ratio per model × type |
| **Task type breakdown** | `Task.type` × `Task.model` cross-tabulation | All metrics sliced by type |

### Available with review agent (future)

| Metric | Source | Notes |
|--------|--------|-------|
| **Inner review cycles** | Review agent pass/fail count per task | Not yet tracked; review agent spike still in design |
| **Review failure reasons** | Structured verdicts from review agent | Gives signal on *what kind* of mistakes each model makes |

### Not worth tracking

- **Wall-clock time to acceptance** — dominated by human wait time (when they check `lazy blocked`), not model performance. Too noisy to be useful.
- **Lines of code changed** — doesn't correlate with quality; a 3-line fix can be harder than a 200-line feature.
- **Commit count** — reflects agent style, not quality.

## 2. Cost Model

### Effective cost per accepted task

The key comparison metric. What does it actually cost to get a task accepted using model X?

```
effective_cost(model, type) =
    avg_token_cost(model, type)
  + avg_feedback_rounds(model, type) × HUMAN_ATTENTION_WEIGHT
  + avg_review_cycles(model, type) × REVIEW_CYCLE_COST    # future, with review agent
```

**Token cost** is computable from usage data. Lazy already tracks `TokenUsage` per session
with input/output/cache breakdowns. We need a price table:

```typescript
// Per-million-token pricing (as of 2025 — update periodically)
const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  opus:        { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
  master:      { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
  sonnet:      { input: 3.00,  output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  journeyman:  { input: 3.00,  output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  haiku:       { input: 0.80,  output: 4.00,  cacheRead: 0.08, cacheWrite: 1.00 },
  apprentice:  { input: 0.80,  output: 4.00,  cacheRead: 0.08, cacheWrite: 1.00 },
};

function computeTokenCost(usage: TokenUsage, model: ModelName): number {
  const prices = MODEL_PRICING[model];
  return (
    (usage.inputTokens / 1_000_000) * prices.input +
    (usage.outputTokens / 1_000_000) * prices.output +
    (usage.cacheReadTokens / 1_000_000) * prices.cacheRead +
    (usage.cacheCreationTokens / 1_000_000) * prices.cacheWrite
  );
}
```

**Human attention cost** is the expensive unknown. We can't measure it directly, but we
can proxy it as "number of human feedback rounds." The HUMAN_ATTENTION_WEIGHT is a
configurable constant — it doesn't need to be precise to be useful. Even a rough value
(e.g., $5 per feedback round) makes the comparison meaningful: if Sonnet saves $2 in
tokens but costs 1.5 extra feedback rounds ($7.50), Opus wins.

Recommendation: **start with a default weight of $5/feedback-round** and let users
override it in `lazy.toml` if they want. The exact value matters less than having *any*
value — it shifts the conversation from "Opus costs more tokens" to "Opus costs less
overall."

### Review cycle cost (future)

When the review agent exists, each review cycle has a measurable token cost (the review
agent's own usage). This slots cleanly into the formula — no design change needed, just
a new term.

## 3. How the Builder Accesses This Data

### Recommendation: MCP tool (`lazy_model_stats`)

A new MCP tool the builder can call when making model decisions. This is the right
approach because:

- **On-demand, not injected.** Stats change as tasks complete. Injecting stale stats into
  the system prompt wastes context window. The builder queries when it needs to decide.
- **Follows existing patterns.** The builder already uses `lazy_search`, `lazy_show`, etc.
  A stats tool is natural.
- **Builder retains agency.** The tool returns data and a recommendation; the builder
  (and ultimately the human) decides. No magic overrides.

#### Tool definition

```typescript
const lazyModelStats: McpTool = {
  name: 'lazy_model_stats',
  description: 'Get model performance statistics for this project. Returns per-model ' +
    'metrics (accept rate, feedback rounds, token cost, effective cost) optionally ' +
    'filtered by task type. Use this when deciding which model to assign to a new task.',
  inputSchema: {
    type: 'object',
    properties: {
      task_type: {
        type: 'string',
        description: 'Filter stats to a specific task type (e.g., "feature", "fix", "tidy"). ' +
          'Omit for aggregate stats across all types.',
      },
      min_tasks: {
        type: 'number',
        description: 'Minimum number of completed tasks required for a model to be included. ' +
          'Default: 3. Prevents recommendations based on too little data.',
      },
    },
    required: [],
  },
};
```

#### Tool output

```json
{
  "stats": {
    "opus": {
      "tasks_completed": 12,
      "tasks_rejected": 1,
      "accept_rate": 0.92,
      "avg_feedback_rounds": 0.8,
      "first_pass_rate": 0.58,
      "avg_token_cost_usd": 2.45,
      "avg_effective_cost_usd": 6.45,
      "task_types": { "feature": 5, "fix": 4, "refactor": 3 }
    },
    "sonnet": {
      "tasks_completed": 8,
      "tasks_rejected": 3,
      "accept_rate": 0.73,
      "avg_feedback_rounds": 2.1,
      "first_pass_rate": 0.25,
      "avg_token_cost_usd": 0.85,
      "avg_effective_cost_usd": 11.35,
      "task_types": { "tidy": 5, "fix": 2, "feature": 1 }
    }
  },
  "recommendation": {
    "model": "opus",
    "reason": "For feature tasks, opus has 58% first-pass rate vs sonnet's 0% (1 task). " +
      "Effective cost $6.45 vs $11.35. Recommendation based on 12 completed tasks.",
    "confidence": "medium"
  },
  "meta": {
    "total_completed_tasks": 20,
    "min_tasks_threshold": 3,
    "human_attention_weight_usd": 5.00,
    "task_type_filter": null
  }
}
```

### What changes in the builder prompt

Replace the static model-guidance.md with a dynamic instruction:

```markdown
## Choosing the right model

Before assigning a model to a new task, check project-specific performance data:

    lazy_model_stats()                        # overall stats
    lazy_model_stats(task_type="feature")     # stats for this task type

If the project has enough data (3+ completed tasks per model), use the recommendation.
If not enough data exists, fall back to defaults:

1. **Opus/master** (default): Any task that touches code
2. **Sonnet/journeyman**: Only truly mechanical changes
3. **Haiku/apprentice**: Non-code tasks only

The stats show effective cost (token cost + human attention cost from feedback rounds).
A cheaper model that requires more feedback rounds can cost more overall.
```

### Alternatives considered and rejected

**Injected context in system prompt**: Wastes context window with potentially stale data.
The builder doesn't need stats for every conversation — only when creating/starting tasks.

**Automatic model selection**: Too opaque. The builder (and human) should see the data and
make the call. Automatic selection hides the reasoning and makes it hard to override.

**`lazy stats` CLI enhancement only**: Useful for humans but doesn't help the builder.
The builder needs an MCP tool, not a CLI command. (A CLI command showing the same data
is a nice-to-have but separate work.)

## 4. Where the Data Lives

**No new storage needed.** Everything is computable from existing entities:

- `Task` — has `model`, `type`, `status`, `created_at`, `completed_at`
- `Session` — has `total_usage` (TokenUsage), `total_duration_ms`
- `Turn` — has `role`, `actor`, `usage`, `model`

The `lazy_model_stats` tool handler queries storage at call time:

```typescript
async function computeModelStats(storage: Storage, taskType?: string, minTasks: number = 3) {
  const tasks = await storage.listTasks();
  const completed = tasks.filter(t =>
    t.status === 'complete' &&
    t.model != null &&
    (taskType ? t.type === taskType : true)
  );

  // Group by model
  const byModel = groupBy(completed, t => t.model!);

  for (const [model, modelTasks] of Object.entries(byModel)) {
    const sessions = await Promise.all(
      modelTasks.map(t => storage.getSessionByTaskId(t.id))
    );

    // Count human feedback turns per task
    const feedbackCounts = await Promise.all(
      sessions.filter(Boolean).map(async s => {
        const turns = await storage.getSessionTurns(s!.id);
        return turns.filter(t => t.role === 'human' && t.actor === 'human').length;
      })
    );

    // Compute token costs from session usage
    const tokenCosts = sessions
      .filter(Boolean)
      .map(s => s!.total_usage ? computeTokenCost(s!.total_usage, model as ModelName) : 0);

    // ... aggregate into stats object
  }
}
```

This is O(tasks × turns) which is fine for project-level data (hundreds of tasks, not
millions). If performance becomes an issue, we can add a materialized stats cache later.

### Rejected alternative: dedicated metrics store

A separate analytics table/store would add complexity without benefit at this scale.
Projects typically have 10-100 completed tasks — computing stats on the fly is instant.
If lazy grows to thousands of tasks per project, a cache or summary table can be added
as an optimization without changing the interface.

## 5. Cold Start Strategy

### No data yet (new project)

Fall back to the static defaults in the builder prompt:
- Opus for code tasks
- Sonnet for mechanical changes
- Haiku for non-code

The `lazy_model_stats` tool returns an explicit signal:

```json
{
  "stats": {},
  "recommendation": null,
  "meta": {
    "total_completed_tasks": 0,
    "note": "No completed tasks yet. Using default model guidance."
  }
}
```

### Partial data (some models used, not others)

The `min_tasks` threshold (default: 3) prevents recommendations from tiny samples.
If Opus has 10 tasks but Sonnet has 1, the recommendation is based on Opus alone —
it doesn't claim Sonnet is worse from one data point.

### New model added to the system

Same as cold start. No data = no recommendation for that model. The builder uses
defaults until enough tasks accumulate.

### Cross-project aggregation

**Not recommended initially.** Each project's codebase is different — Sonnet might be
fine for tidy tasks in a simple project but fail in a complex one. Cross-project stats
would mix signals. If users want this later, it's a separate feature.

## 6. Confidence Levels

The recommendation includes a confidence signal:

| Confidence | Criteria |
|------------|----------|
| **high** | 10+ tasks per model being compared, >20% difference in effective cost |
| **medium** | 3-9 tasks per model, or <20% difference |
| **low** | Only one model has enough data, or <3 tasks for all models |
| **none** | No completed tasks; using defaults |

The builder should treat low/none confidence as "use defaults" and only override
defaults at medium+ confidence.

## 7. Implementation Plan

### Phase 1: Core stats computation (standalone task)

1. Add `computeTokenCost()` utility with model pricing table to `src/cli/helpers.ts`
2. Add `computeModelStats()` function that queries storage and returns the stats structure
3. Add `lazy_model_stats` MCP tool in `src/mcp/tools.ts`
4. Update `model-guidance.md` to reference `lazy_model_stats`

### Phase 2: Builder integration (after Phase 1)

5. Update `builder-system-prompt.md` to instruct builder to check stats before model selection
6. Add a `lazy stats` CLI command for humans to see the same data

### Phase 3: Review agent integration (after review agent ships)

7. Add review cycle count to the stats computation
8. Add `REVIEW_CYCLE_COST` term to effective cost formula

### Out of scope

- **Per-agent stats** (different Claude Code versions) — model matters more than agent version
- **A/B testing framework** — premature; the builder can do informal A/B by alternating models
- **Automatic model switching mid-task** — a task's model is set at creation and shouldn't change
- **Real-time cost tracking** — the tool computes on demand, which is sufficient

## 8. Pricing Maintenance

Model pricing changes over time. The price table should be:
- Defined as a constant in source code (not in config), since it changes infrequently
- Updated when model pricing changes via a simple code edit
- Documented with the date of last update

The universal monikers (`master`, `journeyman`, `apprentice`) map to the same pricing as
their Claude-specific equivalents (`opus`, `sonnet`, `haiku`). This mapping should be
explicit in the code.

## 9. What This Spike Does NOT Propose

- **No changes to task creation flow.** The builder still picks the model — it just has
  better data to inform the choice.
- **No mandatory model selection.** `Task.model` remains nullable. Tasks without a model
  are excluded from stats (they provide no signal).
- **No cost tracking in the UI beyond what exists.** The `list` command already shows a
  COST column. This spike doesn't change that — it adds a *comparison* tool.
- **No new storage entities.** Everything is computed from existing data.
