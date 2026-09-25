/**
 * Every command `bin/smolvm-hardware-probe` runs INSIDE a guest must exist in
 * the image that guest boots from.
 *
 * INVARIANT: the probe's guest-side commands use only tools the guest image
 * provides. Three real-hardware runs were lost to this class of bug — `busybox
 * httpd` (Alpine's busybox has no httpd applet), a `socat SYSTEM:` string that
 * socat unescaped into several shell lines, and `wget` in the daemon image,
 * which installs `curl` — each costing a Mac round trip to discover, because
 * nothing here can boot a VM and the fake CLI in the Ruby suite models none of
 * this. This scan reads the probe's text, pulls out what each stage sends to
 * `machine exec`, and checks every leading command word against what the
 * target image has: Alpine's busybox applets (plus `busybox-extras`, which the
 * probe installs) for stages 1–2b, and the daemon image's Debian base plus its
 * apt list for stages 3 and 5.
 *
 * The probe also preflights the same tool list inside the guest at stage 3
 * (`guest_tools`), so a mismatch fails early on the box rather than as a
 * misread relay result.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..', '..');
const probe = readFileSync(join(repoRoot, 'lazy-teams', 'bin', 'smolvm-hardware-probe'), 'utf8');
const daemonDockerfile = readFileSync(
  join(repoRoot, 'lazy-teams', 'deploy', 'daemon-image', 'Dockerfile'),
  'utf8',
);

/** The probe's text between two stage markers. */
function stage(name: string, next: string): string {
  const start = probe.indexOf(`# ── Stage ${name}:`);
  const end = probe.indexOf(`# ── Stage ${next}:`);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return probe.slice(start, end);
}

/**
 * The argv the guest sees, for every `machine exec` in a stage: the text after
 * `-- ` up to the end of the shell command. Also the guest scripts the probe
 * writes with `cat > "$OUT/guest/<name>.sh" <<'GUEST' … GUEST`.
 */
