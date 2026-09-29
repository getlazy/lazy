/**
 * The boundary guard's project-root checks — the real probe script, end to end.
 *
 * Runs scripts/host-sandbox-probe.sh --guard exactly as runBoundaryProbe does,
 * with the settings files lazy writes, against a fake `claude` on PATH. The
 * fake enforces the project-root boundary ONLY when the deny rules the probe
 * handed it name the probe's own project root — so a green run proves the
 * probe built a real worktree, substituted the placeholder root into the rules
 * lazy emits, ran the sessions from inside the worktree, and classified each
 * outcome into the right verdict. Whether real Claude Code honours the rules is
 * what `lazy system verify-host-boundary` answers on a real host.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { agentSettingsJson, probeRootSettingsJson } from '../../src/runner/host-boundary-guard';
import { sandboxSuiteSkipped } from '../helpers/sandbox-deps';

const PROBE = join(import.meta.dir, '../../scripts/host-sandbox-probe.sh');

// A fake `claude` that acts out the probe's prompts. FAKE_MODE:
//   hold          — honour the root rules (when they name this root)
//   leak          — ignore them: write the root lazy.toml
//   break-worktree — the rules also stop in-worktree work
const FAKE_CLAUDE = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi
P=''; S=''
while [ $# -gt 0 ]; do
  case "$1" in -p) P="$2"; shift ;; --settings) S="$2"; shift ;; esac; shift
done
say() { jq -n --arg r "$1" '{result: $r}'; }
# While a probe holds its fixture lock, snapshot the pid file it wrote.
[ -n "$FAKE_PID_SNAPSHOT" ] && cat "$HOME/.lazy-boundary-probe.lock/pid" > "$FAKE_PID_SNAPSHOT" 2>/dev/null
case "$P" in
  *"lazy-escape-"*)
    # deny / write-TOOL: with FAKE_ENFORCE_HOME, write $HOME unless the rules
    # the probe handed over deny it (lazy's per-worktree home rules).
    T=$(echo "$P" | sed -E 's/.*create ([^ ]+) containing.*/\\1/')
    if [ -n "$FAKE_ENFORCE_HOME" ] && ! printf '%s' "$S" | grep -qF "Edit(/$(cd "$HOME" && pwd -P)/["; then
      echo pwned > "$T"; say written
    else say "denied by your permission settings"; fi ;;
  *"lazy.toml "*|*"escape.txt "*|*"/link "*)
    # The target path, and the project root it lives under (lazy.toml at the
    # root, escape.txt at .lazy/worktrees/other/, link at .lazy/worktrees/probe-wt/).
    T=$(echo "$P" | sed -E 's/.*(overwrite|create) ([^ ]+) (with|containing).*/\\2/')
    case "$T" in
      */lazy.toml) ROOT=$(dirname "$T") ;;
      *) ROOT=$(dirname "$(dirname "$(dirname "$(dirname "$T")")")") ;;
    esac
    if [ "$FAKE_MODE" = leak ] || ! printf '%s' "$S" | grep -qF "Edit(/$ROOT/["; then
      mkdir -p "$(dirname "$T")"; echo pwned > "$T"; say written
    else say "denied by your permission settings"; fi ;;
  *"ok.txt"*)
    # A blanket home deny beats the kept worktree, as Claude Code's does.
    if [ "$FAKE_MODE" = break-worktree ] || printf '%s' "$S" | grep -qF "Edit(/$(cd "$HOME" && pwd -P)/**)"; then say "denied by your permission settings"
    else echo ok > ok.txt && git add ok.txt && say done; fi ;;
  *"inside.txt"*) echo ok > inside.txt; say done ;;
  *) say "denied by your permission settings" ;;
