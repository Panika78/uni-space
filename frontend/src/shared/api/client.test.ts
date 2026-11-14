import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError, apiFetch, AUTHENTICATED_GET_DEADLINE_MS, configureApiAuth } from './client'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('apiFetch', () => {
  it('returns JSON and adds the shared request headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ value: 3 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(apiFetch<{ value: number }>('/api/v1/example')).resolves.toEqual({ value: 3 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = new Headers(init.headers)
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.get('Content-Type')).toBeNull()
  })

  it('retains Request headers and lets init headers override them', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const request = new Request('https://example.test/api/v1/example', {
      headers: {
        Authorization: 'Bearer from-request',
        'Content-Type': 'text/plain',
        Accept: 'text/plain',
        'X-Shared': 'from-request',
        'X-Request-Only': 'kept',
      },
    })

    await apiFetch(request, {
      headers: {
        Authorization: 'Bearer from-init',
        'Content-Type': 'application/custom+json',
        'X-Shared': 'from-init',
        'X-Init-Only': 'kept',
      },
    })

    const [, init] = fetchMock.mock.calls[0] as [Request, RequestInit]
    const headers = new Headers(init.headers)
    expect(headers.get('Authorization')).toBe('Bearer from-init')
    expect(headers.get('Content-Type')).toBe('application/custom+json')
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.get('X-Shared')).toBe('from-init')
    expect(headers.get('X-Request-Only')).toBe('kept')
    expect(headers.get('X-Init-Only')).toBe('kept')
  })

  it('sets JSON Content-Type for a regular URL call with a body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await apiFetch('https://example.test/api/v1/example', {
      method: 'POST',
      body: JSON.stringify({ name: 'sample' }),
      headers: { 'X-Client': 'web' },
    })

    const [input, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = new Headers(init.headers)
    expect(input).toBe('https://example.test/api/v1/example')
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('X-Client')).toBe('web')
  })

  it('returns undefined for 204 without trying to parse a body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(apiFetch<void>('/api/v1/test/empty', { method: 'POST' })).resolves.toBeUndefined()
  })

  it('normalizes API errors from the shared error format', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: {
              code: 'validation_error',
              message: 'Invalid input',
              details: [],
            },
          },
          { status: 422 },
        ),
      ),
    )

    const request = apiFetch('/api/v1/example')
    await expect(request).rejects.toBeInstanceOf(ApiClientError)
    await expect(request).rejects.toMatchObject({
      name: 'ApiClientError',
      status: 422,
      code: 'validation_error',
      message: 'Invalid input',
      details: [],
    })
  })

  it('handles non-JSON responses on success and error statuses', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }))
      .mockResolvedValueOnce(new Response('not json', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(apiFetch('/api/v1/example')).rejects.toMatchObject({
      code: 'invalid_response',
      status: 502,
    })
    await expect(apiFetch('/api/v1/example')).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('normalizes network errors without retrying the request', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(apiFetch('/api/v1/example')).rejects.toMatchObject({
      code: 'network_error',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

it('preserves cancellation instead of turning it into a network error', async () => {
  const abort = new DOMException('cancelled', 'AbortError')
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort))
  await expect(apiFetch('/api/v1/example')).rejects.toBe(abort)
})

it('preserves abort while reading the response body', async () => {
  const controller = new AbortController()
  const response = {
    status: 200,
    json: async () => {
      controller.abort()
      throw controller.signal.reason
    },
  }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
  await expect(apiFetch('/api/v1/example', { signal: controller.signal })).rejects.toMatchObject({
    name: 'AbortError',
  })
})

describe('authenticated API destination policy', () => {
  function configureSession() {
    const refresh = vi.fn().mockResolvedValue('fictional-refreshed-token')
    const begin = vi.fn().mockReturnValue({
      token: 'fictional-token',
      signal: new AbortController().signal,
      assertCurrent: vi.fn(),
      invalidate: vi.fn(),
      refresh,
    })
    configureApiAuth(begin)
    return { begin, refresh }
  }

  it.each([
    '/api/v1/example',
    new URL('/api/v1/example', window.location.href).href,
    new URL('/api/v1/example', window.location.href),
    new Request(new URL('/api/v1/example', window.location.href)),
    '/api/v1/items/../example',
  ])('allows and normalizes an internal API destination: %s', async (target) => {
    configureSession()
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(apiFetch(target, { authenticated: true })).resolves.toEqual({ ok: true })
    const [input, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit]
    const url = new URL(input instanceof Request ? input.url : String(input))
    expect(url.origin).toBe(window.location.origin)
    expect(url.pathname).toBe('/api/v1/example')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer fictional-token')
    expect(init.redirect).toBe('error')
  })

  it.each([
    'https://external.example/api/v1/example',
    '//external.example/api/v1/example',
    new Request('https://external.example/api/v1/example'),
    `${window.location.origin}.external.example/api/v1/example`,
    '/outside',
    '/api/v1',
    '/api/v10/example',
    '/api/v1suffix/example',
    '/api/v1/../outside',
    '/api/v1/%2e%2e/%2e%2e/outside',
    '/api/v1/%2f..%2f..%2foutside',
    'data:text/plain,example',
    'file:///api/v1/example',
  ])('rejects an unsafe destination locally without exposing a token: %s', async (target) => {
    const { begin } = configureSession()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const request = apiFetch(target, { authenticated: true })
    await expect(request).rejects.toMatchObject({ code: 'invalid_api_target' })
    await expect(request).rejects.not.toHaveProperty(
      'message',
      expect.stringContaining('fictional-token'),
    )
    expect(begin).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the same validated destination for the one replay and forbids caller-supplied redirect following', async () => {
    const { refresh } = configureSession()
    const target = new URL('/api/v1/example', window.location.href)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: 'access_expired', message: '', details: [] } },
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const pending = apiFetch(target, { authenticated: true, redirect: 'follow' })
    target.href = 'https://external.example/api/v1/example'
    await expect(pending).resolves.toEqual({ ok: true })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [input, init] of fetchMock.mock.calls) {
      expect(input).toBe(new URL('/api/v1/example', window.location.href).href)
      expect(init.redirect).toBe('error')
    }
  })
})

