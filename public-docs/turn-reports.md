# Structured turn reports

At the end of a turn, an agent can deliver a **typed report** instead of only a
long prose summary. Review surfaces (`lazy show`, web review, the review TUI,
**Lazy Teams** task and accept pages) prefer that structured payload when it is
present; if the agent skips the tool, the final message is shown as prose —
same as before.

## `lazy_report`

From a task agent, call `lazy_report` with one or more sections. You choose
**authoring** order; reviewers see what changed for a user before how it was
done (agent order is kept within each of those). Kinds:

| Kind | Use for |
| --- | --- |
| `behavior_change` | What a user or operator observes differently. Write this for someone who will not read the diff: no file or function names. Screenshots and diagrams belong here. |
| `capabilities_lost` | Broken, degraded, or missing capability — shown next to behavior, not buried below code |
| `how_to_verify` | Concrete steps a human can take to check it — one step per paragraph, every command in its own fenced code block (rendered as a one-click-copy panel on review), URLs of anything started |
| `implementation` | How it was done; this is where names belong. |
| `what_was_done` | The older combined narrative. Stored reports still render on Summary under **What was done** — not as implementation, and not as a "no behavioral change" claim. |
| `commentary` | Anything else (context, caveats) |

On the tabbed task page, **Summary** shows `behavior_change`, `capabilities_lost`, and any stored `what_was_done`; **Changes** shows `implementation`. A report that has the new `implementation` kind but no `behavior_change` shows an explicit "Agent declared no behavioral change" line on Summary rather than silence.

Link a presentation group with `[the retry path](#group-retry)` when that
group's `id` is `retry`. A backticked name in the report that matches a
function, class or type in the diff becomes a jump link to that line.

Skip kinds that do not apply. Duplicate kinds in one call are allowed (for
example two commentary blocks).

Questions and merge decisions still belong in **`lazy_raise`** — pass those ids
in `raised_item_ids` if helpful. Do not invent a "questions" section.

Calling `lazy_report`:

- does **not** end the turn
- does **not** change task status
- is **not** required — skipping it only means review falls back to prose

### The presentation walkthrough

Pass **`presentation`** on the same call when the change spans files or tiers
of unequal weight. You choose **group order** (the story), **tiers** (`core`,
`tests`, `docs`, `generated`, `other`), and **snippets** (line ranges) vs whole
files. The web review **Changes** block shows this walkthrough first; the
reviewer can switch to **Raw files** in one click. Skip presentation for a
small one-file change.

The walkthrough is a **partition of the change**: every file in the review
lands in exactly one group, and the groups' file lists add up to the whole
change. A file claimed whole by two groups is refused at the source, naming
both groups and the file — an overlapping claim is an error, not a rendering
detail. A **snippet** into another group's file is accepted, though: two
groups can each show particular line ranges of one file, and the file belongs
wholly to the group that claimed it whole. Whatever you claim nothing of
appears in a last group, **Other changes**, that lazy appends itself — it
cannot be suppressed or renamed, because an unclaimed file is exactly the
thing a reviewer most needs pointed at, and it states how many of the change's
files the walkthrough did not name. When the change is fully accounted for,
there is no residual group at all.

One item can claim **many files**. Alongside a path, a `file` item takes a
**directory** (`src/review/` — the trailing slash is required) or a **glob**
(`test/e2e/regions*.test.ts`), and every changed file it matches belongs to
that group. A pattern matching nothing the task changed is refused, naming it.
A path is always safe to write as itself: if the value is exactly one of the
files the task changed it is taken literally, so a dynamic route such as
`app/blog/[slug]/page.tsx` needs no escaping.
This is what keeps a several-hundred-file branch presentable: a walkthrough
may carry at most 512 file items, 64 snippets and prose paragraphs, and 32
groups, and a release-sized branch fits because its test and docs masses cost
one item each rather than forty. If a walkthrough is refused for exceeding one
of those, lazy records that against the task and says so on **Other changes** —
a walkthrough cut down to fit should not read like one that chose to leave
things out. The refusal never discards a walkthrough already stored for that
turn, and if no smaller one is ever sent the review still names the cap rather
than reporting no walkthrough at all.

These groups are the review's map afterwards: every region surface — the
Regions tab, `lazy regions`, the `lazy_regions` tool — reads this walkthrough
by default, scopes diffs by it, and judges a region sign-off against the
region's own files. See [Review regions](review-regions.md).

On a task an agent is going to review (no human in the loop), that is the whole
story. When a human will review it, lazy runs a dedicated presentation step
**every time the task parks for you** — whether the agent declared the work done,
raised something blocking, or simply stopped. The walkthrough is what you decide
from, so you get it whichever way the turn ended. The step asks the agent to
author the report WITH the walkthrough in one `lazy_report` call.

Two rules keep that cheap and honest:

- **It is re-authored only when the branch has moved** since the walkthrough on
  record was written. A task that parks three times for decisions pays for one
  walkthrough, not three.
- **On a declared-done turn the walkthrough is required**: a step that ends
  without the declaration fails the turn and parks the task. On an ordinary park
  it is asked for and not enforced — the task is already stopping for you, and
  failing the turn would cost you the agent's own account of where it got to on
  top of the walkthrough you did not get.

A task with SUBTASKS is presented differently and asks nothing of the agent:
its regions are its accepted children, derived from the merge history, plus a
note naming the children that can still land. "What is in, and what is still
out" is the question a parent task raises, and it is one lazy can answer without a model
turn. A subtask you closed or rejected does not count — it will never land, so
it neither makes a task a parent nor appears in that note. An agent that files a
walkthrough on a parent task anyway still wins.

### Optional: screenshots

When the work is visual — a web page, a TUI, a command's output — the agent can
show it. It attaches an image to the task with `lazy_artifact_add` and lists it
in `presentation.screenshots`:

```json
{
  "presentation": {
    "screenshots": [
      { "artifact": "shots/settings.png", "caption": "Settings page, dark theme" }
    ]
  }
}
```

The web review page renders those images in a **Screenshots** card at the very
top, above the raised items and the agent's report, each with its caption. A
click opens the picture over the page, and the arrow keys walk the whole set
without leaving it. Images are served from the task's artifact store
behind the same sign-in as the rest of the dashboard — never from the task's
worktree.

Each entry must name an image artifact that is already attached to the task, and
a raster one (png, jpeg, gif, webp). A name that is missing, an artifact that is
not an image, or an SVG makes the `lazy_report` call fail and say which artifact
was at fault, so a report never renders a broken image. A presentation may carry
screenshots, groups, or both.

There is no CLI command to author a report. Humans read reports via `lazy show`
and review; they do not write them.

## Keep / skip justifications

When an agent is nudged about **protected files** or **maintained file groups**,
it records structured reasons instead of burying them in prose:

| Tool | When | Meaning |
| --- | --- | --- |
| `lazy_justify_protected` | Keeping a protected-file change | One file, one short reason |
| `lazy_justify_maintain` | Skipping a maintained group | One group title, one short reason |

**Important:** a keep reason does **not** approve the protected file. You still
decide on the review surface. Files the agent reverts need no justify call —
re-detection drops them from the pending set.

## Related

- [Raised items](raised-items.md) — decisions that gate accept
- [Surface asymmetries](surface-asymmetries.md) — why report/justify are agent-only writes
