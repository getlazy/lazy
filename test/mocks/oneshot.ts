/**
 * Mock implementation of src/oneshot/index.ts for e2e tests.
 *
 * Machine one-shots have their own production module now (daemon -> Runner ->
 * runner infra), so they get their own mock: this one replaces the DISPATCHER,
 * which means no test ever reaches the daemon RPC, the runner, or a container.
 *
 * The real callers make N+1 calls (a map pass per unit, then a reduce), so the
 * mock dispatches on the stage marker each caller stamps into its prompt:
 *
 *   LAZY_CONV_ASK_STAGE: single|map|reduce   — `lazy ask` / lazy_conversation_ask
 *   LAZY_TASK_RECORD_ASK_STAGE: single|map|reduce — `lazy ask <task>` answered
 *                                              from the task's stored record
 *   LAZY_REPORT_STAGE:   task|commit|reduce  — `lazy report`'s map-reduce
 *   LAZY_MEMORY_COMPACT                      — `lazy memory compact`
 *   LAZY_LINK_DESCRIBE                       — `lazy link` / `lazy describe`
 *
 * With no marker it falls through to the shared `LAZY_MOCK_CLAUDE_RESPONSE`
 * default, matching the other callers.
 *
 * Test-only knobs:
 *   LAZY_MOCK_FAIL_KEYWORD        — prompt contains it at a MAP stage -> throw
 *                                   (a map failure the reduce must survive).
 *   LAZY_MOCK_CONV_ASK_IRRELEVANT — comma-separated 1-based excerpt indexes
 *                                   whose ask map pass returns NOTHING_RELEVANT.
 *   LAZY_MOCK_COMPACT_FAIL / LAZY_MOCK_COMPACT_RESPONSE — see the compact branch.
 *
 * Must export every symbol that source files import from src/oneshot/index.ts:
 * `mock.module` replaces the module WHOLESALE, and an importer of a symbol the
 * mock omits fails at import time.
 */

import type { AgentResponse } from '../../src/types';
import type { OneshotRequest } from '../../src/oneshot/types';
import { getMockResponse } from './mock-response';

export type { OneshotRequest, OneshotRepoAccess } from '../../src/oneshot/types';