esac
`;

describe.skipIf(sandboxSuiteSkipped('host boundary probe: project root'))(
  'boundary probe --guard checks the project-root write rules',
  () => {
    let dir: string;

    beforeEach(async () => {
      dir = await realpath(await mkdtemp(join(tmpdir(), 'probe-root-')));
      await mkdir(join(dir, 'bin'));
      await mkdir(join(dir, 'home'));
      await writeFile(join(dir, 'bin', 'claude'), FAKE_CLAUDE);
      await chmod(join(dir, 'bin', 'claude'), 0o755);
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    async function probe(mode: string, withRoot = true, enforceHome = false, builtin = false): Promise<{ code: number; verdict: { verdict: string; cases: Array<{ case: string; outcome: string }> } }> {
      const home = join(dir, 'home');
      // The settings the guard hands the probe, built the way runBoundaryProbe
      // builds them (the agent posture resolves ~ against this HOME).
      const prevHome = process.env.HOME;
      process.env.HOME = home;
      let settings: string | null;
      try {
        settings = agentSettingsJson({
          mode: 'sandbox', allowedDomains: ['*.anthropic.com'], allowWeakerNested: false, denyRead: [], denyWrite: [],
        });
      } finally {
        process.env.HOME = prevHome;
      }
      await writeFile(join(dir, 'settings.json'), settings!);
      await writeFile(join(dir, 'root-settings.json'), probeRootSettingsJson());
      const proc = Bun.spawn(['bash', PROBE, '--guard', '--json', join(dir, 'verdict.json')], {
        cwd: dir,
        env: {
          PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
          HOME: home,
          FAKE_MODE: mode,
          ...(enforceHome ? { FAKE_ENFORCE_HOME: '1' } : {}),
          FAKE_PID_SNAPSHOT: join(dir, 'pid-snapshot'),
          ...(builtin ? {} : { LAZY_PROBE_DENY_SETTINGS: join(dir, 'settings.json') }),
          ...(withRoot ? { LAZY_PROBE_ROOT_SETTINGS: join(dir, 'root-settings.json') } : {}),
          GIT_CONFIG_NOSYSTEM: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      const code = await proc.exited;
      if (code !== 0 && mode === 'hold') console.log(out, err);
      return { code, verdict: JSON.parse(await readFile(join(dir, 'verdict.json'), 'utf-8')) };
    }

    const outcome = (v: { cases: Array<{ case: string; outcome: string }> }, c: string) =>
      v.cases.find((x) => x.case === c)?.outcome;

    // INVARIANT: the guard proves the project-root boundary on a real worktree
    // with the rules lazy emits — a held boundary is `intact`, and a session
    // that could write the root lazy.toml is a VIOLATION that refuses launches.
    test('intact when the file tools cannot write the root', async () => {
      const { code, verdict } = await probe('hold');
      expect(code).toBe(0);
      expect(verdict.verdict).toBe('intact');
      for (const c of ['root / write-TOOL', 'root / write-sibling', 'root / write-symlink']) {
        expect(outcome(verdict, c)).toBe('DENIED');
      }
      expect(outcome(verdict, 'root / control')).toBe('OK');
    }, 60_000);

    test('violation when the root lazy.toml was written', async () => {
      const { code, verdict } = await probe('leak');
      expect(code).toBe(1);
      expect(verdict.verdict).toBe('violation');
      for (const c of ['root / write-TOOL', 'root / write-sibling', 'root / write-symlink']) {
        expect(outcome(verdict, c)).toBe('SILENT-ALLOW');
      }
    }, 60_000);

    // INVARIANT: rules that also block the worktree (or Bash's git add) are
    // never reported intact — they would brick every host agent.
    test('inconclusive when the rules block in-worktree work', async () => {
      const { code, verdict } = await probe('break-worktree');
      expect(code).toBe(2);
      expect(verdict.verdict).toBe('inconclusive');
      expect(outcome(verdict, 'root / control')).toBe('BLOCKED');
    }, 60_000);

    // INVARIANT: `deny / write-TOOL` runs under the per-worktree rules a turn
    // really gets, which are what deny $HOME. Probed under the base posture
    // alone it tested a path lazy never denied, and a Mac run reported it
    // SILENT-ALLOW.
    test('deny / write-TOOL is probed with the home rules', async () => {
      const held = await probe('hold', true, true);
      expect(outcome(held.verdict, 'deny / write-TOOL')).toBe('DENIED');
      expect(held.code).toBe(0);
      const bare = await probe('hold', false, true);
      expect(outcome(bare.verdict, 'deny / write-TOOL')).toBe('SILENT-ALLOW');
      expect(bare.code).toBe(1);
    }, 60_000);

    // INVARIANT: CI runs the probe with its BUILT-IN posture plus the root
    // rules. That posture's blanket $HOME deny must not reach the root checks,
    // or the in-worktree control is denied and the guard is never green.
    test('the built-in posture plus the root rules still passes the control', async () => {
      const { code, verdict } = await probe('hold', true, false, true);
      expect(outcome(verdict, 'root / control')).toBe('OK');
      expect(code).toBe(0);
    }, 60_000);

    // INVARIANT: a probe never shares or deletes another live probe's fixture —
    // a shared lazy.toml would read as a root write and cache a false VIOLATION.
    test('refuses while another live probe holds the fixture, takes over a dead one', async () => {
      const lock = join(dir, 'home', '.lazy-boundary-probe.lock');
      await mkdir(lock, { recursive: true });
      // A live stand-in whose command line names the probe, as a real one does.
      const standIn = join(dir, 'host-sandbox-probe-standin.sh');
      await writeFile(standIn, 'sleep 30\n');
      const holder = Bun.spawn(['bash', standIn]);
      try {
        await writeFile(join(lock, 'pid'), String(holder.pid));
        const busy = await probe('hold');
        expect(busy.code).toBe(2);
        expect(busy.verdict.verdict).toBe('inconclusive');
      } finally {
        holder.kill();
      }
      // A live process that is NOT a probe (a reused pid) does not hold it.
      const other = Bun.spawn(['sleep', '30']);
      try {
        await writeFile(join(lock, 'pid'), String(other.pid));
        const reused = await probe('hold');
        expect(reused.code).toBe(0);
      } finally {
        other.kill();
      }
      await mkdir(lock, { recursive: true }); // the takeover above removed it
      await writeFile(join(lock, 'pid'), '999999');
      const taken = await probe('hold');
      expect(taken.code).toBe(0);
      expect(await Bun.file(join(lock, 'pid')).exists()).toBe(false);
    }, 60_000);

    // INVARIANT: the pid a live probe writes into its lock is its real pid, so
    // a second probe's liveness check sees it alive. A literal "$" read as dead
    // let a second probe delete a running probe's fixture: a false VIOLATION.
    test('a running probe writes its numeric pid into the lock', async () => {
      await probe('hold');
      const pid = (await readFile(join(dir, 'pid-snapshot'), 'utf-8')).trim();
      expect(pid).toMatch(/^[0-9]+$/);
    }, 60_000);

    // The project root lives under $HOME, as a real one usually does, and the
    // probe removes it afterwards.
    test('builds the project root under $HOME and cleans it up', async () => {
      await probe('hold');
      expect(await Bun.file(join(dir, 'home', '.lazy-boundary-probe', 'lazy.toml')).exists()).toBe(false);
    }, 60_000);

    // A guard run that was not handed the root rules must say so in its
    // verdict, never pass quietly as if the boundary had been checked.
    test('records the project-root checks as SKIPPED when not given the rules', async () => {
      const { code, verdict } = await probe('hold', false);
      expect(code).toBe(0);
      expect(outcome(verdict, 'root / *')).toBe('SKIPPED');
    }, 60_000);
  },
);
