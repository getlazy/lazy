import { describe, test, expect } from 'bun:test';
import {
  resolveRunnerType,
  VALID_RUNNER_TYPES,
  RUNNER_ALIASES,
} from '../../src/config/types';
import { isRemovedHostRunnerInput } from '../../src/runner/host-runner-gate';

describe('runner alias resolution', () => {
  // INVARIANT: user-facing CLI/MCP aliases map to container runners only.
  // Host-process runner is test-harness-internal (see host-runner-gate.ts).
  test('host alias is rejected as a removed runner input', () => {
    expect(isRemovedHostRunnerInput('host')).toBe(true);
    expect(resolveRunnerType('host')).toBeNull();
  });

  test('docker and container both map to docker', () => {
    expect(resolveRunnerType('docker')).toBe('docker');
    expect(resolveRunnerType('container')).toBe('docker');
  });

  test('podman maps to podman', () => {
    expect(resolveRunnerType('podman')).toBe('podman');
  });

  test('container runner canonical values resolve through aliases', () => {
    expect(resolveRunnerType('docker')).toBe('docker');
    expect(resolveRunnerType('podman')).toBe('podman');
  });

  test('case-insensitive and whitespace-tolerant', () => {
    expect(resolveRunnerType('Docker')).toBe('docker');
    expect(resolveRunnerType('  podman ')).toBe('podman');
  });

  test('unknown values return null (caller produces an actionable error)', () => {
    expect(resolveRunnerType('vm')).toBeNull();
    expect(resolveRunnerType('')).toBeNull();
    expect(resolveRunnerType('hostt')).toBeNull();
  });

  test('every alias resolves to a valid runner type', () => {
    for (const [alias, type] of Object.entries(RUNNER_ALIASES)) {
      expect(VALID_RUNNER_TYPES).toContain(type);
      expect(resolveRunnerType(alias)).toBe(type);
    }
  });
});
