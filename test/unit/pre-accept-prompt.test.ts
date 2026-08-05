/**
 * Unit tests for the host-side pre-accept prompt renderer.
 *
 * INVARIANT: the built-in post-mortem is NOT a config knob. Every pre-accept
 * turn — even with no gate commands and no maintained-file groups — must ask the
 * agent to append a short retrospective to the task JOURNAL (append-only,
 * prompt-immune). The e2e suite drives a MOCK agent that cannot actually run
 * `lazy_journal`, so the guarantee that "the post-mortem is recorded" is enforced
 * here at the prompt-construction boundary instead: if the journaling step is
 * ever dropped or made conditional, this test fails.
 */

import { describe, test, expect } from 'bun:test';
import { renderPreAcceptPrompt } from '../../src/supervisor/pre-accept';
import type { MaintainEntry } from '../../src/config/types';

const CHANGELOG: MaintainEntry = {
  title: 'changelog',
  pattern: 'CHANGELOG.md',
  instructions: 'Add a line describing your work.',
};

describe('renderPreAcceptPrompt', () => {
  // INVARIANT: the post-mortem journaling instruction is unconditional — it must
  // appear even when the project configures no commands and no maintained files.
  test('always includes the built-in post-mortem journaling instruction', () => {
    const prompt = renderPreAcceptPrompt([], []);
    expect(prompt).toContain('lazy_journal');
    expect(prompt).toContain('post-mortem');
    // The retrospective must go to the journal, explicitly NOT a comment or code.
    expect(prompt).toContain('Do NOT put it in a comment or in the code.');
  });

  // INVARIANT: the ONLY built-in behavior is the journaled post-mortem. With no
  // commands and no maintained-file groups, the rendered turn is the post-mortem
  // alone — no acceptance-checks step, no maintained-files step, and no filler
  // prose standing in for the omitted sections. Every other instruction must come
  // from configuration, never be hardcoded into lazy's built-in prompt.
  test('with no config, renders ONLY the post-mortem step', () => {
    const prompt = renderPreAcceptPrompt([], []);
    // The post-mortem is the sole numbered step.
    expect(prompt).toContain('## 1. Record a short post-mortem');
    expect(prompt).not.toContain('## 2.');
    // No acceptance-checks step and no filler for the absent commands section.
    expect(prompt).not.toContain('acceptance checks');
    expect(prompt).not.toContain('nothing to run');
    // No maintained-files step and no CHANGELOG/docs fallback nudge.
    expect(prompt).not.toContain('maintained');
    expect(prompt).not.toContain('CHANGELOG');
  });

  test('renders configured gate commands as the first step, post-mortem after', () => {
    const prompt = renderPreAcceptPrompt(['bun test', 'bun run build'], []);
    expect(prompt).toContain('## 1. Run the acceptance checks');
    expect(prompt).toContain('bun test');
    expect(prompt).toContain('bun run build');
    // No maintained-files step (none configured); post-mortem is step 2.
    expect(prompt).not.toContain('Bring maintained files up to date');
    expect(prompt).toContain('## 2. Record a short post-mortem');
  });

  test('with no commands but maintained groups, omits the checks step and renders maintain first', () => {
    const prompt = renderPreAcceptPrompt([], [CHANGELOG]);
    // No acceptance-checks step or filler when no commands are configured.
    expect(prompt).not.toContain('Run the acceptance checks');
    expect(prompt).not.toContain('nothing to run');
    // Maintained groups render so accept-time enforces completeness.
    expect(prompt).toContain('## 1. Bring maintained files up to date');
    expect(prompt).toContain('CHANGELOG.md');
    expect(prompt).toContain('Add a line describing your work.');
    expect(prompt).toContain('## 2. Record a short post-mortem');
  });

  test('with both commands and maintained groups, numbers all three steps in order', () => {
    const prompt = renderPreAcceptPrompt(['true'], [CHANGELOG]);
    expect(prompt).toContain('## 1. Run the acceptance checks');
    expect(prompt).toContain('## 2. Bring maintained files up to date');
    expect(prompt).toContain('## 3. Record a short post-mortem');
  });

  // The template must never hardcode CHANGELOG-specific guidance — that belongs
  // in a project's [[automation.maintain]] instructions, not lazy's built-in
  // prompt. The maintained-files step renders the configured group's own
  // instructions and nothing more.
  test('maintained-files step carries no hardcoded CHANGELOG prose', () => {
    const prompt = renderPreAcceptPrompt([], [CHANGELOG]);
    // The only CHANGELOG mention comes from the configured group, not the template.
    expect(prompt).not.toContain('write a single entry');
    expect(prompt).not.toContain('The CHANGELOG entry in particular');
  });
});
