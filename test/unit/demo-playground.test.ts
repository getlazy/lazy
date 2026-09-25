/**
 * The playground repository's starter tasks, and the parser `lazy playground up`
 * reads them with.
 */

import { describe, expect, test } from 'bun:test';
import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { cloneProjectRepo, parseStarterTasks, readStarterTasks, resolveRepoSource } from '../../src/demo/playground';
import { patchDemoToml } from '../../src/demo/config';

const PLAYGROUND = resolve(import.meta.dir, '../../playground');

describe('the playground starter tasks', () => {
  test('tasks.json parses and has 6-10 tasks of varied types', async () => {
    const tasks = (await readStarterTasks(PLAYGROUND))!;
    expect(tasks.length).toBeGreaterThanOrEqual(6);
    expect(tasks.length).toBeLessThanOrEqual(10);
    const types = new Set<string>(tasks.map(task => task.type));
    for (const type of ['fix', 'feature', 'refactor', 'document', 'spike']) expect(types).toContain(type);
  });

  // INVARIANT: tasks.md and tasks.json describe the same tasks. tasks.md is what a
  // human reads and tasks.json is what the demo creates; drift means the demo
  // seeds tasks the README's list does not mention, or the reverse.
  test('tasks.md documents every task in tasks.json with the same goal', async () => {
    const tasks = (await readStarterTasks(PLAYGROUND))!;
    const markdown = await readFile(join(PLAYGROUND, 'tasks.md'), 'utf-8');
    const headings = [...markdown.matchAll(/^## (\S+) — (.+)$/gm)].map(m => ({ code: m[1], goal: m[2] }));
    expect(headings).toEqual(tasks.map(task => ({ code: task.code, goal: task.goal })));
  });

  // INVARIANT: the playground's own lazy.toml keeps its protection through the
  // demo's config patch — a cloned project must not have the fixture's
  // protected file written over its own.
  test('the demo config patch keeps the playground protection', async () => {
    const toml = await readFile(join(PLAYGROUND, 'lazy.toml'), 'utf-8');
    const patched = Bun.TOML.parse(patchDemoToml(toml, null)!) as Record<string, any>;
    expect(patched.permissions.protected).toEqual(['src/schema.sql']);
    expect(patched.runner.type).toBeDefined();
    expect(patched.serve.services.web).toBe(3000);
  });
});

describe('parseStarterTasks', () => {
  const valid = { code: 'fix-it', type: 'fix', goal: 'Fix it', prompt: 'Please fix it.' };
  const parse = (doc: unknown) => () => parseStarterTasks(JSON.stringify(doc));

  test('accepts a well-formed file', () => {
    expect(parseStarterTasks(JSON.stringify({ version: 1, tasks: [valid] }))).toEqual([valid as never]);
  });

  test('refuses what it cannot trust, naming the entry', () => {
    expect(() => parseStarterTasks('{')).toThrow(/not valid JSON/);
    expect(parse({ version: 2, tasks: [valid] })).toThrow(/version/);
    expect(parse({ version: 1, tasks: [] })).toThrow(/non-empty/);
    expect(parse({ version: 1, tasks: [{ ...valid, goal: '' }] })).toThrow(/task #1: "goal"/);
    expect(parse({ version: 1, tasks: [{ ...valid, code: 'Bad Code' }] })).toThrow(/lowercase/);
    expect(parse({ version: 1, tasks: [{ ...valid, type: 'cluster' }] })).toThrow(/type "cluster"/);
    expect(parse({ version: 1, tasks: [valid, valid] })).toThrow(/task #2: code "fix-it" appears twice/);
  });
});

describe('cloneProjectRepo', () => {
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
  const missing = join(import.meta.dir, 'no-such-playground-repo');

  // INVARIANT: only the built-in default may fall back to the fixture — that is
  // what keeps an offline `lazy playground up` working once the playground is published.
  test('an unreachable default falls back to the fixture', async () => {
    const reports: string[] = [];
    const dest = join(await import('os').then(os => os.tmpdir()), `pg-clone-${process.pid}-a`);
    const ok = await cloneProjectRepo({ repo: missing, dest, env, fallbackAllowed: true, report: m => reports.push(m) });
    expect(ok).toBe(false);
    expect(reports.join('\n')).toContain('using the built-in fixture');
  });

  // INVARIANT: a repository the human named that cannot be cloned is an error.
  test('an unreachable named repository is an error', async () => {
    const dest = join(await import('os').then(os => os.tmpdir()), `pg-clone-${process.pid}-b`);
    await expect(cloneProjectRepo({ repo: missing, dest, env, fallbackAllowed: false, report: () => {} }))
      .rejects.toThrow(/Could not clone/);
  });

  test('local paths are resolved; URLs and scp addresses are not', () => {
    expect(resolveRepoSource('../pg', '/home/me/work')).toBe('/home/me/pg');
    expect(resolveRepoSource('/abs/pg', '/x')).toBe('/abs/pg');
    expect(resolveRepoSource('https://github.com/getlazy/playground.git', '/x')).toBe('https://github.com/getlazy/playground.git');
    expect(resolveRepoSource('git@github.com:getlazy/playground.git', '/x')).toBe('git@github.com:getlazy/playground.git');
  });
});
