import type { components } from './schema'

export type ApiErrorBody = components['schemas']['ApiError']['error']

export class ApiClientError extends Error {
  readonly status: number | undefined
  readonly code: string
  readonly details: ApiErrorBody['details']

  constructor(
    message: string,
    code: string,
    status?: number,
    details: ApiErrorBody['details'] = [],
  ) {
    super(message)
    this.name = 'ApiClientError'
    this.code = code
    this.status = status
    this.details = details
  }
}

function isApiError(value: unknown): value is { error: ApiErrorBody } {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false
  const error = value.error
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    'message' in error &&
    typeof error.message === 'string' &&
    'details' in error &&
    Array.isArray(error.details)
  )
}

export async function apiFetch<T>(input: RequestInfo | URL, init: RequestInit = {}): Promise<T> {
  const requestHeaders =
    typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined
  const headers = new Headers(requestHeaders)
  new Headers(init.headers).forEach((value, name) => headers.set(name, value))
  headers.set('Accept', 'application/json')
  if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  let response: Response
  try {
    response = await fetch(input, { ...init, headers })
  } catch {
    throw new ApiClientError('Не удалось связаться с сервером', 'network_error')
  }

  if (response.status === 204) return undefined as T

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new ApiClientError(
      'Сервер вернул ответ в неизвестном формате',
      'invalid_response',
      response.status,
    )
  }

  if (!response.ok) {
    if (isApiError(payload)) {
      throw new ApiClientError(
        payload.error.message,
        payload.error.code,
        response.status,
        payload.error.details,
      )
    }
    throw new ApiClientError('Запрос не выполнен', 'http_error', response.status)
  }
  return payload as T
}
