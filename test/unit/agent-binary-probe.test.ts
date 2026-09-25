/**
 * Unit tests: custom-image agent-binary probe exit-code classification.
 *
 * INVARIANT: only `which` exit 1 may claim the agent binary is absent from the
 * image. Docker daemon failures and probe infrastructure failures must name
 * what actually happened — misreporting them as "add this RUN line" sent
 * engineers on a wild goose chase.
 */

import { describe, test, expect } from 'bun:test';
import {
  classifyAgentBinaryProbeResult,
  type AgentBinaryProbeContext,
} from '../../src/capture/claude';

const ctx: Pick<AgentBinaryProbeContext, 'imageName' | 'agentId' | 'agentBinary'> = {
  imageName: 'lazy-custom-abc:0.21',
  agentId: 'cursor',
  agentBinary: 'cursor-agent',
};

describe('classifyAgentBinaryProbeResult', () => {
  test('exit 0 means the binary was found', () => {
    expect(classifyAgentBinaryProbeResult(0, null, '', ctx)).toEqual({ kind: 'ok' });
  });

  test('exit 1 means the binary is genuinely missing', () => {
    expect(classifyAgentBinaryProbeResult(1, null, '', ctx)).toEqual({ kind: 'missing-binary' });
  });

  test('SIGTERM with null exit code is a probe timeout', () => {
    const result = classifyAgentBinaryProbeResult(null, 'SIGTERM', 'still running', ctx);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toMatch(/Timed out probing/i);
      expect(result.message).toContain(ctx.imageName);
      expect(result.message).toContain(ctx.agentBinary);
      expect(result.message).toContain('still running');
    }
  });

  test('docker exit 125 is a container start failure, not a missing binary', () => {
    const result = classifyAgentBinaryProbeResult(
      125,
      null,
      'Cannot connect to the Docker daemon',
      ctx,
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toMatch(/exit 125/i);
      expect(result.message).toContain(ctx.imageName);
      expect(result.message).toContain(ctx.agentBinary);
      expect(result.message).toContain(ctx.agentId);
      expect(result.message).toContain('Cannot connect to the Docker daemon');
      expect(result.message).not.toMatch(/does not contain/i);
    }
  });

  test('exit 126 means which could not execute', () => {
    const result = classifyAgentBinaryProbeResult(126, null, '', ctx);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toMatch(/exit 126/i);
      expect(result.message).toContain(ctx.imageName);
    }
  });

  test('exit 127 means which is absent from the image', () => {
    const result = classifyAgentBinaryProbeResult(127, null, '', ctx);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toMatch(/exit 127/i);
      expect(result.message).toMatch(/requires 'which'/i);
      expect(result.message).toContain(ctx.imageName);
    }
  });

  test('other non-zero exits are unexpected with stderr attached', () => {
    const result = classifyAgentBinaryProbeResult(42, null, 'weird failure', ctx);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toMatch(/exit 42/i);
      expect(result.message).toContain(ctx.imageName);
      expect(result.message).toContain('weird failure');
    }
  });
});
