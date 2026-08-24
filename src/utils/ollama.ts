import type { OllamaConfig } from '../config/types';
import { spawnSyncUnsupervised } from './spawn';

export type OllamaCheckResult =
  | { reachable: true; endpoint: string }
  | { reachable: false; endpoint: string; reason: string };

/**
 * Check if Ollama is reachable at the configured endpoint.
 * Replaces host.docker.internal with localhost for the check (the host-side
 * process can't reach the Docker-internal alias).
 */
export function checkOllamaConnectivity(ollamaConfig: OllamaConfig): OllamaCheckResult {
  const endpoint = ollamaEndpointForHost(ollamaConfig.endpoint);
  try {
    const result = spawnSyncUnsupervised(
      ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `${endpoint}/api/tags`],
      { stdout: 'pipe', stderr: 'ignore', timeout: 5_000 },
    );
    const statusCode = result.stdout.toString().trim();
    if (result.exitCode === 0 && statusCode === '200') {
      return { reachable: true, endpoint };
    }
    return {
      reachable: false,
      endpoint,
      reason: `Ollama is not responding at ${endpoint}. Start it with: ollama serve`,
    };
  } catch {
    return {
      reachable: false,
      endpoint,
      reason: `Could not check Ollama at ${endpoint}. Ensure Ollama is running: ollama serve`,
    };
  }
}

/**
 * Resolve the effective model: use the explicit model if provided,
 * otherwise fall back to the Ollama model when Ollama is enabled.
 */
export function getEffectiveModel(model: string | undefined, ollamaConfig?: OllamaConfig): string | undefined {
  return model ?? (ollamaConfig?.enabled ? ollamaConfig.model : undefined);
}

/**
 * Convert a Docker-internal Ollama endpoint to one reachable from the host.
 * Uses URL parsing so it only replaces the hostname, not substrings that
 * happen to contain "host.docker.internal" (e.g. host.docker.internal.example.com).
 */
export function ollamaEndpointForHost(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (url.hostname === 'host.docker.internal') {
      url.hostname = 'localhost';
      return url.toString().replace(/\/$/, ''); // strip trailing slash added by URL
    }
    return endpoint;
  } catch {
    // If the endpoint isn't a valid URL, fall back to the original string.
    return endpoint;
  }
}
