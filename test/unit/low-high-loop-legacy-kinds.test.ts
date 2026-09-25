/**
 * The low-high loop was renamed from the "Ivan loop", and its supervised
 * follow-up kinds and supervisor phases were spelled `ivan_review` /
 * `ivan_revise` / `ivan_review_done` / `ivan_revise_done` before the rename.
 *
 * INVARIANT: those spellings are still READ correctly, and compatibility lives
 * at the protocol read boundary alone. A supervisor that started before an
 * upgrade keeps writing the old spellings into its status/response files for
 * the rest of its turn, and the host that reads them may already be the new
 * build — a status file that renders as "unknown phase", or a review turn that
 * loses its heading, is the failure this guards.
 *
 * Nothing WRITES the old spellings any more, and no store is migrated in place:
 * normalization happens on the way in, so everything downstream switches on the
 * current spelling only and needs no `||` checks of its own.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  normalizeSupervisedKind,
  normalizeSupervisorPhase,
  readResponse,
  readStatus,
  writeStatus,
  completedResponses,
  type CompletedResponse,
  type SupervisorStatus,
} from '../../src/protocol';
import { readSupervisorStatusAsync } from '../../src/utils/working-substate';

const LEGACY_TO_CURRENT: Array<[string, string]> = [
  ['ivan_review', 'low_high_review'],
  ['ivan_review_done', 'low_high_review_done'],
  ['ivan_revise', 'low_high_revise'],
  ['ivan_revise_done', 'low_high_revise_done'],
];

describe('low-high loop legacy spellings', () => {
  test('every legacy phase maps onto its current spelling', () => {
    for (const [legacy, current] of LEGACY_TO_CURRENT) {
      expect(normalizeSupervisorPhase(legacy)).toBe(current as never);
    }
  });

  test('a phase that was never renamed passes through untouched', () => {
    expect(normalizeSupervisorPhase('work')).toBe('work');
    expect(normalizeSupervisedKind('maintain')).toBe('maintain');
    expect(normalizeSupervisedKind('permission_pushback')).toBe('permission_pushback');
  });

  // The two kinds that appear on a supervised follow-up (the `_done` phases are
  // status-only and never reach `supervised.kind`).
  test('legacy supervised kinds map onto their current spelling', () => {
    expect(normalizeSupervisedKind('ivan_review')).toBe('low_high_review');
    expect(normalizeSupervisedKind('ivan_revise')).toBe('low_high_revise');
  });

  describe('reading files a pre-rename supervisor wrote', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'low-high-legacy-'));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    async function writeRawStatus(phase: string): Promise<void> {
      // Written by hand, not through writeStatus(), because the current type
      // union no longer admits the old spellings — which is the point.
      await writeFile(
        join(dir, 'status.json'),
        JSON.stringify({ version: 3, task_id: 't1', phase, updated_at: new Date().toISOString() }),
      );
    }

    for (const [legacy, current] of LEGACY_TO_CURRENT) {
      test(`readStatus normalizes '${legacy}'`, async () => {
        await writeRawStatus(legacy);
        expect(readStatus(dir)?.phase).toBe(current as never);
      });

      // The async status read in working-substate.ts is a SECOND path onto the
      // same file (the daemon's substate derivation) and must not diverge.
      test(`readSupervisorStatusAsync normalizes '${legacy}'`, async () => {
        await writeRawStatus(legacy);
        const status = await readSupervisorStatusAsync(dir);
        expect(status?.phase).toBe(current as never);
      });
    }

    test('readResponse normalizes every supervised kind in a bundle', async () => {
      const invocation = (kind: string | undefined): Record<string, unknown> => ({
        status: 'completed',
        result: 'ok',
        session_id: 's1',
        usage: { input_tokens: 0, output_tokens: 0 },
        ...(kind ? { supervised: { kind, prompt: 'p' } } : {}),
      });

      await writeFile(
        join(dir, 'response.json'),
        JSON.stringify({
          status: 'completed',
          responses: [invocation(undefined), invocation('ivan_review'), invocation('ivan_revise')],
        }),
      );

      const response = readResponse(dir);
      expect(response).not.toBeNull();
      const kinds = completedResponses(response as CompletedResponse).map((r) => r.supervised?.kind);
      expect(kinds).toEqual([undefined, 'low_high_review', 'low_high_revise']);
    });

    test('a single (non-bundle) response is normalized too', async () => {
      await writeFile(
        join(dir, 'response.json'),
        JSON.stringify({
          status: 'completed',
          result: 'ok',
          session_id: 's1',
          usage: { input_tokens: 0, output_tokens: 0 },
          supervised: { kind: 'ivan_revise', prompt: 'p' },
        }),
      );

      const response = readResponse(dir) as CompletedResponse;
      expect(response.supervised?.kind).toBe('low_high_revise');
    });

    // A status file the CURRENT supervisor wrote must round-trip unchanged —
    // normalization is a compatibility shim, not a rewrite of live values.
    test('a current-spelling status round-trips untouched', async () => {
      const now = new Date().toISOString();
      const status: SupervisorStatus = {
        task_id: 't1',
        command_type: 'start',
        phase: 'low_high_review',
        started_at: now,
        updated_at: now,
        pid: process.pid,
      };
      await mkdir(dir, { recursive: true });
      writeStatus(dir, status);

      expect(readStatus(dir)?.phase).toBe('low_high_review');
    });
  });
});
