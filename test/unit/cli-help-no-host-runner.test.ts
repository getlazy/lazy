import { describe, test, expect } from 'bun:test';
import { builderUsage } from '../../src/cli/commands/builder';
import { upgradeUsage } from '../../src/cli/commands/upgrade';
import { daemonHealthUsage } from '../../src/cli/commands/daemon-health';

function capture(fn: () => void): string {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

describe('CLI help text', () => {
  // INVARIANT: help text must not advertise the removed host-process runner or host sandbox. Users following it would configure a runner lazy no longer offers.
  for (const [name, fn] of [
    ['lazy builder --help', builderUsage],
    ['lazy upgrade --help', upgradeUsage],
    ['lazy daemon health --help', daemonHealthUsage],
  ] as const) {
    test(`${name} does not mention the host runner`, () => {
      const out = capture(fn);
      expect(out.length).toBeGreaterThan(0);
      expect(out).not.toMatch(/host-process|host sandbox|without any isolation/i);
    });
  }
});
