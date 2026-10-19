import { describe, test, expect } from 'bun:test';
import { renderBackgroundNudgePrompt, MAX_BACKGROUND_LABEL_CHARS } from '../../src/supervisor/leftovers';

describe('background nudge prompt', () => {
  test('names each stopped command as one inline code line', () => {
    const prompt = renderBackgroundNudgePrompt(['bun test test/e2e/']);
    expect(prompt).toContain('- `bun test test/e2e/`');
    expect(prompt).toContain("Are you sure you didn't need it to finish?");
  });

  // INVARIANT: a raw multi-line or huge command is flattened and capped, so it
  // can neither break the inline code span nor bloat the prompt.
  test('flattens multi-line commands and caps long ones', () => {
    const prompt = renderBackgroundNudgePrompt(['cat <<EOF > x\nhello\nEOF\n&& bun test', 'x'.repeat(5000)]);
    expect(prompt).toContain('- `cat <<EOF > x hello EOF && bun test`');
    const long = prompt.split('\n').find(l => l.startsWith('- `xxx'))!;
    expect(long.length).toBeLessThanOrEqual(MAX_BACKGROUND_LABEL_CHARS + 4);
    expect(long).toContain('…');
  });
});
