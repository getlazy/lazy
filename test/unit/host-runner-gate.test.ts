import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  HOST_RUNNER_TYPE,
  assertHostRunnerConfigAllowed,
  hostRunnerRemovedMessage,
  isHostRunnerType,
  isRemovedHostRunnerInput,
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
