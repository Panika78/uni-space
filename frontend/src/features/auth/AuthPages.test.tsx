import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '../../app/queryClient'
import { AuthProvider } from './AuthProvider'
import { LoginPage, ProtectedRoute, SchedulePage } from './AuthPages'
import { StudentLayout } from '../../app/StudentLayout'

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('navigator', {
    locks: {
      request: (_name: string, _options: LockOptions, action: () => Promise<unknown>) => action(),
    },
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderRoute(path = '/schedule') {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<ProtectedRoute />}>
              <Route element={<StudentLayout />}>
                <Route path="/schedule" element={<SchedulePage />} />
              </Route>
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  )
}

it('does not show a protected page before refresh and redirects on invalid cookie', async () => {
  let complete!: (response: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        complete = resolve
      }),
    ),
  )
  renderRoute()
  expect(screen.getByRole('status')).toHaveTextContent('Проверяем сессию')
  expect(screen.queryByRole('complementary', { name: 'Боковая панель' })).not.toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'Расписание' })).not.toBeInTheDocument()
  await act(async () => {
    complete(
      Response.json(
        { error: { code: 'invalid_refresh', message: '', details: [] } },
        { status: 401 },
      ),
    )
  })
  expect(await screen.findByRole('heading', { name: 'Вход' })).toBeInTheDocument()
  expect(screen.queryByText(/связаться с сервером/)).not.toBeInTheDocument()
})

it('submits once, opens schedule and hides it on logout', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        { error: { code: 'invalid_refresh', message: '', details: [] } },
        { status: 401 },
      ),
    )
    .mockResolvedValueOnce(
      Response.json({ access_token: 'test-access', token_type: 'bearer', expires_in: 600 }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
  renderRoute('/login')
  const user = userEvent.setup()
  await user.type(await screen.findByLabelText('Логин'), 'fictional')
  await user.type(screen.getByLabelText('Пароль'), 'fictional-password')
  await user.click(screen.getByRole('button', { name: 'Войти' }))
  expect(await screen.findByRole('heading', { name: 'Расписание' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Меню пользователя' }))
  await user.click(screen.getByRole('button', { name: 'Выйти' }))
  expect(await screen.findByRole('heading', { name: 'Вход' })).toBeInTheDocument()
  expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
    '/api/v1/auth/refresh',
    '/api/v1/auth/login',
    '/api/v1/auth/logout',
  ])
})

it('shows rate feedback and clears password without resubmission', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        { error: { code: 'invalid_refresh', message: '', details: [] } },
        { status: 401 },
      ),
    )
    .mockResolvedValueOnce(
      Response.json(
        { error: { code: 'rate_limited', message: 'internal', details: [] } },
        { status: 429, headers: { 'Retry-After': '42' } },
      ),
    )
  vi.stubGlobal('fetch', fetchMock)
  renderRoute('/login')
  const user = userEvent.setup()
  await user.type(await screen.findByLabelText('Логин'), 'fictional')
  await user.type(screen.getByLabelText('Пароль'), 'fictional-password')
  await user.click(screen.getByRole('button', { name: 'Войти' }))
  expect(await screen.findByRole('status')).toHaveTextContent('через 42 сек.')
  expect(screen.getByLabelText('Пароль')).toHaveValue('')
  expect(fetchMock).toHaveBeenCalledTimes(2)
})
