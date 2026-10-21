# Dashboard

The dashboard is lazy's local web interface: a browser view of one project's tasks, reviews, raised items, messages, memory and settings, served by that project's daemon.

## Opening it

```bash
lazy dashboard
```

This starts the daemon if it is not running, asks it for a one-time sign-in link and opens that link in your browser. The link works once; the browser keeps a session afterwards. When lazy cannot open a browser (an SSH session, no graphical session, or output that is not a terminal) it prints the link instead. To print the link without opening anything:

```bash
lazy dashboard --print
```

`lazy dashboard --project <path>` opens the dashboard of another project. To see the address the daemon serves without signing in, run `lazy daemon dashboard-url`.

The address is `http://lazy.localhost:<port>`. The port starts at 26024 and moves to the next free one if that is busy; the `[server]` section of [lazy.toml](../../lazy-toml.md) sets the starting port, the interface the daemon binds to, and an optional public address for use behind a reverse proxy.

The dashboard needs a signed-in browser. Without a session, a page shows a sign-in message; run `lazy dashboard` for a new link.

## Screens

The navigation bar runs across the top of every page. Each of its entries is documented on its own page below. A number beside **Clusters**, **Review**, **Raised** or **Inbox** counts what is waiting there; the **Raised** badge shows blocking items first (for example `1/1`).

| Screen | Where | What it is |
|---|---|---|
| [Dashboard](overview.md) | **Dashboard**, `/` | Counts, activity, usage, and the tasks that need you. |
| [Tasks](tasks.md) | **Tasks**, `/tasks` | The task list, with the New task and Link forms. |
| [Runs](../../running-a-commit.md) | **Runs**, `/runs` | Run the product at any commit. |
| [Task page](task.md) | `/tasks/<code>` | One task: header, actions and tabs. |
| [Review queue](review-queue.md) | **Review**, `/review` | Tasks waiting for a human decision. |
| [Raised items](raised.md) | **Raised**, `/raised` | Questions and proposals agents raised, across all tasks. |
| [Clusters](clusters.md) | **Clusters**, `/clusters` | Tasks whose agent drives its own subtasks. |
| [Builders](builders.md) | **Builders**, `/builders` | Captured dialogues with the project's builder. |
| [Scratch](scratch.md) | **Scratch**, `/scratch` | Files builders left in their scratch directory. |
| [Settings](settings.md) | **Settings**, `/settings` | Memories, Services and Doctor. |
| [Inbox](inbox.md) | **Inbox**, `/messages` | System messages. |
| [Search](search.md) | search box, `/search` | Search across tasks, turns, prompts and more. |

Reviewing a task in depth is covered in [Reviewing in the browser](../../web-review.md); terminals in a task's container are covered in [Web shell](../../web-shell.md).
