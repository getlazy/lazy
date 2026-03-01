# Fix Task: Experimental Debugging Methodology

This is a debugging/fix task. The key difference from regular tasks: **prove everything through execution, never assume by reading code.**

Regular agents read code, form theories, and write fixes based on assumptions. This fails for subtle bugs because the theory is often wrong. Fix tasks enforce a different approach:

## The Debugging Methodology

### 1. Reproduce First

Before touching any code, reproduce the bug. If there's no reproduction, create one:
- Write a failing test that demonstrates the bug
- Create a script that triggers the issue
- Document manual steps that consistently reproduce it

**CRITICAL**: If you cannot reproduce the bug, you cannot verify the fix. Do not proceed until you have a working reproduction.

### 2. Instrument, Don't Assume

Add throws, panics, console.logs, or assertions at suspected failure points. Run the code. See what actually happens.

- **Don't**: Read code and conclude "x could be null here"
- **Do**: Add `if (!x) throw new Error('X IS NULL AT LINE 42')`, run it, confirm

Examples:
```typescript
// Before reading further, prove your hypothesis
if (token === null) {
  throw new Error('TOKEN IS NULL before refresh');
}

// Prove the order of execution
console.log('[DEBUG] entering handleAuth, user:', user?.id ?? 'UNDEFINED');

// Assert your understanding
if (sessionId === undefined) {
  throw new Error('INVARIANT VIOLATED: sessionId undefined at cleanup');
}
```

### 3. Prove Hypotheses Through Execution

If you think something is the cause, prove it:
- Add instrumentation to capture the suspected state
- Run the reproduction
- Observe the actual behavior
- Only then draw conclusions

Never say "I think..." or "This might be because..." — if you're uncertain, add instrumentation and prove it.

### 4. Bisect the Flow

If the bug is in a control flow, add instrumentation at multiple points to narrow down exactly where behavior diverges from expectation:

```typescript
console.log('[DEBUG] checkpoint 1: before validation');
// validation code
console.log('[DEBUG] checkpoint 2: after validation, result:', result);
// next stage
console.log('[DEBUG] checkpoint 3: before network call');
```

This lets you pinpoint where the actual behavior deviates from expected.

### 5. Fix with Evidence

Only write the fix after you have concrete evidence of the root cause. The evidence should be:
- Captured in your instrumentation output
- Documented in your commit messages or code comments
- Reproducible by running the failing test/script

### 6. Verify the Fix

After implementing the fix:
- Run the reproduction again — it must pass
- Run the full test suite — no regressions
- Leave a regression test that would catch this bug if reintroduced
- Verify the fix addresses the root cause, not just the symptom

### 7. Clean Up Instrumentation

Remove debug logging and temporary throws before committing the final fix. Keep useful assertions that document invariants or prevent future bugs.

## Commit Message Guidelines

Your commit messages should include:
- **What you proved**: The evidence you gathered through instrumentation
- **How you proved it**: The technique you used (added assertion, logged state, etc.)
- **What you changed**: The actual fix
- **Why it works**: How the fix addresses the proven root cause

Example:
```
Fix token refresh hanging on expired tokens

Proved through instrumentation that handleRefresh was not checking
token expiration before attempting refresh, causing infinite retry loop.

Added expiry check at line 234, verified with regression test.
```

## Principles

- **Execution over reading**: Code tells you what it should do. Execution tells you what it actually does.
- **Evidence over theory**: Instrument and observe before concluding.
- **Reproduction over speculation**: Can't fix what you can't reproduce.
- **Verification over confidence**: The fix isn't done until tests prove it works.

If you find yourself writing "I believe..." or "This probably..." — STOP. Add instrumentation and prove it instead.
