/**
 * In-process coverage for the Settings page: Memories listing, Doctor GET
 * never running the sweep, Run streaming past the web-request deadline, and
 * a remedy going through the dialog NDJSON.
 */

import { describe, test, expect } from 'bun:test';
import { createWebRequestHandler } from '../../src/server/index';
import type { Storage } from '../../src/storage';
import type { DoctorActions } from '../../src/server/doctor-actions';
import type { DoctorReport, StoredDoctorReport } from '../../src/doctor';
import type { DoctorRemedyPreview, DoctorRemedyResult } from '../../src/doctor/remedies';

function emptyStorage(): Storage {
  return new Proxy({}, {
    get: (_target, prop) => {
      if (prop === 'getMemoryCompact') return async () => null;
      if (prop === 'getMemory') return async () => null;
      return async () => [];
    },
  }) as unknown as Storage;
}

function fakeReport(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    ranAt: '2026-09-09T12:00:00.000Z',
    root: '/tmp/proj',
    checks: [
      { id: 'lazy-toml-parses', title: 'lazy.toml parses', status: 'ok' },
      {
        id: 'no-stale-images',
        title: 'No stale runner images',
        status: 'warning',
        detail: '2 older images',
        remedyFlag: 'clean-docker-images',
        remedy: 'lazy doctor --clean-docker-images',
      },
    ],
    contextBudget: null,
    missingRuns: [],
    staleStorageLockPath: null,
    configError: null,
    notes: [],
    errorCount: 0,
    warningCount: 1,
    ...overrides,
  };
}

function fakePreview(overrides: Partial<DoctorRemedyPreview> = {}): DoctorRemedyPreview {
  return {
    flag: 'unset-upstream-tracking',
    title: 'Unset leftover upstream tracking',
    items: [],
    notes: [],
    empty: true,
    emptyMessage: 'No task branches have upstream tracking — nothing to unset.',
    destructive: false,
    ...overrides,
  };
}

function fakeResult(overrides: Partial<DoctorRemedyResult> = {}): DoctorRemedyResult {
  return {
    flag: 'unset-upstream-tracking',
    message: 'Unset tracking on 0 of 0 branch(es).',
    done: 0,
    total: 0,
    failed: false,
    lines: [],
    ...overrides,
  };
}

function doctorActions(options: {
  stored?: StoredDoctorReport | null;
  runMs?: number;
  onRun?: () => void;
  preview?: DoctorRemedyPreview;
  result?: DoctorRemedyResult;
} = {}): DoctorActions {
  return {
    async run() {
      options.onRun?.();
      if (options.runMs) await new Promise((resolve) => setTimeout(resolve, options.runMs));
      return fakeReport();
    },
    async report() {
      return options.stored === undefined ? null : options.stored;
    },
    async previewRemedy() {
      return options.preview ?? fakePreview();
    },
    async applyRemedy(_flag, onProgress) {
      onProgress?.({ label: 'Unsetting tracking', state: 'start' });
      onProgress?.({ label: 'Unsetting tracking', state: 'done' });
      return options.result ?? fakeResult();
    },
  };
}

