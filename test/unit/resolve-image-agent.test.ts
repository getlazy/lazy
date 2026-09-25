/**
 * Unit tests: resolveImageAgent — which agent CLI an image build should bake in.
 *
 * INVARIANT: unknown agent ids fall back to the base image, but genuine
 * packaging failures must propagate — swallowing getAgentPackaging errors
 * silently built base images and failed far from the cause.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveImageAgent } from '../../src/capture/claude';
import { pinConfig } from '../helpers/pin-config';

describe('resolveImageAgent', () => {
  let root: string;
  let undoConfig: (() => void) | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-resolve-image-agent-'));
    await writeFile(
      join(root, 'lazy.toml'),
      '[project]\nname = "t"\n[docker]\ndockerfile = ""\n[agent]\nagent_id = "claude-code"\n',
    );
    undoConfig = pinConfig(root);
  });

  afterEach(async () => {
    undoConfig?.();
    await rm(root, { recursive: true, force: true });
  });

  test('claude-code needs no extra agent install (already in the base image)', async () => {
    expect(await resolveImageAgent(root, 'claude-code')).toBeNull();
    expect(await resolveImageAgent(root)).toBeNull();
  });

  test('a registered container-capable agent is baked into its own image', async () => {
    expect(await resolveImageAgent(root, 'cursor')).toBe('cursor');
  });

  test('a registered host-only agent does not reach a container-specific image', async () => {
    expect(await resolveImageAgent(root, 'qa-agent')).toBeNull();
  });

  test('an unregistered agent id falls back to the base image', async () => {
    expect(await resolveImageAgent(root, 'not-a-real-agent-id')).toBeNull();
  });
});
