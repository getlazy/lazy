import { describe, expect, test } from 'bun:test';
import { applyBuilderPromptPlaceholders } from '../../src/builder/system-prompt';
import dockerBuilderInstructions from '../../src/prompts/docker-builder-runner-instructions.md' with { type: 'text' };

const base = { runnerInstructions: dockerBuilderInstructions, chattinessSnippet: '', dashboardSection: 'DASH' };

describe('builder prompt scratch location', () => {
  // INVARIANT: a Lazy Teams (detached) builder is never told its scratch path is
  // valid on anybody's host. Its $LAZY_SCRATCH_DIR is a container-only mount
  // (/lazy-builder/scratch), so a member handed that path cannot open it — they
  // read scratch only through the captured copy (`lazy scratch show`).
  test('store access: no same-path-on-host promise, points at lazy scratch show', () => {
    const prompt = applyBuilderPromptPlaceholders({ ...base, scratchAccess: 'store' });
    expect(prompt).not.toContain('{{SCRATCH_LOCATION}}');
    expect(prompt).not.toMatch(/same absolute path on the engineer/);
    expect(prompt).not.toMatch(/identical path on the engineer/);
    expect(prompt).toContain('exists ONLY inside your container');
    expect(prompt).toContain('lazy scratch show');
  });

  test('host access (default): keeps the pastes-into-your-shell wording', () => {
    const prompt = applyBuilderPromptPlaceholders(base);
    expect(prompt).not.toContain('{{SCRATCH_LOCATION}}');
    expect(prompt).toContain('same absolute path on the engineer');
  });
});

describe('builder launch paths choose the right scratch wording', () => {
  const src = (p: string) => Bun.file(new URL(`../../${p}`, import.meta.url)).text();

  // INVARIANT: the detached (Teams) builder session always gets the store
  // wording — its scratch is the container-only /lazy-builder/scratch.
  test('detached builder sessions pass store', async () => {
    const s = await src('src/daemon/builder-sessions.ts');
    expect(s).toMatch(/assembleBuilderSystemPrompt\(\{[^}]*scratchAccess: 'store'/);
  });

  // INVARIANT: the review-conversation builder mounts scratch at the daemon
  // host's path, which in managed mode is a VM no member can open — so managed
  // mode gets the store wording.
  test('review-conversation builder picks store under managed mode', async () => {
    const s = await src('src/daemon/review-session-builder-turn.ts');
    expect(s).toMatch(/scratchAccess: isManagedMode\(\) \? 'store' : 'host'/);
  });
});
