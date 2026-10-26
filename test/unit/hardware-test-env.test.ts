import { expect, test } from 'bun:test';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import ts from 'typescript';
import { hardwareTestEnv } from '../helpers/hardware-env';

function environmentFailures(name: string, source: string): string[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const failures: string[] = [];
  const fail = (node: ts.Node, reason: string) => {
    failures.push(`${name}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${reason}`);
  };
  const visit = (node: ts.Node) => {
    // Individual hardware opt-ins and PATH are intentional inputs. Passing the
    // entire environment (including via an alias) is the launch-state leak.
    if (ts.isPropertyAccessExpression(node) && node.getText(file) === 'process.env' &&
        !ts.isPropertyAccessExpression(node.parent) && !ts.isElementAccessExpression(node.parent)) {
      fail(node, 'use hardwareTestEnv() instead of inheriting process.env');
    }
    if (ts.isCallExpression(node) && /^Bun\.spawn(?:Sync)?$/.test(node.expression.getText(file))) {
      const options = node.arguments[1];
      if (!options || !ts.isObjectLiteralExpression(options) ||
          !options.properties.some(p => p.name?.getText(file) === 'env')) {
        fail(node, 'hardware subprocess needs an explicit isolated env');
      }
    }
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'setupTestLazy') {
      const options = node.arguments[0];
      if (options && ts.isObjectLiteralExpression(options) &&
          options.properties.some(p => p.name?.getText(file) === 'realRunner') &&
          !options.properties.some(p => p.name?.getText(file) === 'inheritedEnv')) {
        fail(node, 'realRunner must declare its inheritedEnv');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return failures;
}

// INVARIANT: hardware suites own all LAZY_* launch state. Inheriting an outer
// agent's MCP config hid missing fixture setup until the suite ran on a Mac.
test('hardware suites and their build helper isolate subprocess environments', async () => {
  const e2e = join(import.meta.dir, '../e2e');
  const checked: string[] = [];
  const failures: string[] = [];
  for (const name of await readdir(e2e)) {
    if (!name.endsWith('.test.ts')) continue;
    const source = await readFile(join(e2e, name), 'utf8');
    if (!/LAZY_SMOLVM_E2E|LAZY_TEST_CONTAINER_BINARY|realRunner:\s*true|LAZY_(?:REAL_)?DOCKER/.test(source) &&
        !['container-outlives-failed-turns.test.ts', 'exited-container-replacement.test.ts'].includes(name)) continue;
    checked.push(name);
    failures.push(...environmentFailures(name, source));
  }
  for (const name of ['container-outlives-failed-turns', 'exited-container-replacement', 'smolvm-solo', 'smolvm-image-build', 'task-container-git-pointers']) {
    expect(checked).toContain(`${name}.test.ts`);
  }
  const helper = '../helpers/smolvm-image-build.ts';
  failures.push(...environmentFailures(helper, await readFile(join(import.meta.dir, helper), 'utf8')));
  expect(failures).toEqual([]);
});

test('the environment guard rejects ambient copies and implicit subprocess inheritance', () => {
  for (const source of [
    'const env = { ...process.env, HOME: temp };',
    'const inherited = process.env; const env = { ...inherited };',
    'Bun.spawn(argv);',
    'Bun.spawnSync(argv, { stdout: "pipe" });',
    'Bun.spawn(argv, { env: process.env });',
    'setupTestLazy({ realRunner: true });',
  ]) expect(environmentFailures('hardware.ts', source).length).toBeGreaterThan(0);
  expect(environmentFailures('hardware.ts', `
    const env = hardwareTestEnv({ PATH: process.env.PATH, LAZY_DAEMON_CONFIG: fixture });
    Bun.spawn(argv, { env });
    setupTestLazy({ realRunner: true, inheritedEnv: hardwareTestEnv() });
  `)).toEqual([]);
});

test('hardware environments remove every inherited LAZY_* key and retain explicit fixture values', async () => {
  const inherited = {
    PATH: process.env.PATH, HOME: '/host-home',
    LAZY_DAEMON_CONFIG: '/outer-task/daemon.json', LAZY_CONFIG: '/outer-task/lazy.toml',
    LAZY_MCP_EXPECTED_TASK_ID: 'outer-task', LAZY_MANAGED: '1', LAZY_FUTURE_LAUNCH_STATE: 'poison',
  };
  const env = hardwareTestEnv({ LAZY_DAEMON_CONFIG: '/fixture/daemon.json' }, inherited);
  const child = Bun.spawn([process.execPath, '-e', 'console.log(JSON.stringify(process.env))'], {
    env, stdout: 'pipe', stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, err }).toEqual({ code: 0, err: '' });
  const actual = JSON.parse(out);
  expect(Object.keys(actual).filter(k => k.startsWith('LAZY_'))).toEqual(['LAZY_DAEMON_CONFIG']);
  expect(actual.LAZY_DAEMON_CONFIG).toBe('/fixture/daemon.json');
  expect(actual.HOME).toBe(inherited.HOME);
  expect(inherited.LAZY_DAEMON_CONFIG).toBe('/outer-task/daemon.json');
});
