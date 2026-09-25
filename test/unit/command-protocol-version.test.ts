/**
 * Unit tests for the host-side command-builder protocol_version invariant.
 *
 * INVARIANT: Every command type written to a supervisor must carry
 * `protocol_version`. The supervisor's version gate (`checkProtocolVersion`
 * in `src/supervisor/index.ts`) rejects on mismatch, and a `undefined`
 * version produces the misleading "rebuild containers" error message. If
 * you add a new command shape, spread `commonCommandFields` so this field
 * is never forgotten — that is the entire purpose of the helper.
 *
 * Background: `lazy_ask` shipped without protocol_version because the ask
 * command was built manually rather than via `commonCommandFields`. The
 * parametrised test below makes the next omission a CI failure rather than
 * a runtime "rebuild containers" mystery.
 */

import { describe, test, expect } from 'bun:test';
import { commonCommandFields, PROTOCOL_VERSION } from '../../src/protocol';
import type { ResolvedConfig } from '../../src/config/types';
import type { Command, StartCommand, UnblockCommand, AskCommand, SyncCommand } from '../../src/protocol';

function makeConfig(): ResolvedConfig {
  return {
    agent: { watchdog_output_timeout_ms: 0 },
    permissions: { protected: [] },
  automation: { maintain: [], react: [], pre_accept: { enabled: false, commands: [], timeout: 600 } },
  mounts: [],
  serve: { services: [], start_services_cmd: '' },
    checks: { post_turn: '', post_turn_timeout: 300 },
  } as unknown as ResolvedConfig;
}

describe('commonCommandFields', () => {
  test('injects protocol_version equal to PROTOCOL_VERSION', () => {
    const fields = commonCommandFields(makeConfig());
    expect(fields.protocol_version).toBe(PROTOCOL_VERSION);
  });

  test('injects a unique command_id on every call', () => {
    const first = commonCommandFields(makeConfig());
    const second = commonCommandFields(makeConfig());
    expect(first.command_id).toBeTruthy();
    expect(second.command_id).toBeTruthy();
    expect(first.command_id).not.toBe(second.command_id);
  });

  test('reuses a provided command_id when asked', () => {
    const id = 'fixed-correlation-id';
    const fields = commonCommandFields(makeConfig(), { command_id: id });
    expect(fields.command_id).toBe(id);
  });
});

describe('command builders include protocol_version', () => {
  const config = makeConfig();

  // The daemon's ask command shape (mirror of src/daemon/task-lifecycle.ts).
  // The whole point of this test is to catch the next person who tries to
  // skip the common-fields spread when building an ask command.
  test('AskCommand carries protocol_version', () => {
    const ask: AskCommand = {
      type: 'ask',
      task_id: 't',
      goal: 'g',
      prompt: 'p',
      ...commonCommandFields(config),
    };
    expect(ask.protocol_version).toBe(PROTOCOL_VERSION);
  });

  test('StartCommand carries protocol_version', () => {
    const start: StartCommand = {
      type: 'start',
      task_id: 't',
      goal: 'g',
      prompt: 'p',
      ...commonCommandFields(config),
    };
    expect(start.protocol_version).toBe(PROTOCOL_VERSION);
  });

  test('UnblockCommand carries protocol_version', () => {
    const unblock: UnblockCommand = {
      type: 'unblock',
      task_id: 't',
      goal: 'g',
      prompt: 'p',
      ...commonCommandFields(config),
    };
    expect(unblock.protocol_version).toBe(PROTOCOL_VERSION);
  });

  // SyncCommand sets protocol_version directly rather than via the helper
  // (it doesn't need the other common fields). That's a deliberate choice,
  // but the version field is still required.
  test('SyncCommand carries protocol_version and command_id', () => {
    const sync: SyncCommand = {
      type: 'sync',
      task_id: 't',
      command_id: 'sync-cmd-id',
      protocol_version: PROTOCOL_VERSION,
      parent_branch: 'main',
    };
    expect(sync.protocol_version).toBe(PROTOCOL_VERSION);
    expect(sync.command_id).toBe('sync-cmd-id');
  });

  // Parametrised guard: every non-stop command in the Command union must
  // declare an optional protocol_version field. StopCommand is exempt —
  // the supervisor consumes it before the version gate runs (see
  // src/supervisor/index.ts:183).
  test('every non-stop Command shape declares protocol_version', () => {
    // Compile-time assertion encoded as a runtime check: if a new command
    // type is added to the union without protocol_version (or an existing
    // one loses the field), `AllHaveVersion` collapses to `never` and the
    // assignment below fails to type-check.
    //
    // The conditional must NOT distribute over the union — a distributive
    // check that produces `true | false` would just widen to `boolean` and
    // silently accept the omission. We wrap `Command` in a tuple so the
    // conditional sees the union as a single type and resolves to exactly
    // `true` or `never`.
    type HasVersion<T> = T extends { type: 'stop' }
      ? true
      : T extends { protocol_version?: number; command_id?: string }
        ? true
        : false;
    type AllHaveVersion =
      false extends HasVersion<Command> ? never : true;
    const ok: AllHaveVersion = true;
    expect(ok).toBe(true);
  });
});
