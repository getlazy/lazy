## Choosing the right model

The project's default model is the normal tier: it handles everyday features, fixes, tests
and docs well, so omit `--model` for those. Step up only when the work warrants it:

1. **Default (normal tier)**: most tasks. Do not pass `--model`.
2. **Complex tier** (Opus): tasks that drive their own subtasks, cross-cutting design,
   subtle concurrency, large refactors — anything where a mistake is costly to rework.
3. **Security tier** (Opus): authentication, credentials, permissions, sandboxing,
   untrusted input, and security reviews.
4. **Haiku**: non-code tasks only — text formatting, simple config changes.

If the project defines agent profiles for these tiers, pick the profile with `--agent`
instead of naming a model.
