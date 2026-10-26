import { expect, test } from 'bun:test';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import ts from 'typescript';

const e2e = join(import.meta.dir, '../e2e');

/** Resolve the registration, rather than mistaking skipIf's condition for a test. */
function testRegistration(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return expression.text === 'test' || expression.text === 'it';
  if (ts.isPropertyAccessExpression(expression) && ['skip', 'todo', 'only'].includes(expression.name.text)) {
    return testRegistration(expression.expression);
  }
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) &&
      ['skipIf', 'runIf', 'each'].includes(expression.expression.name.text)) {
    return testRegistration(expression.expression.expression);
  }
  return false;
}

function timeoutFailures(name: string, source: string): string[] {
  const failures: string[] = [];
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const constants = new Map<string, ts.Expression>();
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) constants.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(file);
  const value = (node: ts.Expression | undefined, seen = new Set<string>()): number => {
    if (!node) return NaN;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isParenthesizedExpression(node)) return value(node.expression, seen);
    if (ts.isIdentifier(node) && !seen.has(node.text)) return value(constants.get(node.text), new Set([...seen, node.text]));
    if (ts.isBinaryExpression(node)) {
      const a = value(node.left, seen), b = value(node.right, seen);
      if (node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return a * b;
      if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return a + b;
    }
    return NaN;
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(file);
      const isTest = testRegistration(node.expression);
      const hook = /^(?:beforeAll|afterAll|beforeEach|afterEach)$/.test(callee);
      if (isTest || hook) {
        const timeout = value(node.arguments[isTest ? 2 : 1]);
        const minimum = name.startsWith('smolvm-')
          ? (isTest || callee === 'beforeAll' ? 7_200_000 : 300_000)
          : 60_000;
        if (!Number.isFinite(timeout) || timeout < minimum) {
          failures.push(`${name}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${callee} needs an explicit timeout >= ${minimum}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return failures;
}

// INVARIANT: hardware tests and their hooks own explicit timeouts. The preload's
// 30s default can override even a two-hour CLI --timeout in a single-file run.
test('real-runtime suites give every test and hook an explicit timeout', async () => {
  const checked: string[] = [];
  const failures: string[] = [];
  for (const name of await readdir(e2e)) {
    if (!name.endsWith('.test.ts')) continue;
    const source = await readFile(join(e2e, name), 'utf8');
    if (!/LAZY_SMOLVM_E2E|LAZY_TEST_CONTAINER_BINARY|realRunner:\s*true|LAZY_(?:REAL_)?DOCKER/.test(source) &&
        !['container-outlives-failed-turns.test.ts', 'exited-container-replacement.test.ts'].includes(name)) continue;
    checked.push(name);
    failures.push(...timeoutFailures(name, source));
  }
  for (const name of ['smolvm-solo', 'smolvm-image-build', 'container-outlives-failed-turns', 'exited-container-replacement']) {
    expect(checked).toContain(`${name}.test.ts`);
  }
  expect(failures).toEqual([]);
});

// INVARIANT: conditional hardware tests need overrides too. Their conditions
// configure a registration; they are not the test's name/callback arguments.
test('the guard checks conditional and parameterized test registrations', () => {
  for (const registration of ['test', 'test.only', 'test.skipIf(true)', 'it.runIf(false)', 'test.each([1, 2])']) {
    expect(timeoutFailures('hardware.test.ts', `${registration}('hardware', async () => {});`)).toHaveLength(1);
    expect(timeoutFailures('hardware.test.ts', `${registration}('hardware', async () => {}, 5_000);`)).toHaveLength(1);
    expect(timeoutFailures('hardware.test.ts', `${registration}('hardware', async () => {}, 60_000);`)).toEqual([]);
  }
});
