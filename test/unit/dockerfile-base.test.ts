/**
 * Parsing `FROM` out of a project's custom Dockerfile.
 *
 * The reason this parse exists at all: `lazy-runner` is a purely local image, so
 * a `FROM lazy-runner` with no local base makes docker try Docker Hub and fail
 * with "pull access denied". Recognising the reference is what lets lazy build
 * the base first. See src/capture/dockerfile-base.ts.
 */
import { describe, test, expect } from 'bun:test';
import { parseFromRefs, analyzeLazyBaseUsage } from '../../src/capture/dockerfile-base';

const BASE = 'lazy-runner';
const BUILDABLE = ['lazy-runner:0.23', 'lazy-runner:latest'];

const analyze = (content: string) => analyzeLazyBaseUsage(content, BASE, BUILDABLE);

describe('FROM parsing', () => {
  test('the spellings a real Dockerfile uses all resolve to the base repository', () => {
    for (const line of [
      'FROM lazy-runner',
      'FROM lazy-runner:latest',
      'from lazy-runner',
      '   FROM   lazy-runner   ',
      'FROM --platform=linux/amd64 lazy-runner',
      'FROM lazy-runner AS base',
      'FROM --platform=$BUILDPLATFORM lazy-runner:latest AS build',
    ]) {
      expect(analyze(line).referenced).toEqual(['lazy-runner:latest']);
    }
  });

  test('an untagged reference normalises to the :latest it actually resolves through', () => {
    expect(analyze('FROM lazy-runner\n').referenced).toEqual(['lazy-runner:latest']);
  });

  test('comments and unrelated bases are ignored', () => {
    const content = [
      '# FROM lazy-runner  <- just a comment',
      'FROM debian:bookworm-slim',
      'RUN echo FROM lazy-runner',
      'FROM node:22 AS node',
    ].join('\n');
    expect(analyze(content).referenced).toEqual([]);
  });

  // A multi-stage `FROM builder` names an earlier STAGE, not an image — docker
  // never tries to pull it, and neither should lazy try to build it.
  test('a reference to an earlier build stage is not an image reference', () => {
    const content = 'FROM debian:bookworm-slim AS lazy-runner\nFROM lazy-runner\n';
    expect(analyze(content).referenced).toEqual([]);
    // ...but the same name BEFORE any such stage is declared is still the image.
    expect(analyze('FROM lazy-runner\nFROM debian AS lazy-runner\n').referenced)
      .toEqual(['lazy-runner:latest']);
  });

  test('a namespaced or registry-qualified lookalike is somebody else’s image', () => {
    expect(analyze('FROM docker.io/acme/lazy-runner:1\n').referenced).toEqual([]);
    expect(analyze('FROM acme/lazy-runner\n').referenced).toEqual([]);
  });

  test('an ARG-interpolated FROM simply does not match — the pre-existing behaviour', () => {
    expect(analyze('ARG BASE=lazy-runner\nFROM ${BASE}\n').referenced).toEqual([]);
  });

  test('a repeated reference is reported once', () => {
    const content = 'FROM lazy-runner AS a\nRUN true\nFROM lazy-runner AS b\n';
    expect(analyze(content).referenced).toEqual(['lazy-runner:latest']);
  });

  test('parseFromRefs surfaces stage names alongside refs', () => {
    expect(parseFromRefs('FROM debian:12 AS builder\n')).toEqual([
      { ref: 'debian:12', stage: 'builder' },
    ]);
  });
});

describe('what lazy will build for you', () => {
  test('the tags a base build writes are buildable', () => {
    expect(analyze('FROM lazy-runner\n').buildable).toEqual(['lazy-runner:latest']);
    expect(analyze('FROM lazy-runner:0.23\n').buildable).toEqual(['lazy-runner:0.23']);
  });

  // A base build writes only the current version tag and `:latest`. Building it
  // would not produce `lazy-runner:0.19`, so lazy must not pretend it can —
  // it says so in the error instead.
  test('a base pinned to a tag no build writes is recognised but not buildable', () => {
    const usage = analyze('FROM lazy-runner:0.19\n');
    expect(usage.referenced).toEqual(['lazy-runner:0.19']);
    expect(usage.buildable).toEqual([]);
    expect(usage.unbuildable).toEqual(['lazy-runner:0.19']);
  });

  // DECISION: agent-suffixed repositories (`lazy-runner-cursor`) are lazy's own
  // per-agent default images, built by ensureImage from the default Dockerfile
  // plus that agent's install line. Nothing documents them as a FROM target, and
  // re-deriving that content inside the custom-build path would be a second
  // image pipeline. They get the actionable error, not an auto-build.
  test('an agent-suffixed base is recognised but never auto-built', () => {
    const usage = analyze('FROM lazy-runner-cursor\n');
    expect(usage.referenced).toEqual(['lazy-runner-cursor:latest']);
    expect(usage.buildable).toEqual([]);
    expect(usage.unbuildable).toEqual(['lazy-runner-cursor:latest']);
  });

  test('a digest-pinned base is never buildable — no tag lazy could write', () => {
    const usage = analyze('FROM lazy-runner@sha256:' + 'a'.repeat(64) + '\n');
    expect(usage.buildable).toEqual([]);
    expect(usage.unbuildable.length).toBe(1);
  });
});
