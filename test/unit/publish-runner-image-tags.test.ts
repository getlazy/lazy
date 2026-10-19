import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import { runnerContentTag } from '../../src/capture/image-tag';
import { runnerIdentityHash } from '../../src/docker/runner-dockerfile';

const ROOT = join(import.meta.dir, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'publish-lazy-runner-image.sh');

function dryRun(args: string[]): string {
  const proc = Bun.spawnSync(['bash', SCRIPT, '--dry-run', ...args], { cwd: ROOT });
  expect(proc.exitCode).toBe(0);
  return proc.stdout.toString();
}

/**
 * INVARIANT: the runner publish applies the content tag launches pull
 * (sha-<fingerprint> from runnerContentTag) plus the daemon's version tags, on
 * BOTH registries, in both publish shapes. If the script stopped applying it,
 * every launch's pull would miss and silently fall back to a multi-minute local build.
 */
describe('publish-lazy-runner-image.sh tags', () => {
  const sha = runnerContentTag(runnerIdentityHash());

  function expectFullTagSet(out: string): void {
    for (const registry of ['ghcr.io/getlazy', 'docker.io/getlazy']) {
      expect(out).toContain(`-t ${registry}/lazy-runner:${sha}`);
      expect(out).toMatch(new RegExp(`-t ${registry.replace(/\./g, '\\.')}/lazy-runner:v\\d+\\.\\d+\\.\\d+ `));
      expect(out).toMatch(new RegExp(`-t ${registry.replace(/\./g, '\\.')}/lazy-runner:v\\d+\\.\\d+ `));
      expect(out).toContain(`-t ${registry}/lazy-runner:latest`);
    }
  }

  test('a tagged multi-platform push carries the full tag set', () => {
    expectFullTagSet(dryRun(['--push', '--platform', 'linux/amd64,linux/arm64']));
  });

  test('the by-digest merge carries the full tag set', () => {
    expectFullTagSet(dryRun(['--merge-digests', 'sha256:aaaa,sha256:bbbb']));
  });
});

// INVARIANT: the runner Dockerfile is composed from the checkout, so a --ref
// that is not the checkout is refused — publishing it would name one commit's
// tag over another commit's text.
test('publish-lazy-runner-image.sh refuses a --ref that is not the checkout', () => {
  const proc = Bun.spawnSync(['bash', SCRIPT, '--dry-run', '--ref', 'HEAD~1'], { cwd: ROOT });
  expect(proc.exitCode).toBe(1);
  expect(proc.stderr.toString()).toContain('is not the checked-out commit');
});
