import { describe, test, expect } from 'bun:test';
import { endpointForHost } from '../../src/utils/endpoint';
import { isHostedOllamaEndpoint } from '../../src/utils/ollama';

// These cases were written against `ollamaEndpointForHost`, which the agent-
// profiles work generalized into `endpointForHost`: any profile can pin an
// endpoint now, not just an Ollama one, so the container→host rewrite stopped
// being Ollama-specific. Same rule, same cases, one home.
describe('endpointForHost', () => {
  test('replaces host.docker.internal with localhost', () => {
    expect(endpointForHost('http://host.docker.internal:11434')).toBe('http://localhost:11434');
  });

  test('leaves localhost endpoints unchanged', () => {
    expect(endpointForHost('http://localhost:11434')).toBe('http://localhost:11434');
  });

  test('leaves other hostnames unchanged', () => {
    expect(endpointForHost('http://my-ollama-server:11434')).toBe('http://my-ollama-server:11434');
  });

  test('does not mangle subdomains containing host.docker.internal', () => {
    // URL parsing only matches exact hostname, not substrings
    expect(endpointForHost('http://host.docker.internal.example.com:11434'))
      .toBe('http://host.docker.internal.example.com:11434');
  });

  test('handles endpoints without port', () => {
    expect(endpointForHost('http://host.docker.internal')).toBe('http://localhost');
  });

  test('handles endpoints with path', () => {
    expect(endpointForHost('http://host.docker.internal:11434/v1')).toBe('http://localhost:11434/v1');
  });

  test('returns invalid URLs unchanged', () => {
    expect(endpointForHost('not-a-url')).toBe('not-a-url');
  });
});

describe('isHostedOllamaEndpoint', () => {
  test('recognizes Ollama Cloud', () => {
    expect(isHostedOllamaEndpoint('https://ollama.com')).toBe(true);
    expect(isHostedOllamaEndpoint('https://api.ollama.com/v1')).toBe(true);
  });

  test('local and LAN Ollama are not hosted', () => {
    expect(isHostedOllamaEndpoint('http://localhost:11434')).toBe(false);
    expect(isHostedOllamaEndpoint('http://192.168.1.40:11434')).toBe(false);
    expect(isHostedOllamaEndpoint('http://host.docker.internal:11434')).toBe(false);
  });

  test('a lookalike hostname is not Ollama Cloud', () => {
    // Suffix matching is on a dot boundary, so an attacker-controlled
    // "notollama.com" cannot claim the hosted credential.
    expect(isHostedOllamaEndpoint('https://notollama.com')).toBe(false);
  });

  test('empty and unparseable endpoints are not hosted', () => {
    expect(isHostedOllamaEndpoint('')).toBe(false);
    expect(isHostedOllamaEndpoint('   ')).toBe(false);
    expect(isHostedOllamaEndpoint('not-a-url')).toBe(false);
  });
});
