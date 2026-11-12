import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { focusManager, onlineManager, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '../../app/queryClient'
import { AuthProvider, useAuth } from '../auth/AuthProvider'
import { AcademicsPage } from './AcademicsPage'
import { createAcademics } from './testFixtures'

function AuthenticatedAcademics() {
  const { status, busy, login, logout } = useAuth()
  return status === 'authenticated' ? (
    <>
      <button
        onClick={() => {
          void logout()
        }}
      >
        Тестовый выход
      </button>
      <AcademicsPage />
    </>
  ) : (
    <button
      disabled={busy}
      onClick={() => {
        void login({ login: 'second-fixture', password: 'fictional-password' })
      }}
    >
      Войти вторым студентом
    </button>
  )
}

beforeEach(() => {
  localStorage.clear()
  vi.setSystemTime(new Date('2026-11-10T08:00:00Z'))
  vi.stubGlobal('navigator', {
    locks: {
      request: (_name: string, _options: LockOptions, action: () => Promise<unknown>) => action(),
    },
  })
  focusManager.setFocused(true)
  onlineManager.setOnline(true)
})
afterEach(() => {
  cleanup()
  focusManager.setFocused(undefined)
  onlineManager.setOnline(true)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('discards delayed grades after logout and account change using real auth and HTTP client', async () => {
  let completeOldResponse!: (response: Response) => void
  let oldSignal!: AbortSignal
  let firstAccountRequests = 0
  const tokens: string[] = []
  const scheduleResponse = (name: string) => Response.json(createAcademics(name))
  const transport = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), window.location.href).pathname
    if (path === '/api/v1/auth/refresh' || path === '/api/v1/auth/login') {
      return Promise.resolve(
        Response.json({
          access_token: path.endsWith('/refresh') ? 'first-access' : 'second-access',
          token_type: 'bearer',
          expires_in: 600,
        }),
      )
    }
    if (path === '/api/v1/auth/logout')
      return Promise.resolve(Response.json({ session_revoked: true }))
    if (path !== '/api/v1/academics') throw new Error('Unexpected test request')
    const token = new Headers(init?.headers).get('Authorization')!
    tokens.push(token)
    if (token === 'Bearer first-access') {
      firstAccountRequests += 1
      if (firstAccountRequests === 1)
        return Promise.resolve(scheduleResponse('Занятие первого студента'))
      oldSignal = init!.signal!
      // Deliberately ignore abort to exercise the shared client's generation check.
      return new Promise<Response>((resolve) => {
        completeOldResponse = resolve
      })
    }
    return Promise.resolve(scheduleResponse('Занятие второго студента'))
  })
  vi.stubGlobal('fetch', transport)
  const queryClient = createQueryClient()
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AuthenticatedAcademics />
      </AuthProvider>
    </QueryClientProvider>,
  )
  await screen.findAllByRole('rowheader', { name: 'Занятие первого студента' })
  const refresh = () =>
    act(() => {
      void queryClient.invalidateQueries({ queryKey: ['academics'] })
    })
  refresh()
  await waitFor(() => expect(firstAccountRequests).toBe(2))
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Тестовый выход' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Войти вторым студентом' })).toBeEnabled(),
  )
  expect(oldSignal.aborted).toBe(true)
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Войти вторым студентом' }))
  await screen.findAllByRole('rowheader', { name: 'Занятие второго студента' })
  await act(async () => {
    completeOldResponse(scheduleResponse('Запоздавшее занятие первого студента'))
  })
  refresh()
  await waitFor(() =>
    expect(tokens.filter((token) => token === 'Bearer second-access')).toHaveLength(2),
  )
  await waitFor(() => expect(queryClient.isFetching()).toBe(0))
  expect(screen.queryByText(/первого студента/)).not.toBeInTheDocument()
  expect(JSON.stringify(queryClient.getQueryData(['academics']))).not.toMatch(/первого студента/)
  expect(tokens).toEqual([
    'Bearer first-access',
    'Bearer first-access',
    'Bearer second-access',
    'Bearer second-access',
  ])
})
