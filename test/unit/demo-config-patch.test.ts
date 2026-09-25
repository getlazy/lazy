/**
 * The edit `lazy playground` makes to its own project's lazy.toml.
 *
 * Both bugs this file pins were invisible by reading and only showed up when
 * the transform was run against a REAL `lazy init` lazy.toml — so the fixture
 * below is shaped like one (a `[runner]` table with sections on both sides, and
 * an existing commented-out `[permissions]`), not like the two-line stub that
 * would have passed either way.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { patchDemoToml, patchDemoConfig } from '../../src/demo/config';
import { HOST_RUNNER_TYPE } from '../../src/runner/host-runner-gate';

/** The shape `lazy init` produces: many sections, `[runner]` in the middle. */
const REAL_SHAPE = [
  '[models]',
  'default = "claude-opus-5"',
  '',
  '[session]',
  'verbose = false',
  '',
  '[runner]',
  '# Runner type: "docker" (default) or "podman". Agents run in isolated containers.',
  'type = "docker"',
  '',
  '[remote]',
  'driver = "local"',
  '',
  '[permissions]',
  '# Glob patterns for files agents should not modify or delete.',
  '# protected = ["test/**"]',
  '',
  '[protection]',
  'enabled = false',
  '',
  '[daemon]',
  'auto_react = false',
  '',
].join('\n');

