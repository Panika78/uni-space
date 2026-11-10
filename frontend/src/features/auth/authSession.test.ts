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
function logoutResult(session_revoked = true) {
  return Response.json({ session_revoked })
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
      request: (
        _name: string,
        optionsOrAction: LockOptions | (() => Promise<unknown>),
        callback?: () => Promise<unknown>,
      ) => {
        const options = typeof optionsOrAction === 'function' ? {} : optionsOrAction
        const action = typeof optionsOrAction === 'function' ? optionsOrAction : callback!
        return new Promise((resolve, reject) => {
          const cancel = () => reject(options.signal?.reason)
          options.signal?.addEventListener('abort', cancel, { once: true })
          const scheduled = queue.then(() => {
            options.signal?.removeEventListener('abort', cancel)
            options.signal?.throwIfAborted()
            return action()
          })
          scheduled.then(resolve, reject)
          queue = scheduled.catch(() => {})
        })
      },
    },
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('session lifecycle and coordinated cookie operations', () => {
  it.each([
    null,
    '{}',
    'null',
    '{invalid-json',
    '{"epoch":4,"blocked":true,"pending":false}',
    '{"epoch":"initial","blocked":true,"pending":false,"logoutRetry":null}',
  ])(
    'allows explicit login after an unreadable journal %s without automatic refresh',
    async (journal) => {
      if (journal !== null) localStorage.setItem(authStorageKey, journal)
      const fetchMock = vi.fn().mockResolvedValue(token('new-access'))
      vi.stubGlobal('fetch', fetchMock)
      const { session, cache } = createSession()
      cache.setQueryData(['private'], 'old data')
      if (journal !== null) {
        await session.start()
        expect(session.getSnapshot().status).toBe('unauthenticated')
        expect(fetchMock).not.toHaveBeenCalled()
        expect(cache.getQueryData(['private'])).toBeUndefined()
      }
      await session.login({ login: 'fictional', password: 'fictional' })
      expect(session.getSnapshot().status).toBe('authenticated')
      expect(session.beginRequest().token).toBe('new-access')
      expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/v1/auth/login'])
      const state = JSON.parse(localStorage.getItem(authStorageKey)!)
      expect(state.blocked).toBe(false)
      expect(state.pending).toBe(false)
    },
  )
  it.each(['invalid_refresh', 'invalid_access', 'session_invalid'])(
    'finishes initial %s without another request or network message',
    async (code) => {
      const fetchMock = vi.fn().mockResolvedValue(error(code))
      vi.stubGlobal('fetch', fetchMock)
      const { session } = createSession()
      await Promise.all([session.start(), session.start()])
      expect(session.getSnapshot()).toEqual({
        status: 'unauthenticated',
        message: '',
        busy: false,
      })
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
    expect(first.getSnapshot().message).toBe('')
    const second = createSession().session
    await second.start()
    expect(second.getSnapshot().status).toBe('unauthenticated')
    expect(second.getSnapshot().message).toBe('')
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
    expect(session.getSnapshot().message).toContain('современный браузер')
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
      .mockResolvedValueOnce(logoutResult())
    vi.stubGlobal('fetch', fetchMock)
    const request = apiFetch('/api/v1/test-only', { authenticated: true })
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    await session.logout()
    expect(cache.getQueryData(['private'])).toBeUndefined()
    response.resolve(Response.json({ name: 'previous user' }))
    await rejection
    expect(session.getSnapshot().message).toBe('Вы вышли из приложения.')
  })

  it('waits for refresh before logout and never restores its late access', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(token()))
    const { session } = createSession()
    await session.start()
    const response = deferred<Response>()
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce(logoutResult())
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

  it('retries a logout that did not reach the server when the site is opened again', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(token()))
    const { session } = createSession()
    await session.start()
    let serverRevoked = false
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new TypeError('request never reached the server')
      })
      .mockImplementationOnce(async () => {
        serverRevoked = true
        return logoutResult()
      })
    vi.stubGlobal('fetch', fetchMock)
    await session.logout()
    expect(session.getSnapshot().message).toContain('восстановлении соединения')
    expect(JSON.parse(localStorage.getItem(authStorageKey)!).logoutRetry).toEqual({ attempts: 0 })
    const reloaded = createSession().session
    await reloaded.start()
    expect(serverRevoked).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/v1/auth/logout',
      '/api/v1/auth/logout',
    ])
    expect(reloaded.getSnapshot().status).toBe('unauthenticated')
    expect(JSON.parse(localStorage.getItem(authStorageKey)!).ended).toBe(true)
  })

  it.each(['{broken-json', '{}'])(
    'closes private data without promising a retry when logout finds a damaged journal %s',
    async (journal) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(token('old-access')))
      const { session, cache } = createSession()
      await session.start()
      cache.setQueryData(['private'], 'old-user-data')
      const oldRequest = session.beginRequest()
      localStorage.setItem(authStorageKey, journal)
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      await session.logout()

      expect(session.getSnapshot().status).toBe('unauthenticated')
      expect(session.getSnapshot().message).toBe(
        'Не удалось завершить выход. Войдите снова, чтобы продолжить.',
      )
      expect(session.getSnapshot().message).not.toContain('Повторим')
      expect(cache.getQueryData(['private'])).toBeUndefined()
      expect(oldRequest.signal.aborted).toBe(true)
      expect(() => session.beginRequest()).toThrow()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(localStorage.getItem(authStorageKey)).toBe(journal)
      await createSession().session.start()
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it('retries an executed logout whose response was lost idempotently', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(token()))
    const { session } = createSession()
    await session.start()
    let serverRevocations = 0
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        serverRevocations++
        throw new TypeError('response lost after logout executed')
      })
      .mockResolvedValueOnce(logoutResult())
    vi.stubGlobal('fetch', fetchMock)
    await session.logout()
    await createSession().session.start()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(serverRevocations).toBe(1)
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/v1/auth/logout',
      '/api/v1/auth/logout',
    ])
  })

  it('retries logout on network recovery without making another refresh request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(token()))
    const { session } = createSession()
    await session.start()
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(logoutResult())
    vi.stubGlobal('fetch', fetchMock)
    await session.logout()
    await session.resumePendingLogout()
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/v1/auth/logout',
      '/api/v1/auth/logout',
    ])
    expect(session.getSnapshot().message).toBe('')
  })

  it('preserves deferred logout when a different user enters invalid credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(token('old-access')))
    const { session } = createSession()
    await session.start()
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(error('invalid_credentials'))
      .mockResolvedValueOnce(logoutResult())
    vi.stubGlobal('fetch', fetchMock)
    await session.logout()
    await session.login({ login: 'different-user', password: 'wrong-password' })
    expect(JSON.parse(localStorage.getItem(authStorageKey)!).logoutRetry).toEqual({ attempts: 0 })

    await session.resumePendingLogout()

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/v1/auth/logout',
      '/api/v1/auth/login',
      '/api/v1/auth/logout',
    ])
    expect(session.getSnapshot().status).toBe('unauthenticated')
  })

  it('does not let a deferred logout revoke a concurrent successful login', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(token('previous-access')))
    vi.stubGlobal('fetch', fetchMock)
    const first = createSession().session
    const secondContext = createSession()
    const second = secondContext.session
    await first.start()
    await second.start()
    secondContext.cache.setQueryData(['private'], 'previous-user-data')
    const staleRequest = second.beginRequest()

    fetchMock
      .mockRejectedValueOnce(new TypeError('lost logout response'))
      .mockResolvedValueOnce(token('replacement-access'))
    await first.logout()
    second.synchronize()
    expect(staleRequest.signal.aborted).toBe(true)
    expect(secondContext.cache.getQueryData(['private'])).toBeUndefined()

    await second.login({ login: 'different-user', password: 'fictional' })
    await first.resumePendingLogout()
    second.synchronize()
    expect(first.getSnapshot().status).toBe('unauthenticated')
    expect(second.getSnapshot().status).toBe('authenticated')
    expect(second.beginRequest().token).toBe('replacement-access')
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/v1/auth/refresh',
      '/api/v1/auth/refresh',
      '/api/v1/auth/logout',
      '/api/v1/auth/login',
    ])
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).login).toBe('different-user')
  })

  it('limits automatic retries across reloads and never retries refresh', async () => {
    const epoch = 'pending-logout'
    localStorage.setItem('uni-space.auth-epoch', epoch)
    localStorage.setItem(
      authStorageKey,
      JSON.stringify({
        epoch,
        blocked: true,
        pending: false,
        logoutRetry: { attempts: 0 },
      }),
    )
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'))
    vi.stubGlobal('fetch', fetchMock)
    for (let attempt = 0; attempt < 5; attempt++) {
      const session = createSession().session
      await session.start()
    }
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.every(([path]) => path === '/api/v1/auth/logout')).toBe(true)
    expect(JSON.parse(localStorage.getItem(authStorageKey)!).logoutRetry.attempts).toBe(3)
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
      new URL('/api/v1/test-only', window.location.href).href,
      '/api/v1/auth/refresh',
      new URL('/api/v1/test-only', window.location.href).href,
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
    ['invalid_credentials', 'Неверный логин', 401],
    ['rate_limited', 'через 7 сек.', 429],
    ['request_too_large', 'Слишком большой', 413],
    ['origin_not_allowed', 'с этого адреса', 403],
    ['internal_error', 'Попробуйте позже', 500],
  ])('maps %s without exposing server details', async (code, message, status) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { error: { code, message: 'sensitive detail', details: [] } },
          { status: Number(status), headers: { 'Retry-After': '7' } },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)
    const { session } = createSession()
    await session.login({ login: 'fictional', password: 'fictional' })
    expect(session.getSnapshot().message).toContain(String(message))
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
  const request = new Request(new URL('/api/v1/test-only', window.location.href), {
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
      if (path.endsWith('/logout')) return Promise.resolve(logoutResult())
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

describe('review regressions: confirmed logout', () => {
  it('shows ordinary login after confirmed logout and reload without another refresh', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(logoutResult())
    vi.stubGlobal('fetch', fetchMock)
    const { session } = createSession()
    await session.start()
    await session.logout()
    expect(session.getSnapshot().message).toBe('Вы вышли из приложения.')
    const reloaded = createSession().session
    await reloaded.start()
    expect(reloaded.getSnapshot()).toEqual({
      status: 'unauthenticated',
      message: '',
      busy: false,
    })
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/v1/auth/refresh',
      '/api/v1/auth/logout',
    ])
  })

  it('clears the other tab immediately and removes uncertainty once logout is confirmed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(token())),
    )
    const first = createSession().session
    await first.start()
    const { session: second, cache } = createSession()
    await second.start()
    cache.setQueryData(['private'], 'old-user')
    const old = second.beginRequest()
    const response = deferred<Response>()
    const fetchMock = vi.fn().mockReturnValue(response.promise)
    vi.stubGlobal('fetch', fetchMock)
    const logout = first.logout()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    second.synchronize()
    expect(second.getSnapshot().status).toBe('unauthenticated')
    expect(old.signal.aborted).toBe(true)
    expect(cache.getQueryData(['private'])).toBeUndefined()
    response.resolve(logoutResult())
    await logout
    second.synchronize()
    expect(second.getSnapshot()).toEqual({
      status: 'unauthenticated',
      message: '',
      busy: false,
    })
    expect(() => old.assertCurrent()).toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not treat an ended journal from a previous intent as confirmation of a new logout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(logoutResult(false)))
    const first = createSession().session
    await first.logout()
    // A second tab closes while a new logout is queued, before it owns the lock.
    localStorage.setItem('uni-space.auth-epoch', 'new-unconfirmed-intent')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const reloaded = createSession().session
    await reloaded.start()
    expect(reloaded.getSnapshot().message).toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('review regressions: login failure diagnostics', () => {
  it.each([
    [
      'malformed JSON',
      new Response('{invalid-json', {
        status: 200,
        headers: {
          'Set-Cookie': 'uni_space_refresh=fictional; HttpOnly; SameSite=Strict; Path=/api/v1/auth',
        },
      }),
    ],
    [
      'invalid token structure',
      Response.json(
        { access_token: '', token_type: 'bearer', expires_in: 600 },
        {
          status: 200,
          headers: {
            'Set-Cookie':
              'uni_space_refresh=fictional; HttpOnly; SameSite=Strict; Path=/api/v1/auth',
          },
        },
      ),
    ],
  ])(
    'allows ordinary login after HTTP 200 with %s without restoring protected state',
    async (_scenario, loginResponse) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(loginResponse)
        .mockResolvedValueOnce(token('recovered-access'))
      vi.stubGlobal('fetch', fetchMock)
      const { session } = createSession()

      await session.login({ login: 'fictional', password: 'fictional' })

      expect(session.getSnapshot().status).toBe('unauthenticated')
      expect(session.getSnapshot().message).toBe('Не удалось выполнить вход. Попробуйте ещё раз.')
      expect(() => session.beginRequest()).toThrow()

      const reloaded = createSession().session
      await reloaded.start()
      expect(reloaded.getSnapshot().status).toBe('unauthenticated')
      expect(reloaded.getSnapshot().message).toBe('')
      expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/v1/auth/login'])

      await reloaded.login({ login: 'fictional', password: 'fictional' })
      expect(reloaded.getSnapshot().status).toBe('authenticated')
      expect(reloaded.beginRequest().token).toBe('recovered-access')
      expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
        '/api/v1/auth/login',
        '/api/v1/auth/login',
      ])
    },
  )

  it('keeps an uncertain login private and presents only a plain message', async () => {
    const controller = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(controller.signal)
    const fetchMock = vi.fn().mockImplementation(
      (_path: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { session } = createSession()
    const login = session.login({ login: 'fictional', password: 'fictional' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    controller.abort(new DOMException('private detail', 'TimeoutError'))
    await login
    expect(timeout).toHaveBeenCalledWith(15000)
    expect(session.getSnapshot().message).toBe(
      'Не удалось выполнить вход. Проверьте соединение и попробуйте ещё раз.',
    )
    expect(session.getSnapshot().message).not.toMatch(/Web Locks|private detail|refresh|сессия/i)
    await createSession().session.start()
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/v1/auth/login'])
    timeout.mockRestore()
  })

  it.each([
    [
      'network failure',
      new TypeError('private detail'),
      'Не удалось выполнить вход. Проверьте соединение',
    ],
    ['ordinary cancellation', new DOMException('private detail', 'AbortError'), ''],
  ])(
    'handles %s without another login POST or a false browser diagnosis',
    async (_name, failure, message) => {
      const fetchMock = vi.fn().mockRejectedValue(failure)
      vi.stubGlobal('fetch', fetchMock)
      const { session } = createSession()
      await session.login({ login: 'fictional', password: 'fictional' })
      if (message === '') expect(session.getSnapshot().message).toBe('')
      else expect(session.getSnapshot().message).toContain(String(message))
      expect(session.getSnapshot().message).not.toMatch(/Web Locks|private detail/)
      expect(session.getSnapshot().busy).toBe(false)
      await createSession().session.start()
      expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/v1/auth/login'])
    },
  )

  it.each([500, 502, 503])(
    'reports HTTP %s as a server problem without asking to fix credentials',
    async (status) => {
      const fetchMock = vi.fn().mockResolvedValue(error('internal_error', status))
      vi.stubGlobal('fetch', fetchMock)
      const { session } = createSession()
      await session.login({ login: 'fictional', password: 'fictional' })
      expect(session.getSnapshot().message).toContain('Попробуйте позже')
      expect(session.getSnapshot().message).not.toMatch(
        /Проверьте данные|internal details|Web Locks/,
      )
      expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/v1/auth/login'])
    },
  )

  it('does not attribute an unknown error to browser coordination', () => {
    expect(getLoginErrorMessage(new Error('private detail'))).toBe(
      'Не удалось выполнить вход. Попробуйте ещё раз.',
    )
  })

  it('diagnoses missing Web Locks before any HTTP request', async () => {
    vi.stubGlobal('navigator', {})
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { session } = createSession()
    await session.login({ login: 'fictional', password: 'fictional' })
    expect(session.getSnapshot().message).toContain('современный браузер')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('diagnoses inaccessible localStorage before any HTTP request', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('private detail', 'SecurityError')
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { session } = createSession()
    await session.login({ login: 'fictional', password: 'fictional' })
    expect(session.getSnapshot().message).toContain('современный браузер')
    expect(session.getSnapshot().message).not.toContain('private detail')
    expect(fetchMock).not.toHaveBeenCalled()
    storage.mockRestore()
  })
})

describe('bounded Web Lock acquisition', () => {
  async function holdLock() {
    const released = deferred<void>()
    const acquired = deferred<void>()
    const completion = navigator.locks.request('uni-space.auth', {}, () => {
      acquired.resolve()
      return released.promise
    })
    await acquired.promise
    return { release: () => released.resolve(), completion }
  }

  it.each(['login', 'logout'] as const)(
    'cancels waiting %s, hides old data, and never dispatches after release or reload',
    async (operation) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(token()))
      const { session, cache } = createSession()
      await session.start()
      cache.setQueryData(['private'], 'old-user')
      const old = session.beginRequest()
      const holder = await holdLock()
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
      vi.stubGlobal('fetch', fetchMock)
      vi.useFakeTimers()
      const pending =
        operation === 'logout'
          ? session.logout()
          : session.login({ login: 'fictional', password: 'fictional' })
      try {
        expect(session.getSnapshot().status).toBe('unauthenticated')
        expect(old.signal.aborted).toBe(true)
        expect(cache.getQueryData(['private'])).toBeUndefined()
        await vi.advanceTimersByTimeAsync(10000)
        expect(session.getSnapshot().busy).toBe(false)
        expect(session.getSnapshot().message).toMatch(
          operation === 'logout'
            ? /завершить выход|восстановлении соединения/
            : /Попробуйте ещё раз/,
        )
        expect(session.getSnapshot().message).not.toMatch(/lock|сесс|refresh|logout/i)
        expect(fetchMock).not.toHaveBeenCalled()
      } finally {
        holder.release()
        await holder.completion
        await pending
      }
      await createSession().session.start()
      expect(fetchMock).not.toHaveBeenCalled()
      const journal = JSON.parse(localStorage.getItem(authStorageKey)!)
      expect(journal.pending).toBe(false)
      expect(journal.ended).not.toBe(true)
    },
  )

  it('finishes initial refresh acquisition without HTTP or a false unsupported-browser diagnosis', async () => {
    const holder = await holdLock()
    const fetchMock = vi.fn().mockResolvedValue(token())
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    const { session } = createSession()
    const pending = session.start()
    try {
      expect(session.getSnapshot().status).toBe('initializing')
      await vi.advanceTimersByTimeAsync(10000)
      expect(session.getSnapshot().status).toBe('unauthenticated')
      expect(session.getSnapshot().message).toBe('')
      expect(localStorage.getItem(authStorageKey)).toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      holder.release()
      await holder.completion
      await pending
    }
    expect(fetchMock).not.toHaveBeenCalled()
    // An explicit reload may bootstrap again: the cancelled waiter never used a cookie.
    await createSession().session.start()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not misdiagnose a lock timeout when another auth intent changes the epoch during bootstrap', async () => {
    const holder = await holdLock()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    const { session } = createSession()
    const pending = session.start()
    localStorage.setItem('uni-space.auth-epoch', 'new-concurrent-intent')
    try {
      await vi.advanceTimersByTimeAsync(10000)
      expect(session.getSnapshot().status).toBe('unauthenticated')
      expect(session.getSnapshot().message).toBe('')
    } finally {
      holder.release()
      await holder.completion
      await pending
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not time out or cancel a callback after it has acquired the lock', async () => {
    vi.useFakeTimers()
    const response = deferred<Response>()
    const fetchMock = vi.fn().mockReturnValue(response.promise)
    vi.stubGlobal('fetch', fetchMock)
    const lockRequest = vi.spyOn(navigator.locks, 'request')
    const { session } = createSession()
    const pending = session.start()
    await vi.advanceTimersByTimeAsync(0)
    const options = lockRequest.mock.calls[0][1] as LockOptions
    expect(options.signal).toBeDefined()
    await vi.advanceTimersByTimeAsync(10001)
    expect(options.signal?.aborted).toBe(false)
    expect(session.getSnapshot().status).toBe('initializing')
    response.resolve(token())
    await pending
    expect(session.getSnapshot().status).toBe('authenticated')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps confirmed logout reload quiet even while another tab holds the lock', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(logoutResult()))
    await createSession().session.logout()
    const holder = await holdLock()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const reloaded = createSession().session
    vi.useFakeTimers()
    const pending = reloaded.start()
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(reloaded.getSnapshot()).toEqual({
        status: 'unauthenticated',
        message: '',
        busy: false,
      })
    } finally {
      holder.release()
      await holder.completion
      await pending
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('rejected login preserves only confirmed absence', () => {
  it.each(['invalid_refresh', 'confirmed_logout'])(
    'keeps reload quiet after %s followed by invalid_credentials',
    async (source) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          source === 'invalid_refresh' ? error('invalid_refresh') : logoutResult(),
        )
        .mockResolvedValueOnce(error('invalid_credentials'))
      vi.stubGlobal('fetch', fetchMock)
      const { session } = createSession()
      if (source === 'invalid_refresh') await session.start()
      else await session.logout()
      await session.login({ login: 'fictional', password: 'incorrect' })
      expect(session.getSnapshot().message).toBe('Неверный логин или пароль.')
      const reloaded = createSession().session
      await reloaded.start()
      expect(reloaded.getSnapshot()).toEqual({
        status: 'unauthenticated',
        message: '',
        busy: false,
      })
      expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
        source === 'invalid_refresh' ? '/api/v1/auth/refresh' : '/api/v1/auth/logout',
        '/api/v1/auth/login',
      ])
    },
  )

  it('does not silently restore account A after account B login is rejected', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(token('fictional-account-a')))
    const { session, cache } = createSession()
    await session.start()
    cache.setQueryData(['private'], 'fictional-account-a')
    const old = session.beginRequest()
    const fetchMock = vi.fn().mockResolvedValue(error('invalid_credentials'))
    vi.stubGlobal('fetch', fetchMock)
    await session.login({ login: 'fictional-account-b', password: 'incorrect' })
    expect(old.signal.aborted).toBe(true)
    expect(cache.getQueryData(['private'])).toBeUndefined()
    const reloaded = createSession().session
    await reloaded.start()
    expect(reloaded.getSnapshot().status).toBe('unauthenticated')
    expect(reloaded.getSnapshot().message).toBe('')
    expect(JSON.parse(localStorage.getItem(authStorageKey)!).ended).not.toBe(true)
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/v1/auth/login'])
  })

  it.each(['network', 'timeout', 'server', 'invalid_credentials_with_500'])(
    'blocks recovery after %s even if absence was confirmed before login',
    async (failure) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(error('invalid_refresh')))
      const { session } = createSession()
      await session.start()
      const controller = new AbortController()
      if (failure === 'timeout')
        vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(controller.signal)
      const fetchMock = vi.fn().mockImplementation((_path: string, init: RequestInit) => {
        if (failure === 'network') return Promise.reject(new TypeError('offline'))
        if (failure === 'timeout')
          return new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            })
          })
        return Promise.resolve(
          error(failure === 'server' ? 'internal_error' : 'invalid_credentials', 500),
        )
      })
      vi.stubGlobal('fetch', fetchMock)
      const login = session.login({ login: 'fictional', password: 'fictional' })
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      if (failure === 'timeout') controller.abort(new DOMException('timed out', 'TimeoutError'))
      await login
      const reloaded = createSession().session
      await reloaded.start()
      expect(reloaded.getSnapshot().message).toBe('')
      expect(JSON.parse(localStorage.getItem(authStorageKey)!).ended).not.toBe(true)
      expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/v1/auth/login'])
    },
  )

  it.each(['rejected', 'successful'])(
    'does not overwrite another tab generation with a late %s login response',
    async (result) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(error('invalid_refresh')))
      const first = createSession().session
      await first.start()
      const late = deferred<Response>()
      const fetchMock = vi
        .fn()
        .mockReturnValueOnce(late.promise)
        .mockResolvedValueOnce(token('fictional-new-account'))
      vi.stubGlobal('fetch', fetchMock)
      const firstLogin = first.login({ login: 'fictional-old-account', password: 'incorrect' })
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      const second = createSession().session
      const secondLogin = second.login({ login: 'fictional-new-account', password: 'fictional' })
      late.resolve(
        result === 'rejected' ? error('invalid_credentials') : token('fictional-stale-token'),
      )
      await Promise.all([firstLogin, secondLogin])
      const journal = JSON.parse(localStorage.getItem(authStorageKey)!)
      expect(journal.epoch).toBe(localStorage.getItem('uni-space.auth-epoch'))
      expect(journal.blocked).toBe(false)
      expect(journal.ended).not.toBe(true)
      expect(first.getSnapshot().status).toBe('unauthenticated')
      expect(first.getSnapshot().message).not.toContain('Неверный логин')
      expect(second.beginRequest().token).toBe('fictional-new-account')
      expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
        '/api/v1/auth/login',
        '/api/v1/auth/login',
      ])
    },
  )
})

