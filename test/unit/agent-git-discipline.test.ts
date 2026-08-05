import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import { readFile } from 'fs/promises';

/**
 * INVARIANT: every agent-facing prompt carries the git-and-transport discipline
 * rules, and the two system-instruction variants carry the SAME rules.
 *
 * The mechanical walls (read-only shared git dir in containers, server-side
 * ownership checks on lazy_* tools) already exist, but agents were discovering
 * them by trial and error and improvising around them: one used `git stash` in a
 * worktree that shares its git dir with every other task and popped a foreign
 * stash, and one hand-rolled a daemon HTTP call after losing its MCP tools and
 * produced a real commit whose message was the literal string "undefined".
 * The prompts must state the boundary up front, as design rather than as a
 * missing capability, so an agent that hits it reports instead of routing around.
 *
 * system-instructions.md (fresh launch) and system-instructions-resume.md
 * (resume / auto-deliver) are separate files that are near-duplicates by
 * convention; a rule added to one and forgotten in the other silently disappears
 * for every resumed turn. This test pins them to byte-identical section text.
 */
describe('agent git-and-transport discipline prompts', () => {
  const promptsDir = join(import.meta.dir, '..', '..', 'src', 'prompts');
  const HEADING = '### Git and transport discipline';

  const readPrompt = (name: string) => readFile(join(promptsDir, name), 'utf-8');

  function extractSection(text: string, file: string): string {
    const start = text.indexOf(HEADING);
    expect(start, `${file} must contain "${HEADING}"`).toBeGreaterThanOrEqual(0);
    const end = text.indexOf('\n### ', start + HEADING.length);
    return (end === -1 ? text.slice(start) : text.slice(start, end)).trim();
  }

  test('both system-instruction variants carry an identical discipline section', async () => {
    const fresh = extractSection(await readPrompt('system-instructions.md'), 'system-instructions.md');
    const resume = extractSection(
      await readPrompt('system-instructions-resume.md'),
      'system-instructions-resume.md',
    );
    expect(resume).toBe(fresh);
  });

  test('the discipline section states each rule the incidents came from', async () => {
    const section = extractSection(await readPrompt('system-instructions.md'), 'system-instructions.md');

    // Allowed: inspection, staging, lazy_commit, conflict resolution.
    expect(section).toContain('git add');
    expect(section).toContain('`lazy_commit`');
    expect(section).toContain('Merge-conflict resolution');

    // Forbidden: history rewriting of any kind.
    expect(section).toContain('commit --amend');
    expect(section).toContain('rebase');
    expect(section).toContain('reset --hard');
    expect(section).toContain('append-only');

    // Forbidden: stash — the shared-git-dir incident.
    expect(section).toContain('git stash');
    expect(section).toContain('git archive');

    // Transport: lazy_* only; a lost channel is reported, not worked around.
    expect(section).toContain('curl');
    expect(section).toContain('`.lazy/`');
    expect(section).toMatch(/reportable condition/);
  });

  test('tool instructions forbid hand-rolled transport when lazy_* tools fail', async () => {
    const tools = await readPrompt('tool-instructions.md');
    expect(tools).toContain('ONLY sanctioned channel to lazy state');
    expect(tools).toContain('curl');
    expect(tools).toContain('reportable condition');
  });

  test('MCP server instructions carry the agent-scoped transport rule', async () => {
    const mcp = await readPrompt('mcp-server-instructions.md');
    // Scoped to agents on purpose: the daemon-HTTP fallback is builder-only,
    // and these instructions are served to the builder too.
    expect(mcp).toContain('Transport discipline (agents)');
    expect(mcp).toContain('reportable condition');
  });

  test('docker agent instructions name the container-enforced boundary', async () => {
    const docker = await readPrompt('docker-agent-instructions.md');
    expect(docker).toContain('git commit --amend');
    expect(docker).toContain('git stash');
    expect(docker).toContain('git archive');
    expect(docker).toContain('raw HTTP');
    // The boundary is design, not an obstacle to route around.
    expect(docker).toContain('not a hurdle to route around');
  });

  test('merge-turn prompts forbid stash (the stack is shared across worktrees)', async () => {
    for (const file of [
      'merge-conflict-resolution.md',
      'merge-conflict-resolution-resume.md',
      'remote-branch-merge.md',
      'remote-branch-merge-resume.md',
    ]) {
      const text = await readPrompt(file);
      expect(text, `${file} must forbid git stash`).toContain('git stash');
    }
  });

  test('no agent-facing prompt tells an agent to reach the daemon over HTTP', async () => {
    // The HTTP fallback is builder-only (shared-memory record
    // project-daemon-http-workaround); task agents must report and hand back.
    for (const file of [
      'system-instructions.md',
      'system-instructions-resume.md',
      'tool-instructions.md',
      'docker-agent-instructions.md',
      'mcp-server-instructions.md',
    ]) {
      const text = await readPrompt(file);
      expect(text, `${file} must not point agents at a daemon HTTP endpoint`).not.toMatch(
        /http:\/\/(localhost|127\.0\.0\.1)/,
      );
      expect(text, `${file} must not reference the builder daemon token file`).not.toContain(
        'daemon-mcp-builder',
      );
    }
  });
});

/**
 * The discipline text is worthless if a prompt-assembly path drops it. Every
 * agent launch composes tool-instructions + one of the system-instruction
 * variants, so assert the composed system prompt carries the section.
 */
describe('composed agent system prompts', () => {
  test('buildSystemPrompt includes the discipline section', async () => {
    const { buildSystemPrompt } = await import('../../src/cli/commands/shared');
    expect(buildSystemPrompt()).toContain('### Git and transport discipline');
  });

  test('buildSystemPromptForResume includes the discipline section', async () => {
    const { buildSystemPromptForResume } = await import('../../src/daemon/task-lifecycle');
    expect(buildSystemPromptForResume()).toContain('### Git and transport discipline');
  });
});
