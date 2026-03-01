/**
 * Toolchain registry and auto-detection for vanilla Dockerfiles.
 *
 * Each toolchain maps to a Dockerfile in src/docker/toolchains/<name>.Dockerfile.
 * Detection rules are applied in order; the first match wins.
 *
 * Dockerfiles are imported at compile time via Bun's text imports so they
 * are bundled into the compiled binary (readFileSync would not work).
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// Static imports for all toolchain Dockerfiles (bundled at compile time)
import dockerfileBase from './toolchains/base.Dockerfile' with { type: 'text' };
import dockerfileBun from './toolchains/bun.Dockerfile' with { type: 'text' };
import dockerfileNode from './toolchains/node.Dockerfile' with { type: 'text' };
import dockerfileDeno from './toolchains/deno.Dockerfile' with { type: 'text' };
import dockerfileRust from './toolchains/rust.Dockerfile' with { type: 'text' };
import dockerfileGo from './toolchains/go.Dockerfile' with { type: 'text' };
import dockerfileCpp from './toolchains/cpp.Dockerfile' with { type: 'text' };
import dockerfileRubyRails from './toolchains/ruby-rails.Dockerfile' with { type: 'text' };
import dockerfileRubyRailsRust from './toolchains/ruby-rails-rust.Dockerfile' with { type: 'text' };
import dockerfileDotnet from './toolchains/dotnet.Dockerfile' with { type: 'text' };
import dockerfilePython from './toolchains/python.Dockerfile' with { type: 'text' };
import dockerfilePythonMl from './toolchains/python-ml.Dockerfile' with { type: 'text' };
import dockerfileJava from './toolchains/java.Dockerfile' with { type: 'text' };
import dockerfileKotlin from './toolchains/kotlin.Dockerfile' with { type: 'text' };
import dockerfileSwift from './toolchains/swift.Dockerfile' with { type: 'text' };

/** Valid toolchain names. Must match filenames in src/docker/toolchains/. */
export const TOOLCHAIN_NAMES = [
  'base',
  'bun',
  'node',
  'deno',
  'rust',
  'go',
  'cpp',
  'ruby-rails',
  'ruby-rails-rust',
  'dotnet',
  'python',
  'python-ml',
  'java',
  'kotlin',
  'swift',
] as const;

export type ToolchainName = (typeof TOOLCHAIN_NAMES)[number];

export function isValidToolchain(name: string): name is ToolchainName {
  return (TOOLCHAIN_NAMES as readonly string[]).includes(name);
}

/**
 * Detection rule: a function that checks a project directory for marker files
 * and returns a toolchain name, or null if the rule doesn't match.
 */
interface DetectionRule {
  /** Toolchain name to return if this rule matches. */
  toolchain: ToolchainName;
  /** Function that checks if this rule matches the project directory. */
  matches: (projectDir: string) => boolean;
}

/** Helper: check if a file exists in the project directory. */
function has(projectDir: string, file: string): boolean {
  return existsSync(join(projectDir, file));
}

/** Helper: check if any file in the directory has the given extension. */
function hasAnyWithExtension(projectDir: string, extension: string): boolean {
  try {
    const files = readdirSync(projectDir);
    return files.some((f: string) => f.endsWith(extension));
  } catch {
    return false;
  }
}

/** ML library patterns to detect in requirements.txt or pyproject.toml. */
const ML_LIBRARY_PATTERNS = [
  /\btorch\b/,
  /\btensorflow\b/,
  /\bkeras\b/,
  /\bjax\b/,
  /\bscikit-learn\b/,
  /\bsklearn\b/,
  /\bxgboost\b/,
  /\blightgbm\b/,
  /\btransformers\b/,
  /\bpaddlepaddle\b/,
];

/**
 * Check if a Python project is an ML project.
 * Returns true if high-confidence ML signals are present:
 * - Jupyter notebooks (.ipynb files) in the project root
 * - ML libraries referenced in requirements.txt or pyproject.toml
 */
export function isPythonMlProject(projectDir: string): boolean {
  // Signal 1: Jupyter notebooks
  if (hasAnyWithExtension(projectDir, '.ipynb')) {
    return true;
  }

  // Signal 2: ML libraries in requirements.txt
  if (has(projectDir, 'requirements.txt')) {
    try {
      const content = readFileSync(join(projectDir, 'requirements.txt'), 'utf-8');
      if (ML_LIBRARY_PATTERNS.some(p => p.test(content))) {
        return true;
      }
    } catch {
      // ignore read errors
    }
  }

  // Signal 3: ML libraries in pyproject.toml dependencies
  if (has(projectDir, 'pyproject.toml')) {
    try {
      const content = readFileSync(join(projectDir, 'pyproject.toml'), 'utf-8');
      if (ML_LIBRARY_PATTERNS.some(p => p.test(content))) {
        return true;
      }
    } catch {
      // ignore read errors
    }
  }

  return false;
}

