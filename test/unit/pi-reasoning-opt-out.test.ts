import { describe, expect, test } from 'bun:test';
import { resolveAgentProfiles } from '../../src/config/agent-profiles';
import { piLaunchEnvVars } from '../../src/agent/pi-turn-config';

const block = { harness: 'pi', model: 'gpt-4o', endpoint: 'https://api.openai.com', credential: 'openai' };

describe('pi profile reasoning opt-out', () => {
  test('reasoning = false reaches the launch env', () => {
    const p = resolveAgentProfiles({ gpt4o: { ...block, reasoning: false } }, () => {}).get('gpt4o')!;
    const env = piLaunchEnvVars({ harness: 'pi', profile: p, upstreamTimeoutMs: 0 });
    expect(env).toContainEqual({ key: 'LAZY_PI_REASONING', value: 'off' });
  });

  // INVARIANT: reasoning stays ON unless a profile opts out. Declaring it is what lets a task's effort reach the model at all.
  test('default and reasoning = true send no opt-out', () => {
    for (const extra of [{}, { reasoning: true }]) {
      const p = resolveAgentProfiles({ x: { ...block, ...extra } }, () => {}).get('x')!;
      const env = piLaunchEnvVars({ harness: 'pi', profile: p, upstreamTimeoutMs: 0 });
      expect(env.find((e) => e.key === 'LAZY_PI_REASONING')).toBeUndefined();
    }
  });

  test('refused on a harness that does not use it', () => {
    expect(() => resolveAgentProfiles({ x: { harness: 'codex', reasoning: false } }, () => {})).toThrow(/only the "pi" harness/);
  });
});
