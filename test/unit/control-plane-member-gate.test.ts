import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { handleRpc } from '../../src/daemon/rpc-handlers';
import {
  CONTROL_PLANE_RPC_COMMANDS,
  MEMBER_ALLOWED_CONTROL_PLANE_RPC_COMMANDS,
  isControlOnlyRpc,
} from '../../src/daemon/rpc-command-kinds';

const MEMBER = { kind: 'user' as const, email: 'member@example.com', name: 'Member' };

let root: string;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'lazy-cp-gate-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

/** The commands Teams' CLI proxy relays on a member's own token. */
async function teamsCliProxyCommands(): Promise<string[]> {
  const ruby = await readFile(join(import.meta.dir, '../../lazy-teams/app/models/cli_rpc_command.rb'), 'utf8');
  const table = ruby.split('COMMANDS = {')[1]?.split(/^\s*}\.freeze|^\s{2}}$/m)[0] ?? '';
  return [...table.matchAll(/^\s*"([A-Za-z.]+)"\s*=>/gm)].map(m => m[1]!);
}

describe('control-plane commands on a member token', () => {
  // INVARIANT: the daemon itself refuses a member (user-kind) token for every control-plane command outside the member-allowed set. No surface may rely on the control plane in front of it to have filtered the request.
  test('every control-only command is refused to a user token before it runs', async () => {
    const controlOnly = [...CONTROL_PLANE_RPC_COMMANDS].filter(isControlOnlyRpc);
    expect(controlOnly.length).toBeGreaterThan(5);
    for (const command of controlOnly) {
      const err = await handleRpc(command, root, {}, undefined, MEMBER).then(() => null, e => e);
      expect({ command, status: err?.statusCode ?? err?.status }).toEqual({ command, status: 403 });
      expect(String(err.message)).toContain('control-plane operation');
    }
  });

  // INVARIANT: the member-allowed set is exactly the control-plane commands Teams' CLI proxy relays on a member's token. A command Teams relays that the daemon refuses is a broken feature; one the daemon allows that Teams never relays is an unguarded door.
  test('the member-allowed set mirrors Teams\' CLI proxy allowlist', async () => {
    const relayed = await teamsCliProxyCommands();
    expect(relayed.length).toBeGreaterThan(20);
    const relayedControlPlane = relayed.filter(c => CONTROL_PLANE_RPC_COMMANDS.has(c)).sort();
    expect(relayedControlPlane).toEqual([...MEMBER_ALLOWED_CONTROL_PLANE_RPC_COMMANDS].sort());
  });

  test('taskEnv and container plumbing are control-only', () => {
    for (const c of ['taskEnv', 'ensureTaskContainer', 'ensureTaskWorktree', 'getDaemonMcpConfig', 'setProjectSettings', 'applyProjectConfig', 'serve.run', 'rebuildRunnerImage', 'cancelImageBuild', 'dismissImageAdoptionFailure']) {
      expect(isControlOnlyRpc(c)).toBe(true);
    }
    expect(isControlOnlyRpc('runOneshot')).toBe(false);
  });
});
