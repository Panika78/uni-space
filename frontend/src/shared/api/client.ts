import type { components } from './schema'

export type ApiErrorBody = components['schemas']['ApiError']['error']

export class ApiClientError extends Error {
  readonly retryAfter: string | null
  readonly status: number | undefined
  readonly code: string
  readonly details: ApiErrorBody['details']

  constructor(
    message: string,
    code: string,
    status?: number,
    details: ApiErrorBody['details'] = [],
    retryAfter: string | null = null,
  ) {
    super(message)
    this.name = 'ApiClientError'
    this.code = code
    this.retryAfter = retryAfter
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

export interface AuthRequest {
  token: string
  signal: AbortSignal
  assertCurrent(): void
  refresh(): Promise<string>
  invalidate(): void
}

let beginAuthRequest: (() => AuthRequest) | undefined

export function configureApiAuth(begin: () => AuthRequest) {
  beginAuthRequest = begin
}

export type ApiRequestInit = RequestInit & { authenticated?: boolean }

export async function apiFetch<T>(input: RequestInfo | URL, init: ApiRequestInit = {}): Promise<T> {
  const { authenticated, ...requestInit } = init
  if (!authenticated) return sendRequest<T>(input, requestInit)
  if (!beginAuthRequest) throw new Error('Auth provider is unavailable')
  const auth = beginAuthRequest()
  const signal = AbortSignal.any([
    auth.signal,
    ...(init.signal ? [init.signal] : input instanceof Request ? [input.signal] : []),
  ])
  // Clone before dispatch so a consumed Request body can be replayed once.
  const replay = input instanceof Request ? input.clone() : input
  const send = (target: RequestInfo | URL, token: string) => {
    const headers = new Headers(target instanceof Request ? target.headers : undefined)
    new Headers(init.headers).forEach((value, name) => headers.set(name, value))
    headers.set('Authorization', `Bearer ${token}`)
    return sendRequest<T>(target, { ...requestInit, headers, signal })
  }
  try {
    let result: T
    try {
      result = await send(input, auth.token)
    } catch (error) {
      signal.throwIfAborted()
      auth.assertCurrent()
      if (
        !(error instanceof ApiClientError) ||
        error.status !== 401 ||
        error.code !== 'access_expired'
      )
        throw error
      // Cancel this waiter promptly without aborting the shared cookie rotation.
      const token = await new Promise<string>((resolve, reject) => {
        const handleAbort = () => reject(signal.reason)
        signal.addEventListener('abort', handleAbort, { once: true })
        const finish = () => signal.removeEventListener('abort', handleAbort)
        auth.refresh().then(
          (value) => {
            finish()
            resolve(value)
          },
          (error: unknown) => {
            finish()
            reject(error)
          },
        )
      })
      signal.throwIfAborted()
      auth.assertCurrent()
      result = await send(replay, token)
    }
    signal.throwIfAborted()
    auth.assertCurrent()
    return result
  } catch (error) {
    signal.throwIfAborted()
    auth.assertCurrent()
    if (error instanceof ApiClientError && error.status === 401) auth.invalidate()
    throw error
  }
}

async function sendRequest<T>(input: RequestInfo | URL, init: RequestInit = {}): Promise<T> {
  const signal = init.signal ?? (input instanceof Request ? input.signal : undefined)
  signal?.throwIfAborted()
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
    response = await fetch(input, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
      headers,
    })
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiClientError('Не удалось связаться с сервером', 'network_error')
  }

  signal?.throwIfAborted()
  if (response.status === 204) return undefined as T

  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiClientError(
      'Сервер вернул ответ в неизвестном формате',
      'invalid_response',
      response.status,
    )
  }

  signal?.throwIfAborted()
  if (!response.ok) {
    if (isApiError(payload)) {
      throw new ApiClientError(
        payload.error.message,
        payload.error.code,
        response.status,
        payload.error.details,
        response.headers.get('Retry-After'),
      )
    }
    throw new ApiClientError('Запрос не выполнен', 'http_error', response.status)
  }
  return payload as T
}
