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

// Bounded API pages still need room for slow mobile connections and an auth
// refresh. This is one wall-clock budget for the initial GET and any replay.
export const AUTHENTICATED_GET_DEADLINE_MS = 90_000

export async function apiFetch<T>(input: RequestInfo | URL, init: ApiRequestInit = {}): Promise<T> {
  const { authenticated, ...requestInit } = init
  if (!authenticated) return sendRequest<T>(input, requestInit)
  const target = requireApiDestination(input)
  if (!beginAuthRequest) throw new Error('Auth provider is unavailable')
  const auth = beginAuthRequest()
  const callerSignal = init.signal ?? (input instanceof Request ? input.signal : undefined)
  const method = (
    requestInit.method ?? (input instanceof Request ? input.method : 'GET')
  ).toUpperCase()
  const timeoutController = method === 'GET' ? new AbortController() : undefined
  const signal = AbortSignal.any([
    auth.signal,
    ...(callerSignal ? [callerSignal] : []),
    ...(timeoutController ? [timeoutController.signal] : []),
  ])
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  // Clone before dispatch so a consumed Request body can be replayed once.
  const replay = target instanceof Request ? target.clone() : target
  const send = (target: RequestInfo | URL, token: string) => {
    target = requireApiDestination(target)
    const headers = new Headers(target instanceof Request ? target.headers : undefined)
    new Headers(init.headers).forEach((value, name) => headers.set(name, value))
    headers.set('Authorization', `Bearer ${token}`)
    return sendRequest<T>(target, { ...requestInit, headers, signal, redirect: 'error' })
  }
  const assertBaseRequestCurrent = () => {
    auth.signal.throwIfAborted()
    callerSignal?.throwIfAborted()
    auth.assertCurrent()
  }
  const assertRequestCurrent = () => {
    assertBaseRequestCurrent()
    if (timeoutController?.signal.aborted) throw createRequestTimeoutError()
  }
  const perform = async () => {
    let result: T
    try {
      result = await send(target, auth.token)
    } catch (error) {
      assertRequestCurrent()
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
      assertRequestCurrent()
      result = await send(replay, token)
    }
    assertRequestCurrent()
    return result
  }
  try {
    if (!timeoutController) return await perform()
    const timedOut = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        timeoutController.abort(new DOMException('Request deadline exceeded', 'TimeoutError'))
        try {
          assertBaseRequestCurrent()
          reject(createRequestTimeoutError())
        } catch (error) {
          reject(error)
        }
      }, AUTHENTICATED_GET_DEADLINE_MS)
    })
    return await Promise.race([perform(), timedOut])
  } catch (error) {
    assertBaseRequestCurrent()
    if (timeoutController?.signal.aborted) throw createRequestTimeoutError()
    if (error instanceof ApiClientError && error.status === 401) auth.invalidate()
    throw error
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

function createRequestTimeoutError() {
  return new ApiClientError(
    'Не удалось загрузить данные за отведённое время. Проверьте соединение и попробуйте ещё раз.',
    'request_timeout',
  )
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

function requireApiDestination(input: RequestInfo | URL): Request | string {
  let url: URL
  try {
    url = new URL(input instanceof Request ? input.url : String(input), window.location.href)
  } catch {
    throw new ApiClientError('Недопустимый адрес API', 'invalid_api_target')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.origin !== window.location.origin ||
    !url.pathname.startsWith('/api/v1/') ||
    // Reject encoded separators whose interpretation can differ at a proxy.
    /%(2f|5c)/i.test(url.pathname) ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new ApiClientError('Недопустимый адрес API', 'invalid_api_target')
  }
  // Freeze URL objects and resolve relative strings independently of document <base>.
  return input instanceof Request ? input : url.href
}
