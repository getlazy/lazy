/**
 * The two edits `lazy playground up` makes to the fixture project's lazy.toml after
 * `lazy init` writes it.
 *
 * Both are EDITS to what init produced, never a hand-written stub: init writes
 * `storage.external_path`, and a stub that threw that away would leave the demo
 * pointing at a store it never created. `[runner]`'s `type` is rewritten in
 * place for the same reason a second `[runner]` table is not appended — a
 * duplicate table is a TOML redefinition error and the daemon would refuse to
 * load the file at all. `[permissions]` IS appended, because init does not write
 * that section.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { HOST_RUNNER_TYPE } from '../runner/host-runner-gate';
import { DEMO_PROTECTED_GLOB } from './fixture';
import { run, run$ } from './runtime';

/**
 * Point the demo project at the host-process runner and protect one file.
 *
 * The runner switch is an ENVIRONMENT fact, not a behaviour choice: there is no
 * Docker inside an agent container, so without it the demo daemon can start but
 * cannot launch a single turn. The daemon must also be started with
 * `LAZY_ALLOW_HOST_RUNNER=1` (see `demoEnv`) or it refuses this very config —
 * the two go together and neither works alone.
 */
/**
 * The whole edit, as a pure function of the file's text.
 *
 * Returns null when the file does not contain a `type` under `[runner]`, which
 * the caller turns into a loud failure: a silent no-op here surfaces two
 * processes later as "the daemon will not launch a turn", with nothing pointing
 * back at this rewrite.
 *
 * Pure so it can be tested against a REAL `lazy init` lazy.toml rather than a
 * stub — which is what caught both bugs below, neither of which was visible by
 * reading the code.
 */
export function patchDemoToml(before: string, protectedGlob: string | null = DEMO_PROTECTED_GLOB): string | null {
  const runner = sectionBody(before, 'runner');
  // A `[runner]` WITHOUT `type` is a format that has moved: refuse. `[^\n]*` and
  // no `s` flag anywhere in this file: with dotAll on, `.*$` is greedy ACROSS
  // newlines and backtracks to the last `$` in the file, which is how an earlier
  // version silently deleted everything after the `type` line — 16 KB and nine
  // sections of a real lazy.toml, unnoticed because every deleted section was a
  // default.
  if (runner !== null && !hasKey(runner.body, 'type')) return null;

  let after = runner
    ? replaceSection(before, runner, (body) => {
      const withType = setKey(body, 'type', `type = "${HOST_RUNNER_TYPE}"`);
      return setKey(withType, 'permission_mode', 'permission_mode = "bypass"');
    })
    // No `[runner]` at all. The ordinary case now, not a format change: the
    // fixture commits a lazy.toml of its own (`[serve]`, see fixture.ts) and
    // `lazy init` keeps a committed file — it only points `[storage]` at the
    // store — so the sections init would have written are simply absent. Every
    // one of them is a default; the runner is the one the demo has to say.
    : `${before.trimEnd()}\n\n[runner]\ntype = "${HOST_RUNNER_TYPE}"\npermission_mode = "bypass"\n`;

  // `[permissions]` ALREADY EXISTS in an init-produced lazy.toml, with
  // `protected` commented out. Appending a second table would be a TOML
  // redefinition error and the daemon would refuse the file outright — which
  // only became reachable once the truncation above was fixed, because until
  // then the append happened to a file whose `[permissions]` had just been
  // deleted. Two bugs that cancelled out; fixing one alone would have broken
  // every demo.
  // A cloned project (the playground) keeps the protection its own lazy.toml
  // declares; only the generated fixture needs the demo's.
  if (protectedGlob === null) {
    assertLoads(after);
    return after;
  }
  const protectedLine =
    `protected = ["${protectedGlob}"]` +
    `  # the demo seeds a task that edits this file on purpose`;

  const permissions = sectionBody(after, 'permissions');
  after = permissions
    ? replaceSection(after, permissions, (body) => setKey(body, 'protected', protectedLine))
    // No `[permissions]` at all — a format change, but an additive one we can
    // handle rather than refuse.
    : `${after.trimEnd()}\n\n[permissions]\n${protectedLine}\n`;

  assertLoads(after);
  return after;
}

/**
 * Refuse to hand back a lazy.toml the daemon cannot load.
 *
 * The Rails side of this rewrite has to approximate this with a hand-rolled
 * scanner; here the real parser is one call away, so there is no excuse for
 * guessing. A rewrite that can produce an unloadable config must never be the
 * thing that persists one — on the Teams side that turned a single failed
 * provisioning attempt into a clone no retry could ever recover, because the
 * broken file was committed and every later attempt patched it again.
 *
 * The WHOLE file is parsed, not just the two sections edited, and that is safe
 * here in a way it would not be on the Teams side: this file is `lazy init`'s
 * own output in the demo's throwaway fixture repo seconds earlier, never a
 * user's committed config, so there is no pre-existing content whose quirks
 * this could refuse.
 */
