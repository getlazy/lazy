import { describe, test, expect } from 'bun:test';
import { getEffectiveModel, ollamaEndpointForHost } from '../../src/utils/ollama';

describe('getEffectiveModel', () => {
  test('returns explicit model when provided', () => {
    const result = getEffectiveModel('explicit-model', { enabled: true, model: 'ollama-model', endpoint: 'http://localhost:11434' });
    expect(result).toBe('explicit-model');
  });

  test('returns Ollama model when enabled and no explicit model', () => {
    const result = getEffectiveModel(undefined, { enabled: true, model: 'ollama-model', endpoint: 'http://localhost:11434' });
    expect(result).toBe('ollama-model');
  });

  test('returns undefined when Ollama is disabled and no explicit model', () => {
    const result = getEffectiveModel(undefined, { enabled: false, model: 'ollama-model', endpoint: 'http://localhost:11434' });
    expect(result).toBeUndefined();
  });

  test('returns undefined when no ollamaConfig and no explicit model', () => {
    const result = getEffectiveModel(undefined, undefined);
    expect(result).toBeUndefined();
  });
});

describe('ollamaEndpointForHost', () => {
  test('replaces host.docker.internal with localhost', () => {
    expect(ollamaEndpointForHost('http://host.docker.internal:11434')).toBe('http://localhost:11434');
  });

  test('leaves localhost endpoints unchanged', () => {
    expect(ollamaEndpointForHost('http://localhost:11434')).toBe('http://localhost:11434');
  });

  test('leaves other hostnames unchanged', () => {
    expect(ollamaEndpointForHost('http://my-ollama-server:11434')).toBe('http://my-ollama-server:11434');
  });

  test('does not mangle subdomains containing host.docker.internal', () => {
    // URL parsing only matches exact hostname, not substrings
    expect(ollamaEndpointForHost('http://host.docker.internal.example.com:11434'))
      .toBe('http://host.docker.internal.example.com:11434');
  });

  test('handles endpoints without port', () => {
    expect(ollamaEndpointForHost('http://host.docker.internal')).toBe('http://localhost');
  });

  test('handles endpoints with path', () => {
    expect(ollamaEndpointForHost('http://host.docker.internal:11434/v1')).toBe('http://localhost:11434/v1');
  });

  test('returns invalid URLs unchanged', () => {
    expect(ollamaEndpointForHost('not-a-url')).toBe('not-a-url');
  });
});
