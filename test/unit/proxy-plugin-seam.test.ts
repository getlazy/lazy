/**
 * Unit tests for the proxy request-plugin seam (src/proxy/plugins/types.ts) and
 * the `.lazy/plugins/` loader that populates it (src/proxy/plugins/loader.ts).
 *
 * The seam has three guaranteed properties — zero-cost when empty, fail-open on
 * a throwing plugin, and no mutation of the caller's body. The loader has the
 * complementary one: it fails LOUD, because a plugin the user wrote and that
 * silently never runs is worse than a startup error.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyRequestPlugins, type ProxyRequestContext, type ProxyRequestPlugin } from '../../src/proxy/plugins/types';
import { loadProxyRequestPlugins, proxyPluginDir, ProxyPluginLoadError } from '../../src/proxy/plugins/loader';

const MESSAGES_CTX: ProxyRequestContext = { method: 'POST', path: '/v1/messages', endpoint: 'messages' };

const SYSTEM_PROMPT = [
  'You are the agent that works on the task in the repository.',
  'It is very important that the change is verified before it is committed.',
].join(' ');

describe('applyRequestPlugins: the seam', () => {
  // INVARIANT: with no plugins the seam returns the caller's exact object
  // identity and changed=false. This is what makes "byte-identical when no
  // plugin is installed" provable rather than merely asserted — the server never
  // re-serialises a body the seam did not change.
  test('no plugins → same object identity, changed=false', () => {
    const body = { model: 'm', system: SYSTEM_PROMPT };
    const result = applyRequestPlugins([], body, MESSAGES_CTX);
    expect(result.body).toBe(body);
    expect(result.changed).toBe(false);
    expect(result.appliedBy).toEqual([]);
  });

  // INVARIANT: the proxy is on every agent's critical path, so a buggy plugin
  // must degrade to "no transform", never to "no request". Note the asymmetry
  // with load time, which fails loud — see the loader tests below.
  test('a throwing plugin is skipped, not propagated', () => {
    const boom: ProxyRequestPlugin = {
      name: 'boom',
      transformRequest() { throw new Error('plugin exploded'); },
    };
    const body = { model: 'm' };
    const result = applyRequestPlugins([boom], body, MESSAGES_CTX);
    expect(result.body).toBe(body);
    expect(result.changed).toBe(false);
  });

  test('a plugin returning null leaves the body untouched', () => {
    const noop: ProxyRequestPlugin = { name: 'noop', transformRequest: () => null };
    const body = { model: 'm' };
    expect(applyRequestPlugins([noop], body, MESSAGES_CTX).body).toBe(body);
  });

  test('plugins compose in order and report who applied', () => {
    const addA: ProxyRequestPlugin = {
      name: 'a',
      transformRequest: (b) => ({ ...(b as object), a: 1 }),
    };
    const addB: ProxyRequestPlugin = {
      name: 'b',
      transformRequest: (b) => ({ ...(b as object), b: 2 }),
    };
    const result = applyRequestPlugins([addA, addB], { model: 'm' }, MESSAGES_CTX);
    expect(result.body).toEqual({ model: 'm', a: 1, b: 2 });
    expect(result.appliedBy).toEqual(['a', 'b']);
  });
});

describe('loadProxyRequestPlugins: .lazy/plugins convention', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-plugin-loader-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Write a plugin module into the project's plugin dir. */
  async function writePlugin(name: string, source: string): Promise<void> {
    const dir = proxyPluginDir(root);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), source, 'utf-8');
  }

  // INVARIANT: no directory means an empty chain, which is what the server
  // short-circuits on. Extending the proxy is opt-in by creating a file; there
  // is no config key to get wrong and no default plugin to turn off.
  test('a project with no .lazy/plugins directory loads nothing', async () => {
    expect(await loadProxyRequestPlugins(root)).toEqual([]);
  });

  test('an empty .lazy/plugins directory loads nothing', async () => {
    await mkdir(proxyPluginDir(root), { recursive: true });
    expect(await loadProxyRequestPlugins(root)).toEqual([]);
  });

  test('a plugin object default export is loaded', async () => {
    await writePlugin(
      'tag.ts',
      `export default {
         name: 'tag',
         transformRequest(body) { return { ...(body as object), tagged: true }; },
       };`,
    );
    const plugins = await loadProxyRequestPlugins(root);
    expect(plugins.map((p) => p.name)).toEqual(['tag']);
    expect(plugins[0].transformRequest({ model: 'm' }, MESSAGES_CTX)).toEqual({ model: 'm', tagged: true });
  });

  test('a factory default export is called once at load time', async () => {
    await writePlugin(
      'factory.ts',
      `let calls = 0;
       export default () => {
         calls++;
         return { name: 'factory', transformRequest: () => ({ calls }) };
       };`,
    );
    const plugins = await loadProxyRequestPlugins(root);
    expect(plugins.map((p) => p.name)).toEqual(['factory']);
    // Calling transform twice must not re-run the factory.
    plugins[0].transformRequest({}, MESSAGES_CTX);
    expect(plugins[0].transformRequest({}, MESSAGES_CTX)).toEqual({ calls: 1 });
  });

  // INVARIANT: the chain is a fold, so order is semantics, not cosmetics.
  // Sorted filename is the ordering rule — reviewable in a directory listing,
  // with no ordering DSL to learn.
  test('plugins load in sorted-filename order', async () => {
    await writePlugin('20-second.ts', `export default { name: 'second', transformRequest: () => null };`);
    await writePlugin('10-first.ts', `export default { name: 'first', transformRequest: () => null };`);
    await writePlugin('30-third.js', `export default { name: 'third', transformRequest: () => null };`);
    const plugins = await loadProxyRequestPlugins(root);
    expect(plugins.map((p) => p.name)).toEqual(['first', 'second', 'third']);
  });

  test('dotfiles, _helpers, .d.ts and *.test.ts are not loaded as plugins', async () => {
    await writePlugin('real.ts', `export default { name: 'real', transformRequest: () => null };`);
    await writePlugin('_shared.ts', `export const helper = 1;`);
    await writePlugin('.hidden.ts', `export default { name: 'hidden', transformRequest: () => null };`);
    await writePlugin('real.test.ts', `throw new Error('a test file must never be imported as a plugin');`);
    await writePlugin('types.d.ts', `export type Nothing = never;`);
    await writePlugin('README.md', `not a module`);
    const plugins = await loadProxyRequestPlugins(root);
    expect(plugins.map((p) => p.name)).toEqual(['real']);
  });

  // INVARIANT: load-time failures are LOUD. The user wrote this file on purpose;
  // a proxy that comes up healthy while their transform silently never runs is
  // the worst outcome. Same posture as a malformed lazy.toml.
  test('a plugin file that will not import fails loudly', async () => {
    await writePlugin('broken.ts', `export default { name: 'broken',,, };`);
    await expect(loadProxyRequestPlugins(root)).rejects.toThrow(ProxyPluginLoadError);
  });

  test('a module with no default export fails loudly and shows the expected shape', async () => {
    await writePlugin('named.ts', `export const plugin = { name: 'named', transformRequest: () => null };`);
    await expect(loadProxyRequestPlugins(root)).rejects.toThrow(/no default export/);
  });

  test('a default export missing transformRequest fails loudly', async () => {
    await writePlugin('shapeless.ts', `export default { name: 'shapeless' };`);
    await expect(loadProxyRequestPlugins(root)).rejects.toThrow(/transformRequest/);
  });

  test('a default export missing a name fails loudly', async () => {
    await writePlugin('anon.ts', `export default { transformRequest: () => null };`);
    await expect(loadProxyRequestPlugins(root)).rejects.toThrow(/name/);
  });

  test('a factory that throws at load time fails loudly', async () => {
    await writePlugin('boom.ts', `export default () => { throw new Error('bad table'); };`);
    await expect(loadProxyRequestPlugins(root)).rejects.toThrow(/bad table/);
  });

  // Names identify a plugin in the startup line and in `appliedBy`; duplicates
  // would make that record ambiguous.
  test('two plugins sharing a name fail loudly', async () => {
    await writePlugin('a.ts', `export default { name: 'dup', transformRequest: () => null };`);
    await writePlugin('b.ts', `export default { name: 'dup', transformRequest: () => null };`);
    await expect(loadProxyRequestPlugins(root)).rejects.toThrow(/both use the name "dup"/);
  });
});
