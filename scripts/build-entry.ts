#!/usr/bin/env bun
// Keep this bootstrap dependency-free: it runs before dependencies are installed.
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const pin = (await readFile(join(root, '.bun-version'), 'utf8')).trim();
let invocation = process.argv.slice(2);
let callerCwd = process.cwd();
// mise runs in the checkout to resolve its toolchain, so carry the original
// directory explicitly when restarting this bootstrap under the selected Bun.
if (invocation[0] === '--caller-cwd') {
  if (!invocation[1]) throw new Error('--caller-cwd requires the original working directory');
  callerCwd = invocation[1];
  invocation = invocation.slice(2);
}
const [entry = 'build', ...args] = invocation;
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const run = (cmd: string[], env = process.env, cwd = root) => {
  const child = Bun.spawn(cmd, { cwd, env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  return child.exited;
};
if (!Bun.semver.satisfies(Bun.version, `>=${pin}`)) {
  const mise = Bun.which('mise') ?? [join(process.env.HOME ?? '', '.local/bin/mise'), '/opt/homebrew/bin/mise']
    .find(path => Bun.which(path));
  const retry = entry === 'build' || entry === 'install:local'
    ? `bun run ${entry}` : `bun run scripts/build-entry.ts ${['--caller-cwd', callerCwd, entry, ...args].map(quote).join(' ')}`;
  if (mise) {
    const installed = await run([mise, 'install', `bun@${pin}`]);
    if (installed === 0) {
      const probe = Bun.spawn([mise, 'exec', `bun@${pin}`, '--', 'bun', '--version'], { cwd: root, stdout: 'pipe', stderr: 'inherit' });
      const version = (await new Response(probe.stdout).text()).trim();
      if (await probe.exited === 0 && version === pin) {
        console.error(`using Bun ${pin} from mise; your default bun is ${Bun.version}`);
        process.exit(await run([mise, 'exec', `bun@${pin}`, '--', 'bun', process.argv[1], '--caller-cwd', callerCwd, entry, ...args]));
      }
    }
  }
  const command = mise
    ? `${quote(mise)} install bun@${pin} && ${quote(mise)} exec bun@${pin} -- ${retry}`
    : `${quote(process.execPath)} upgrade && ${quote(process.execPath)} ${retry.slice(4)}`;
  console.error(`Cannot build lazy: Bun ${Bun.version} at ${process.execPath}; this checkout requires Bun ${pin} or newer.\nRun in this checkout:\n  ${command}`);
  process.exit(1);
}
// Child scripts must inherit this runtime even when the shell's default is older.
const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` };
if (entry === 'check') process.exit(0);
if (entry === 'compile') {
  await import('./build');
} else if (entry === 'build' || entry === 'install:local') {
  const build = 'bun install && bun run generate:version && bun run typecheck && bun run scripts/build-entry.ts compile';
  const install = " && mkdir -p ~/.lazy/bin && mv lazy ~/.lazy/bin/lazy && mv lazy-agent ~/.lazy/bin/lazy-agent && bun run ensure:agent-placeholder && echo 'Installation to ~/.lazy/bin complete.' && echo '' && echo 'If `lazy` is not found, add ~/.lazy/bin to your PATH:' && echo '  zsh/bash: export PATH=\"$HOME/.lazy/bin:$PATH\"' && echo '  fish: set -Ux PATH $HOME/.lazy/bin $PATH'";
  process.exit(await run(['bash', '-c', build + (entry === 'install:local' ? install : '')], env));
} else {
  process.exit(await run([entry, ...args], env, callerCwd));
}
