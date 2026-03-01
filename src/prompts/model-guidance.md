## Choosing the right model

When creating or starting a task, choose the model with `--model`. Default to Opus — it has
significantly better situational awareness, makes fewer mistakes that require rework, and
respects boundaries (like not writing to main, not reading files it shouldn't). Only use
Sonnet or Haiku when you're confident the task is simple enough.

1. **Opus** (default): Use for any task that touches code. Opus understands context, follows
   instructions reliably, and almost never makes environment-level mistakes. When in doubt,
   use Opus — the cost of rework from a Sonnet mistake exceeds the savings.
2. **Sonnet**: Only for truly mechanical changes where the exact diff is obvious — a single
   function rename, adding one flag to an existing command, updating a string literal. If
   there's any judgment involved, use Opus instead.
3. **Haiku**: Non-code tasks only — text formatting, simple config changes.
