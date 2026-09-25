/**
 * The demo agent's stream-json output, fed to the REAL parser.
 *
 * INVARIANT: every event kind `src/demo/agent.ts` emits must parse to the
 * activity kind it is meant to be, through `ClaudeCodeActivityStream` itself.
 * The demo agent is a second fake alongside `test/helpers/fake-claude.ts`, and
 * the failure that reaches a user is never "two fakes disagree with each other"
 * — it is one of them disagreeing with the parser. When that happens the
 * supervisor's watchdog stops seeing progress, and a demo turn HANGS instead of
 * failing, which is the expensive shape of the bug.
 *
 * The samples come from the demo agent module rather than being written out
 * here, so a shape that changes there cannot leave this test asserting on a
 * copy that no longer exists anywhere.
 */

import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { ClaudeCodeActivityStream } from '../../src/agent/activity-stream';
import {
  demoAgentEventSamples,
  demoSessionStartEvent,
  demoToolUseEvent,
  demoToolResultEvent,
  demoResultEvent,
} from '../../src/demo/agent';

const stream = new ClaudeCodeActivityStream();

function parse(event: Record<string, unknown>) {
  return stream.parseLine(JSON.stringify(event));
}

describe('demo agent stream-json events', () => {
  test('the session-start line is recognized as a session start, carrying its id', () => {
    const event = parse(demoSessionStartEvent('demo-sess-x'));
    expect(event?.kind).toBe('session_start');
    expect(event?.sessionId).toBe('demo-sess-x');
  });

  test('a tool_use block is recognized as tool activity', () => {
    // INVARIANT: this is what the no-progress watchdog counts as progress. A
    // demo turn that emitted an unrecognized shape here would be killed
    // mid-turn as silent, which looks like a lazy bug rather than a fake one.
    const event = parse(demoToolUseEvent('toolu_x'));
    expect(event?.kind).toBe('tool_start');
    expect(event?.toolUseId).toBe('toolu_x');
  });

  test('a tool_result block is recognized as the end of that tool call', () => {
    const event = parse(demoToolResultEvent('toolu_x'));
    expect(event?.kind).toBe('tool_end');
    expect(event?.toolUseId).toBe('toolu_x');
  });

  test('the result line is recognized as the turn result, carrying its session id', () => {
    // The supervisor takes the turn's summary and its end from this line; an
    // unrecognized result is a turn that never appears to finish.
    const event = parse(demoResultEvent('Demo turn finished.', 'demo-sess-x'));
    expect(event?.kind).toBe('result');
    expect(event?.sessionId).toBe('demo-sess-x');
  });

  // INVARIANT: the keep-alive a held-open turn emits is a COMPLETED STEP, not a
  // heartbeat. Lazy deliberately does not count a stuck tool call's keep-alives
  // as progress (otherwise a wedged call would never be caught), so a hold built
  // on `tool_progress` would still be killed by the watchdog — which is exactly
  // what happened when the hold was a bare sleep: the advertised `working` task
  // always became `interrupted` around the 30-minute mark.
  test('the hold keep-alive is a completed step, so it resets the watchdog', () => {
    const start = parse(demoToolUseEvent('toolu_demo_hold_1', 'Read'));
    const end = parse(demoToolResultEvent('toolu_demo_hold_1'));

    expect(start?.kind).toBe('tool_start');
    expect(end?.kind).toBe('tool_end');
    // Not a heartbeat: that kind is liveness, and liveness is not progress.
    expect(start?.kind).not.toBe('heartbeat');
    expect(end?.kind).not.toBe('heartbeat');
  });

  test('every sample the demo agent can emit parses to something', () => {
    // Belt and braces for a kind added to the agent without a case above: the
    // parser returns null for a line it cannot make sense of, and null is the
    // value that silently costs the watchdog its progress signal.
    for (const sample of demoAgentEventSamples()) {
      expect(parse(sample)).not.toBeNull();
    }
  });
});

/**
 * The agent source is a `String.raw` template, and a backtick inside it ends
 * the template early.
 *
 * That has broken the build three separate times while writing this command,
 * always the same way: a comment written in normal prose style, with a
 * `backticked` identifier in it, silently terminating the literal and producing
 * a wall of unrelated syntax errors thirty lines further down. It is caught by
 * the typechecker, but only after the fact and never legibly — so it is worth
 * one cheap scan that says what actually happened.
 */
describe('the generated agent source', () => {
  // INVARIANT: no backtick may appear inside DEMO_AGENT_SOURCE. The template
  // that carries it is delimited by backticks, so one inside it is not an
  // escaping nuisance — it is the end of the string.
  test('contains no backtick that would terminate its own template', async () => {
    const source = await readFile(
      join(resolve(import.meta.dir, '../..'), 'src', 'demo', 'agent.ts'),
      'utf-8',
    );

    const start = source.indexOf('String.raw`');
    expect(start).toBeGreaterThan(-1);

    const body = source.slice(start + 'String.raw`'.length);
    const end = body.indexOf('`');
    expect(end).toBeGreaterThan(-1);

    // The template must end at the closing line, not somewhere in the middle of
    // the agent. If a stray backtick closed it early, everything after that
    // point is no longer part of the generated script.
    const terminator = body.slice(end).split('\n')[0];
    expect(terminator.trim()).toBe('`;');
  });
});
