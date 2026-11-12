import { QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '../../app/queryClient'
import { apiFetch } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'
import { AuthProvider, useAuth } from '../auth/AuthProvider'
import { NotificationsDrawer } from './NotificationsDrawer'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => (resolve = complete))
  return { promise, resolve }
}

function response(value: unknown, status = 200) {
  return Response.json(value, { status })
}

function Harness() {
  const auth = useAuth()
  const cache = useQueryClient()
  const [open, setOpen] = useState(false)
  const [lateResult, setLateResult] = useState('pending')
  return (
    <>
      {auth.status === 'authenticated' ? (
        <>
          <button onClick={() => setOpen(true)}>Открыть уведомления</button>
          <button onClick={() => void auth.logout()}>Выйти</button>
          <button
            onClick={() =>
              void apiFetch<components['schemas']['NotificationPage']>(
                '/api/v1/notifications?limit=20',
                { authenticated: true },
              ).then(
                (page) => setLateResult(page.items[0]?.title ?? 'empty'),
                (error: unknown) =>
                  setLateResult(
                    error instanceof Error ? `${error.name}: ${error.message}` : String(error),
                  ),
              )
            }
          >
            Запросить уведомления в фоне
          </button>
          {open && <NotificationsDrawer onClose={() => setOpen(false)} />}
        </>
      ) : (
        <>
          <button onClick={() => void auth.login({ login: 'student-a', password: 'fictional' })}>
            Войти A
          </button>
          <button onClick={() => void auth.login({ login: 'student-b', password: 'fictional' })}>
            Войти B
          </button>
        </>
      )}
      <output data-testid="private-cache-count">{cache.getQueryCache().getAll().length}</output>
      <output data-testid="late-request-result">{lateResult}</output>
    </>
  )
}

describe('notification isolation across real auth sessions', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('navigator', {
      ...navigator,
      locks: {
        request: async (
          _name: string,
          optionsOrAction: LockOptions | (() => Promise<unknown>),
          callback?: () => Promise<unknown>,
        ) => {
          const action = typeof optionsOrAction === 'function' ? optionsOrAction : callback!
          if (typeof optionsOrAction !== 'function') optionsOrAction.signal?.throwIfAborted()
          return action()
        },
      },
    })
  })

  afterEach(() => {
    document.body.style.overflow = ''
    vi.unstubAllGlobals()
  })

  it('drops an A notification response after logout, B login, and private cache clearing', async () => {
    const delayedDrawerA = deferred<Response>()
    const delayedDirectA = deferred<Response>()
    let studentARequestCount = 0
    const requests: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(input instanceof Request ? input.url : String(input), location.href)
          .pathname
        requests.push(`${path} ${new Headers(init?.headers).get('Authorization') ?? ''}`)
        if (path.endsWith('/auth/refresh'))
          return response(
            { error: { code: 'invalid_refresh', message: 'invalid', details: [] } },
            401,
          )
        if (path.endsWith('/auth/login')) {
          const login = JSON.parse(String(init?.body)).login
          return response({ access_token: `token-${login}`, token_type: 'bearer', expires_in: 600 })
        }
        if (path.endsWith('/auth/logout')) return response({ session_revoked: true })
        if (path.endsWith('/notifications')) {
          const authorization = new Headers(init?.headers).get('Authorization')
          if (authorization === 'Bearer token-student-a') {
            studentARequestCount++
            return studentARequestCount === 1 ? delayedDrawerA.promise : delayedDirectA.promise
          }
          return response({
            items: [
              {
                id: '2',
                type: 'future',
                title: 'Уведомление студента B',
                body: 'Только B',
                created_at: '2026-11-10T10:00:00Z',
              },
            ],
            next_cursor: null,
          })
        }
        throw new Error(`Unexpected API request: ${path}`)
      }),
    )

    const queryClient = createQueryClient()
    const view = render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Harness />
        </AuthProvider>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Войти A' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Войти A' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Открыть уведомления' })).toBeInTheDocument(),
    )
    queryClient.setQueryData(['private', 'student'], { title: 'Данные студента A' })
    fireEvent.click(screen.getByRole('button', { name: 'Открыть уведомления' }))
    await waitFor(() =>
      expect(requests.some((request) => request.endsWith('Bearer token-student-a'))).toBe(true),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Запросить уведомления в фоне' }))
    await waitFor(() => expect(studentARequestCount).toBe(2))

    fireEvent.click(screen.getByRole('button', { name: 'Выйти' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Войти A' })).toBeInTheDocument())
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Войти B' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Открыть уведомления' })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Открыть уведомления' }))
    expect(await screen.findByText('Уведомление студента B')).toBeInTheDocument()

    delayedDrawerA.resolve(
      response({
        items: [
          {
            id: '1',
            type: 'future',
            title: 'Старое уведомление студента A',
            body: 'Только A',
            created_at: '2026-11-10T09:00:00Z',
          },
        ],
        next_cursor: null,
      }),
    )
    delayedDirectA.resolve(
      response({
        items: [
          {
            id: '3',
            type: 'future',
            title: 'Поздний ответ API студента A',
            body: 'Только A',
            created_at: '2026-11-10T09:00:00Z',
          },
        ],
        next_cursor: null,
      }),
    )
    await waitFor(() =>
      expect(screen.getByTestId('late-request-result')).toHaveTextContent('AbortError'),
    )
    expect(screen.queryByText('Старое уведомление студента A')).not.toBeInTheDocument()
    expect(screen.queryByText('Поздний ответ API студента A')).not.toBeInTheDocument()
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .every((query) => !JSON.stringify(query.state.data).includes('студента A')),
    ).toBe(true)
    expect(requests.filter((request) => request.includes('/notifications '))).toHaveLength(3)
    view.unmount()
  })
})
