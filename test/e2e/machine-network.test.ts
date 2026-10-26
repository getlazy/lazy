import { test, expect } from 'bun:test';
import { setupTestLazy } from '../helpers/setup';
import { DaemonClient } from '../../src/daemon/client';
import { storageDirFor } from '../helpers/storage';
import { getDaemonTcpTarget } from '../../src/daemon/lifecycle';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// INVARIANT: these probes run inside a project microVM, never on the shared
// Teams host. A member token must not turn them into a host network probe.
test('network diagnostics refuse non-microVM projects over the real RPC wire', async () => {
  const ctx = await setupTestLazy({ withDaemon: true });
  try {
    const client = await DaemonClient.create(ctx.root);
    expect(client).not.toBeNull();
    for (const command of ['machineNetworkCheck', 'machineRestartPreview']) {
      await expect(client!.rpc(command, ctx.root, {})).rejects.toThrow('require a Lazy Teams microVM');
    }
    await ctx.restartDaemon({ LAZY_MANAGED: '1', LAZY_MANAGED_BACKEND: 'microvm', LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root) });
    const managed = await DaemonClient.create(ctx.root);
    await expect(managed!.rpc('machineNetworkCheck', ctx.root, { hostname: 'https://example.com/' })).rejects.toThrow('Enter a hostname');
    const result = await managed!.rpc('machineNetworkCheck', ctx.root, { hostname: 'nonexistent.invalid' }) as any;
    expect(result.servers.length).toBeGreaterThan(0);
    expect(result.dns).toHaveLength(10);
    expect(result.dns.find((row: any) => row.label === 'nonexistent.invalid A').ok).toBe(false);
    expect(result.https).toHaveLength(2);
    expect(typeof result.egress.ok).toBe('boolean');
    const user = await managed!.rpc('mintActorToken', ctx.root, { kind: 'user', email: 'member@example.com' }) as { token: string };
    const member = DaemonClient.fromTarget(getDaemonTcpTarget(ctx.root)!, user.token);
    for (const command of ['machineNetworkCheck', 'machineRestartPreview']) {
      await expect(member.rpc(command, ctx.root, {})).rejects.toThrow('project control token only');
    }
  } finally {
    await ctx.cleanup();
  }
}, 60_000);

test('restart previews preserve running-work identities over the real RPC wire', async () => {
  const ctx = await setupTestLazy({ withDaemon: true });
  try {
    const bin = join(ctx.root, 'network-bin');
    await mkdir(bin);
    await writeFile(join(bin, 'docker'), '#!/bin/sh\nprintf \'%s\\n\' \'{"ID":"container-a","Names":"task-a","Image":"runner:test","Status":"Up 1 minute"}\'\n', { mode: 0o755 });
    await ctx.restartDaemon({
      PATH: `${bin}:${process.env.PATH}`,
      LAZY_MANAGED: '1', LAZY_MANAGED_BACKEND: 'microvm', LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root),
    });
    const client = await DaemonClient.create(ctx.root);
    const preview = await client!.rpc('machineRestartPreview', ctx.root, {}) as any;
    expect(preview.containers[0].id).toBe('container-a');
    expect(preview.containers[0].name).toBe('task-a');
  } finally {
    await ctx.cleanup();
  }
}, 60_000);
