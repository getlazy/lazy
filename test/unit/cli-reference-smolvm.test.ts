import { expect, test } from 'bun:test';
import { collectPages, render } from '../../scripts/gen-cli-reference';

// INVARIANT: solo smolvm stays available in CLI help but unpublished; Teams
// microVM documentation remains supported. Publication must not change either.
test('publication omits solo smolvm without changing collected help or Teams pages', async () => {
  const pages = await collectPages();
  const original = pages.map((p) => ({ ...p }));
  const files = render(pages);

  expect(pages).toEqual(original);
  expect(pages.find((p) => p.command === 'init')!.usage).toContain('--runner docker|smolvm');
  for (const command of ['system smolvm-build-image', 'system smolvm-install']) {
    expect(pages.some((p) => p.command === command)).toBe(true);
    expect(files.has(`${command.replaceAll(' ', '-')}.md`)).toBe(false);
  }
  for (const name of ['init.md', 'system.md', 'index.md']) {
    expect(files.get(name)).not.toContain('smolvm');
  }
  const teams = pages.find((p) => p.command === 'playground')!;
  expect(teams.usage).toContain('--fleet smolvm');
  expect(files.get('playground.md')).toContain(teams.usage);
}, 60_000);