describe('authenticated GET deadline', () => {
  function configureTimedSession() {
    const authController = new AbortController()
    const assertCurrent = vi.fn()
    const refresh = vi.fn().mockResolvedValue('fictional-refreshed-token')
    configureApiAuth(() => ({
      token: 'fictional-token',
      signal: authController.signal,
      assertCurrent,
      refresh,
      invalidate: vi.fn(),
    }))
    return { authController, assertCurrent, refresh }
  }

  it('times out while waiting for response headers, then permits a manual request to recover', async () => {
    vi.useFakeTimers()
    configureTimedSession()
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(Response.json({ recovered: true }))
    vi.stubGlobal('fetch', fetchMock)

    const pending = apiFetch('/api/v1/schedule', { authenticated: true })
    const result = expect(pending).rejects.toMatchObject({
      code: 'request_timeout',
      message: expect.stringContaining('попробуйте ещё раз'),
    })
    await vi.advanceTimersByTimeAsync(AUTHENTICATED_GET_DEADLINE_MS)
    await result
    await expect(apiFetch('/api/v1/schedule', { authenticated: true })).resolves.toEqual({
      recovered: true,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('aborts and times out an open response body after HTTP 200 headers', async () => {
    vi.useFakeTimers()
    configureTimedSession()
    let chunks = 0
    let cancelled = false
    const fetchMock = vi.fn().mockImplementation((_input, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const sendChunk = () => {
            chunks += 1
            controller.enqueue(new TextEncoder().encode(' '))
          }
          sendChunk()
          const interval = setInterval(sendChunk, 10_000)
          init.signal?.addEventListener('abort', () => {
            cancelled = true
            clearInterval(interval)
            controller.error(init.signal?.reason)
          })
        },
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const pending = apiFetch('/api/v1/notifications', { authenticated: true })
    const result = expect(pending).rejects.toMatchObject({ code: 'request_timeout' })
    await vi.advanceTimersByTimeAsync(AUTHENTICATED_GET_DEADLINE_MS)
    await result
    expect(chunks).toBeGreaterThan(1)
    expect(cancelled).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('uses one deadline for access_expired refresh and replay', async () => {
    vi.useFakeTimers()
    const { refresh } = configureTimedSession()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: 'access_expired', message: 'expired', details: [] } },
          { status: 401 },
        ),
      )
      .mockImplementationOnce(() => new Promise(() => {}))
    vi.stubGlobal('fetch', fetchMock)

    const pending = apiFetch('/api/v1/academics', { authenticated: true })
    const result = expect(pending).rejects.toMatchObject({ code: 'request_timeout' })
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(AUTHENTICATED_GET_DEADLINE_MS)
    await result
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('keeps auth-generation cancellation distinct and does not add a deadline to POST', async () => {
    vi.useFakeTimers()
    const { authController } = configureTimedSession()
    const fetchMock = vi.fn((_input, init: RequestInit) => {
      if (init.method === 'POST') return new Promise(() => {})
      return new Promise<never>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const get = apiFetch('/api/v1/applications', { authenticated: true })
    const getResult = expect(get).rejects.toMatchObject({ name: 'AbortError' })
    authController.abort(new DOMException('account changed', 'AbortError'))
    await getResult

    configureTimedSession()
    const post = apiFetch('/api/v1/applications', {
      authenticated: true,
      method: 'POST',
      body: JSON.stringify({}),
    })
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
    // The deliberately pending POST is outside this API deadline and has no retry.
    void post.catch(() => {})
  })
})
