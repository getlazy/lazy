import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  HOST_RUNNER_TYPE,
  assertHostRunnerConfigAllowed,
  hostRunnerRemovedMessage,
  isHostRunnerType,
  isRemovedHostRunnerInput,
  assertRunnerAllowedInManagedMode,
  smolvmRefusedInManagedMode,
} from '../../src/runner/host-runner-gate';

describe('host runner gate', () => {
  let priorAllow: string | undefined;

  beforeEach(() => {
    priorAllow = process.env.LAZY_ALLOW_HOST_RUNNER;
    delete process.env.LAZY_ALLOW_HOST_RUNNER;
  });

  afterEach(() => {
    if (priorAllow === undefined) delete process.env.LAZY_ALLOW_HOST_RUNNER;
    else process.env.LAZY_ALLOW_HOST_RUNNER = priorAllow;
  });

  test('isHostRunnerType recognizes the canonical internal type', () => {
    expect(isHostRunnerType(HOST_RUNNER_TYPE)).toBe(true);
    expect(isHostRunnerType('docker')).toBe(false);
  });

  test('isRemovedHostRunnerInput catches user-facing spellings', () => {
    expect(isRemovedHostRunnerInput('host')).toBe(true);
    expect(isRemovedHostRunnerInput('  HOST-PROCESS ')).toBe(true);
    expect(isRemovedHostRunnerInput(HOST_RUNNER_TYPE)).toBe(true);
    expect(isRemovedHostRunnerInput('docker')).toBe(false);
  });

  test('assertHostRunnerConfigAllowed refuses outside the test harness', () => {
    expect(() => assertHostRunnerConfigAllowed('lazy.toml')).toThrow(hostRunnerRemovedMessage('lazy.toml'));
  });

  test('LAZY_ALLOW_HOST_RUNNER=1 permits the internal runner in config', () => {
    process.env.LAZY_ALLOW_HOST_RUNNER = '1';
    expect(() => assertHostRunnerConfigAllowed()).not.toThrow();
  });
});

describe('smolvm in managed mode', () => {
  const keys = ['LAZY_MANAGED', 'LAZY_FOREIGN_DOCKER_HOST', 'LAZY_SMOLVM_BINARY'] as const;
  const prior: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of keys) prior[k] = process.env[k];
    process.env.LAZY_MANAGED = '1';
    process.env.LAZY_FOREIGN_DOCKER_HOST = '1';
    process.env.LAZY_SMOLVM_BINARY = '/opt/lazy/smolvm/smolvm';
  });
  afterEach(() => {
    for (const k of keys) { if (prior[k] === undefined) delete process.env[k]; else process.env[k] = prior[k]; }
  });

  test('a per-task smolvm override is refused, at validation and at runner creation', async () => {
    // INVARIANT: Teams never runs the smolvm runner. A per-task override
    // bypasses the managed lazy.toml runner lock and would skip the
    // foreign-docker-host refusal and run the fleet's own vendored smolvm.
    expect(() => assertRunnerAllowedInManagedMode('smolvm')).toThrow(/not available on Lazy Teams/);
    expect(smolvmRefusedInManagedMode('docker')).toBeNull();
    const { createSmolvmRunner } = await import('../../src/runner/smolvm-runner');
    await expect(createSmolvmRunner('/nonexistent-project', {} as never, {} as never)).rejects.toThrow(/not available on Lazy Teams/);
  });

  test('outside managed mode smolvm is allowed', () => {
    delete process.env.LAZY_MANAGED;
    expect(smolvmRefusedInManagedMode('smolvm')).toBeNull();
  });
});
