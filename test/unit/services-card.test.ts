/**
 * The Services card (src/server/services-card.ts) — one renderer for the
 * review page and the task detail page, so the two can never disagree about
 * what a task serves or whether anything is listening.
 */

import { describe, test, expect } from 'bun:test';
import { servicesCardHtml, toProbedState, type ProbedServeState } from '../../src/server/services-card';

const task = { id: 'task-id-0001', code: 'svc-task' };

const base: ProbedServeState = {
  declared: [
    { name: 'web', port: 3000 },
    { name: 'api', port: 8080 },
  ],
  services: [
    {
      name: 'web',
      port: 3000,
      binding: { containerPort: 3000, hostAddress: '127.0.0.1', hostPort: 49154 },
      url: 'http://127.0.0.1:49154',
      listening: true,
    },
    {
      name: 'api',
      port: 8080,
      binding: { containerPort: 8080, hostAddress: '127.0.0.1', hostPort: 49155 },
      url: 'http://127.0.0.1:49155',
      listening: false,
    },
  ],
  unavailable: null,
  containerName: 'lazy-svc-task',
  runnerType: 'docker',
};

describe('servicesCardHtml', () => {
  test('links each service, shows its liveness dot and its lazy url command', () => {
    const html = servicesCardHtml(task, base);
    expect(html).toContain('href="http://127.0.0.1:49154"');
    expect(html).toContain('svc-dot-on');
    expect(html).toContain('svc-dot-off');
    expect(html).toContain('lazy url svc-task web');
    expect(html).toContain('lazy url svc-task api');
    expect(html).toContain('data-svc-copy="lazy url svc-task web"');
    expect(html).toContain('1/2 listening');
  });

  test('an empty declaration renders the card with an honest empty state', () => {
    const html = servicesCardHtml(task, { ...base, declared: [], services: [] });
    expect(html).toContain('Services');
    expect(html).toContain('declares no services');
    expect(html).not.toContain('data-svc-copy');
  });

  // A down container is ONE line for the whole card, not one row per service:
  // repeating the same reason per service read as a list of live services.
  test('a stopped container says so once, for the whole card', () => {
    const html = servicesCardHtml(task, { ...base, services: [], unavailable: 'not-running' });
    expect(html).toContain('container not running');
    expect(html).toContain('svc-down');
    expect(html).toContain('Container not running — nothing is published');
    expect(html).toContain('2 declared: web, api');
    expect(html).not.toContain('svc-row');
    expect(html).not.toContain('http://127.0.0.1:');
  });

  // The whole point of probing server-side: a published port with nothing
  // behind it must not look like a working URL.
  test('a published port with nothing listening is not a link', () => {
    const html = servicesCardHtml(task, base);
    expect(html).toContain('nothing listening on port 8080');
    expect(html).toContain('svc-dead');
    expect(html).toContain('svc-row svc-off');
    expect(html).not.toContain('href="http://127.0.0.1:49155"');
    // …while the live one still links, with a green dot.
    expect(html).toContain('svc-row svc-up');
    expect(html).toContain('href="http://127.0.0.1:49154"');
  });

  test('a container-less runner explains where the services actually are', () => {
    const html = servicesCardHtml(task, {
      ...base,
      services: [],
      unavailable: 'no-container-runner',
      runnerType: 'host-process',
    });
    expect(html).toContain('host-process runner');
  });

  test('an unresolvable state renders nothing rather than a guess', () => {
    expect(servicesCardHtml(task, null)).toBe('');
  });

  test('a task with no code addresses lazy url by short id', () => {
    const html = servicesCardHtml({ id: 'abcdef0123456789', code: null }, base);
    expect(html).toContain('lazy url abcdef01 web');
  });

  // toProbedState lets a caller with only resolution (no probe ran) still
  // render honestly: unprobed services read as null, probed ones keep their
  // result through the widening.
  test('toProbedState preserves an existing probe result and defaults to null', () => {
    const widened = toProbedState({
      ...base,
      services: [
        base.services[0],
        { name: 'api', port: 8080, binding: null, url: null },
      ],
    });
    expect(widened.services[0].listening).toBe(true);
    expect(widened.services[1].listening).toBeNull();
  });
});

