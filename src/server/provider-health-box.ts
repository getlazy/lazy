/**
 * The dashboard's provider-health box: per model provider over the last hour,
 * requests, failures by kind and the latest failure — "is it the provider or is
 * it lazy?" answered by looking. Pure over the same summary `lazy stats limits`
 * and `lazy_usage_limits` show (src/proxy/provider-health.ts).
 */
import { escapeHtml } from './escape';
import { PROVIDER_FAILURE_KINDS, type ProviderHealth, type ProviderFailureKind } from '../proxy/provider-health';

const HEADINGS: Record<ProviderFailureKind, string> = {
  reset: 'Reset', timeout: 'Timeout', connect: 'Connect', server_error: '5xx',
  overloaded: '529', rate_limited: '429', other: 'Other',
};

export function providerHealthBoxHtml(health: readonly ProviderHealth[], now: number = Date.now()): string {
  if (health.length === 0) return '';
  const rows = health.map((h) => {
    const last = h.lastFailureAt === null
      ? '—'
      : `${Math.max(0, Math.round((now - h.lastFailureAt) / 60_000))} min ago`;
    return `<tr data-provider="${escapeHtml(h.provider)}" data-host="${escapeHtml(h.host)}">
      <td>${escapeHtml(h.provider)}<br><span class="text-muted">${escapeHtml(h.host)}</span></td>
      <td>${h.requests}</td>
      ${PROVIDER_FAILURE_KINDS.map((k) => `<td class="${h.failures[k] ? 'text-warning' : 'text-muted'}">${h.failures[k]}</td>`).join('')}
      <td title="${escapeHtml(h.lastFailure ?? '')}" style="white-space: normal; overflow-wrap: anywhere; max-width: 40em">${escapeHtml(last)}${h.lastFailure ? `<br><span class="text-muted">${escapeHtml(h.lastFailure.slice(0, 160))}</span>` : ''}</td>
    </tr>`;
  });
  return `
    <div class="detail-section" id="provider-health">
      <h2>Model providers, last hour</h2>
      <table class="table provider-health">
        <thead><tr><th>Provider</th><th>Requests</th>${PROVIDER_FAILURE_KINDS.map((k) => `<th>${HEADINGS[k]}</th>`).join('')}<th>Last failure</th></tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
      <p class="text-muted">Failures the provider (or the network to it) caused; lazy's own refusals are not counted. Full detail: <code>lazy stats limits</code>.</p>
    </div>
  `;
}
