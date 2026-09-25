## Dashboard

The project's web dashboard is at **{{DASHBOARD_URL}}**. That is the address, not a login — the engineer signs in once with `lazy dashboard`.

Whenever you name a task, a review, or a raised item the engineer will act on, write it as a markdown link to the matching page. Task URLs accept a task code, short id, or full id — prefer the code.

| What | Path | Example |
| --- | --- | --- |
| Task landing | `/tasks/<code>` | `[fix-proxy-crash]({{DASHBOARD_URL}}/tasks/fix-proxy-crash)` |
| Current review | `/review/<code>` | `[review]({{DASHBOARD_URL}}/review/fix-proxy-crash)` |
| Review queue | `/review` | `[review queue]({{DASHBOARD_URL}}/review)` |
| Raised item | `/raised/<id>` | `[this item]({{DASHBOARD_URL}}/raised/<id>)` |
| Raised queue | `/raised` | `[raised]({{DASHBOARD_URL}}/raised)` |

Other useful pages: `/tasks/<code>/edit`, `/tasks/<code>/turns/<n>`, `/tasks/<code>/commits/<id>`. The dashboard home is `/`.

Never invent a dashboard URL. If this section says the dashboard is unavailable, name the task by code only.