function guestCommandTexts(text: string): string[] {
  const out: string[] = [];
  // Everything after `-- ` on a `machine exec` line, continued across `\`-joined
  // lines and across a quoted multi-line script.
  const exec = /machine exec --name "\$\w+"(?: --detach)? --\s*(?:\\\n\s*)?((?:[^\n"']|"(?:[^"\\]|\\.)*"|'[^']*')+)/g;
  for (const m of text.matchAll(exec)) out.push(unwrapShC(m[1]!));
  const scripts = /cat > "\$OUT\/guest\/[^"]+" <<'GUEST'\n(.*?)\nGUEST/gs;
  for (const m of text.matchAll(scripts)) out.push(m[1]!);
  return out;
}

/** `sh -c "<script>"` / `sh -c '<script>'` → the script itself, else the argv as is. */
function unwrapShC(argv: string): string {
  const m = argv.trim().match(/^sh -c\s+(["'])([\s\S]*)\1\s*$/);
  if (!m) return argv;
  return m[1] === '"' ? m[2]!.replace(/\\(["\\\$])/g, '$1') : m[2]!;
}

const SHELL_WORDS = new Set([
  'sh', 'if', 'then', 'else', 'elif', 'fi', 'for', 'do', 'done', 'while', 'case', 'esac', 'in',
  'exec', 'command', 'echo', 'printf', 'true', 'false', 'test', '[', 'exit', 'return', 'set',
  'export', 'read', 'kill', 'wait', 'cd', 'umask', '.', 'eval', 'local', 'break', 'continue',
]);

/** Leading command words from shell text, ignoring quoted arguments and assignments. */
function commandWords(shell: string): Set<string> {
  const words = new Set<string>();
  // Strip comments, redirections (`2>&1` would otherwise yield a "command" named 1)
  // and quoted spans, so only real command positions remain.
  const stripped = shell
    .replace(/^\s*#.*$/gm, "")
    // Arithmetic (`$((i + 1))`) is not a command position: its operands would
    // otherwise read as commands named `i` or `now`.
    .replace(/\$\(\([^)]*\)\)/g, " 0 ")
    .replace(/\d*[<>]+&?\d*/g, " ")
    .replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const segments = stripped.split(/(?:\n|;|&&|\|\||\||&|\$\(|\(|`|\bthen\b|\bdo\b|\belse\b)/);
  for (const raw of segments) {
    const tokens = raw.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
    while (i < tokens.length && (tokens[i] === 'exec' || tokens[i] === 'setsid' || tokens[i] === '!')) i++;
    const word = tokens[i];
    if (!word) continue;
    if (/^[$'"\\<>\/{}\[\]*-]/.test(word) && !word.startsWith('/probe/') && !word.startsWith('/')) continue;
    if (word.startsWith('/')) { words.add(word); continue; }
    if (/^\d+$/.test(word)) continue;
    if (/^[A-Za-z0-9_.+-]+$/.test(word)) words.add(word);
  }
  return words;
}

// Alpine 3.20 busybox applets the probe leans on, plus what it installs.
const ALPINE_TOOLS = new Set([
  'busybox', 'apk', 'httpd', 'wget', 'nslookup', 'cat', 'ls', 'stat', 'id', 'sleep', 'kill',
  'pkill', 'flock', 'netstat', 'grep', 'awk', 'tail', 'head', 'tr', 'cut', 'ip', 'sh', 'rm',
  'mkdir', 'echo', 'printf', 'sort', 'uniq', 'wc', 'sed', 'ps', 'seq', 'true', 'date',
]);

// Debian bookworm-slim base (coreutils, util-linux, procps via apt) plus the
// daemon image's apt list and the two scripts it installs.
const DEBIAN_BASE = new Set([
  'cat', 'ls', 'stat', 'id', 'sleep', 'grep', 'awk', 'tail', 'head', 'tr', 'cut', 'sh', 'rm',
  'mkdir', 'echo', 'printf', 'sort', 'uniq', 'wc', 'sed', 'df', 'free', 'ps', 'pkill', 'setsid',
  'sync', 'kill', 'tee', 'env', 'true', 'bun', 'lazy', 'lazy-guest-init', 'date',
]);
const APT_TO_TOOLS: Record<string, string[]> = {
  curl: ['curl'],
  socat: ['socat'],
  iproute2: ['ip', 'ss'],
  git: ['git'],
  'docker.io': ['docker', 'dockerd'],
  procps: ['ps', 'pkill', 'free'],
  jq: ['jq'],
  'e2fsprogs': ['mkfs.ext4', 'e2fsck'],
  iptables: ['iptables'],
  unzip: ['unzip'],
  'xz-utils': ['xz'],
  'ca-certificates': [],
};

function daemonImageTools(): Set<string> {
  const tools = new Set(DEBIAN_BASE);
  const apt = daemonDockerfile.match(/apt-get install[^&]*?\\\n([\s\S]*?)&&/);
  expect(apt).not.toBeNull();
  for (const pkg of apt![1]!.split(/\s+/).map((p) => p.replace(/\\$/, '')).filter(Boolean)) {
    for (const tool of APT_TO_TOOLS[pkg] ?? []) tools.add(tool);
  }
  return tools;
}

function check(stageText: string, provided: Set<string>): string[] {
  const missing = new Set<string>();
  for (const cmd of guestCommandTexts(stageText)) {
    for (const word of commandWords(cmd)) {
      if (SHELL_WORDS.has(word) || provided.has(word)) continue;
      if (word.startsWith('/probe/') || word.startsWith('/tmp/')) continue; // scripts the probe wrote itself
      missing.add(word);
    }
  }
  return [...missing].sort();
}

describe('the hardware probe runs only tools its guest images have', () => {
  test('the scan sees guest commands at all', () => {
    expect(guestCommandTexts(stage('3', '4')).length).toBeGreaterThan(5);
    expect(guestCommandTexts(stage('2b', '3')).length).toBeGreaterThan(1);
  });

  test('stages 1, 2 and 2b (alpine guest) use busybox applets and what the probe installs', () => {
    const text = stage('1', '2') + stage('2', '2b') + stage('2b', '3');
    expect(check(text, ALPINE_TOOLS)).toEqual([]);
  });

  test('stage 3 (daemon image) uses only what its Dockerfile installs', () => {
    expect(check(stage('3', '4'), daemonImageTools())).toEqual([]);
  });

  test('stage 5 (daemon image) uses only what its Dockerfile installs', () => {
    const s5 = probe.slice(probe.indexOf("# ── Stage 5:"), probe.indexOf("# ── Summary"));
    expect(s5.length).toBeGreaterThan(100);
    expect(check(s5, daemonImageTools())).toEqual([]);
  });

  // The runs that were lost, spelled out so the scan is known to catch them.
  test('the scan catches the three known guest-tool mistakes', () => {
    const daemon = daemonImageTools();
    expect(check('machine exec --name "$IMAGE_VM" -- sh -c "wget -qO- http://x/"\n', daemon)).toEqual(['wget']);
    expect(check('machine exec --name "$IMAGE_VM" -- sh -c "python3 -m http.server"\n', daemon)).toEqual(['python3']);
    expect(check('machine exec --name "$RELAY_VM" -- sh -c "curl http://x/"\n', ALPINE_TOOLS)).toEqual(['curl']);
  });

  test('stage 3 preflights its guest tools inside the machine before reading results', () => {
    const s3 = stage('3', '4');
    expect(s3).toContain('result guest_tools');
    for (const tool of ['curl', 'socat', 'ss', 'ip', 'pkill', 'setsid', 'lazy-guest-init']) {
      expect(s3).toMatch(new RegExp(`for t in [^;]*\\b${tool}\\b`));
    }
    const code = s3.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).not.toMatch(/\bwget\b/);
  });
});

// INVARIANT: a helper the probe calls inside a stage is defined before any
// stage, never inside another stage's `if stage_on` block. Runs 5, 6 and 7
// (every `--stage 3` run) reported relay_via_forwarder FAIL while the failure
// branch's own `curl -v` received `HTTP/1.0 200 OK forwarder-ok` through the
// mapping: `wait_http` lived inside stage 1's block, `--stage 3` skipped stage
// 1, and "wait_http: command not found" was read as "no answer". Three Mac
// round trips for a function defined in the wrong place.
describe('the hardware probe defines every helper before any stage', () => {
  const firstStage = probe.indexOf('# ── Stage 0:');
  const preamble = probe.slice(0, firstStage);
  const stages = probe.slice(firstStage);

  test('no function is defined inside a stage block', () => {
    const defs = [...stages.matchAll(/^([a-z_]+)\(\)\s*\{/gm)].map((m) => m[1]);
    expect(defs).toEqual([]);
  });

  test('every helper a stage calls exists in the preamble', () => {
    const defined = new Set([...preamble.matchAll(/^([a-z_]+)\(\)\s*\{/gm)].map((m) => m[1]!));
    for (const helper of ['wait_http', 'guest_httpd', 'guest_httpd_log', 'guest_httpd_kill', 'ls_schema', 'vmm_memory_mb', 'guest_mem', 'gx', 'sv', 'result', 'say', 'now', 'stage_on']) {
      expect(defined.has(helper), `${helper} is used by a stage but not defined before stage 0`).toBe(true);
    }
    // The stages actually use them, so a rename that leaves a stale call is caught too.
    for (const helper of ['wait_http', 'vmm_memory_mb', 'guest_mem']) {
      expect(stages).toMatch(new RegExp(`\\b${helper}\\b`));
    }
  });

  test('the probe refuses to run with a helper missing', () => {
    expect(preamble).toContain('probe bug — helper');
  });
});

// INVARIANT: a guest `pkill -f` pattern names exactly its target — never the
// shell that runs it, and (outside the labelled DIAGNOSTIC branch) never the
// daemon image's forwarder. Run 20260920-130837 lost `serve_request_via_chain`
// to `pkill -f 'TCP4-LISTEN:26024'`: the forwarder's argv contains those bytes
// too (bind=<link>), so the forwarder died with the probe's answerer and the
// host got the relay's "connection reset by peer" — and the pattern appears in
// the `sh -c` string running it, so pkill terminated its own shell before the
// wait loop ran (reproduced locally, exit 143). One Mac round trip each.
describe("the probe's kill commands hit what they name and nothing else", () => {
  const guestInit = readFileSync(
    join(repoRoot, 'lazy-teams', 'deploy', 'daemon-image', 'lazy-guest-init'),
    'utf8',
  );
  // The forwarder's argv as a guest sees it, with the values lazy-guest-init
  // substitutes (26024, the guest's link address).
  const FORWARDER_ARGV = 'socat -d TCP4-LISTEN:26024,bind=100.96.0.2,reuseaddr,fork TCP4:127.0.0.1:26024';

  test('the forwarder argv this test assumes is what lazy-guest-init runs', () => {
    expect(guestInit).toContain(
      'socat -d "TCP4-LISTEN:${DAEMON_PORT},bind=${link},reuseaddr,fork" "TCP4:127.0.0.1:${DAEMON_PORT}"',
    );
  });

  function killPatterns(text: string): { pattern: string; cmd: string }[] {
    const out: { pattern: string; cmd: string }[] = [];
    for (const cmd of guestCommandTexts(text)) {
      for (const m of cmd.matchAll(/pkill -f '([^']+)'/g)) out.push({ pattern: m[1]!, cmd });
    }
    return out;
  }

  test('the scan sees kill commands at all', () => {
    expect(killPatterns(probe).length).toBeGreaterThan(3);
  });

  test('no kill pattern matches the shell that runs it', () => {
    for (const { pattern, cmd } of killPatterns(probe)) {
      expect(new RegExp(pattern).test(cmd), `pkill -f '${pattern}' matches its own sh -c text and would terminate it`).toBe(false);
    }
  });

  test('outside the DIAGNOSTIC branch, no stage-3 kill touches the forwarder', () => {
    const nonDiagnostic = stage('3', '4').split('\n').filter((l) => !/sv image-diag\d-kill/.test(l)).join('\n');
    for (const { pattern } of killPatterns(nonDiagnostic)) {
      expect(new RegExp(pattern).test(FORWARDER_ARGV), `pkill -f '${pattern}' would kill the forwarder`).toBe(false);
    }
  });

  test('the diagnostic kills still take the forwarder down, on purpose', () => {
    const diagnostic = stage('3', '4').split('\n').filter((l) => /sv image-diag\d-kill/.test(l)).join('\n');
    const patterns = killPatterns(diagnostic);
    expect(patterns.length).toBe(2);
    for (const { pattern } of patterns) expect(new RegExp(pattern).test(FORWARDER_ARGV)).toBe(true);
  });

  test("the scan catches run 8's pattern on both counts", () => {
    const run8 = "pkill -f 'TCP4-LISTEN:26024'; for i in 1 2; do ss -ltn | grep -q ':26024 ' || break; done";
    const [{ pattern, cmd }] = killPatterns(`machine exec --name "$IMAGE_VM" -- sh -c "${run8}"\n`);
    expect(new RegExp(pattern!).test(FORWARDER_ARGV)).toBe(true);
    expect(new RegExp(pattern!).test(cmd!)).toBe(true);
  });
});

// INVARIANT: a SCRIPT a guest runs from /probe is written under $OUT/guest BEFORE
// the machine that runs it is created, and that machine's create line mounts
// "$OUT/guest" at /probe. (Stage 2 mounts other host directories under /probe/a
// and /probe/missing on purpose — those are the things under test, not scripts,
// so the rule is scoped to `.sh` files.) Mounts are create-time properties, so a script added
// to a stage whose machine lacks the mount fails inside the guest with "Can't
// open /probe/…" — a result that reads like a broken chain.
describe('a guest script under /probe is mounted on the machine that reads it', () => {
  // Backslash-continued lines joined, so a `-v` on a continuation line counts.
  const joined = probe.replace(/\\\n\s*/g, ' ');
  const STAGES: [string, string][] = [['1', '2'], ['2', '2b'], ['2b', '3'], ['3', '4'], ['4', '5']];

  for (const [name, next] of STAGES) {
    test(`stage ${name}`, () => {
      const start = joined.indexOf(`# ── Stage ${name}:`);
      const end = joined.indexOf(`# ── Stage ${next}:`);
      expect(start).toBeGreaterThan(-1);
      const text = joined.slice(start, end);
      const files = new Set<string>();
      for (const cmd of guestCommandTexts(text)) for (const m of cmd.matchAll(/\/probe\/([\w.-]+\.sh)\b/g)) files.add(m[1]!);
      if (files.size === 0) return;

      const create = text.search(/machine create [^\n]*-v "\$OUT\/guest:\/probe:ro"/);
      expect(create, `stage ${name} reads ${[...files].join(', ')} from /probe but no machine create line in it mounts "$OUT/guest" at /probe`).toBeGreaterThan(-1);
      for (const file of files) {
        const written = joined.indexOf(`cat > "$OUT/guest/${file}"`);
        expect(written, `${file} is read from /probe but never written under $OUT/guest`).toBeGreaterThan(-1);
        expect(written, `${file} must be written before the machine that mounts it is created`).toBeLessThan(start + create);
      }
    });
  }

  test('the scan sees at least one mounted script', () => {
    expect(joined).toContain('sh /probe/echo-request.sh');
    expect(joined).toContain('sh /probe/visibility.sh');
  });

  // INVARIANT: every guest script is written BEFORE stage 0, never inside a
  // stage's `if stage_on` block. Stage 2c's visibility.sh lived inside stage
  // 2b's block, so `--stage 2c` alone mounted a /probe with no script in it and
  // reported "can't open /probe/visibility.sh" as a visibility FAIL (Mac run
  // 2026-09-21) — the same shape as the helper-in-a-stage bug of run 7.
  test('every guest script is written in the preamble, before any stage', () => {
    const stage0 = probe.indexOf('# ── Stage 0:');
    const writes = [...probe.matchAll(/^\s*cat > "\$OUT\/guest\/([^"]+)" <<'GUEST'/gm)];
    expect(writes.length).toBeGreaterThan(3);
    for (const w of writes) {
      expect(w.index!, `${w[1]} is written after stage 0 begins`).toBeLessThan(stage0);
    }
    expect(probe.indexOf('mkdir -p "$OUT/guest"')).toBeLessThan(stage0);
  });
});

// The guest helpers before stage 0 run against BOTH images (stage 2c calls
// mount_shape_probe on alpine and on the daemon image), so their commands must
// exist in both: the intersection, not either set.
describe('guest helpers defined before stage 0 use only tools both images have', () => {
  test('visibility_probe uses only what alpine AND the daemon image have', () => {
    const start = probe.indexOf('visibility_probe() {');
    const end = probe.indexOf('\n}\n', start);
    expect(start).toBeGreaterThan(-1);
    const fn = probe.slice(start, end);
    const both = new Set([...ALPINE_TOOLS].filter((t) => daemonImageTools().has(t)));
    expect(guestCommandTexts(fn).length).toBeGreaterThan(1);
    expect(check(fn, both)).toEqual([]);
  });

  test('stage 2c measures both directions and the negative-entry window on the supervisor\'s mount shape', () => {
    const s2c = stage('2c', '3');
    expect(s2c).toMatch(/machine create [^\n]*--storage 4 \\\n\s*-v "\$HOST_V:\/lazy\/projects\/probe\/store" -v "\$OUT\/guest:\/probe:ro"/);
    expect(s2c).toContain('visibility_probe "${SHAPE_VMS[0]}" "$HOST_V" /lazy/projects/probe/store');
    const helper = probe.slice(probe.indexOf('visibility_probe() {'), probe.indexOf('# ── Stage 0:'));
    for (const name of ['negative_entry_window', 'host_to_guest_fresh_name', 'guest_to_host']) expect(helper).toContain(`result ${name} `);
    // The guest script polls lookup and readdir separately and stamps each.
    const script = probe.slice(probe.indexOf('cat > "$OUT/guest/visibility.sh"'), probe.indexOf('cat > "$OUT/guest/floor-check.sh"'));
    expect(script).toContain('readdir-visible');
    expect(script).toContain('lookup-visible');
    expect(script).toMatch(/date \+%s/);
    expect(probe).toMatch(/STAGES="\$\{LAZY_PROBE_STAGES:-0,1,2,2b,2c,3,4\}"/);
  });
});
