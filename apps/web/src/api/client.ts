import type { MetricsSummary, PaginatedRecoveryAttempts, RecoveryAttemptDetail } from '../types/api';

/**
 * Merchant API Client (§8.1, §16.2)
 *
 * Communicates with backend endpoints using X-Merchant-Key header auth.
 * Base URL defaults to window location or relative path '/api/v1'.
 */
// biome-ignore lint/complexity/useLiteralKeys: Vite env index access
const API_BASE_URL = (import.meta.env['VITE_API_BASE_URL'] as string | undefined) || '';
// biome-ignore lint/complexity/useLiteralKeys: Vite env index access
const MERCHANT_KEY = (import.meta.env['VITE_MERCHANT_API_KEY'] as string | undefined) || 'test-merchant-key';

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${API_BASE_URL}${path}`;
  const headers = new Headers(options?.headers);
  headers.set('X-Merchant-Key', MERCHANT_KEY);
  headers.set('Accept', 'application/json');

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    let errorMsg = `HTTP Error ${response.status}: ${response.statusText}`;
    try {
      const errJson = (await response.json()) as { message?: string };
      if (errJson.message) errorMsg = errJson.message;
    } catch {
      // Ignore JSON parse errors for non-200 responses
    }
    throw new ApiError(response.status, errorMsg);
  }

  return (await response.json()) as T;
}

/**
 * Fetch recovery metrics summary (§8.1)
 */
export async function fetchMetricsSummary(from?: string, to?: string): Promise<MetricsSummary> {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);

  const queryString = params.toString();
  const path = `/api/v1/metrics/summary${queryString ? `?${queryString}` : ''}`;
  return request<MetricsSummary>(path);
}

/**
 * Fetch paginated recovery attempts list (§8.1)
 */
export async function fetchRecoveries(status?: string, page = 1, limit = 20): Promise<PaginatedRecoveryAttempts> {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  params.set('page', String(page));
  params.set('limit', String(limit));

  return request<PaginatedRecoveryAttempts>(`/api/v1/recoveries?${params.toString()}`);
}

/**
 * Fetch detailed recovery attempt with payment summary and audit logs (§8.1)
 */
export async function fetchRecoveryDetail(id: string): Promise<RecoveryAttemptDetail> {
  return request<RecoveryAttemptDetail>(`/api/v1/recoveries/${id}`);
}
