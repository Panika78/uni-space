import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch, ApiClientError, type ApiRequestInit } from '../../shared/api/client'

export const staffJournal = '/api/v1/staff/journals'
export type Page<T> = { items: T[]; next_cursor: string | null }
export type JournalAccess = readonly [string, 'staff', boolean, boolean]

export function journalRequest<T>(path: string, init?: ApiRequestInit) {
  return apiFetch<T>(path, { ...init, authenticated: true, cache: 'no-store' })
}

export function isAccessError(error: unknown) {
  return error instanceof ApiClientError && (error.status === 401 || error.status === 403)
}

export function useJournalQuery<T>(access: JournalAccess, path: string | null) {
  const client = useQueryClient()
  const query = useQuery({
    queryKey: ['staff-journal', ...access, path],
    queryFn: ({ signal }) => journalRequest<T>(path!, { signal }),
    enabled: path !== null,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: 'always',
  })
  useEffect(() => {
    if (isAccessError(query.error)) {
      void client.invalidateQueries({ queryKey: ['authorization-context'] })
    }
  }, [client, query.error])
  return query
}

export function pageUrl(path: string, cursor: string | null, filters: Record<string, string> = {}) {
  const params = new URLSearchParams(filters)
  if (cursor) params.set('cursor', cursor)
  return `${path}?${params}`
}

export function journalError(error: unknown) {
  const status = error instanceof ApiClientError ? error.status : undefined
  switch (status) {
    case 401:
      return 'Войдите в кабинет снова.'
    case 403:
      return 'Доступ запрещён.'
    case 404:
      return 'Запись больше недоступна. Обновите журнал.'
    case 409:
      return 'Данные изменились. Проверьте актуальное состояние.'
    case 422:
      return 'Проверьте введённые данные.'
    case 503:
      return 'Сервис временно недоступен.'
    default:
      return 'Не удалось получить ответ сервера.'
  }
}
