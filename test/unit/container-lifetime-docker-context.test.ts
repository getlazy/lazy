import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import ts from 'typescript';
import { hardwareTestEnv } from '../helpers/hardware-env';

// INVARIANT: host Docker commands keep the host HOME; only supervisors use a
// private HOME. Docker Desktop's selected context can live solely in ~/.docker.
test('the survival suite uses one host environment for Docker probes and commands', async () => {
  const path = join(import.meta.dir, '../e2e/container-outlives-failed-turns.test.ts');
  const file = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const environments: Record<string, string> = {};
  let hostInitializer: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'hostEnv') {
      hostInitializer = node.initializer?.getText(file);
    }
    if (ts.isCallExpression(node) && /^Bun\.spawn(?:Sync)?$/.test(node.expression.getText(file))) {
      const argv = node.arguments[0]?.getText(file);
      const options = node.arguments[1];
      if (options && ts.isObjectLiteralExpression(options)) {
        const env = options.properties.find(p => p.name?.getText(file) === 'env');
        if (env && ts.isPropertyAssignment(env)) environments[argv] = env.initializer.getText(file);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(hostInitializer).toBe('hardwareTestEnv()');
  expect(environments["[binary, 'image', 'inspect', image]"]).toBe('hostEnv');
  expect(environments.argv).toBe('hostEnv');
  expect(environments["['sh', '-c', script]"]).toBe('supervisorEnv');
});

const docker = Bun.which('docker');
if (!docker) console.log('[skip] Docker context regression: no Docker client (no engine is needed)');

// INVARIANT: context selection from config survives hardware env isolation.
// This exercises the real client without contacting a Docker engine.
test.skipIf(!docker)('a file-selected Docker context survives while the supervisor HOME stays private', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lazy-docker-context-'));
  const hostHome = join(root, 'host');
  const supervisorHome = join(root, 'supervisor');
  const hostEnv = hardwareTestEnv({ HOME: hostHome, DOCKER_CONFIG: undefined, DOCKER_HOST: undefined, DOCKER_CONTEXT: undefined });
  async function command(env: Record<string, string | undefined>, args: string[]): Promise<string> {
    const proc = Bun.spawn([docker!, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`docker ${args.join(' ')} failed (${code}): ${err}`);
    return out.trim();
  }
  try {
    await Promise.all([mkdir(hostHome), mkdir(supervisorHome)]);
    await command(hostEnv, ['context', 'create', 'desktop-fixture', '--docker', `host=unix://${join(root, 'desktop.sock')}`]);
    await writeFile(join(hostHome, '.docker/config.json'), JSON.stringify({ currentContext: 'desktop-fixture' }));
    const supervisorEnv = hardwareTestEnv({ HOME: supervisorHome, LAZY_TEST_AGENT_HOME: supervisorHome }, hostEnv);
    const inspect = ['context', 'inspect', '--format', '{{.Name}}'];
    expect(await command(hostEnv, inspect)).toBe('desktop-fixture');
    expect(await command(supervisorEnv, inspect)).toBe('default');
    expect(supervisorEnv.HOME).toBe(supervisorHome);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
