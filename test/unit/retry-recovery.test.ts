import { test, expect } from 'bun:test';
import { execWithWatchdog } from '../../src/supervisor/watchdog';
import { getAgent, listAgents } from '../../src/agent/registry';
import { decideRetry, TRANSIENT_MAX_ATTEMPTS } from '../../src/supervisor/retry-policy';

// INVARIANT: the recovery deadline is independent of diagnostic output and the
// normal watchdog, including for harnesses without a structured activity stream.
for (const id of listAgents()) {
  test(`${id}: live child emitting chatter cannot hold a retry forever`, async () => {
    const agent = getAgent(id);
    const failure = agent.classifyFailure({ message: 'API Error: 529 Overloaded' });
    // QA has no provider and intentionally classifies provider text as unknown.
    expect(failure.class).toBe(id === 'qa-agent' ? 'unknown' : 'transient_overload');
    expect(decideRetry(failure, TRANSIENT_MAX_ATTEMPTS).action).toBe('stop');
    let progressed = false;
    const start = Date.now();
    const result = await execWithWatchdog([process.execPath, '-e',
      `setInterval(() => console.error('API Error: 529 Overloaded'), 10)`], {
      cwd: '/tmp', env: {}, timeoutMs: 0, activityStream: agent.activityStream(),
      recovery: { timeoutMs: 100, onProgress: () => { progressed = true; } },
    });
    expect(result.recoveryTimedOut).toBe(true);
    expect(progressed).toBe(false);
    expect(Date.now() - start).toBeLessThan(7000);
  });
}

test('real model activity releases recovery deadline for long-running work', async () => {
  let progressed = false;
  const result = await execWithWatchdog([process.execPath, '-e',
    `console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'working'}]}})); await Bun.sleep(250);`], {
    cwd: '/tmp', env: {}, timeoutMs: 0, activityStream: getAgent('claude-code').activityStream(),
    recovery: { timeoutMs: 150, onProgress: () => { progressed = true; } },
  });
  expect(progressed).toBe(true);
  expect(result.recoveryTimedOut).toBe(false);
});

test('an error result cannot cancel the recovery deadline', async () => {
  const agent = getAgent('claude-code');
  let progressed = false;
  const result = await execWithWatchdog([process.execPath, '-e',
    `console.log(JSON.stringify({type:'result',is_error:true,result:'API Error: 529 Overloaded',session_id:'test'})); setInterval(() => {}, 1000);`], {
    cwd: '/tmp', env: {}, timeoutMs: 0, activityStream: agent.activityStream(),
    recovery: { timeoutMs: 100, onProgress: () => { progressed = true; },
      isSuccessfulResult: raw => {
        try { agent.parseResponse(raw); return true; }
        catch { return false; } // Error results remain failures, even with exit code zero.
      } },
  });
  expect(result.recoveryTimedOut).toBe(true);
  expect(progressed).toBe(false);
});

// INVARIANT: a live provider failure arms the guard even after useful output;
// ordinary prose mentioning failures is never a provider diagnostic.
test('live error rearms after recovery without classifying generated prose', async () => {
  const agent = getAgent('claude-code');
  let failures = 0;
  const result = await execWithWatchdog([process.execPath, '-e', `
    console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'fixing rate limit handling'}]}}));
    await Bun.sleep(120);
    setInterval(() => console.log(JSON.stringify({type:'system',subtype:'api_retry',error_status:529,error:'overloaded'})), 10);
  `], {
    cwd: '/tmp', env: {}, timeoutMs: 0, activityStream: agent.activityStream(),
    recovery: { timeoutMs: 80, initiallyArmed: true, onProgress: () => {},
      onFailure: message => { expect(agent.classifyFailure({message}).class).toBe('transient_overload'); failures++; return 80; } },
  });
  expect(failures).toBeGreaterThan(0);
  expect(result.recoveryTimedOut).toBe(true);
});

test('Codex reasoning is genuine recovery activity', async () => {
  let progressed = false;
  const result = await execWithWatchdog([process.execPath, '-e', `
    console.log(JSON.stringify({type:'item.completed',item:{id:'i',type:'reasoning',text:'Considering the solution'}}));
    await Bun.sleep(250);
  `], {
    cwd: '/tmp', env: {}, timeoutMs: 0, activityStream: getAgent('codex').activityStream(),
    recovery: { timeoutMs: 150, onProgress: () => { progressed = true; } },
  });
  expect(progressed).toBe(true);
  expect(result.recoveryTimedOut).toBe(false);
});

test('all harnesses normalize live retry diagnostics without calling prose an error', () => {
  const fixtures: [string, unknown][] = [
    ['claude-code', {type:'system',subtype:'api_retry',error_status:529,error:'overloaded'}],
    ['codex', {type:'error',message:'529 Overloaded'}],
    ['cursor', {type:'retry',subtype:'starting',attempt:1,is_resume:true}],
    ['pi', {type:'auto_retry_start',attempt:1,maxAttempts:3,delayMs:1000,errorMessage:'529 Overloaded'}],
  ];
  for (const [id, event] of fixtures) {
    const agent = getAgent(id);
    const parsed = agent.activityStream()!.parseLine(JSON.stringify(event));
    expect(parsed?.failureMessage).toBeTruthy();
    expect(agent.classifyFailure({message:parsed!.failureMessage!}).class.startsWith('transient_')).toBe(true);
    expect(parsed?.modelOutput).not.toBe(true);
  }
  expect(getAgent('pi').activityStream()!.parseLine(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_start',contentIndex:0}}))?.modelOutput).not.toBe(true);
  expect(getAgent('claude-code').activityStream()!.parseLine(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:''}]}}))?.modelOutput).not.toBe(true);
});
