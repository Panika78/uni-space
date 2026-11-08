import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError, apiFetch } from './client'

afterEach(() => vi.unstubAllGlobals())

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
    expect(new Headers(init.headers).get('Accept')).toBe('application/json')
  })

  it('returns undefined for 204 without trying to parse a body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(apiFetch<void>('/api/v1/auth/logout', { method: 'POST' })).resolves.toBeUndefined()
  })

  it('normalizes API errors from the shared error format', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          { error: { code: 'validation_error', message: 'Invalid input', details: [] } },
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

    await expect(apiFetch('/api/v1/example')).rejects.toMatchObject({ code: 'network_error' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
