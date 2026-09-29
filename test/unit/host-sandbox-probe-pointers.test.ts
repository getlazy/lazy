/**
 * INVARIANT: the boundary guard's git-pointer vectors (scripts/host-sandbox-probe.sh)
 * report `violation` when a session can rewrite a worktree's git pointers, the
 * common config or a hook, and `intact` against the posture lazy emits
 * (applyGitPointerDenies on PROBE_GIT_POINTERS, rewritten to the probe's own
 * worktree). A probe that silently passed a broken posture would let every host
 * agent regain the git-pointer escape unnoticed.
 *
 * Real sessions cost money and need a login, so `claude` here is a fake that
 * HONOURS the --settings it is given — it performs a write only when no rule
 * denies it — which is exactly the contract the real sandbox is verified to
 * keep elsewhere. bwrap/socat are stubbed: the fake never sandboxes anything.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import PROBE_SCRIPT from '../../scripts/host-sandbox-probe.sh' with { type: 'text' };
import { agentSettingsJson } from '../../src/runner/host-boundary-guard';
import { withGitPointerDenies, PROBE_GIT_POINTERS, type HostPermissionConfig } from '../../src/runner/host-sandbox';

const SANDBOX: HostPermissionConfig = {
  mode: 'sandbox',
  allowedDomains: ['*.anthropic.com'],
  allowWeakerNested: false,
  denyRead: [],
  denyWrite: [],
};

// A settings-honouring stand-in for `claude -p`. Prompts are the probe's own.
const FAKE_CLAUDE = String.raw`
import { appendFileSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
const prompt = argv[argv.indexOf('-p') + 1] ?? '';
const s = JSON.parse(argv[argv.indexOf('--settings') + 1] ?? '{}');
const deny: string[] = s.permissions?.deny ?? [];
const bashDeny: string[] = [
  ...(s.sandbox?.filesystem?.denyWrite ?? []),
  ...deny.filter((r) => r.startsWith('Edit(//')).map((r) => r.slice(6, -1).replace(/\/\*\*$/, '')),
];
const under = (p: string, base: string) => p === base || p.startsWith(base + '/');
const toolDenied = (tool: string, p: string) => deny.some((r) => {
  if (!r.startsWith(tool + '(//')) return false;
  return under(p, r.slice(tool.length + 2, -1).replace(/\/\*\*$/, ''));
});
const out = (result: string) => { console.log(JSON.stringify({ result })); process.exit(0); };
let m: RegExpMatchArray | null;
if (prompt.includes('inside.txt')) { writeFileSync('inside.txt', 'ok'); out('ok'); }
if ((m = prompt.match(/Read tool \(NOT Bash\) to read (\S+)/))) {
  out(toolDenied('Read', m[1]!) ? 'denied' : readFileSync(m[1]!, 'utf-8'));
}
if ((m = prompt.match(/Write tool \(NOT Bash\) to (?:create|overwrite) (\S+)/))) {
  if (!toolDenied('Write', m[1]!)) writeFileSync(m[1]!, '/tmp/x\n');
  out('done');
}
if ((m = prompt.match(/in Bash[^:]*: ([\s\S]*)$/)) || (m = prompt.match(/Run exactly this: ([\s\S]*)$/))) {
  for (const seg of m[1]!.split(';')) {
    const r = seg.match(/^\s*(?:printf|echo)\s+(.*?)\s*(>>?)\s*(\S+)\s*$/);
    if (!r) continue;
    const target = resolve(r[3]!);
    if (bashDeny.some((d) => under(target, d))) continue;
    const text = r[1]!.replace(/^'|'$/g, '');
    (r[2] === '>>' ? appendFileSync : writeFileSync)(target, text);
  }
  out('ran');
}
out('nothing to do');
`;

let dir: string;
let home: string;
let bin: string;
let script: string;
const jqMissing = Bun.spawnSync(['sh', '-c', 'command -v jq']).exitCode !== 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'probe-ptr-'));
  home = join(dir, 'home');
  bin = join(dir, 'bin');
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(dir, 'fake-claude.ts'), FAKE_CLAUDE);
  await writeFile(join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'fake-claude.ts')}" "$@"\n`);
  for (const stub of ['bwrap', 'socat']) await writeFile(join(bin, stub), '#!/bin/sh\nexit 0\n');
  for (const f of ['claude', 'bwrap', 'socat']) await chmod(join(bin, f), 0o755);
  script = join(dir, 'probe.sh');
  await writeFile(script, PROBE_SCRIPT);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function probe(pointerSettings: string): Promise<{ code: number; out: string }> {
  const denyPath = join(dir, 'deny.json');
  const ptrPath = join(dir, 'ptr.json');
  await writeFile(denyPath, agentSettingsJson({ ...SANDBOX, denyRead: [home], denyWrite: [home] })!);
  await writeFile(ptrPath, pointerSettings);
  const proc = Bun.spawn(['bash', script, '--guard'], {
    cwd: dir,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      LAZY_PROBE_DENY_SETTINGS: denyPath,
      LAZY_PROBE_POINTER_SETTINGS: ptrPath,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  return { code: await proc.exited, out };
}

describe.skipIf(jqMissing)('host boundary probe — git-pointer vectors', () => {
  test('the posture lazy emits holds: intact', async () => {
    const settings = withGitPointerDenies(agentSettingsJson({ ...SANDBOX, denyRead: [home], denyWrite: [home] })!, PROBE_GIT_POINTERS);
    const r = await probe(settings);
    expect(r.out).toContain('pointer / write-bash');
    expect(r.out).toContain('pointer / write-TOOL');
    expect(r.out).not.toContain('SILENT-ALLOW');
    expect(r.out + `\nexit=${r.code}`).toContain("exit=0");
  }, 60_000);

  test('a posture without the pointer denies is a violation', async () => {
    const r = await probe(agentSettingsJson({ ...SANDBOX, denyRead: [home], denyWrite: [home] })!);
    expect(r.out).toContain('git pointer rewritten');
    expect(r.out).not.toContain('LEAKED');
    expect(r.code).toBe(1);
  }, 60_000);
});