function assertLoads(text: string): void {
  try {
    Bun.TOML.parse(text);
  } catch (err) {
    throw new Error(
      `The playground's lazy.toml rewrite produced a file that does not parse: ${(err as Error).message}. ` +
      `This is a bug in src/demo/config.ts — nothing has been written.`,
    );
  }
}

/** Where a top-level table's body lives: after its header, up to the next one. */
function sectionBody(text: string, name: string): { start: number; body: string } | null {
  const header = new RegExp(`^\\[${name}\\][^\n]*\n`, 'm').exec(text);
  if (header === null) return null;

  const start = header.index + header[0].length;
  const rest = text.slice(start);
  const end = rest.search(/^\[/m);
  return { start, body: end === -1 ? rest : rest.slice(0, end) };
}

function replaceSection(
  text: string,
  section: { start: number; body: string },
  edit: (body: string) => string,
): string {
  return text.slice(0, section.start) + edit(section.body) + text.slice(section.start + section.body.length);
}

function keyPattern(key: string): RegExp {
  return new RegExp(`^[ \t]*${key}[ \t]*=[^\n]*\n?`, 'gm');
}

function hasKey(body: string, key: string): boolean {
  return keyPattern(key).test(body);
}

/**
 * Set `key` to `line` inside a section body, IDEMPOTENTLY: the first occurrence
 * is rewritten, any later one is dropped, and a key that is not there is added
 * at the end of the section.
 *
 * This is the half that was missing. Appending unconditionally meant a second
 * run over the same file wrote the key twice, and a TOML file that defines a
 * key twice does not load at all. Unreachable in the demo today only because
 * `demo up` tears its root down first and always patches a fresh clone — one
 * refactor away from being the bug that bit Teams, where the same rewrite runs
 * again on every provisioning attempt.
 *
 * A commented-out `# protected = [...]`, which an init-produced lazy.toml
 * ships, is not an occurrence.
 */
function setKey(body: string, key: string, line: string): string {
  if (!hasKey(body, key)) {
    // After the section's last real line, before the blank line that separates
    // it from the next table — so the file still reads the way init wrote it.
    const tail = /\n*$/.exec(body)!;
    const content = body.slice(0, tail.index);
    if (content.length === 0) return `${line}\n${tail[0]}`;
    return `${content}\n${line}\n${tail[0].replace(/^\n/, '')}`;
  }

  let written = false;
  return body.replace(keyPattern(key), (match) => {
    if (written) return '';
    written = true;
    return match.endsWith('\n') ? `${line}\n` : line;
  });
}

export async function patchDemoConfig(
  repoPath: string,
  env: Record<string, string>,
  protectedGlob: string | null = DEMO_PROTECTED_GLOB,
): Promise<void> {
  const path = join(repoPath, 'lazy.toml');

  let before: string;
  try {
    before = await readFile(path, 'utf-8');
  } catch (err) {
    throw new Error(
      `No lazy.toml at ${path} after \`lazy init\` — init reported success but wrote nothing: ` +
      `${(err as Error).message}`,
    );
  }

  const after = patchDemoToml(before, protectedGlob);
  if (after === null) {
    throw new Error(
      `Could not find \`type\` under [runner] in ${path}. The lazy.toml format has changed ` +
      `under the demo — update src/demo/config.ts to match it.`,
    );
  }

  if (after !== before) await writeFile(path, after);

  // Committed, not merely written: task worktrees are checked out from HEAD, so
  // anything reading config from inside one would otherwise see the committed
  // file rather than this.
  await run$('git add lazy.toml', ['git', 'add', '-A'], { cwd: repoPath, env });

  // Nothing staged is the ORDINARY outcome of running this over a project that
  // is already patched, and `git commit` calls it an error — so a second `demo
  // up` over one would die on a raw "nothing to commit" from git. That case
  // only became reachable when the rewrite above stopped appending blindly:
  // before, it always produced a changed file, which is the same reason it
  // always produced a broken one. Ask git first rather than letting a
  // successful no-op look like a failure.
  const staged = await run(['git', 'diff', '--cached', '--quiet'], { cwd: repoPath, env });
  if (staged.code === 0) return;

  await run$(
    'git commit lazy.toml',
    [
      'git', '-c', 'user.email=demo@lazy.invalid', '-c', 'user.name=Lazy Demo',
      'commit', '-m', protectedGlob === null
        ? 'Demo harness: host-process runner'
        : 'Demo harness: host-process runner and a protected file',
    ],
    { cwd: repoPath, env },
  );
}
