/**
 * Imported endpoints and agent profiles become usable only when a project
 * admin CONFIRMS them: the control plane then records the text judged by its
 * own rules. Until then they are listed as waiting, and a refusal on one says so.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm, mkdir, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../../src/config/loader';
import { MANAGED_CONFIG_ENV } from '../../src/config/managed';
import { agentProfileOrThrow, agentProfilesFor } from '../../src/config/agent-profiles';
import { PROFILE_AWAITING_CONFIRMATION } from '../../src/config/agent-profile-advice';
import { readConnections } from '../../src/config/connection-consent';
import { applyProjectConfig, readProjectConnections } from '../../src/daemon/project-config';
import { resetRunningProxy } from '../../src/daemon/proxy-fingerprint';

const ENV_KEYS = ['LAZY_MANAGED', 'LAZY_MANAGED_STORAGE_PATH', MANAGED_CONFIG_ENV, 'LAZY_CONFIG'];

const IMPORTED = `[endpoints.lunaroute]
url = "http://lunaroute.internal:8080"
credential = "lunaroute"

[agents.pi-lunaroute-glm-5-3]
harness = "pi"
model = "glm-5.3"
named_endpoint = "lunaroute"

[agents.security]
harness = "claude-code"
model = "claude-opus-5-5"
`;

// The repository gained a profile after the import.
const REPOSITORY = IMPORTED + `
[agents.pi-later]
harness = "claude-code"
tiers = [ { endpoint = "lunaroute", model = "claude-opus-5-5" } ]
`;

let base: string;
let root: string;
let saved: Record<string, string | undefined>;

function refusal(config: Awaited<ReturnType<typeof loadConfig>>, name: string): string {
  try {
    agentProfileOrThrow(agentProfilesFor(config), name);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error(`expected profile ${name} to be refused`);
}

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  base = await realpath(await mkdtemp(join(tmpdir(), 'lazy-consent-')));
  root = join(base, 'repo');
  await mkdir(root, { recursive: true });
  await mkdir(join(base, 'fleet', 'store'), { recursive: true });
  process.env.LAZY_MANAGED = '1';
  process.env.LAZY_MANAGED_STORAGE_PATH = join(base, 'fleet', 'store');
  process.env[MANAGED_CONFIG_ENV] = join(base, 'fleet', 'config', 'lazy.toml');
  await writeFile(join(root, 'lazy.toml'), REPOSITORY);
});

afterEach(async () => {
  resetRunningProxy();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(base, { recursive: true, force: true });
});

describe('connections awaiting confirmation', () => {
  test('lists each endpoint with the profiles that use it, and what waits for confirmation', () => {
    const read = readConnections(IMPORTED, 'repository', null);
    expect(read.endpoints).toEqual([{
      name: 'lunaroute', url: 'http://lunaroute.internal:8080', credential: 'lunaroute',
      usedBy: ['pi-lunaroute-glm-5-3'], status: 'awaiting-confirmation', reason: expect.any(String),
    }]);
    expect(read.profiles.find((p) => p.name === 'pi-lunaroute-glm-5-3')).toMatchObject({ status: 'awaiting-confirmation' });
    expect(read.profiles.find((p) => p.name === 'security')).toMatchObject({ status: 'usable' });
    expect(read.confirmable).toBe(true);
  });

  test('once judged by the control plane\'s rules nothing waits', () => {
    const read = readConnections(IMPORTED, 'control-plane', IMPORTED);
    expect(read.confirmable).toBe(false);
    expect([...read.endpoints, ...read.profiles].every((c) => c.status === 'usable')).toBe(true);
  });

  // INVARIANT: a project imported before the repository gained a block is not
  // stuck without it — confirming brings it in, verbatim, and it is listed first.
  test('names blocks only the repository defines, with text that reparses to the same block', () => {
    const read = readConnections(IMPORTED, 'control-plane', REPOSITORY);
    expect(read.fromRepository.profiles).toEqual(['pi-later']);
    expect(read.fromRepository.toml).toContain('[agents.pi-later]');
    expect(read.profiles.find((p) => p.name === 'pi-later')).toMatchObject({ status: 'awaiting-confirmation', namedEndpoints: ['lunaroute'] });
    expect(read.confirmable).toBe(true);
    const merged = Bun.TOML.parse(`${IMPORTED}\n${read.fromRepository.toml}`) as { agents: Record<string, unknown> };
    expect(merged.agents['pi-later']).toEqual((Bun.TOML.parse(REPOSITORY) as { agents: Record<string, unknown> }).agents['pi-later']);
  });

  test('a block it cannot copy on its own is reported, not mangled', () => {
    const repo = IMPORTED + '\n[agents]\ninline = { harness = "pi" }\n';
    const read = readConnections(IMPORTED, 'control-plane', repo);
    expect(read.fromRepository.toml).toBe('');
    expect(read.fromRepository.skipped.map((s) => s.key)).toEqual(['agents.inline']);
  });

  test('the RPC reads the repository lazy.toml itself and refuses an unnamed origin', async () => {
    const read = await readProjectConnections(root, IMPORTED, 'repository');
    expect(read.fromRepository.profiles).toEqual(['pi-later']);
    await expect(readProjectConnections(root, IMPORTED, undefined)).rejects.toThrow(/origin/);
  });
});

describe('"Unknown agent profile" says what is true', () => {
  // INVARIANT: an imported profile withheld only because nobody confirmed its
  // endpoint is told so — with the words the control plane links to its page —
  // never reported as nonexistent. The engineer got a flat "unknown" on fabricate.
  test('an imported profile waits for an admin', async () => {
    await applyProjectConfig(root, IMPORTED, 1, 'repository');
    const message = refusal(await loadConfig(root), 'pi-lunaroute-glm-5-3');
    expect(message).toContain(PROFILE_AWAITING_CONFIRMATION);
    expect(message).toContain('Endpoints and agent profiles');
  });

  test('confirming (the control plane\'s rules) makes it usable', async () => {
    await applyProjectConfig(root, IMPORTED, 2, 'control-plane');
    expect(agentProfilesFor(await loadConfig(root)).has('pi-lunaroute-glm-5-3')).toBe(true);
  });

  test('a profile only the repository has can be brought in', async () => {
    await applyProjectConfig(root, IMPORTED, 1, 'repository');
    const message = refusal(await loadConfig(root), 'pi-later');
    expect(message).toContain(PROFILE_AWAITING_CONFIRMATION);
  });

  test('a profile defined nowhere says so', async () => {
    await applyProjectConfig(root, IMPORTED, 1, 'repository');
    const message = refusal(await loadConfig(root), 'no-such-profile');
    expect(message).toContain('is not defined anywhere');
    expect(message).not.toContain(PROFILE_AWAITING_CONFIRMATION);
  });

  // Never claim "defined nowhere" about a repository that was not read: with no
  // control-plane file in force the repository's names are not looked at.
  test('with the repository unread it does not claim the profile is defined nowhere', async () => {
    const message = refusal(await loadConfig(root), 'no-such-profile');
    expect(message).not.toContain('is not defined anywhere');
  });
});

describe('a confirmation that would be refused', () => {
  test('is reported before it is offered', async () => {
    await writeFile(join(root, 'lazy.toml'), IMPORTED + '\n[agents.dangling]\nharness = "pi"\nmodel = "m"\nnamed_endpoint = "nowhere"\n');
    const read = await readProjectConnections(root, IMPORTED, 'repository');
    expect(read.fromRepository.profiles).toEqual(['dangling']);
    expect(read.blockedBy.length).toBeGreaterThan(0);
  });

  test('a clean confirmation is not blocked', async () => {
    expect((await readProjectConnections(root, IMPORTED, 'repository')).blockedBy).toEqual([]);
  });
});