function parseNdjson(text: string): Array<Record<string, unknown>> {
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('web settings routes', () => {
  test('GET /memory 308-redirects to /settings/memory', async () => {
    const handler = createWebRequestHandler(emptyStorage());
    const res = await handler(new Request('http://localhost/memory?all=1'));
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('http://localhost/settings/memory?all=1');
  });

  test('GET /settings lands on Memories', async () => {
    const handler = createWebRequestHandler(emptyStorage());
    const res = await handler(new Request('http://localhost/settings'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Settings');
    expect(html).toContain('Memories');
    expect(html).toContain('Doctor');
    expect(html).toContain('No memory records yet');
  });

  test('GET /memory Location keeps the request Host', async () => {
    const handler = createWebRequestHandler(emptyStorage());
    const res = await handler(new Request('http://127.0.0.1:8765/memory?all=1', {
      headers: { Host: 'lazy.localhost:8765' },
    }));
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('http://lazy.localhost:8765/settings/memory?all=1');
  });

  test('Memories listing is the Settings page', async () => {
    const handler = createWebRequestHandler(emptyStorage());
    const res = await handler(new Request('http://localhost/settings/memory'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/settings"');
    expect(html).toContain('Memories');
    expect(html).toContain('Doctor');
    expect(html).toContain('No memory records yet');
  });

  // INVARIANT: the Doctor GET is a last-report read. Docker and git probes
  // belong on POST /settings/doctor/run. A GET that ran the sweep would make
  // opening Settings as slow as `lazy doctor` and would surprise anyone who
  // just wanted the last result.
  test('GET /settings/doctor does not run the sweep', async () => {
    let ran = 0;
    const handler = createWebRequestHandler(emptyStorage(), undefined, {
      doctorActions: doctorActions({
        stored: { report: fakeReport(), storedAt: '2026-09-09T12:00:01.000Z' },
        onRun: () => { ran++; },
      }),
    });
    const res = await handler(new Request('http://localhost/settings/doctor'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(ran).toBe(0);
    expect(html).toContain('id="doctor-report"');
    expect(html).toContain('Last run 2026-09-09 12:00 UTC');
    expect(html).toContain('lazy.toml parses');
    expect(html).toContain('data-lz-doctor-run');
    expect(html).toContain('data-lz-doctor-remedy="unset-upstream-tracking"');
    expect(html).toContain('clean-docker-images');
  });

  test('GET /settings/doctor without a port still renders', async () => {
    const handler = createWebRequestHandler(emptyStorage());
    const res = await handler(new Request('http://localhost/settings/doctor'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Doctor actions are not available');
  });

  test('Run POST streams past the web-request deadline', async () => {
    const runMs = 400;
    const deadlineMs = 200;
    const handler = createWebRequestHandler(emptyStorage(), undefined, {
      deadlineMs,
      doctorActions: doctorActions({ runMs }),
    });
    const started = Date.now();
    const res = await handler(new Request('http://localhost/settings/doctor/run', { method: 'POST' }));
    expect(Date.now() - started).toBeLessThan(runMs);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('Request Timed Out');
    expect(body).toContain('id="doctor-progress"');
    expect(body).toContain('Running health checks');
  });

  test('a remedy through the dialog header returns NDJSON preview then result', async () => {
    const handler = createWebRequestHandler(emptyStorage(), undefined, {
      doctorActions: doctorActions({
        preview: fakePreview({
          items: ['lazy/foo → origin refs/heads/lazy/foo'],
          empty: false,
        }),
      }),
    });
    const res = await handler(new Request('http://localhost/settings/doctor/remedy/unset-upstream-tracking', {
      method: 'POST',
      headers: { 'X-Lazy-Doctor-Dialog': '1', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '',
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('ndjson');
    const events = parseNdjson(await res.text());
    expect(events.some((e) => e.kind === 'preview')).toBe(true);
    expect(events.some((e) => e.kind === 'result')).toBe(true);
  });

  test('a destructive remedy stops at the preview until confirm=1', async () => {
    let applied = 0;
    const actions = doctorActions({
      preview: fakePreview({
        flag: 'clean-worktrees',
        title: 'Remove finished-task worktrees',
        items: ['abc complete — /tmp/wt (12 MB)'],
        empty: false,
        destructive: true,
      }),
    });
    const orig = actions.applyRemedy.bind(actions);
    actions.applyRemedy = async (flag, onProgress) => {
      applied++;
      return orig(flag, onProgress);
    };
    const handler = createWebRequestHandler(emptyStorage(), undefined, { doctorActions: actions });

    const preview = await handler(new Request('http://localhost/settings/doctor/remedy/clean-worktrees', {
      method: 'POST',
      headers: { 'X-Lazy-Doctor-Dialog': '1' },
    }));
    const previewEvents = parseNdjson(await preview.text());
    expect(previewEvents.some((e) => e.kind === 'preview' && e.destructive === true)).toBe(true);
    expect(previewEvents.some((e) => e.kind === 'result')).toBe(false);
    expect(applied).toBe(0);

    const apply = await handler(new Request('http://localhost/settings/doctor/remedy/clean-worktrees', {
      method: 'POST',
      headers: {
        'X-Lazy-Doctor-Dialog': '1',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'confirm=1',
    }));
    const applyEvents = parseNdjson(await apply.text());
    expect(applyEvents.some((e) => e.kind === 'result')).toBe(true);
    expect(applied).toBe(1);
  });
});
