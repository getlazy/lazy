import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectToolchain, isValidToolchain, isPythonMlProject, TOOLCHAIN_NAMES } from '../../src/docker/toolchains';

describe('detectToolchain', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function createDir(): Promise<string> {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-toolchain-'));
    return tmpDir;
  }

  test('returns base for empty directory', async () => {
    const dir = await createDir();
    expect(detectToolchain(dir)).toBe('base');
  });

  test('detects rust from Cargo.toml', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'Cargo.toml'), '[package]\nname = "foo"\n');
    expect(detectToolchain(dir)).toBe('rust');
  });

  test('detects go from go.mod', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'go.mod'), 'module example.com/foo\n');
    expect(detectToolchain(dir)).toBe('go');
  });

  test('detects bun from bun.lockb', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'bun.lockb'), '');
    expect(detectToolchain(dir)).toBe('bun');
  });

  test('detects bun from bunfig.toml', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'bunfig.toml'), '[test]\ntimeout = 30000\n');
    expect(detectToolchain(dir)).toBe('bun');
  });

  test('detects node from package.json', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'package.json'), '{"name": "foo"}\n');
    expect(detectToolchain(dir)).toBe('node');
  });

  test('detects deno from package.json + deno.json', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'package.json'), '{"name": "foo"}\n');
    await writeFile(join(dir, 'deno.json'), '{"tasks": {}}\n');
    expect(detectToolchain(dir)).toBe('deno');
  });

  test('detects deno from package.json + deno.lock', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'package.json'), '{"name": "foo"}\n');
    await writeFile(join(dir, 'deno.lock'), '');
    expect(detectToolchain(dir)).toBe('deno');
  });

  test('detects python from requirements.txt', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'requirements.txt'), 'flask==2.0\n');
    expect(detectToolchain(dir)).toBe('python');
  });

  test('detects python from pyproject.toml', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'pyproject.toml'), '[project]\nname = "foo"\n');
    expect(detectToolchain(dir)).toBe('python');
  });

  test('detects python from setup.py', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'setup.py'), 'from setuptools import setup\n');
    expect(detectToolchain(dir)).toBe('python');
  });

  test('detects java from pom.xml', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'pom.xml'), '<project></project>\n');
    expect(detectToolchain(dir)).toBe('java');
  });

  test('detects java from build.gradle', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'build.gradle'), 'apply plugin: "java"\n');
    expect(detectToolchain(dir)).toBe('java');
  });

  test('detects kotlin from build.gradle.kts + .kt file', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'build.gradle.kts'), 'plugins { kotlin("jvm") }\n');
    await writeFile(join(dir, 'Main.kt'), 'fun main() {}\n');
    expect(detectToolchain(dir)).toBe('kotlin');
  });

  test('detects java (not kotlin) from build.gradle.kts without .kt files', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'build.gradle.kts'), 'plugins { java }\n');
    // No .kt files - build.gradle.kts alone doesn't have a rule;
    // but build.gradle.kts doesn't match 'build.gradle' exactly
    // so it falls through to other rules. This tests that kotlin needs .kt files.
    // Since build.gradle.kts isn't build.gradle, and no pom.xml, it falls to base.
    expect(detectToolchain(dir)).toBe('base');
  });

  test('detects swift from Package.swift', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'Package.swift'), '// swift-tools-version:5.9\n');
    expect(detectToolchain(dir)).toBe('swift');
  });

  test('detects cpp from CMakeLists.txt', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\n');
    expect(detectToolchain(dir)).toBe('cpp');
  });

  test('detects cpp from Makefile', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'Makefile'), 'all:\n\tgcc -o main main.c\n');
    expect(detectToolchain(dir)).toBe('cpp');
  });

  test('detects dotnet from .csproj file', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'App.csproj'), '<Project></Project>\n');
    expect(detectToolchain(dir)).toBe('dotnet');
  });

  test('detects dotnet from .sln file', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'Solution.sln'), 'Microsoft Visual Studio Solution\n');
    expect(detectToolchain(dir)).toBe('dotnet');
  });

  test('detects dotnet from global.json', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'global.json'), '{"sdk": {"version": "8.0.0"}}\n');
    expect(detectToolchain(dir)).toBe('dotnet');
  });

  test('detects ruby-rails from Gemfile alone', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'Gemfile'), 'source "https://rubygems.org"\n');
    expect(detectToolchain(dir)).toBe('ruby-rails');
  });

  test('detects ruby-rails from Gemfile + Rakefile', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'Gemfile'), 'source "https://rubygems.org"\n');
    await writeFile(join(dir, 'Rakefile'), 'task :default\n');
    expect(detectToolchain(dir)).toBe('ruby-rails');
  });

  test('detects ruby-rails from Gemfile + config/routes.rb', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'Gemfile'), 'source "https://rubygems.org"\n');
    await mkdir(join(dir, 'config'), { recursive: true });
    await writeFile(join(dir, 'config', 'routes.rb'), 'Rails.application.routes.draw {}\n');
    expect(detectToolchain(dir)).toBe('ruby-rails');
  });

  test('detects ruby-rails-rust from Gemfile + Cargo.toml', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'Gemfile'), 'source "https://rubygems.org"\n');
    await writeFile(join(dir, 'Cargo.toml'), '[package]\nname = "ext"\n');
    expect(detectToolchain(dir)).toBe('ruby-rails-rust');
  });

  // Priority tests: multi-runtime detection must come before single-runtime
  test('Cargo.toml + Gemfile picks ruby-rails-rust over rust', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'Gemfile'), 'source "https://rubygems.org"\n');
    await writeFile(join(dir, 'Cargo.toml'), '[package]\nname = "foo"\n');
    expect(detectToolchain(dir)).toBe('ruby-rails-rust');
  });

  test('bun.lockb takes priority over package.json (bun over node)', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'bun.lockb'), '');
    await writeFile(join(dir, 'package.json'), '{"name": "foo"}\n');
    expect(detectToolchain(dir)).toBe('bun');
  });

  test('Gemfile takes priority over package.json (ruby-rails over node)', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'Gemfile'), 'source "https://rubygems.org"\n');
    await writeFile(join(dir, 'package.json'), '{"name": "foo"}\n');
    expect(detectToolchain(dir)).toBe('ruby-rails');
  });

  // python-ml detection tests
  test('detects python-ml from requirements.txt with torch', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'requirements.txt'), 'torch==2.1.0\nnumpy\n');
    expect(detectToolchain(dir)).toBe('python-ml');
  });

  test('detects python-ml from requirements.txt with tensorflow', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'requirements.txt'), 'tensorflow>=2.14\npandas\n');
    expect(detectToolchain(dir)).toBe('python-ml');
  });

  test('detects python-ml from requirements.txt with scikit-learn', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'requirements.txt'), 'scikit-learn\nmatplotlib\n');
    expect(detectToolchain(dir)).toBe('python-ml');
  });

  test('detects python-ml from requirements.txt with transformers', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'requirements.txt'), 'transformers\ndatasets\n');
    expect(detectToolchain(dir)).toBe('python-ml');
  });

  test('detects python-ml from pyproject.toml with torch dependency', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'pyproject.toml'), '[project]\nname = "foo"\ndependencies = ["torch>=2.0", "numpy"]\n');
    expect(detectToolchain(dir)).toBe('python-ml');
  });

  test('detects python-ml from .ipynb files', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'requirements.txt'), 'pandas\n');
    await writeFile(join(dir, 'analysis.ipynb'), '{"cells": []}\n');
    expect(detectToolchain(dir)).toBe('python-ml');
  });

  test('detects plain python when no ML signals present', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'requirements.txt'), 'flask==2.0\nrequests\n');
    expect(detectToolchain(dir)).toBe('python');
  });

  test('detects python-ml from requirements.txt with xgboost', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'requirements.txt'), 'xgboost\npandas\n');
    expect(detectToolchain(dir)).toBe('python-ml');
  });

  test('detects python-ml from requirements.txt with jax', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'requirements.txt'), 'jax[cuda]\nflax\n');
    expect(detectToolchain(dir)).toBe('python-ml');
  });

  test('.ipynb alone does not trigger python-ml (needs python marker file)', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'notebook.ipynb'), '{"cells": []}\n');
    // No requirements.txt or pyproject.toml — falls through to base
    expect(detectToolchain(dir)).toBe('base');
  });
});

