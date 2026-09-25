/**
 * How the release and docs-publish workflows handle PUBLIC_REPO_DEPLOY_KEY — a
 * WRITE deploy key to the public getlazy/lazy repo (source on `main`, the docs
 * site on `gh-pages`). A structural guard over the workflow YAML, because none
 * of this can run outside GitHub Actions.
 *
 * INVARIANT: no pull-request-shaped trigger can reach the key. Only a tag push,
 * a dispatch and a workflow_call from those may run a workflow that holds it,
 * and no other workflow may call one that does.
 *
 * INVARIANT: every secret is passed by name. `secrets: inherit` handed the deploy
 * key to publish-images.yml, which never needs it, along with every other
 * repository secret.
 *
 * INVARIANT: the GITHUB_TOKEN is read-only in all three workflows. release.yml
 * had no `permissions:` at all, so it (and the two workflows it calls) ran with
 * whatever the repository default grants.
 *
 * INVARIANT: no `${{ }}` expression is expanded inside a `run:` script. Inputs
 * (`tag`, `release_tag`, `dry_run`, `platforms`) reach the shell only through
 * `env:` as quoted variables, so a crafted value is data, never a command.
 *
 * INVARIANT: the key is handed to scripts/with-deploy-key.sh and nothing else —
 * no ~/.ssh/deploy_key, no global ~/.ssh/config, no `ssh-keyscan`, no
 * `StrictHostKeyChecking accept-new` — and a job holding it runs only
 * SHA-pinned actions, since any action in that job could read it.
 *
 * INVARIANT: a dry run never holds the key, so it cannot push even by mistake.
 * release.yml's dry run used to install the write key and clone the public repo
 * over SSH with it; it now clones anonymously over HTTPS.
 *
 * INVARIANT: the pinned github.com host keys are GitHub's published ones.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';

const REPO = join(import.meta.dir, '..', '..');
const WF_DIR = join(REPO, '.github', 'workflows');
const KEY_SECRET = 'PUBLIC_REPO_DEPLOY_KEY';
const RELEASE_WORKFLOWS = ['release.yml', 'publish-docs.yml', 'publish-images.yml'];
// Triggers under which a pull request's code (or a fork's) could run a workflow.
const UNTRUSTED_TRIGGERS = ['pull_request', 'pull_request_target', 'workflow_run', 'issue_comment', 'pull_request_review', 'pull_request_review_comment', 'merge_group'];
// https://api.github.com/meta → ssh_key_fingerprints
const GITHUB_SSH_FINGERPRINTS = [
  'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU',
  'SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM',
  'SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s',
];

type Step = { name?: string; uses?: string; run?: string; if?: string; env?: Record<string, unknown>; with?: Record<string, unknown> };
type Job = { steps?: Step[]; uses?: string; secrets?: unknown; permissions?: unknown; env?: Record<string, unknown>; if?: string };
type Workflow = { on: Record<string, unknown>; permissions?: unknown; jobs: Record<string, Job> };

function raw(file: string): string {
  return readFileSync(join(WF_DIR, file), 'utf-8');
}
function load(file: string): Workflow {
  return Bun.YAML.parse(raw(file)) as Workflow;
}
function allWorkflowFiles(): string[] {
  return readdirSync(WF_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
}
function triggers(wf: Workflow): string[] {
  const on = wf.on as unknown;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on as string[];
  return Object.keys(on as Record<string, unknown>);
}
function mentionsKey(value: unknown): boolean {
  return JSON.stringify(value ?? null).includes(KEY_SECRET);
}
function jobsHoldingKey(wf: Workflow): [string, Job][] {
  return Object.entries(wf.jobs).filter(([, job]) => (job.steps ?? []).some((s) => mentionsKey(s.env) || mentionsKey(s.with)));
}

describe('release workflows: deploy key handling', () => {
  test('no pull-request-shaped trigger can reach the key', () => {
    const reachable = new Set(RELEASE_WORKFLOWS);
    for (const file of allWorkflowFiles()) {
      const wf = load(file);
      const holds = mentionsKey(wf.jobs) || Object.values(wf.jobs).some((j) => reachable.has((j.uses ?? '').replace('./.github/workflows/', '')));
      if (!holds && !reachable.has(file)) continue;
      const bad = triggers(wf).filter((t) => UNTRUSTED_TRIGGERS.includes(t));
      expect({ file, bad }).toEqual({ file, bad: [] });
    }
    expect(triggers(load('release.yml')).sort()).toEqual(['push', 'workflow_dispatch']);
    expect((load('release.yml').on.push as { tags?: string[]; branches?: string[] }).branches).toBeUndefined();
    expect(triggers(load('publish-docs.yml')).sort()).toEqual(['workflow_call', 'workflow_dispatch']);
    expect(triggers(load('publish-images.yml')).sort()).toEqual(['workflow_call', 'workflow_dispatch']);
  });

  // INVARIANT: a tag input is checked out as `refs/tags/<tag>`, never by its bare
  // name. actions/checkout resolves a bare name as a BRANCH first, so a branch
  // called v0.23.1234 would win over the tag and its code would run in the job
  // that then holds the deploy key (or builds the published image/docs).
  test('every tag-driven checkout names refs/tags/ explicitly', () => {
    const TAG_INPUT = /inputs\.(tag|release_tag)\b/;
    // Order matters: the guarded form (`inputs.X && format(...)`, where the bare
    // input is only the is-it-set test) is stripped before the plain `format(...)`.
    const QUALIFIED = [/inputs\.(tag|release_tag) && format\('refs\/tags\/\{0\}', inputs\.\1\)/g, /format\('refs\/tags\/\{0\}', inputs\.(tag|release_tag)\)/g, /refs\/tags\/\$\{\{ inputs\.(tag|release_tag) \}\}/g];
    let checked = 0;
    for (const file of RELEASE_WORKFLOWS) {
      for (const [name, job] of Object.entries(load(file).jobs)) {
        for (const step of job.steps ?? []) {
          const ref = step.with?.ref;
          if (!step.uses?.startsWith('actions/checkout') || typeof ref !== 'string' || !TAG_INPUT.test(ref)) continue;
          checked++;
          const bare = QUALIFIED.reduce((s, re) => s.replace(re, ''), ref);
          expect({ file, job: name, step: step.name, ref, bareTagInput: TAG_INPUT.test(bare) }).toEqual({ file, job: name, step: step.name, ref, bareTagInput: false });
        }
      }
    }
    // release (1) + publish-docs "Checkout the released tag" (1) + both image jobs (2)
    expect(checked).toBe(4);
  });

  // INVARIANT: before the deploy key exists, the release job proves HEAD is the
  // tag's commit — whatever the checkout resolved, the key only ever pushes the tag.
  test('release job asserts HEAD is the tag commit before the key step', () => {
    const steps = load('release.yml').jobs.release.steps ?? [];
    const keyAt = steps.findIndex((s) => mentionsKey(s.env));
    const assertAt = steps.findIndex((s) => /git rev-parse HEAD/.test(s.run ?? '') && s.run!.includes('git rev-parse "refs/tags/$RELEASE_TAG^{commit}"'));
    expect(keyAt).toBeGreaterThan(-1);
    expect(assertAt).toBeGreaterThan(-1);
    expect(assertAt).toBeLessThan(keyAt);
  });

  test('secrets are passed by name, and the deploy key only to the docs job', () => {
    for (const file of allWorkflowFiles()) {
      expect({ file, inherit: /secrets:\s*inherit/.test(raw(file)) }).toEqual({ file, inherit: false });
    }
    const release = load('release.yml');
    expect(mentionsKey(release.jobs.images.secrets)).toBe(false);
    expect(release.jobs.docs.secrets).toEqual({ [KEY_SECRET]: `\${{ secrets.${KEY_SECRET} }}` });
  });

  test('GITHUB_TOKEN is read-only everywhere in the release workflows', () => {
    for (const file of RELEASE_WORKFLOWS) {
      const wf = load(file);
      expect({ file, permissions: wf.permissions }).toEqual({ file, permissions: { contents: 'read' } });
      for (const [name, job] of Object.entries(wf.jobs)) {
        expect({ file, job: name, permissions: job.permissions }).toEqual({ file, job: name, permissions: undefined });
      }
    }
  });

  test('no ${{ }} expression is expanded inside a run: script', () => {
    for (const file of RELEASE_WORKFLOWS) {
      for (const [name, job] of Object.entries(load(file).jobs)) {
        for (const step of job.steps ?? []) {
          if (step.run === undefined) continue;
          expect({ file, job: name, step: step.name, expr: step.run.includes('${{') }).toEqual({ file, job: name, step: step.name, expr: false });
        }
      }
    }
  });

  test('the key goes only to with-deploy-key.sh, never onto ~/.ssh, and only SHA-pinned actions share its job', () => {
    for (const file of RELEASE_WORKFLOWS) {
      // Code only: the comments explain what these used to be.
      const text = raw(file).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
      expect({ file, keyscan: /ssh-keyscan/.test(text) }).toEqual({ file, keyscan: false });
      expect({ file, tofu: /StrictHostKeyChecking\s+(accept-new|no)\b/i.test(text) }).toEqual({ file, tofu: false });
      expect({ file, dotSsh: /~\/\.ssh|\$HOME\/\.ssh/.test(text) }).toEqual({ file, dotSsh: false });
    }
    const holders = [...jobsHoldingKey(load('release.yml')), ...jobsHoldingKey(load('publish-docs.yml'))];
    expect(holders.map(([n]) => n).sort()).toEqual(['docs', 'release']);
    for (const [name, job] of holders) {
      for (const step of job.steps ?? []) {
        if (step.uses) expect({ job: name, uses: step.uses }).toEqual({ job: name, uses: expect.stringMatching(/@[0-9a-f]{40}$/) });
        if (step.uses?.startsWith('actions/checkout')) expect({ job: name, persist: step.with?.['persist-credentials'] }).toEqual({ job: name, persist: false });
        if (!mentionsKey(step.env)) continue;
        expect(Object.keys(step.env ?? {})).toEqual(expect.arrayContaining(['DEPLOY_KEY']));
        expect({ job: name, step: step.name, wrapped: /^\s*scripts\/with-deploy-key\.sh /m.test(step.run ?? '') }).toEqual({ job: name, step: step.name, wrapped: true });
      }
    }
  });

  test('a dry run never holds the key', () => {
    const release = load('release.yml').jobs.release;
    const keySteps = (release.steps ?? []).filter((s) => mentionsKey(s.env));
    expect(keySteps.length).toBe(1);
    expect(keySteps[0].if).toBe("env.DRY_RUN != 'true'");
    expect(release.env?.DRY_RUN).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.dry_run }}");
    const dry = (release.steps ?? []).filter((s) => s.if === "env.DRY_RUN == 'true'");
    expect(dry.length).toBe(1);
    expect(mentionsKey(dry[0])).toBe(false);
    expect(dry[0].run).toContain('--dry-run');
    // Anonymous HTTPS for the clone: nothing on this path can authenticate a push.
    expect(dry[0].env?.GIT_CONFIG_KEY_0).toBe('url.https://github.com/.insteadOf');
    expect(dry[0].env?.GIT_CONFIG_VALUE_0).toBe('git@github.com:');

    const docs = load('publish-docs.yml').jobs.docs;
    for (const step of docs.steps ?? []) {
      if (!mentionsKey(step.env)) continue;
      expect(step.if).toBe('${{ !inputs.dry_run }}');
    }
    for (const step of (docs.steps ?? []).filter((s) => s.if === '${{ inputs.dry_run }}')) {
      expect(mentionsKey(step)).toBe(false);
    }
  });

  test('the pinned github.com host keys are the ones GitHub publishes', () => {
    const result = spawnSyncUnsupervised(['ssh-keygen', '-lf', join(REPO, 'scripts', 'github-known-hosts')], { stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.toString().trim().split('\n');
    expect(lines.every((l) => / github\.com /.test(l))).toBe(true);
    expect(lines.map((l) => l.split(' ')[1]).sort()).toEqual([...GITHUB_SSH_FINGERPRINTS].sort());
  });
});
