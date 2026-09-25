import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..', '..');

const DOCKERFILE = join(ROOT, 'Dockerfile.lazy');
const RUBY_VERSION_FILE = join(ROOT, 'lazy-teams', '.ruby-version');

/** File content, or null when the file is not in this checkout. */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new Error(`failed to read ${path}: ${String(err)}`);
  }
}

/**
 * `test/**` ships in the public release; `Dockerfile.lazy` and the Rails app do
 * not (`.releaseinclude` matches neither). So in a clone of the published repo
 * both subjects of this guard are absent, and a hard failure there would be a
 * red suite nobody who sees it can fix. The invariant only means anything where
 * both files exist, so it gates on that — and says so rather than passing
 * quietly, because a skip is not a pass.
 */
const dockerfile = await readIfPresent(DOCKERFILE);
const pinnedRaw = await readIfPresent(RUBY_VERSION_FILE);
const subjectsPresent = dockerfile !== null && pinnedRaw !== null;
if (!subjectsPresent) {
  console.log(
    'skipped: Dockerfile.lazy / lazy-teams/.ruby-version are not in this checkout ' +
      '(neither ships in a public release) — nothing to compare',
  );
}

/**
 * INVARIANT: the Ruby `Dockerfile.lazy` ships is the one `lazy-teams/.ruby-version`
 * pins, copied from an image built for the same Debian release as this image's base.
 *
 * The image carries a Ruby so a task touching the Rails app in `lazy-teams/` can
 * run that app's own suite; before it did, such a task could run `ruby -c` and
 * nothing else, and Rails changes reached review unverified. `.ruby-version` is
 * what the app's CI installs (`ruby/setup-ruby` with `ruby-version-file`), so a
 * drift means an agent's green run and CI's red one are different Rubies.
 *
 * A version drift also silently undoes the baked bundle: gems install under
 * `/usr/local/bundle/ruby/<minor>.0/`, so a minor bump on either side hides every
 * prebuilt gem from the app and each turn re-resolves them over the network —
 * which is the one thing a task container may not have.
 *
 * The Debian release is the other half of the same coupling, and it is what the
 * COPY rests on: only interpreter and stdlib are copied, so the binaries link
 * against C libraries (libssl, libyaml, glibc) supplied by THIS image's base.
 * Bump the base to the next Debian release on its own and the copied Ruby links
 * against libraries that are no longer there — a Ruby that will not start in a
 * rebuilt container, found by whoever rebuilt it.
 *
 * Nothing else in the bun suite reads either file, so without this the mismatch
 * first surfaces to whoever next runs `bin/test` inside a rebuilt container.
 */
describe.skipIf(!subjectsPresent)('Dockerfile.lazy Ruby stage', () => {
  // The COPY --from stage that provides the interpreter, e.g.
  //   COPY --from=docker.io/library/ruby:3.4.10-slim-bookworm /usr/local /usr/local
  const rubyStage = () => {
    const match = dockerfile!.match(/ruby:(\d+\.\d+\.\d+)-slim-([a-z]+)/);
    expect(
      match,
      'Dockerfile.lazy no longer copies Ruby from a ruby:<version>-slim-<debian release> ' +
        'stage — if the interpreter now arrives another way, update this test to read that spelling.',
    ).not.toBeNull();
    return { version: match![1], debianRelease: match![2] };
  };

  test('the Ruby it copies is the one lazy-teams pins', () => {
    const pinned = pinnedRaw!.trim();
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(rubyStage().version).toBe(pinned);
  });

  test('that Ruby was built for the same Debian release as the base image', () => {
    // e.g. `FROM debian:bookworm-slim`
    const base = dockerfile!.match(/^FROM\s+debian:([a-z]+)-slim/m);
    expect(
      base,
      'Dockerfile.lazy no longer starts FROM a debian:<release>-slim base — if the base ' +
        'changed, check that the copied Ruby still links against libraries this image has, ' +
        'then update this test.',
    ).not.toBeNull();

    expect(rubyStage().debianRelease).toBe(base![1]);
  });
});
