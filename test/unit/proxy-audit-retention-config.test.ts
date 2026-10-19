/**
 * `[proxy] audit_retention_days` / `audit_retention_mib` — the audit log keeps
 * 7 days or 128 MiB, whichever comes first (engineer's decision, 2026-10-06).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig } from '../../src/config/loader';

describe('[proxy] audit retention keys', () => {
  let root: string | null = null;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = null; });

  async function load(proxy: string) {
    root = await mkdtemp(join(tmpdir(), 'lazy-audit-cfg-'));
    await writeFile(join(root, 'lazy.toml'), proxy ? `[proxy]\n${proxy}\n` : '');
    return loadConfig(root);
  }

  test('defaults to 7 days and 128 MiB', async () => {
    const c = await load('');
    expect(c.proxy.auditRetentionDays).toBe(7);
    expect(c.proxy.auditRetentionMib).toBe(128);
  });

  test('both are configurable', async () => {
    const c = await load('audit_retention_days = 30\naudit_retention_mib = 512');
    expect(c.proxy.auditRetentionDays).toBe(30);
    expect(c.proxy.auditRetentionMib).toBe(512);
  });

  // INVARIANT: neither limit can be turned off — the log stays bounded by
  // construction, so 0, negatives and a budget below one rotated segment are
  // refused at load rather than read as "unlimited".
  test('refuses a value that would unbound or empty the log', async () => {
    await expect(load('audit_retention_days = 0')).rejects.toThrow(/audit_retention_days must be a positive number/);
    await expect(load('audit_retention_mib = 4')).rejects.toThrow(/audit_retention_mib must be a number of MiB, at least 8/);
  });
});
