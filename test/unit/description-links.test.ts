import { describe, test, expect } from 'bun:test';
import { applyLinksSection, composeInitialBody, applyFidelitySection, LINKS_BEGIN } from '../../src/synthesis/fidelity';
import { mainServiceOf } from '../../src/serve/ports';
import { resolveDescriptionLinks } from '../../src/remote/description-links';

const LINE = '🔗 [**Task in Lazy Teams**](https://t/x)';

describe('lazy-owned links block', () => {
  test('initial body opens with the links, then Goal and Summary', () => {
    const body = composeInitialBody({ goal: 'G', footer: 'F', links: LINE });
    expect(body.startsWith(LINKS_BEGIN)).toBe(true);
    expect(body.indexOf('## Goal')).toBeGreaterThan(body.indexOf(LINE));
    expect(body.indexOf('## Summary')).toBeGreaterThan(body.indexOf('## Goal'));
  });

  test('no links means the body is the old shape', () => {
    expect(composeInitialBody({ goal: 'G', footer: 'F', links: null })).not.toContain('lazy:links');
  });

  // INVARIANT: a refresh replaces the block in place and never duplicates it.
  test('refresh replaces in place and is idempotent', () => {
    const body = composeInitialBody({ goal: 'G', footer: 'F', links: LINE });
    const updated = applyLinksSection(body, '🔗 NEW');
    expect(updated).toContain('🔗 NEW');
    expect(updated).not.toContain(LINE);
    expect(applyLinksSection(updated, '🔗 NEW')).toBe(updated);
    expect(updated.split(LINKS_BEGIN).length - 1).toBe(1);
    // A summary refresh alongside leaves the block alone.
    expect(applyLinksSection(applyFidelitySection(updated, 'S'), '🔗 NEW')).toContain('🔗 NEW');
  });

  test('a body without the block gets one at the top; null removes it; undefined leaves it', () => {
    const plain = '## Goal\n\nG\n';
    const added = applyLinksSection(plain, LINE);
    expect(added.startsWith(LINKS_BEGIN)).toBe(true);
    expect(applyLinksSection(added, null)).toBe(plain);
    expect(applyLinksSection(added, undefined)).toBe(added);
  });

  test('main service: configured port, else first, else none', () => {
    const services = [{ name: 'web', port: 3000 }, { name: 'api', port: 8080 }];
    expect(mainServiceOf(services, 8080)?.name).toBe('api');
    expect(mainServiceOf(services, undefined)?.name).toBe('web');
    expect(mainServiceOf([], undefined)).toBeNull();
  });

  test('resolver: nothing pushed means no links; with no ports the task link only', async () => {
    const task = { id: 'abc', code: 'my-task' } as any;
    const storageWith = (teamsLinks: unknown) => ({ getProjectSettings: async () => (teamsLinks ? { teamsLinks } : null) }) as any;
    const config = (services: any[], main?: number) => ({ serve: { services, main_service: main } }) as any;
    expect(await resolveDescriptionLinks(storageWith(undefined), config([{ name: 'web', port: 3000 }]), task)).toBeNull();
    const templates = { taskUrlTemplate: 'https://t/tasks/{task}', serviceUrlTemplate: 'https://t/tasks/{task}/services/{service}' };
    const both = await resolveDescriptionLinks(storageWith(templates), config([{ name: 'web', port: 3000 }]), task);
    expect(both).toContain('(https://t/tasks/my-task)');
    expect(both).toContain('(https://t/tasks/my-task/services/web)');
    const only = await resolveDescriptionLinks(storageWith(templates), config([]), task);
    expect(only).toContain('(https://t/tasks/my-task)');
    expect(only).not.toContain('services');
  });
});

describe('service link uses the host label', () => {
  // INVARIANT: {service} is the daemon's host label (Teams' door matches on it),
  // so a name with '_' links by its port.
  test('a non-label service name falls back to its port', async () => {
    const task = { id: 'abc', code: 'my-task' } as any;
    const storage = { getProjectSettings: async () => ({ teamsLinks: { taskUrlTemplate: 'https://t/{task}', serviceUrlTemplate: 'https://t/{task}/s/{service}' } }) } as any;
    const config = { serve: { services: [{ name: 'web_api', port: 3000 }], main_service: undefined } } as any;
    expect(await resolveDescriptionLinks(storage, config, task)).toContain('(https://t/my-task/s/3000)');
  });
});