export async function runOneshot(req: OneshotRequest): Promise<AgentResponse> {
  const prompt = req.prompt;
  // --- Conversation ask (`lazy ask <conversation-id>`, lazy_conversation_ask) ---
  //
  // Same stage-marker dispatch as the report mock below, on its own markers.
  // The `[ro]` suffix echoes whether the caller asked for a read-only one-shot,
  // so a test can assert the lockdown is requested without spawning an agent.
  //
  //   LAZY_MOCK_CONV_ASK_IRRELEVANT — comma-separated 1-based excerpt indexes
  //                                   whose map pass returns NOTHING_RELEVANT.
  {
    const ro = req.repoAccess === 'read-only' ? '[ro]' : '';
    if (prompt.includes('LAZY_CONV_ASK_STAGE: single')) {
      const q = prompt.match(/## Question\n\n([^\n]*)/)?.[1] ?? '';
      return {
        result: `[conv-ask:single]${ro} mocked answer to: ${q}`,
        session_id: 'mock-conv-ask',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    }
    if (prompt.includes('LAZY_CONV_ASK_STAGE: map')) {
      const idx = prompt.match(/## Excerpt (\d+) of (\d+)/)?.[1] ?? '?';
      const failKeyword = process.env.LAZY_MOCK_FAIL_KEYWORD;
      if (failKeyword && prompt.includes(failKeyword)) {
        throw new Error('mock claude failure (sentinel matched)');
      }
      const irrelevant = (process.env.LAZY_MOCK_CONV_ASK_IRRELEVANT ?? '')
        .split(',').map(s => s.trim()).filter(Boolean);
      if (irrelevant.includes(idx)) {
        return { result: 'NOTHING_RELEVANT', session_id: `mock-conv-map-${idx}`, usage: { input_tokens: 1, output_tokens: 1 } };
      }
      return {
        result: `[conv-ask:map:${idx}]${ro} mocked finding from excerpt ${idx}.`,
        session_id: `mock-conv-map-${idx}`,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    }
    if (prompt.includes('LAZY_CONV_ASK_STAGE: reduce')) {
      const markers = Array.from(prompt.matchAll(/\[conv-ask:map:(\d+)\]/g)).map(mm => `[conv-ask:map:${mm[1]}]`);
      return {
        result: `[conv-ask:reduce]${ro} mocked answer from ${markers.length} excerpt(s): ${markers.join(' ')}`,
        session_id: 'mock-conv-reduce',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    }
  }

  // --- Task-record ask (`lazy ask <task>` with no live session to resume) ---
  //
  // Same stage-marker dispatch as the conversation ask, on its own markers. The
  // answer echoes the question and whether the prompt actually carried the
  // task's record, so a test can assert WHAT the answer was derived from
  // without spawning an agent.
  {
    const ro = req.repoAccess === 'read-only' ? '[ro]' : '';
    if (prompt.includes('LAZY_TASK_RECORD_ASK_STAGE: single')) {
      const q = prompt.match(/## Question\n\n([^\n]*)/)?.[1] ?? '';
      const turns = (prompt.match(/--- turn \d+:/g) ?? []).length;
      return {
        result: `[record-ask:single]${ro} mocked answer from ${turns} turn(s) to: ${q}`,
        session_id: 'mock-record-ask',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    }
    if (prompt.includes('LAZY_TASK_RECORD_ASK_STAGE: map')) {
      const idx = prompt.match(/## Excerpt (\d+) of (\d+)/)?.[1] ?? '?';
      return {
        result: `[record-ask:map:${idx}]${ro} mocked finding from excerpt ${idx}.`,
        session_id: `mock-record-map-${idx}`,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    }
    if (prompt.includes('LAZY_TASK_RECORD_ASK_STAGE: reduce')) {
      const markers = Array.from(prompt.matchAll(/\[record-ask:map:(\d+)\]/g)).map(mm => `[record-ask:map:${mm[1]}]`);
      return {
        result: `[record-ask:reduce]${ro} mocked answer from ${markers.length} excerpt(s)`,
        session_id: 'mock-record-reduce',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    }
  }

  // --- Linked-task description (`lazy link`'s last phase, `lazy describe`) ---
  //
  // Answers in the real format (a GOAL line, `---`, then the body) so the
  // parser under test is the production one. Echoes the branch and whether any
  // comments reached the prompt, so a test can assert WHAT was assembled.
  //
  //   LAZY_MOCK_LINK_DESCRIBE_FAIL=1 — throw, exercising the "link still
  //                                    succeeds, with a warning" path.
  if (prompt.includes('LAZY_LINK_DESCRIBE')) {
    if (process.env.LAZY_MOCK_LINK_DESCRIBE_FAIL === '1') {
      throw new Error('mock claude failure (link description)');
    }
    const branch = prompt.match(/^Branch: (.+)$/m)?.[1] ?? 'unknown';
    const base = prompt.match(/^Base branch: (.+)$/m)?.[1] ?? 'unknown';
    const hasComments = !prompt.includes('_(no comments)_');
    // Echo the material blocks (bounded) so a test can assert WHICH commits and
    // WHICH files reached the prompt — that is how the diff base is pinned.
    const section = (name: string, max: number) =>
      (prompt.match(new RegExp(`=== BEGIN ${name}[^\\n]*===\\n([\\s\\S]*?)\\n=== END ${name} ===`))?.[1] ?? '')
        .slice(0, max);
    return {
      result: [
        `GOAL: Describe ${branch}`,
        '---',
        '[link-describe] Mocked description of the linked branch.',
        '',
        `Branch: ${branch}. Base: ${base}. Comments in prompt: ${hasComments ? 'yes' : 'no'}.`,
        '',
        `Commits seen: ${section('COMMITS', 400)}`,
        '',
        `Diff seen: ${section('DIFF', 400)}`,
      ].join('\n'),
      session_id: 'mock-link-describe',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }

  // Only fail at map stages — the reduce prompt may legitimately echo the
  // failure keyword in the failed-units list, and we don't want that to
  // cascade into a reduce failure too.
  const failKw = process.env.LAZY_MOCK_FAIL_KEYWORD;
  const isMap = prompt.includes('LAZY_REPORT_STAGE: task') || prompt.includes('LAZY_REPORT_STAGE: commit');
  if (failKw && isMap && prompt.includes(failKw)) {
    throw new Error(`mock claude failure (sentinel matched)`);
  }

  if (prompt.includes('LAZY_REPORT_STAGE: task')) {
    // Extract the task display id from the bundle header
    // `### Task <code> — <goal>`.
    const m = prompt.match(/### Task ([^\s—]+)/);
    const code = m ? m[1] : 'unknown';
    return {
      result: `[map:task:${code}] mocked lead-tier summary for task ${code}.`,
      session_id: `mock-task-${code}`,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }

  if (prompt.includes('LAZY_REPORT_STAGE: commit')) {
    // Extract the short SHA from `### Commit <sha7> on main`.
    const m = prompt.match(/### Commit ([0-9a-f]{7,40}) on main/);
    const sha = m ? m[1].slice(0, 7) : 'unknown';
    return {
      result: `[map:commit:${sha}] mocked lead-tier summary for commit ${sha}.`,
      session_id: `mock-commit-${sha}`,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }

  // Memory compaction (`lazy memory compact`, LLM path). Deterministic and
  // deliberately TINY so the real "a compact must be smaller than the index it
  // replaces" guard is satisfied: one line naming every record in backticks.
  //
  //   LAZY_MOCK_COMPACT_FAIL=1        — throw (exercises the mechanical fallback)
  //   LAZY_MOCK_COMPACT_RESPONSE=...  — return this verbatim (used to exercise the
  //                                     omitted-name repair path with a summary
  //                                     that skips names on purpose)
  if (prompt.includes('LAZY_MEMORY_COMPACT')) {
    if (process.env.LAZY_MOCK_COMPACT_FAIL === '1') {
      throw new Error('mock claude failure (memory compaction)');
    }
    const override = process.env.LAZY_MOCK_COMPACT_RESPONSE;
    if (override !== undefined) {
      return { result: override, session_id: 'mock-compact', usage: { input_tokens: 1, output_tokens: 1 } };
    }
    const names = Array.from(prompt.matchAll(/^### `([a-z0-9-]+)`/gm)).map(mm => mm[1]);
    return {
      result: `## Mocked memory summary\n\n- ${names.map(n => `\`${n}\``).join(', ')}`,
      session_id: 'mock-compact',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }

  if (prompt.includes('LAZY_REPORT_STAGE: reduce')) {
    // Always synthesize for the reduce stage — tests that need the
    // synthesized body to be observable shouldn't have to fight the
    // harness's default `LAZY_MOCK_CLAUDE_RESPONSE`. The synthesis
    // echoes every `[map:...]` marker from the units block so tests
    // can verify map outputs flow into the reduce input.
    const markers = Array.from(prompt.matchAll(/\[map:(task|commit):([^\]]+)\]/g))
      .map(mm => `[map:${mm[1]}:${mm[2]}]`);
    const leadBody = markers.length > 0
      ? markers.map(m => `- ${m}`).join('\n')
      : 'Nothing of note in this window.';
    const result = [
      '## Brief',
      '',
      `Mocked digest covering ${markers.length} unit(s).`,
      '',
      '## For the engineering manager',
      '',
      '- Mocked manager-tier bullet.',
      '',
      '## For the engineering lead',
      '',
      leadBody,
    ].join('\n');
    return {
      result,
      session_id: 'mock-reduce',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }

  return getMockResponse();
}

/**
 * The daemon-side entry point. Same behavior: a mocked run never reaches a
 * Runner, so there is nothing for the two paths to differ about.
 */
export async function runOneshotWithRunner(
  req: OneshotRequest,
  _projectRoot?: string,
): Promise<AgentResponse> {
  return runOneshot(req);
}

/**
 * The usage-pause admission of a one-shot COMMAND (src/oneshot/index.ts). A
 * mocked run spends nothing, so every command is admitted and `run` just runs;
 * the daemon side of the admission is real and covered where a daemon runs it.
 */
export interface OneshotCommand {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export async function admitOneshotCommand(_opts: { actor?: string } = {}): Promise<OneshotCommand> {
  return { run: (fn) => fn() };
}