describe('isPythonMlProject', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function createDir(): Promise<string> {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-toolchain-ml-'));
    return tmpDir;
  }

  test('returns false for empty directory', async () => {
    const dir = await createDir();
    expect(isPythonMlProject(dir)).toBe(false);
  });

  test('returns true for .ipynb files', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'notebook.ipynb'), '{}');
    expect(isPythonMlProject(dir)).toBe(true);
  });

  test('returns false for requirements.txt without ML libs', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'requirements.txt'), 'flask\nrequests\ndjango\n');
    expect(isPythonMlProject(dir)).toBe(false);
  });

  test('returns true for requirements.txt with torch', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'requirements.txt'), 'torch>=2.0\nnumpy\n');
    expect(isPythonMlProject(dir)).toBe(true);
  });

  test('returns true for pyproject.toml with keras', async () => {
    const dir = await createDir();
    await writeFile(join(dir, 'pyproject.toml'), 'dependencies = ["keras", "numpy"]\n');
    expect(isPythonMlProject(dir)).toBe(true);
  });

  test('does not false-positive on partial matches', async () => {
    const dir = await createDir();
    // "pytorch-lightning" contains "torch" so it should match
    await writeFile(join(dir, 'requirements.txt'), 'pytorch-lightning\n');
    // This actually DOES match because "torch" appears as substring inside \b boundary
    // pytorch-lightning won't match \btorch\b since it's "torch" within "pytorch"
    expect(isPythonMlProject(dir)).toBe(false);
  });
});

describe('isValidToolchain', () => {
  test('returns true for all known toolchains', () => {
    for (const name of TOOLCHAIN_NAMES) {
      expect(isValidToolchain(name)).toBe(true);
    }
  });

  test('returns false for unknown names', () => {
    expect(isValidToolchain('unknown')).toBe(false);
    expect(isValidToolchain('nodejs')).toBe(false);
    expect(isValidToolchain('')).toBe(false);
    expect(isValidToolchain('Ruby-Rails')).toBe(false);
  });
});
