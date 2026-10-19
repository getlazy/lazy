import { describe, test, expect, spyOn } from 'bun:test';
import { systemMachineUsage } from '../../src/cli/commands/system-machine';

describe('lazy system machine --help', () => {
  // INVARIANT: every flag the command parses is described in its help, and the
  // help carries no leftover text-substitution artifact. A scripted edit once
  // replaced the `--json` line with a literal `$1`, hiding the flag from users.
  test('documents --json and contains no stray substitution text', () => {
    const lines: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    try {
      systemMachineUsage();
    } finally {
      spy.mockRestore();
    }
    const text = lines.join('\n');
    expect(text).toMatch(/^\s+--json\s+Machine-readable output/m);
    expect(text).not.toMatch(/^\s*\$\d+\s*$/m);
  });
});