/**
 * Detection rules, checked in order. First match wins.
 *
 * Multi-language combinations must come before their single-language
 * counterparts (e.g., ruby-rails-rust before ruby-rails before rust).
 */
const DETECTION_RULES: DetectionRule[] = [
  // Cargo.toml + Gemfile → ruby-rails-rust
  {
    toolchain: 'ruby-rails-rust',
    matches: (dir) => has(dir, 'Cargo.toml') && has(dir, 'Gemfile'),
  },
  // Gemfile + (Rakefile or config/routes.rb) → ruby-rails
  {
    toolchain: 'ruby-rails',
    matches: (dir) =>
      has(dir, 'Gemfile') && (has(dir, 'Rakefile') || has(dir, 'config/routes.rb')),
  },
  // Gemfile alone → ruby-rails (Rails is the common case)
  {
    toolchain: 'ruby-rails',
    matches: (dir) => has(dir, 'Gemfile'),
  },
  // *.csproj or *.sln or global.json → dotnet
  {
    toolchain: 'dotnet',
    matches: (dir) =>
      hasAnyWithExtension(dir, '.csproj') ||
      hasAnyWithExtension(dir, '.sln') ||
      has(dir, 'global.json'),
  },
  // Cargo.toml → rust
  {
    toolchain: 'rust',
    matches: (dir) => has(dir, 'Cargo.toml'),
  },
  // go.mod → go
  {
    toolchain: 'go',
    matches: (dir) => has(dir, 'go.mod'),
  },
  // bun.lockb or bunfig.toml → bun
  {
    toolchain: 'bun',
    matches: (dir) => has(dir, 'bun.lockb') || has(dir, 'bunfig.toml'),
  },
  // package.json + (deno.json or deno.lock) → deno
  {
    toolchain: 'deno',
    matches: (dir) =>
      has(dir, 'package.json') && (has(dir, 'deno.json') || has(dir, 'deno.lock')),
  },
  // package.json → node
  {
    toolchain: 'node',
    matches: (dir) => has(dir, 'package.json'),
  },
  // Python ML project: requirements.txt/pyproject.toml with ML deps, or .ipynb files
  {
    toolchain: 'python-ml',
    matches: (dir) =>
      (has(dir, 'requirements.txt') || has(dir, 'pyproject.toml') || has(dir, 'setup.py')) &&
      isPythonMlProject(dir),
  },
  // requirements.txt or pyproject.toml or setup.py → python
  {
    toolchain: 'python',
    matches: (dir) =>
      has(dir, 'requirements.txt') || has(dir, 'pyproject.toml') || has(dir, 'setup.py'),
  },
  // pom.xml or build.gradle → java
  {
    toolchain: 'java',
    matches: (dir) => has(dir, 'pom.xml') || has(dir, 'build.gradle'),
  },
  // build.gradle.kts + *.kt files → kotlin
  {
    toolchain: 'kotlin',
    matches: (dir) => has(dir, 'build.gradle.kts') && hasAnyWithExtension(dir, '.kt'),
  },
  // Package.swift → swift
  {
    toolchain: 'swift',
    matches: (dir) => has(dir, 'Package.swift'),
  },
  // CMakeLists.txt or Makefile → cpp
  {
    toolchain: 'cpp',
    matches: (dir) => has(dir, 'CMakeLists.txt') || has(dir, 'Makefile'),
  },
];

/**
 * Detect the appropriate toolchain for a project directory.
 * Checks detection rules in order; first match wins.
 * Returns 'base' as the fallback if nothing is detected.
 */
export function detectToolchain(projectDir: string): ToolchainName {
  for (const rule of DETECTION_RULES) {
    if (rule.matches(projectDir)) {
      return rule.toolchain;
    }
  }
  return 'base';
}

/** Map from toolchain name to Dockerfile content (bundled at compile time). */
const TOOLCHAIN_DOCKERFILES: Record<ToolchainName, string> = {
  'base': dockerfileBase,
  'bun': dockerfileBun,
  'node': dockerfileNode,
  'deno': dockerfileDeno,
  'rust': dockerfileRust,
  'go': dockerfileGo,
  'cpp': dockerfileCpp,
  'ruby-rails': dockerfileRubyRails,
  'ruby-rails-rust': dockerfileRubyRailsRust,
  'dotnet': dockerfileDotnet,
  'python': dockerfilePython,
  'python-ml': dockerfilePythonMl,
  'java': dockerfileJava,
  'kotlin': dockerfileKotlin,
  'swift': dockerfileSwift,
};

/**
 * Get the contents of a toolchain's Dockerfile.
 * Returns the Dockerfile content as a string (bundled at compile time).
 */
export function getToolchainDockerfileContent(toolchain: ToolchainName): string {
  return TOOLCHAIN_DOCKERFILES[toolchain];
}