function git(cwd: string, env: Record<string, string>, args: string[]): string {
  const result = Bun.spawnSync(['git', '-c', 'user.email=t@t.invalid', '-c', 'user.name=T', ...args], {
    cwd, env, stdout: 'pipe', stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

function commitCount(cwd: string, env: Record<string, string>): number {
  return Number(git(cwd, env, ['rev-list', '--count', 'HEAD']).trim());
}

describe('patchDemoToml', () => {
  test('switches the runner type in place and adds the permission mode', () => {
    const after = patchDemoToml(REAL_SHAPE)!;

    expect(after).toContain(`type = "${HOST_RUNNER_TYPE}"`);
    expect(after).toContain('permission_mode = "bypass"');
    expect(after).not.toContain('type = "docker"');
    // Rewritten in place, never appended: a duplicate `[runner]` is a TOML
    // redefinition error and the daemon refuses the whole file.
    expect(after.match(/^\[runner\]/gm)).toHaveLength(1);
  });

  // INVARIANT: every other section survives. The original regex was dotAll, so
  // `.*$` matched greedily across newlines and backtracked to the LAST `$` in
  // the file — silently deleting everything after the `type` line. On a real
  // lazy.toml that was 16 KB and nine sections, including `[permissions]`,
  // `[protection]` and `[daemon]`. It went unnoticed because every deleted
  // section was a default, so the demo kept working.
  test('keeps every section that follows [runner]', () => {
    const after = patchDemoToml(REAL_SHAPE)!;

    for (const section of ['[models]', '[session]', '[remote]', '[protection]', '[daemon]']) {
      expect(after).toContain(section);
    }
    expect(after).toContain('auto_react = false');
    expect(after).toContain('driver = "local"');

    // Counted, not just sampled: a truncation that spared one named section
    // would still pass the loop above.
    const sectionsBefore = REAL_SHAPE.match(/^\[/gm)!.length;
    expect(after.match(/^\[/gm)).toHaveLength(sectionsBefore);
  });

  // INVARIANT: exactly one `[permissions]` table. An init-produced lazy.toml
  // already has one, so appending a second is a TOML redefinition error that
  // makes the daemon refuse the file outright. This only became reachable once
  // the truncation above was fixed — until then the append landed on a file
  // whose `[permissions]` had just been deleted. Two bugs that cancelled out,
  // which is why fixing either one alone would have broken every demo.
  test('sets protected inside the existing [permissions] rather than adding a second', () => {
    const after = patchDemoToml(REAL_SHAPE)!;

    expect(after.match(/^\[permissions\]/gm)).toHaveLength(1);
    expect(after).toMatch(/^protected = \[".+"\]/m);
    // In the right TABLE, read back through the parser. Scanning for the next
    // `[` cannot answer this: an init-produced `[permissions]` ships a
    // commented-out `# protected = ["test/**"]`, whose bracket ends a `[^[]*`
    // scan mid-section — so that spelling of the assertion passed for a line
    // placed anywhere before the comment and would have missed one placed after
    // it, in the same table, which is just as correct.
    const parsed = Bun.TOML.parse(after) as { permissions: { protected: string[] } };
    expect(parsed.permissions.protected).toHaveLength(1);
  });

  test('adds a [permissions] table when the file genuinely has none', () => {
    const noPermissions = REAL_SHAPE.replace(
      /\[permissions\][^[]*/,
      '',
    );
    const after = patchDemoToml(noPermissions)!;

    expect(after.match(/^\[permissions\]/gm)).toHaveLength(1);
    expect(after).toMatch(/^protected = /m);
  });

  // INVARIANT: a file whose shape has moved reports rather than passing the
  // original through. The caller raises on null; a silent no-op surfaces two
  // processes later as a daemon that cannot launch a turn.
  test('returns null when [runner] exists without a type, and adds [runner] when the file has none', () => {
    // A `[runner]` that lost its `type` is a moved format: refused.
    expect(patchDemoToml('[runner]\n# no type key\n\n[remote]\n')).toBeNull();
    // No `[runner]` at all is the fixture's committed lazy.toml after `lazy
    // init` (see the describe below): the section is added, nothing is lost.
    const added = patchDemoToml('[models]\ndefault = "x"\n');
    expect(added).not.toBeNull();
    const parsed = Bun.TOML.parse(added!) as Record<string, Record<string, unknown>>;
    expect(parsed.models!.default).toBe('x');
    expect(parsed.runner!.type).toBe(HOST_RUNNER_TYPE);
  });

  // INVARIANT: patching is idempotent, and the result always parses.
  //
  // Both keys used to be APPENDED unconditionally, so a second run over the
  // same file wrote each of them twice and the daemon then refused the file
  // outright with "Cannot redefine key". Unreachable in the demo only because
  // `demo up` tears its root down first and always patches a fresh clone — one
  // refactor away from being live. The identical bug in the Teams supervisor's
  // copy of this rewrite (which DOES run again on every provisioning attempt)
  // permanently bricked the project's clone, which is what this pins.
  test('patching its own output changes nothing and still parses', () => {
    const once = patchDemoToml(REAL_SHAPE)!;
    const twice = patchDemoToml(once)!;
    const thrice = patchDemoToml(twice)!;

    expect(twice).toBe(once);
    expect(thrice).toBe(once);
    for (const key of ['type', 'permission_mode', 'protected']) {
      expect(once.match(new RegExp(`^${key} = `, 'gm'))).toHaveLength(1);
    }
    expect(() => Bun.TOML.parse(once)).not.toThrow();
  });

  // The state an earlier build left on disk, since the patched file is
  // committed: a config that already carries the key twice. The next run must
  // REPAIR it rather than inherit it.
  test('repairs a file an earlier run already broke', () => {
    const broken = REAL_SHAPE.replace(
      'type = "docker"',
      `type = "${HOST_RUNNER_TYPE}"\npermission_mode = "bypass"\npermission_mode = "bypass"`,
    );
    expect(() => Bun.TOML.parse(broken)).toThrow(/redefine/i);

    const after = patchDemoToml(broken)!;

    expect(after.match(/^permission_mode = /gm)).toHaveLength(1);
    expect(() => Bun.TOML.parse(after)).not.toThrow();
  });

  // INVARIANT: the rewrite proves its own output with the real parser before
  // handing it back, so nothing unloadable can ever reach the file. Bun has a
  // TOML parser one call away — there is no reason for this check to guess.
  test('refuses to return a file that does not parse', () => {
    const alreadyBroken = REAL_SHAPE.replace('[daemon]', '[daemon]\nauto_react = false');

    expect(() => Bun.TOML.parse(alreadyBroken)).toThrow(/redefine/i);
    expect(() => patchDemoToml(alreadyBroken)).toThrow(/does not parse/);
  });

  // INVARIANT: patching a project that is already patched is a successful
  // no-op, not an error. Nothing staged is what `git add` produces when the
  // rewrite changed nothing, and `git commit` treats that as a failure — so
  // this died on a raw "nothing to commit" from git. The case only became
  // reachable when the rewrite stopped appending blindly, which is to say the
  // fix for one bug is what exposed this one.
  test('patching an already-patched project commits nothing and does not fail', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'lazy-demo-config-'));
    try {
      const env = {
        PATH: process.env.PATH!,
        HOME: repo,
        // Hermetic: never read the developer's or the container's git config.
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      };
      await writeFile(join(repo, 'lazy.toml'), REAL_SHAPE);
      git(repo, env, ['init', '-q']);
      git(repo, env, ['add', '-A']);
      git(repo, env, ['commit', '-qm', 'initial']);

      await patchDemoConfig(repo, env);
      const afterFirst = await readFile(join(repo, 'lazy.toml'), 'utf-8');
      const commitsAfterFirst = commitCount(repo, env);

      await patchDemoConfig(repo, env);

      expect(await readFile(join(repo, 'lazy.toml'), 'utf-8')).toBe(afterFirst);
      expect(commitCount(repo, env)).toBe(commitsAfterFirst);
      // The first run did commit — otherwise the assertion above would hold
      // for a function that never commits anything at all.
      expect(commitsAfterFirst).toBe(2);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('the patched file says what the demo needs it to say', () => {
    const parsed = Bun.TOML.parse(patchDemoToml(REAL_SHAPE)!) as {
      runner: { type: string; permission_mode: string };
      permissions: { protected: string[] };
    };

    expect(parsed.runner.type).toBe(HOST_RUNNER_TYPE);
    expect(parsed.runner.permission_mode).toBe('bypass');
    expect(parsed.permissions.protected).toHaveLength(1);
    // Read back through the parser, not off the text: the point is what the
    // daemon will see, and a key landing in the wrong TABLE still greps fine.
    expect(parsed.permissions.protected[0]).toBeTruthy();
  });
});

// The fixture commits its own lazy.toml (`[serve] ports = [8080]`, see
// src/demo/fixture.ts) and `lazy init` keeps a committed file, upserting only
// `[storage]`. So the file this patch sees in the demo has NO `[runner]`
// section — the ordinary case now, not a moved format.
describe('patchDemoToml on the fixture\'s committed lazy.toml', () => {
  const COMMITTED_THEN_INIT = [
    '# Lazy configuration for the demo shop.',
    '',
    '[serve]',
    '# The port a task\'s dev server listens on inside its environment; lazy',
    '# publishes it and the Services card shows where it answers.',
    'ports = [8080]',
    '',
    '[storage]',
    'backend = "external"',
    'external_path = "/tmp/demo/store"',
    '',
  ].join('\n');

  test('adds a [runner] section with the demo runner and keeps [serve] and [storage]', () => {
    const after = patchDemoToml(COMMITTED_THEN_INIT);
    expect(after).not.toBeNull();
    const parsed = Bun.TOML.parse(after!) as Record<string, Record<string, unknown>>;
    expect(parsed.runner!.type).toBe(HOST_RUNNER_TYPE);
    expect(parsed.runner!.permission_mode).toBe('bypass');
    expect(parsed.serve!.ports).toEqual([8080]);
    expect(parsed.storage!.external_path).toBe('/tmp/demo/store');
    expect((parsed.permissions!.protected as string[])[0]).toBe('src/pricing.js');
  });

  test('patching that output again changes nothing', () => {
    const once = patchDemoToml(COMMITTED_THEN_INIT)!;
    expect(patchDemoToml(once)).toBe(once);
  });

  test('a [runner] section that has lost its type is still refused', () => {
    expect(patchDemoToml('[runner]\nfoo = 1\n\n[serve]\nports = [8080]\n')).toBeNull();
  });
});