it('does not reuse an ended journal belonging to an older auth intent after rejected login', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(error('invalid_refresh')))
  const { session } = createSession()
  await session.start()
  localStorage.setItem('uni-space.auth-epoch', 'unconfirmed-newer-intent')
  const fetchMock = vi.fn().mockResolvedValue(error('invalid_credentials'))
  vi.stubGlobal('fetch', fetchMock)
  await session.login({ login: 'fictional', password: 'incorrect' })
  const reloaded = createSession().session
  await reloaded.start()
  expect(reloaded.getSnapshot().message).toBe('')
  expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/v1/auth/login'])
})

describe('logout access fallback', () => {
  it('captures access before clearing private data and sends it once only to the fixed non-redirecting endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(token('fictional-current-access')))
    const { session, cache } = createSession()
    await session.start()
    cache.setQueryData(['private'], 'fictional-private-data')
    const old = session.beginRequest()
    const fetchMock = vi.fn().mockResolvedValue(logoutResult())
    vi.stubGlobal('fetch', fetchMock)
    const logout = session.logout()
    expect(session.getSnapshot().status).toBe('unauthenticated')
    expect(cache.getQueryData(['private'])).toBeUndefined()
    expect(old.signal.aborted).toBe(true)
    await logout
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [path, init] = fetchMock.mock.calls[0]
    expect(path).toBe('/api/v1/auth/logout')
    expect(init.redirect).toBe('error')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer fictional-current-access')
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(
      'fictional-current-access',
    )
    expect(session.getSnapshot().message).toBe('Вы вышли из приложения.')
    expect(() => session.beginRequest()).toThrow()
  })

  it('does not send a stale logout when another tab has already changed authorization', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(token())),
    )
    const first = createSession().session
    await first.start()
    const second = createSession().session
    await second.login({ login: 'fictional-second', password: 'fictional' })
    const journal = localStorage.getItem(authStorageKey)
    const epoch = localStorage.getItem('uni-space.auth-epoch')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await first.logout()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(localStorage.getItem(authStorageKey)).toBe(journal)
    expect(localStorage.getItem('uni-space.auth-epoch')).toBe(epoch)
    expect(second.getSnapshot().status).toBe('authenticated')
    expect(first.getSnapshot().status).toBe('unauthenticated')
  })
})

