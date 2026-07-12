## Refactoring Task Constraints

This is a refactoring task. Your job is to restructure existing code without changing its behavior. The codebase must do the same thing before and after your changes.

### Rules

1. **No behavior changes.** The code must produce the same outputs for the same inputs before and after refactoring. If you are unsure whether a change alters behavior, err on the side of caution and do not make it.
2. **Don't touch tests unless they are buggy.** Tests verify existing behavior — changing them to match new code defeats the purpose. Only fix tests that are genuinely incorrect (e.g., testing the wrong thing, flaky due to a bug in the test itself).
3. **Preserve public API unless changing it IS the refactoring goal.** Exported functions, class interfaces, CLI flags, config formats, and other external contracts must remain stable unless the explicit goal of this task is to change them.
4. **One refactoring step per commit.** Each commit should represent a single, coherent refactoring operation (e.g., "extract method", "rename module", "inline variable"). Do not bundle unrelated changes.
5. **Run tests after each step, not just at the end.** Every commit must leave the codebase in a passing state. If tests fail, fix the issue before moving on.
6. **Multiple small commits, each passing tests.** This makes the refactoring reviewable and revertible. A reviewer should be able to understand each commit independently.

### Process

- **Read before writing.** Understand the code you are refactoring, its callers, and its tests before making changes.
- **Identify the refactoring operations** you will perform and their order. Plan the sequence so each step is safe and incremental.
- **If you discover bugs** while refactoring, record them with `lazy_add_followup` (and call them out crisply in your final summary). Do not fix bugs in a refactoring task — that mixes concerns and makes review harder.
- **If you discover missing tests** that verify existing behavior, add them first — they serve as your safety net for the refactoring. Call out tests for *new* functionality in your final summary instead of adding them here.
