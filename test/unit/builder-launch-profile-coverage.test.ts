/**
 * Every launch identity carries the profile its role RESOLVED to — never a
 * hard-coded profile name.
 *
 * Named for the builder defect that prompted it (below); the agent half at the
 * bottom guards the same class at agent launch sites, where a one-shot shipped
 * with no profile at all and silently took the primary upstream.
 *
 * This is a source scan rather than a behavioural test because the defect it
 * guards is a WIRING defect at each launch site, and each site sits behind a
 * different unreachable dependency (docker, a host Claude Code binary, a
 * builder-kind MCP token). `test/unit/auth-env.test.ts` pins the behaviour that
 * a resolved profile reaches the minted grant; this pins that every site
 * actually passes one.
 *
 * WHY IT MATTERS: the grant's profile is the proxy's routing key
 * (src/proxy/agent-upstreams.ts). Six builder sites hard-coded
 * `BUILDER_PROFILE_NAME`, so a project with `[models.roles.builder] agent =
 * "builder-ollama"` — a config `lazy builder --help` advertises — had its
 * endpoint reachability preflighted and its traffic then forwarded to the
 * primary Anthropic upstream on the primary credential. The daemon's own
 * relaunch path (`handleGetBuilderLaunchEnv`) already resolved it properly, so
 * the same builder routed one way at `docker run` and another after a daemon
 * restart.
 *
 * Same idiom as `test/unit/cli-flag-alias-coverage.test.ts` and
 * `test/unit/mcp-spawn-env-coverage.test.ts`: a class of bug that no single
 * suite would catch, scanned for at the source.
 */

import { describe, test, expect } from 'bun:test';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';

const SRC = join(import.meta.dir, '..', '..', 'src');

async function tsFilesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await tsFilesUnder(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * A builder launch identity's `profile` value, one per site.
 *
 * Anchored on `role: 'builder'` and capped at 400 characters so the match
 * cannot wander into an unrelated later object. Audit-hint objects (`{ role:
 * 'builder' }`, no profile) simply produce no match.
 *
 * Shorthand (`{ …, profile }`, how `oneshotLaunchIdentity` passes its resolved
 * parameter through) is a site too: it cannot be a hard-coded name, but it must
 * still be COUNTED, or a launch site disappears from this guard by being
 * written idiomatically. Machine one-shots run on the builder role, so the
 * shorthand form now lives on this side of the file.
 */
const BUILDER_IDENTITY =
  /role:\s*'builder'(?:\s+as\s+const)?\s*,[\s\S]{0,400}?profile(?:\s*:\s*([^,\n}]+))?\s*[,}]/g;

describe('builder launch identities carry the resolved profile', () => {
  test('no builder launch site hard-codes the profile name', async () => {
    const files = await tsFilesUnder(SRC);
    const offenders: string[] = [];
    let sites = 0;

    for (const file of files) {
      const text = await readFile(file, 'utf-8');
      for (const match of text.matchAll(BUILDER_IDENTITY)) {
        sites += 1;
        const expr = match[1]?.trim();
        // The value must be READ OFF a resolved role target. A bare constant
        // (or any string literal) is the regression. Shorthand carries a
        // parameter the caller already resolved and has no value to check.
        if (expr && !expr.includes('.profile')) {
          const line = text.slice(0, match.index).split('\n').length;
          offenders.push(`${file.slice(SRC.length + 1)}:${line} — profile: ${expr}`);
        }
      }
    }

    expect(offenders).toEqual([]);
    // A scan that matches nothing would pass vacuously forever. The exact count
    // is not the contract — that there are builder identities being checked is.
    expect(sites).toBeGreaterThanOrEqual(5);
  });

  // The same value must not creep back in as a literal, which the check above
  // would miss if a site were reformatted past the 400-char window.
  test('BUILDER_PROFILE_NAME is never the whole value of a profile field', async () => {
    const files = await tsFilesUnder(SRC);
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf-8');
      // `target?.profile || BUILDER_PROFILE_NAME` is fine — that is a fallback
      // for a caller that passed no target at all. `profile: BUILDER_PROFILE_NAME`
      // as the entire value is not.
      for (const match of text.matchAll(/profile:\s*BUILDER_PROFILE_NAME\s*[,}]/g)) {
        const line = text.slice(0, match.index).split('\n').length;
        offenders.push(`${file.slice(SRC.length + 1)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // Same class, other role. An agent identity's profile is resolved from the
  // task's own agent (`profileNameForAgent`) or from the role target the launch
  // env was built from (`target.profile`) — both computed, neither a literal.
  // Shorthand (`{ …, profile }`) cannot be a literal and is a site all the same.
  const AGENT_IDENTITY =
    /role:\s*'agent'(?:\s+as\s+const)?\s*,[\s\S]{0,400}?profile(?:\s*:\s*([^,\n}]+))?\s*[,}]/g;

  test('no agent launch site hard-codes the profile name', async () => {
    const files = await tsFilesUnder(SRC);
    const offenders: string[] = [];
    let sites = 0;

    for (const file of files) {
      const text = await readFile(file, 'utf-8');
      for (const match of text.matchAll(AGENT_IDENTITY)) {
        sites += 1;
        const expr = match[1]?.trim();
        if (expr && /^['"`]/.test(expr)) {
          const line = text.slice(0, match.index).split('\n').length;
          offenders.push(`${file.slice(SRC.length + 1)}:${line} — profile: ${expr}`);
        }
      }
    }

    expect(offenders).toEqual([]);
    // Vacuity guard, as above: the supervisor container launch and the one-shot
    // are the two agent identities that must always be here.
    expect(sites).toBeGreaterThanOrEqual(2);
  });
});
