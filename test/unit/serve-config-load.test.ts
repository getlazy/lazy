/**
 * `[serve]` through the real config loader: both spellings land in one
 * validated `ServicePort[]`, and a malformed section fails at LOAD time rather
 * than turning into a task that quietly publishes nothing.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../../src/config/loader';

let dir: string;
let priorConfigEnv: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lazy-serve-config-'));
  // Pin LAZY_CONFIG at this temp file. Without it loadConfig walks up from
  // process.cwd(), which under `bun test` is lazy's OWN worktree — the test
  // would then silently assert against lazy's real lazy.toml.
  priorConfigEnv = process.env.LAZY_CONFIG;
  process.env.LAZY_CONFIG = join(dir, 'lazy.toml');
});

afterEach(async () => {
  if (priorConfigEnv === undefined) delete process.env.LAZY_CONFIG;
  else process.env.LAZY_CONFIG = priorConfigEnv;
  await rm(dir, { recursive: true, force: true });
});

async function load(toml: string) {
  await writeFile(join(dir, 'lazy.toml'), toml);
  return loadConfig(dir);
}

describe('[serve] config loading', () => {
  test('a project with no [serve] resolves to an empty service list', async () => {
    const config = await load('[agent]\n');
    expect(config.serve.services).toEqual([]);
  });

  test('bare ports resolve, named by their port', async () => {
    const config = await load('[serve]\nports = [3000, 5173]\n');
    expect(config.serve.services).toEqual([
      { name: '3000', port: 3000 },
      { name: '5173', port: 5173 },
    ]);
  });

  test('[serve.services] resolves with names', async () => {
    const config = await load('[serve.services]\nweb = 3000\napi = 8080\n');
    expect(config.serve.services).toEqual([
      { name: 'web', port: 3000 },
      { name: 'api', port: 8080 },
    ]);
  });

  test('both spellings merge into one list', async () => {
    const config = await load('[serve]\nports = [5173]\n\n[serve.services]\napi = 8080\n');
    expect(config.serve.services.map(s => s.name)).toEqual(['5173', 'api']);
  });

  // INVARIANT: fail loud. A typo'd [serve] must surface where the user typed it,
  // not as an empty `lazy url` three commands later with no explanation.
  test('a malformed [serve] fails at load time', async () => {
    await expect(load('[serve]\nports = 3000\n')).rejects.toThrow(/must be an array/);
  });

  test('an out-of-range port fails at load time', async () => {
    await expect(load('[serve]\nports = [99999]\n')).rejects.toThrow(/out of range/);
  });

  test('a duplicate port fails at load time', async () => {
    await expect(load('[serve]\nports = [3000]\n\n[serve.services]\nweb = 3000\n'))
      .rejects.toThrow(/declared twice/);
  });
});

describe('[serve] start_services_cmd', () => {
  test('is empty when unset', async () => {
    const config = await load('[serve]\nports = [3000]\n');
    expect(config.serve.start_services_cmd).toBe('');
  });

  test('resolves, trimmed', async () => {
    const config = await load('[serve]\nports = [3000]\nstart_services_cmd = "  bin/dev  "\n');
    expect(config.serve.start_services_cmd).toBe('bin/dev');
  });

  // INVARIANT: same fail-loud rule as the ports. A blank command would render a
  // "Start services" button that runs nothing and reports success.
  test('an empty command fails at load time', async () => {
    await expect(load('[serve]\nstart_services_cmd = "   "\n')).rejects.toThrow(/must not be empty/);
  });

  test('a non-string command fails at load time', async () => {
    await expect(load('[serve]\nstart_services_cmd = 3000\n')).rejects.toThrow(/must be a string/);
  });

  // A legally-escaped newline is valid TOML but not a start command — reject
  // at load so write and load stay one validator.
  test('an escaped newline in the command fails at load time', async () => {
    await expect(load('[serve]\nstart_services_cmd = "bin/dev\\ncurl evil"\n'))
      .rejects.toThrow(/single line/);
  });

  // It stands alone: a project can offer one-click service start without
  // declaring any published port (the app may bind a port lazy forwards ad hoc).
  test('may be set without any declared port', async () => {
    const config = await load('[serve]\nstart_services_cmd = "npm run dev"\n');
    expect(config.serve.services).toEqual([]);
    expect(config.serve.start_services_cmd).toBe('npm run dev');
  });
});
