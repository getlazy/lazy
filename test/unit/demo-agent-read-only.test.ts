/**
 * The playground stand-in agent on a READ-ONLY launch (ask, review, the
 * low-high self-review), which lazy's claude-code argv marks with
 * `--disallowedTools` and feeds its prompt on stdin.
 *
 * INVARIANT: a read-only launch leaves HEAD, the worktree and the work-turn
 * counter exactly as it found them. lazy fails a turn whose read-only step
 * changed anything, and a stand-in that committed there left every scripted
 * playground task blocked with no work recorded.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { installDemoAgent } from '../../src/demo/agent';
import { parseReviewReport } from '../../src/review/parse-report';
import { resolveReviewVerdict } from '../../src/review/verdict';

const dirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd });
  expect(r.exitCode).toBe(0);
  return r.stdout.toString().trim();
}

async function readOnlyRun(prompt: string, argv: string[] = ['-p', '--disallowedTools', 'Edit,Write']) {
  const agentDir = await tempDir('demo-agent-');
  const { binPath } = await installDemoAgent(agentDir, { pacingMs: 0 });
  const repo = await tempDir('demo-agent-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  const head = git(repo, 'rev-parse', 'HEAD');

  const proc = Bun.spawn([binPath, ...argv], {
    cwd: repo, stdin: new Blob([prompt]), stdout: 'pipe', stderr: 'pipe',
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  expect({ code: await proc.exited, err }).toEqual({ code: 0, err: '' });

  const events = out.trim().split('\n').map(line => JSON.parse(line));
  return { agentDir, repo, head, events, result: String(events[events.length - 1].result) };
}

describe('playground agent read-only launch', () => {
  test('changes nothing, counts no turn, and approves a self-review with a clean report', async () => {
    const run = await readOnlyRun('Review the draft. Reply LOW_HIGH_LOOP_APPROVED if it is fine.');

    expect(git(run.repo, 'rev-parse', 'HEAD')).toBe(run.head);
    expect(git(run.repo, 'status', '--porcelain')).toBe('');
    const counts = await readdir(join(run.agentDir, 'turn-counts')).catch(() => []);
    expect(counts).toEqual([]);

    expect(run.events.some(e => e.type === 'assistant' && JSON.stringify(e).includes('tool_use'))).toBe(true);
    expect(run.result.split('\n')[0]).toBe('LOW_HIGH_LOOP_APPROVED');
    expect(resolveReviewVerdict(parseReviewReport(run.result))).toBe('clean');
  });

  test('does not approve when nobody asked for the self-review verdict', async () => {
    const run = await readOnlyRun('What does this task do?');
    expect(run.result).not.toContain('LOW_HIGH_LOOP_APPROVED');
    expect(git(run.repo, 'rev-parse', 'HEAD')).toBe(run.head);
  });

  // INVARIANT: a wrap-up step (walkthrough, commit nudge) resumes WITHOUT a
  // system prompt and must not replay the scripted turn: that committed the
  // work twice and made the next unblock skip a scripted turn.
  test('a resumed step with no system prompt commits nothing and counts no turn', async () => {
    const run = await readOnlyRun('Your turn is ending — walk the reviewer through it.', ['-p', '--resume', 'x']);
    expect(git(run.repo, 'rev-parse', 'HEAD')).toBe(run.head);
    expect(git(run.repo, 'status', '--porcelain')).toBe('');
    expect(await readdir(join(run.agentDir, 'turn-counts')).catch(() => [])).toEqual([]);
  });
});