it('never posts a queued logout from the old generation after a different tab starts login', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(token('fictional-account-a')))
  const first = createSession().session
  await first.start()
  const held = deferred<void>()
  const acquired = deferred<void>()
  const holder = navigator.locks.request('uni-space.auth', {}, () => {
    acquired.resolve()
    return held.promise
  })
  await acquired.promise
  const fetchMock = vi.fn().mockResolvedValue(token('fictional-account-b'))
  vi.stubGlobal('fetch', fetchMock)
  const logout = first.logout()
  const second = createSession().session
  const login = second.login({ login: 'fictional-account-b', password: 'fictional' })
  held.resolve()
  await Promise.all([holder, logout, login])
  expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/v1/auth/login'])
  expect(second.beginRequest().token).toBe('fictional-account-b')
})

it('does not dispatch an old queued logout after login repairs a damaged journal', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(token('old-access')))
  const first = createSession().session
  await first.start()
  const held = deferred<void>()
  const acquired = deferred<void>()
  const holder = navigator.locks.request('uni-space.auth', {}, () => {
    acquired.resolve()
    return held.promise
  })
  await acquired.promise
  const logout = first.logout()
  localStorage.setItem(authStorageKey, '{corrupt')
  const fetchMock = vi.fn().mockResolvedValue(token('new-access'))
  vi.stubGlobal('fetch', fetchMock)
  const second = createSession().session
  const login = second.login({ login: 'fictional-second', password: 'fictional' })
  held.resolve()
  await Promise.all([holder, logout, login])
  expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/v1/auth/login'])
  expect(second.beginRequest().token).toBe('new-access')
  expect(first.getSnapshot().status).toBe('unauthenticated')
})

it('keeps logout without an in-memory access token compatible and does not claim server revocation', async () => {
  const fetchMock = vi.fn().mockResolvedValue(logoutResult(false))
  vi.stubGlobal('fetch', fetchMock)
  const { session } = createSession()
  await session.logout()
  const [, init] = fetchMock.mock.calls[0]
  expect(new Headers(init.headers).has('Authorization')).toBe(false)
  expect(init.redirect).toBe('error')
  expect(session.getSnapshot().message).toContain('завершить выход')
})
