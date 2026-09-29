/**
 * INVARIANT: every path that builds an image from a checkout with no `.git`
 * passes the source identity in (LAZY_BUILD_SHA / _BRANCH / _DIRTY /
 * _COMMIT_COUNT), and the image's build step writes it before the version is
 * generated. Drop one link and that image reads `lazy-agent ok 0.90.0` again,
 * with nothing saying which commit it is — the report that started this.
 *
 * A source scan, like deploy-image-copy-graph.test.ts, because no suite builds
 * an image: a missing arg fails only on real hardware, after a release.
 */

import { describe, test, expect } from 'bun:test';
import { join, resolve } from 'path';

const root = resolve(import.meta.dir, '..', '..');
const read = (rel: string) => Bun.file(join(root, rel)).text();
const ARGS = ['LAZY_BUILD_SHA', 'LAZY_BUILD_BRANCH', 'LAZY_BUILD_DIRTY', 'LAZY_BUILD_COMMIT_COUNT', 'LAZY_BUILD_TIME'];

describe('image builds carry the source identity', () => {
  test('the daemon image declares the args and writes the stamp BEFORE generate:version', async () => {
    const text = await read('lazy-teams/deploy/daemon-image/Dockerfile');
    const stage = text.slice(text.indexOf('AS lazy-checkout'), text.indexOf('\nFROM ', text.indexOf('AS lazy-checkout')));
    for (const arg of ARGS) expect(stage).toContain(`ARG ${arg}`);
    const stampAt = stage.indexOf('scripts/write-source-stamp.ts');
    expect(stampAt).toBeGreaterThan(-1);
    expect(stampAt).toBeLessThan(stage.indexOf('bun run generate:version'));
    expect(stage.slice(0, stampAt)).toMatch(/RUN bun run $/);
  });

  test('the Teams image turns the args into the app identity', async () => {
    const text = await read('lazy-teams/deploy/Dockerfile');
    for (const arg of ['LAZY_BUILD_SHA', 'LAZY_BUILD_BRANCH', 'LAZY_BUILD_DIRTY']) {
      expect(text).toContain(`ARG ${arg}`);
      expect(text).toContain(`LAZY_TEAMS_${arg.replace('LAZY_', '')}="\${${arg}}"`);
    }
  });

  test('the shared helper produces all four args', async () => {
    const text = await read('scripts/source-stamp-build-args.sh');
    for (const arg of ARGS) expect(text).toContain(`--build-arg "${arg}=`);
  });

  // Both publish scripts (and through them the CI workflow and releases).
  for (const script of ['scripts/publish-lazy-daemon-image.sh', 'scripts/publish-lazy-teams-image.sh']) {
    test(`${script} passes them to its build`, async () => {
      const text = await read(script);
      expect(text).toContain('source "${SCRIPT_DIR}/source-stamp-build-args.sh"');
      expect(text).toContain('"${SOURCE_STAMP_ARGS[@]}"');
    });
  }

  test('the dry-run daemon build command line really carries them', () => {
    const res = Bun.spawnSync(['bash', join(root, 'scripts/publish-lazy-daemon-image.sh'), '--dry-run'], { cwd: root });
    const build = res.stdout.toString().split('\n').find((l) => l.includes('buildx build'));
    expect(build).toBeDefined();
    for (const arg of ARGS) expect(build!).toContain(`--build-arg ${arg}=`);
  });

  // Every hand-typed developer build of the daemon image (docs, bootstrap
  // output, deploy-remote) goes through the helper rather than a bare build.
  test('documented hand-typed daemon image builds pass the helper output', async () => {
    const files = [
      'lazy-teams/deploy/bootstrap.sh',
      'lazy-teams/deploy/docker-compose.build.yml',
      'lazy-teams/deploy/Dockerfile',
      'public-docs/self-hosting-lazy-teams.md',
    ];
    for (const file of files) {
      const lines = (await read(file)).split('\n').filter((l) => /docker build .*daemon-image\/Dockerfile/.test(l));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line).toContain('source-stamp-build-args.sh');
    }
  });

  // INVARIANT: bootstrap.sh PRINTS the developer command for a human to copy,
  // so the helper call must reach the terminal literally. Unescaped inside the
  // echo's double quotes it was EVALUATED at bootstrap time — multi-line args
  // in a checkout (a broken copy-paste), "No such file" plus `docker build  -f`
  // for an operator with no checkout.
  test('bootstrap.sh prints the helper call literally, not its output', async () => {
    const lines = (await read('lazy-teams/deploy/bootstrap.sh')).split('\n')
      .filter((l) => l.includes('source-stamp-build-args.sh'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toContain('\\$(../../scripts/source-stamp-build-args.sh)');
      expect(line).not.toMatch(/[^\\]\$\(\.\.\/\.\.\/scripts\/source-stamp-build-args\.sh\)/);
    }
    // And the printed text is exactly the command to type.
    const res = Bun.spawnSync(['bash', '-c', lines[0]!.trim()]);
    expect(res.stdout.toString().trim())
      .toBe('docker build $(../../scripts/source-stamp-build-args.sh) -f daemon-image/Dockerfile -t lazy-daemon:local ../..');
  });

  // deploy-remote builds ON THE BOX. --source git has a clone there and asks it;
  // --source rsync ships a git archive, so the workstation — which has the
  // checkout — computes the args and ships them beside the export.
  test('deploy-remote passes the identity in both source modes', async () => {
    const text = await read('lazy-teams/bin/deploy-remote');
    expect(text).toContain('source scripts/source-stamp-build-args.sh');
    expect(text).toContain('> "${export_dir}/.deployed-build-args"');
    const build = text.split('\n').find((l) => /docker build .*daemon-image\/Dockerfile/.test(l));
    expect(build).toContain('BUILD_ARGS');
    expect(text).toContain('../../scripts/source-stamp-build-args.sh');
    expect(text).toContain('cat ../../.deployed-build-args');
  });
});