describe('servicesCardHtml container controls', () => {
  const controls = {
    taskId: task.id,
    canStart: true,
    start: null,
    startServicesCmd: '',
    shellAvailable: true,
    canDesignate: false,
  };

  test('a stopped container offers Start container on the same line', () => {
    const html = servicesCardHtml(task, { ...base, services: [], unavailable: 'not-running' }, controls);
    expect(html).toContain(`action="/tasks/${task.id}/container/start"`);
    expect(html).toContain('Start container');
  });

  test('no button without an action port, and none while a start is in flight', () => {
    const down = { ...base, services: [], unavailable: 'not-running' as const };
    expect(servicesCardHtml(task, down)).not.toContain('container/start');
    expect(servicesCardHtml(task, down, { ...controls, canStart: false })).not.toContain('container/start');

    const running = servicesCardHtml(task, down, {
      ...controls,
      start: { phase: 'starting', detail: 'Building the image…', startedAt: Date.now() },
    });
    expect(running).not.toContain('<button type="submit"');
    expect(running).toContain('Building the image…');
    // No JS needed to follow a launch that can legitimately take minutes.
    expect(running).toContain('http-equiv="refresh"');
  });

  test('Start services appears only with a configured command and a live shell', () => {
    const withCmd = { ...controls, startServicesCmd: 'bin/dev' };
    const html = servicesCardHtml(task, base, withCmd);
    expect(html).toContain('data-lz-shell-run="bin/dev"');
    expect(html).toContain(`data-lz-shell-for="${task.id}"`);

    expect(servicesCardHtml(task, base, controls)).not.toContain('data-lz-shell-run');
    expect(servicesCardHtml(task, base, { ...withCmd, shellAvailable: false }))
      .not.toContain('data-lz-shell-run');
  });

  // The button and its shell-mount slot must share one `data-lz-shell-step`
  // wrap — the same convention review-verify.ts's Run buttons use — so the
  // delegated click handler in shell-ui.ts can find the mount and open the
  // terminal in place instead of switching to the Shell tab.
  test('Start services carries its own shell-mount slot for an in-place terminal', () => {
    const withCmd = { ...controls, startServicesCmd: 'bin/dev' };
    const html = servicesCardHtml(task, base, withCmd);
    expect(html).toMatch(
      /<div[^>]*data-lz-shell-step[^>]*>[\s\S]*?data-lz-shell-run="bin\/dev"[\s\S]*?data-lz-shell-mount[^>]*>[\s\S]*?<\/div>/,
    );
  });

  test('Start services still appears when the container is down', () => {
    const html = servicesCardHtml(
      task,
      { ...base, services: [], unavailable: 'not-running' },
      { ...controls, startServicesCmd: 'bin/dev', canDesignate: true },
    );
    expect(html).toContain('data-lz-shell-run="bin/dev"');
    expect(html).toContain('data-lz-shell-label="Services"');
    expect(html).toContain('Change the project-wide Start services command');
  });

  test('when unset, the card offers to designate the project-wide command', () => {
    const html = servicesCardHtml(task, base, { ...controls, canDesignate: true });
    expect(html).toContain('project-wide command that Start services will run');
    expect(html).toContain('not a per-task override');
    expect(html).toContain(`action="/tasks/${task.id}/services/start-cmd"`);
    expect(html).toContain('name="command"');
    expect(html).toContain('method="POST"');
    // No Start button until a command is saved.
    expect(html).not.toContain('data-lz-shell-run');
  });

  test('when set, the card still offers Start services and a change form', () => {
    const html = servicesCardHtml(task, base, {
      ...controls,
      startServicesCmd: 'npm run dev',
      canDesignate: true,
    });
    expect(html).toContain('data-lz-shell-run="npm run dev"');
    expect(html).toContain('Change the project-wide Start services command');
    expect(html).toContain('value="npm run dev"');
    expect(html).toContain(`action="/tasks/${task.id}/services/start-cmd"`);
  });

  test('designation form is hidden without a ServeActions port', () => {
    const html = servicesCardHtml(task, base, controls);
    expect(html).not.toContain('services/start-cmd');
    expect(html).not.toContain('Designate the project-wide');
  });

  test('designation form appears even when no services are declared', () => {
    const html = servicesCardHtml(
      task,
      { ...base, declared: [], services: [] },
      { ...controls, canDesignate: true },
    );
    expect(html).toContain('declares no services');
    expect(html).toContain('project-wide command that Start services will run');
    expect(html).toContain('services/start-cmd');
  });
});
