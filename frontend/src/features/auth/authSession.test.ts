import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, configureApiAuth } from '../../shared/api/client'
import { createQueryClient } from '../../app/queryClient'
import { AuthSession, authStorageKey, getLoginErrorMessage } from './authSession'
import { ApiClientError } from '../../shared/api/client'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function token(access = 'access') {
  return Response.json({ access_token: access, token_type: 'bearer', expires_in: 600 })
}
function error(code: string, status = 401) {
  return Response.json(
    { error: { code, message: 'internal details must stay hidden', details: [] } },
    { status },
  )
}
function createSession() {
  const cache = createQueryClient()
  const session = new AuthSession(cache)
  configureApiAuth(session.beginRequest)
  return { session, cache }
}

beforeEach(() => {
  localStorage.clear()
  let queue: Promise<unknown> = Promise.resolve()
  vi.stubGlobal('navigator', {
    locks: {
      request: (_name: string, action: () => Promise<unknown>) => {
        const result = queue.then(action)
        queue = result.catch(() => {})
        return result
      },
    },
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('session lifecycle and coordinated cookie operations', () => {
  it.each(['invalid_refresh', 'invalid_access', 'session_invalid'])(
    'finishes initial %s without another request or network message',
    async (code) => {
      const fetchMock = vi.fn().mockResolvedValue(error(code))
      vi.stubGlobal('fetch', fetchMock)
      const { session } = createSession()
      await Promise.all([session.start(), session.start()])
      expect(session.getSnapshot()).toEqual({ status: 'unauthenticated', message: '', busy: false })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  it('hides protected state until the initial refresh completes', async () => {
    const response = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(response.promise))
    const { session } = createSession()
    const start = session.start()
    expect(session.getSnapshot().status).toBe('initializing')
    response.resolve(token())
    await start
    expect(session.getSnapshot().status).toBe('authenticated')
    expect(localStorage.getItem(authStorageKey)).not.toContain('access')
  })

  it('serializes two tabs, reading the cookie only when each fetch is dispatched', async () => {
    let cookie = 0
    let active = 0
    const firstResponse = deferred<Response>()
    const fetchMock = vi.fn().mockImplementation(async () => {
      expect(active++).toBe(0)
      const previous = cookie
      if (previous === 0) await firstResponse.promise
      expect(cookie).toBe(previous)
      cookie++
      active--
      return token(`access-${cookie}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const first = createSession().session
    const second = createSession().session
    const starts = Promise.all([first.start(), second.start()])
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    firstResponse.resolve(token())
    await starts
    expect(cookie).toBe(2)
    expect(first.getSnapshot().status).toBe('authenticated')
    expect(second.getSnapshot().status).toBe('authenticated')
  })

  it('combines refresh within a tab', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(token()))
    const { session } = createSession()
    await session.start()
    const fetchMock = vi.fn().mockResolvedValue(token('new-access'))
    vi.stubGlobal('fetch', fetchMock)
    await Promise.all([session.refresh(), session.refresh(), session.refresh()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('blocks recovery in every tab and after reload when a refresh response is lost', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'))
    vi.stubGlobal('fetch', fetchMock)
    const first = createSession().session
    await first.start()
    await createSession().session.start()
    await first.refresh().catch(() => {})
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(first.getSnapshot().message).toContain('Войдите снова')
  })

  it('does not reuse a cookie after a tab closes during rotation', async () => {
    localStorage.setItem(
      authStorageKey,
      JSON.stringify({ epoch: 'old', pending: true, blocked: false }),
    )
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { session } = createSession()
    await session.start()
    expect(session.getSnapshot().status).toBe('unauthenticated')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails closed without Web Locks or storage', async () => {
    vi.stubGlobal('navigator', {})
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { session } = createSession()
    await session.start()
    expect(session.getSnapshot().message).toContain('Web Locks')
    expect(fetchMock).not.toHaveBeenCalled()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementationOnce(() => {
      throw new Error('denied')
    })
    await session.login({ login: 'fictional', password: 'fictional' })
    expect(session.getSnapshot().status).toBe('unauthenticated')
    vi.restoreAllMocks()
  })

  it('clears cache and rejects late data even when transport ignores abort', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(token()))
    const { session, cache } = createSession()
    await session.start()
    cache.setQueryData(['private'], { name: 'previous user' })
    const response = deferred<Response>()
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const request = apiFetch('/api/v1/test-only', { authenticated: true })
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    await session.logout()
    expect(cache.getQueryData(['private'])).toBeUndefined()
    response.resolve(Response.json({ name: 'previous user' }))
    await rejection
    expect(session.getSnapshot().message).toContain('подтверждён сервером')
  })

  it('waits for refresh before logout and never restores its late access', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(token()))
    const { session } = createSession()
    await session.start()
    const response = deferred<Response>()
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const refresh = session.refresh().catch(() => {})
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const logout = session.logout()
    expect(session.getSnapshot().status).toBe('unauthenticated')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    response.resolve(token('stale'))
    await Promise.all([refresh, logout])
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/v1/auth/refresh',
      '/api/v1/auth/logout',
    ])
    expect(() => session.beginRequest()).toThrow()
  })

  it('propagates account changes and logout and discards old responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(token())),
    )
    const first = createSession().session
    await first.start()
    const { session: second, cache } = createSession()
    await second.start()
    cache.setQueryData(['private'], 'old')
    const old = second.beginRequest()
    await first.login({ login: 'another-fictional-user', password: 'fictional' })
    second.synchronize()
    expect(old.signal.aborted).toBe(true)
    expect(() => old.assertCurrent()).toThrow()
    expect(cache.getQueryData(['private'])).toBeUndefined()
    expect(second.getSnapshot().status).toBe('unauthenticated')
  })

  it('persists unconfirmed logout and permits explicit retry without automatic refresh', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(token()))
    const { session } = createSession()
    await session.start()
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('lost logout'))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    await session.logout()
    expect(session.getSnapshot().message).toContain('сервер не подтвердил')
    const reloaded = createSession().session
    await reloaded.start()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await reloaded.logout()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(reloaded.getSnapshot().message).toContain('подтверждён сервером')
  })
})

describe('authenticated HTTP retry policy', () => {
  it('replays once with a new bearer after access_expired', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(error('access_expired'))
      .mockResolvedValueOnce(token('new'))
      .mockResolvedValueOnce(Response.json({ value: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    await createSession().session.start()
    await expect(apiFetch('/api/v1/test-only', { authenticated: true })).resolves.toEqual({
      value: 1,
    })
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/v1/auth/refresh',
      '/api/v1/test-only',
      '/api/v1/auth/refresh',
      '/api/v1/test-only',
    ])
    expect(new Headers(fetchMock.mock.calls[3][1].headers).get('Authorization')).toBe('Bearer new')
  })

  it.each([
    ['forbidden', 403],
    ['validation_error', 422],
    ['invalid_access', 401],
    ['session_invalid', 401],
  ])('does not refresh on %s', async (code, status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(token()))
    const { session } = createSession()
    await session.start()
    const fetchMock = vi.fn().mockResolvedValue(error(String(code), Number(status)))
    vi.stubGlobal('fetch', fetchMock)
    await expect(apiFetch('/api/v1/test-only', { authenticated: true })).rejects.toMatchObject({
      code,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(session.getSnapshot().status).toBe(status === 401 ? 'unauthenticated' : 'authenticated')
  })

  it('does not repeat again when replay is also expired', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(error('access_expired'))
      .mockResolvedValueOnce(token('new'))
      .mockResolvedValueOnce(error('access_expired'))
    vi.stubGlobal('fetch', fetchMock)
    await createSession().session.start()
    await expect(apiFetch('/api/v1/test-only', { authenticated: true })).rejects.toMatchObject({
      code: 'access_expired',
    })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('does not retry or refresh on abort or network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(token()))
    await createSession().session.start()
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'))
      .mockRejectedValueOnce(new TypeError('offline'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(apiFetch('/api/v1/test-only', { authenticated: true })).rejects.toMatchObject({
      name: 'AbortError',
    })
    await expect(apiFetch('/api/v1/test-only', { authenticated: true })).rejects.toMatchObject({
      code: 'network_error',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not let Query retry failed requests or mutations', async () => {
    const cache = createQueryClient()
    const queryFn = vi.fn().mockRejectedValue(new Error('offline'))
    await expect(cache.fetchQuery({ queryKey: ['test'], queryFn })).rejects.toThrow('offline')
    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(cache.getDefaultOptions().mutations?.retry).toBe(false)
    expect(cache.getDefaultOptions().queries?.retryOnMount).toBe(false)
    cache.clear()
  })
})

describe('login feedback', () => {
  it.each([
    ['invalid_credentials', 'Неверный логин'],
    ['rate_limited', 'через 7 сек.'],
    ['request_too_large', 'Слишком большой'],
    ['origin_not_allowed', 'с этого адреса'],
    ['internal_error', 'Не удалось войти'],
  ])('maps %s without exposing server details', async (code, message) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { error: { code, message: 'sensitive detail', details: [] } },
          { status: code === 'rate_limited' ? 429 : 401, headers: { 'Retry-After': '7' } },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)
    const { session } = createSession()
    await session.login({ login: 'fictional', password: 'fictional' })
    expect(session.getSnapshot().message).toContain(message)
    expect(session.getSnapshot().message).not.toContain('sensitive')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('supports Retry-After dates and missing headers', () => {
    expect(
      getLoginErrorMessage(
        new ApiClientError('', 'rate_limited', 429, [], new Date(Date.now() + 10000).toUTCString()),
      ),
    ).toContain('сек.')
    expect(getLoginErrorMessage(new ApiClientError('', 'rate_limited', 429))).toContain('минуту')
  })
})

it('does not erase a pending rotation marker when another tab initializes', async () => {
  let complete!: (response: Response) => void
  const fetchMock = vi
    .fn()
    .mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        complete = resolve
      }),
    )
    .mockResolvedValueOnce(
      Response.json({ access_token: 'second', token_type: 'bearer', expires_in: 600 }),
    )
  vi.stubGlobal('fetch', fetchMock)
  const first = createSession().session
  const startFirst = first.start()
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  const startSecond = createSession().session.start()
  expect(JSON.parse(localStorage.getItem(authStorageKey)!).pending).toBe(true)
  complete(Response.json({ access_token: 'first', token_type: 'bearer', expires_in: 600 }))
  await Promise.all([startFirst, startSecond])
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('rejects malformed refresh success and requires explicit login without retry', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ unexpected: true }))
  vi.stubGlobal('fetch', fetchMock)
  const { session } = createSession()
  await session.start()
  expect(session.getSnapshot().status).toBe('unauthenticated')
  await createSession().session.start()
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('aborts a caller during shared refresh without replaying its original request', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(token()))
  const { session } = createSession()
  await session.start()
  const response = deferred<Response>()
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(error('access_expired'))
    .mockReturnValueOnce(response.promise)
  vi.stubGlobal('fetch', fetchMock)
  const abort = new AbortController()
  const request = apiFetch('/api/v1/test-only', { authenticated: true, signal: abort.signal })
  const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  abort.abort()
  await rejection
  response.resolve(token('new'))
  await session.refresh()
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(session.getSnapshot().status).toBe('authenticated')
})

it('coordinates refresh and a new login across tabs without reviving the old generation', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => Promise.resolve(token())),
  )
  const first = createSession().session
  await first.start()
  const second = createSession().session
  await second.start()
  const response = deferred<Response>()
  const fetchMock = vi
    .fn()
    .mockReturnValueOnce(response.promise)
    .mockResolvedValueOnce(token('different-user'))
  vi.stubGlobal('fetch', fetchMock)
  const rotation = first.refresh().catch(() => {})
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  const login = second.login({ login: 'fictional-second', password: 'fictional' })
  first.synchronize()
  expect(first.getSnapshot().status).toBe('unauthenticated')
  response.resolve(token('old-user'))
  await Promise.all([rotation, login])
  expect(first.getSnapshot().status).toBe('unauthenticated')
  expect(second.beginRequest().token).toBe('different-user')
})

it('replays a cloned Request body once after refresh', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(token()))
  await createSession().session.start()
  const bodies: string[] = []
  const fetchMock = vi.fn().mockImplementation(async (input: Request | string) => {
    if (typeof input === 'string') return token('refreshed')
    bodies.push(await input.text())
    return bodies.length === 1 ? error('access_expired') : Response.json({ ok: true })
  })
  vi.stubGlobal('fetch', fetchMock)
  const request = new Request('http://localhost/api/v1/test-only', {
    method: 'POST',
    body: JSON.stringify({ fictional: true }),
  })
  await expect(apiFetch(request, { authenticated: true })).resolves.toEqual({ ok: true })
  expect(bodies).toEqual(['{"fictional":true}', '{"fictional":true}'])
  expect(fetchMock).toHaveBeenCalledTimes(3)
})

it('cancels an active Query and never puts late personal data back in the cache', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(token()))
  const { session, cache } = createSession()
  await session.start()
  const response = deferred<Response>()
  let requestSignal: AbortSignal | undefined
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((path: string, init: RequestInit) => {
      if (path.endsWith('/logout')) return Promise.resolve(new Response(null, { status: 204 }))
      requestSignal = init.signal as AbortSignal
      return response.promise
    }),
  )
  const query = cache
    .fetchQuery({
      queryKey: ['private'],
      queryFn: ({ signal }) => apiFetch('/api/v1/test-only', { authenticated: true, signal }),
    })
    .catch((error: unknown) => error)
  await session.logout()
  expect(requestSignal?.aborted).toBe(true)
  response.resolve(Response.json({ previousUser: true }))
  await query
  expect(cache.getQueryState(['private'])).toBeUndefined()
})

it('clears a reused QueryClient before restoring a new provider session', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(token()))
  const { session, cache } = createSession()
  cache.setQueryData(['private'], 'previous provider owner')
  await session.start()
  expect(session.getSnapshot().status).toBe('authenticated')
  expect(cache.getQueryData(['private'])).toBeUndefined()
})
