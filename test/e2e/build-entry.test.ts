import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, copyFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture(pin: string, body: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-build-entry-')));
  try {
    await mkdir(join(root, 'scripts'));
    // Refusal cases must not discover a developer's real mise and try to download Bun 99.
    await mkdir(join(root, '.local/bin'), { recursive: true });
    await writeFile(join(root, '.local/bin/mise'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await copyFile(new URL('../../scripts/build-entry.ts', import.meta.url), join(root, 'scripts/build-entry.ts'));
    await writeFile(join(root, '.bun-version'), pin);
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const entry of ['build', 'install:local', 'compile']) {
  // INVARIANT: unsupported Bun refuses before dependencies or generated files. A late refusal wastes work and can leave misleading artifacts.
  test(`${entry} refuses before doing build work and gives one exact remedy`, async () => {
    await fixture('99.0.0', async root => {
      const child = Bun.spawn([process.execPath, 'scripts/build-entry.ts', entry], {
        cwd: root, env: { PATH: '', HOME: root }, stdout: 'pipe', stderr: 'pipe',
      });
      const output = await new Response(child.stderr).text();
      expect(await child.exited).toBe(1);
      expect(output).toContain(`Bun ${Bun.version} at ${process.execPath}`);
      expect(output).toContain('requires Bun 99.0.0');
      expect(output).toContain('install bun@99.0.0 &&');
      expect(output).toContain('exec bun@99.0.0 -- bun run');
      expect(output).not.toContain('Cannot find module');
      expect(await Bun.file(join(root, 'lazy-agent')).exists()).toBe(false);
      expect(await Bun.file(join(root, 'src/build-info.ts')).exists()).toBe(false);
    });
  });
}

test('supported runtime runs the requested command with its own Bun first on PATH', async () => {
  await fixture('1.0.0', async root => {
    const child = Bun.spawn([process.execPath, 'scripts/build-entry.ts', process.execPath, '-e', 'console.log(Bun.which("bun"))'], {
      cwd: root, env: { PATH: '', HOME: root }, stdout: 'pipe', stderr: 'pipe',
    });
    expect((await new Response(child.stdout).text()).trim()).toBe(process.execPath);
    expect(await child.exited).toBe(0);
  });
});

// INVARIANT: mise handoff preserves the requested operation and arguments before build work starts.
test('mise installs the pin, announces the handoff and preserves arguments', async () => {
  await fixture('99.0.0', async root => {
    const mise = join(root, 'mise');
    await writeFile(mise, `#!/bin/bash
if [[ "$1" == install ]]; then exit 0; fi
if [[ "$5" == --version ]]; then echo 99.0.0; exit 0; fi
printf '%s\\n' "$@"
exit 37
`, { mode: 0o755 });
    const child = Bun.spawn([process.execPath, 'scripts/build-entry.ts', 'bash', 'a script', 'a value'], {
      cwd: root, env: { PATH: root, HOME: root }, stdout: 'pipe', stderr: 'pipe',
    });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited).toBe(37);
    expect(err).toContain(`using Bun 99.0.0 from mise; your default bun is ${Bun.version}`);
    expect(out).toContain('exec\nbun@99.0.0\n--\nbun\n');
    expect(out).toContain('bash\na script\na value\n');
  });
});

test('failed mise installation refuses with the same operation as its remedy', async () => {
  await fixture('99.0.0', async root => {
    await writeFile(join(root, 'mise'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
    const child = Bun.spawn([process.execPath, 'scripts/build-entry.ts', 'install:local'], {
      cwd: root, env: { PATH: root, HOME: root }, stdout: 'pipe', stderr: 'pipe',
    });
    const output = await new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    expect(output).toContain('install bun@99.0.0 &&');
    expect(output).toContain('exec bun@99.0.0 -- bun run install:local');
  });
});

for (const entry of ['build', 'install:local']) {
  test(`package ${entry} checks Bun before install, generation or typecheck`, async () => {
    await fixture('99.0.0', async root => {
      const pkg = await Bun.file(new URL('../../package.json', import.meta.url)).json();
      await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: pkg.scripts }));
      const child = Bun.spawn([process.execPath, 'run', entry], {
        cwd: root, env: { PATH: `${root}/.local/bin:${process.execPath.slice(0, process.execPath.lastIndexOf('/'))}`, HOME: root }, stdout: 'pipe', stderr: 'pipe',
      });
      const output = await new Response(child.stderr).text();
      expect(await child.exited).toBe(1);
      expect(output).toContain('Cannot build lazy:');
      expect(output).not.toContain('bun install v');
      expect(output).not.toContain('generate:version');
      expect(output).not.toContain('tsc.js');
    });
  });
}

// The public source archive ships the deploy bundle, but not the native Teams installer.
const nativeInstaller = new URL('../../lazy-teams/bin/native-install', import.meta.url);
const nativeInstallerAvailable = await Bun.file(nativeInstaller).exists();
if (!nativeInstallerAvailable) console.log('[skip] native-install bootstrap coverage: native Teams installer is not shipped in this archive');
test.skipIf(!nativeInstallerAvailable)('native install checks Bun before any installation phase and retains its arguments', async () => {
  await fixture('99.0.0', async root => {
    const dir = join(root, 'lazy-teams/bin');
    await mkdir(dir, { recursive: true });
    const script = join(dir, 'native-install');
    await copyFile(nativeInstaller, script);
    const child = Bun.spawn(['/bin/bash', script, '--yes', '--app-host', 'localhost:3000'], {
      cwd: root,
      env: { ...process.env, PATH: `${root}/.local/bin:${process.execPath.slice(0, process.execPath.lastIndexOf('/'))}:/usr/bin:/bin`, HOME: root },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited).toBe(1);
    expect(out).not.toContain('[1/9]');
    expect(err).toContain('Cannot build lazy:');
    expect(err).toContain("'--app-host' 'localhost:3000'");
  });
});

for (const source of ['flag', 'environment']) {
  // INVARIANT: selecting a runtime must not select a different install. Relative settings and data paths belong to the caller's working directory across mise handoff.
  test.skipIf(!nativeInstallerAvailable)(`native install preserves a relative ${source} settings path through mise handoff`, async () => {
    await fixture('99.0.0', async root => {
      const caller = join(root, 'caller');
      const dir = join(root, 'lazy-teams/bin');
      await mkdir(caller);
      await mkdir(dir, { recursive: true });
      const script = join(dir, 'native-install');
      await copyFile(nativeInstaller, script);
      // Both paths exist so an incorrect cwd deterministically reads the wrong file.
      // Malformed dummy settings stop native-install before it can change anything.
      for (const path of [root, caller]) await writeFile(join(path, 'deploy.env'), "KEY='\n");
      const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
      await writeFile(join(root, 'mise'), `#!/bin/bash
if [[ "$1" == install ]]; then exit 0; fi
if [[ "$5" == --version ]]; then echo 99.0.0; exit 0; fi
# Simulate switching to a supported runtime, then run the real bootstrap again.
printf '%s\\n' ${quote(Bun.version)} > .bun-version
shift 4
exec ${quote(process.execPath)} "$@"
`, { mode: 0o755 });
      const child = Bun.spawn(['/bin/bash', script, '--yes', ...(source === 'flag' ? ['--env-file', './deploy.env'] : [])], {
        cwd: caller,
        env: {
          ...process.env,
          PATH: `${root}:${process.execPath.slice(0, process.execPath.lastIndexOf('/'))}:/usr/bin:/bin`,
          HOME: root,
          LAZY_TEAMS_ENV_FILE: source === 'environment' ? './deploy.env' : undefined,
        },
        stdout: 'pipe', stderr: 'pipe',
      });
      const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(await child.exited).toBe(1);
      expect(err).toContain('using Bun 99.0.0 from mise');
      expect(err).toContain(`${caller}/./deploy.env:1 does not parse`);
      expect(err).not.toContain(`${root}/./deploy.env:1 does not parse`);
      expect(out).not.toContain('[1/9]');
    });
  });
}

test('direct compiler invocation refuses before loading generated metadata or dependencies', async () => {
  await fixture('99.0.0', async root => {
    await copyFile(new URL('../../scripts/build.ts', import.meta.url), join(root, 'scripts/build.ts'));
    const child = Bun.spawn([process.execPath, 'scripts/build.ts'], {
      cwd: root, env: { PATH: '', HOME: root }, stdout: 'pipe', stderr: 'pipe',
    });
    const output = await new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    expect(output).toContain('Cannot build lazy:');
    expect(output).not.toContain('Cannot find module');
  });
});

// INVARIANT: the image build carries the pin and checks it before dependency installation, just like a checkout build.
test('daemon image supplies the pin and bootstrap before installing dependencies', async () => {
  const dockerfile = await Bun.file(new URL('../../lazy-teams/deploy/daemon-image/Dockerfile', import.meta.url)).text();
  const install = dockerfile.indexOf('bun install --ignore-scripts');
  expect(dockerfile.indexOf('COPY .bun-version ./')).toBeLessThan(install);
  expect(dockerfile.indexOf('COPY scripts/build-entry.ts ./scripts/build-entry.ts')).toBeLessThan(install);
  expect(dockerfile).toContain('RUN bun run scripts/build-entry.ts check && bun install --ignore-scripts');
});
