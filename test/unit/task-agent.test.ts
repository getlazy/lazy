import { describe, test, expect } from 'bun:test';
import {
  resolveAgentForNewTask,
  resolveAgentForNewTaskFromConfig,
  formatAgentResolutionLine,
} from '../../src/agent/task-agent';

describe('resolveAgentForNewTask', () => {
  const base = {
    byType: { fix: 'cursor', feature: 'cursor' } as const,
    configDefault: 'claude-code',
  };

  test('explicit --agent wins over by_type and default', () => {
    expect(resolveAgentForNewTask({
      ...base,
      explicit: 'claude-code',
      taskType: 'fix',
    })).toEqual({ agentId: 'claude-code', source: 'explicit' });
  });

  test('inheritFrom wins over by_type and default', () => {
    expect(resolveAgentForNewTask({
      ...base,
      inheritFrom: { agent_id: 'claude-code' },
      taskType: 'fix',
    })).toEqual({ agentId: 'claude-code', source: 'inherit' });
  });

  test('by_type applies when type is mapped and nothing overrides', () => {
    expect(resolveAgentForNewTask({
      ...base,
      taskType: 'fix',
    })).toEqual({ agentId: 'cursor', source: 'by_type', taskType: 'fix' });
  });

  test('unmapped types fall back to agent_id default', () => {
    expect(resolveAgentForNewTask({
      ...base,
      taskType: 'spike',
    })).toEqual({ agentId: 'claude-code', source: 'default' });
  });

  test('resolveAgentForNewTaskFromConfig reads agent section', () => {
    expect(resolveAgentForNewTaskFromConfig(
      { taskType: 'feature' },
      { agent_id: 'claude-code', by_type: { feature: 'cursor' } },
    )).toEqual({ agentId: 'cursor', source: 'by_type', taskType: 'feature' });
  });

  test('resolveAgentForNewTaskFromConfig honors the project defaultAgent overlay', () => {
    expect(resolveAgentForNewTaskFromConfig(
      { taskType: 'spike' },
      { agent_id: 'claude-code', by_type: {} },
      { defaultAgent: 'cursor' },
    )).toEqual({ agentId: 'cursor', source: 'default' });
  });
});

describe('formatAgentResolutionLine', () => {
  test('annotates by_type resolutions', () => {
    expect(formatAgentResolutionLine({
      agentId: 'cursor',
      source: 'by_type',
      taskType: 'fix',
    })).toBe('  Agent:  cursor (task type fix → [agent.by_type])');
  });

  test('shows non-default agents without annotation when not from by_type', () => {
    expect(formatAgentResolutionLine({
      agentId: 'cursor',
      source: 'explicit',
    })).toBe('  Agent:  cursor');
  });

  test('omits line for stock default with no type mapping', () => {
    expect(formatAgentResolutionLine({
      agentId: 'claude-code',
      source: 'default',
    })).toBeNull();
  });
});
