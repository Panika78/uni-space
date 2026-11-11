import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { focusManager, onlineManager, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '../../app/queryClient'
import { AuthProvider, useAuth } from '../auth/AuthProvider'
import { SchedulePage } from './SchedulePage'
import { createLesson } from './testFixtures'

function AuthenticatedSchedule() {
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
      <SchedulePage />
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

it.each(['focus', 'reconnect'] as const)(
  'discards a delayed %s refresh after logout and account change using real auth and HTTP client',
  async (event) => {
    let completeOldResponse!: (response: Response) => void
    let oldSignal!: AbortSignal
    let firstAccountRequests = 0
    const tokens: string[] = []
    const scheduleResponse = (name: string) =>
      Response.json({
        date_from: '2026-11-09',
        date_to: '2026-11-15',
        timezone: 'Europe/Moscow',
        items: [createLesson({ course_offering: { id: '1', discipline: { id: '1', name } } })],
      })
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
      if (path !== '/api/v1/schedule') throw new Error('Unexpected test request')
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
          <AuthenticatedSchedule />
        </AuthProvider>
      </QueryClientProvider>,
    )
    await screen.findByRole('article', { name: 'Занятие первого студента' })
    const refresh = () =>
      act(() => {
        if (event === 'focus') {
          focusManager.setFocused(false)
          focusManager.setFocused(true)
        } else {
          onlineManager.setOnline(false)
          onlineManager.setOnline(true)
        }
      })
    refresh()
    await waitFor(() => expect(firstAccountRequests).toBe(2))
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Тестовый выход' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Войти вторым студентом' })).toBeEnabled(),
    )
    expect(oldSignal.aborted).toBe(true)
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Войти вторым студентом' }))
    await screen.findByRole('article', { name: 'Занятие второго студента' })
    await act(async () => {
      completeOldResponse(scheduleResponse('Запоздавшее занятие первого студента'))
    })
    refresh()
    await waitFor(() =>
      expect(tokens.filter((token) => token === 'Bearer second-access')).toHaveLength(2),
    )
    await waitFor(() => expect(queryClient.isFetching()).toBe(0))
    expect(screen.queryByText(/первого студента/)).not.toBeInTheDocument()
    expect(
      JSON.stringify(queryClient.getQueryData(['schedule', '2026-11-09', '2026-11-15'])),
    ).not.toMatch(/первого студента/)
    expect(tokens).toEqual([
      'Bearer first-access',
      'Bearer first-access',
      'Bearer second-access',
      'Bearer second-access',
    ])
  },
)
