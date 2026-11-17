import { apiFetch, ApiClientError } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'

export type Application = components['schemas']['ApplicationResponse']
export type HistoryPage = components['schemas']['ApplicationHistoryPage']
export const applicationsKey = ['applications'] as const
export const applicationDetailKey = (id: string) => [...applicationsKey, 'detail', id] as const
export const applicationHistoryKey = (id: string) => [...applicationsKey, 'history', id] as const
export const applicationPath = (id: string) => `/api/v1/applications/${encodeURIComponent(id)}`

export function isApplicationAccessError(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError && [401, 403, 404].includes(error.status ?? 0)
}

export async function getApplicationHistory(
  id: string,
  cursor: string | null,
  signal: AbortSignal,
) {
  const params = new URLSearchParams({ limit: '20' })
  if (cursor) params.set('cursor', cursor)
  const page = await apiFetch<HistoryPage>(`${applicationPath(id)}/history?${params}`, {
    authenticated: true,
    signal,
  })
  if (
    !page ||
    !Array.isArray(page.items) ||
    (page.next_cursor !== null && typeof page.next_cursor !== 'string')
  ) {
    throw new ApiClientError('Не удалось прочитать историю', 'invalid_response')
  }
  return page
}
