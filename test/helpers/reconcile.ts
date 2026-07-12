/**
 * Drive a single reconcile pass for a daemonless e2e test.
 *
 * Post-v0.11 only the daemon reconciles — no CLI command triggers it — so
 * daemonless suites that assert on reconciler behavior (interrupt detection,
 * auto-resume, circuit breaker, stranded-completion recovery) invoke this to
 * run one pass on demand.
 *
 * Runs in a subprocess loaded with the mock preload so the container/agent
 * boundary is mocked before any module loads (see reconcile-entry.ts for why
 * in-process mocking is unreliable here). LAZY_TEST=1 keeps it from auto-
 * starting a daemon; LAZY_MOCK_CLAUDE_RESPONSE lets the mock supervisor write a
 * response when auto-resume launches.
 */
import { resolve } from 'path';

const PRELOAD_PATH = resolve(__dirname, '../mocks/preload-mocks.ts');
const RECONCILE_ENTRY = resolve(__dirname, 'reconcile-entry.ts');

export interface ReconcileResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runReconcile(
  root: string,
  protocolBase: string,
  mockResponse: { result: string; session_id: string; usage?: { input_tokens: number; output_tokens: number } } = {
    result: 'Mock reconcile response',
    session_id: 'mock-sess-reconcile',
    usage: { input_tokens: 100, output_tokens: 200 },
  },
): Promise<ReconcileResult> {
  const proc = Bun.spawn(['bun', 'run', '--preload', PRELOAD_PATH, RECONCILE_ENTRY, root], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      LAZY_TEST: '1',
      LAZY_PROTOCOL_BASE: protocolBase,
      LAZY_MOCK_CLAUDE_RESPONSE: JSON.stringify(mockResponse),
      ANTHROPIC_API_KEY: 'sk-test-fake-key-for-testing',
    },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}
