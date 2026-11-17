import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { PasswordSettingsPage } from './PasswordSettings'
import { ApiClientError, apiFetch } from '../../shared/api/client'

const auth = vi.hoisted(() => ({ finishPasswordChange: vi.fn() }))
const role = vi.hoisted(() => ({ value: 'staff' }))
vi.mock('./AuthProvider', () => ({ useAuth: () => auth }))
vi.mock('./RoleContext', () => ({
  useRoleContext: () => ({ user_id: '1', role: role.value, permissions: [] }),
}))
vi.mock('../../shared/api/client', async (original) => ({
  ...(await original<typeof import('../../shared/api/client')>()),
  apiFetch: vi.fn(),
}))

afterEach(() => {
  cleanup()
  role.value = 'staff'
  vi.resetAllMocks()
})

function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      { path: '/settings', element: <PasswordSettingsPage /> },
      { path: '/login', element: <h1>Вход</h1> },
    ],
    { initialEntries: ['/settings'] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return queryClient
}

it.each([360, 1440])('renders a single settings form at %i px', async (width) => {
  window.innerWidth = width
  vi.mocked(apiFetch).mockResolvedValue(undefined)
  mount()
  expect(await screen.findByRole('heading', { name: 'Смена пароля' })).toBeInTheDocument()
  expect(screen.getByLabelText('Действующий пароль')).toBeInTheDocument()
  expect(screen.getByLabelText('Новый пароль')).toBeInTheDocument()
  expect(screen.getByLabelText('Повторите новый пароль')).toBeInTheDocument()
})

it('counts Unicode code points, accepts a 12 character phrase and ends the session', async () => {
  vi.mocked(apiFetch).mockResolvedValue(undefined)
  mount()
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('Действующий пароль'), 'fictional-current')
  await user.type(screen.getByLabelText('Новый пароль'), '😀'.repeat(11))
  await user.type(screen.getByLabelText('Повторите новый пароль'), '😀'.repeat(11))
  await user.click(screen.getByRole('button', { name: 'Сменить пароль' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('от 12 до 128')
  expect(apiFetch).not.toHaveBeenCalled()

  await user.clear(screen.getByLabelText('Новый пароль'))
  await user.clear(screen.getByLabelText('Повторите новый пароль'))
  const phrase = '😀'.repeat(12)
  await user.type(screen.getByLabelText('Новый пароль'), phrase)
  await user.type(screen.getByLabelText('Повторите новый пароль'), phrase)
  await user.click(screen.getByRole('button', { name: 'Сменить пароль' }))
  expect(await screen.findByRole('heading', { name: 'Вход' })).toBeInTheDocument()
  expect(auth.finishPasswordChange).toHaveBeenCalledOnce()
  const request = vi.mocked(apiFetch).mock.calls[0]
  expect(request?.[1]).toMatchObject({ authenticated: true, replayAfterRefresh: false })
  expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
    current_password: 'fictional-current',
    new_password: phrase,
    confirm_password: phrase,
  })
})

it('accepts exactly 128 Unicode code points and rejects 129 before sending', async () => {
  vi.mocked(apiFetch).mockResolvedValue(undefined)
  mount()
  const user = userEvent.setup()
  const exactMaximum = '🔐'.repeat(128)
  await user.type(screen.getByLabelText('Действующий пароль'), 'fictional-current')
  await user.type(screen.getByLabelText('Новый пароль'), exactMaximum)
  await user.type(screen.getByLabelText('Повторите новый пароль'), exactMaximum)
  await user.click(screen.getByRole('button', { name: 'Сменить пароль' }))
  expect(await screen.findByRole('heading', { name: 'Вход' })).toBeInTheDocument()
  expect(JSON.parse(String(vi.mocked(apiFetch).mock.calls[0]?.[1]?.body)).new_password).toBe(
    exactMaximum,
  )

  cleanup()
  vi.mocked(apiFetch).mockClear()
  mount()
  const secondUser = userEvent.setup()
  await secondUser.type(screen.getByLabelText('Действующий пароль'), 'fictional-current')
  await secondUser.type(screen.getByLabelText('Новый пароль'), 'x'.repeat(129))
  await secondUser.type(screen.getByLabelText('Повторите новый пароль'), 'x'.repeat(129))
  await secondUser.click(screen.getByRole('button', { name: 'Сменить пароль' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('от 12 до 128')
  expect(apiFetch).not.toHaveBeenCalled()
})

it('does not repeat a request after a lost response and reports uncertainty', async () => {
  vi.mocked(apiFetch).mockRejectedValue(new Error('network failure'))
  mount()
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('Действующий пароль'), 'fictional-current')
  await user.type(screen.getByLabelText('Новый пароль'), 'fictional new phrase')
  await user.type(screen.getByLabelText('Повторите новый пароль'), 'fictional new phrase')
  await user.click(screen.getByRole('button', { name: 'Сменить пароль' }))
  expect(await screen.findByRole('heading', { name: 'Проверьте вход' })).toBeInTheDocument()
  expect(apiFetch).toHaveBeenCalledOnce()
  expect(auth.finishPasswordChange).toHaveBeenCalledWith(true)
})

it('keeps the settings form and session after an invalid current password', async () => {
  vi.mocked(apiFetch).mockRejectedValue(
    new ApiClientError('Invalid credentials', 'invalid_credentials', 401),
  )
  mount()
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('Действующий пароль'), 'fictional-wrong')
  await user.type(screen.getByLabelText('Новый пароль'), 'fictional new phrase')
  await user.type(screen.getByLabelText('Повторите новый пароль'), 'fictional new phrase')
  await user.click(screen.getByRole('button', { name: 'Сменить пароль' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Действующий пароль неверен.')
  expect(screen.getByLabelText('Действующий пароль')).toHaveFocus()
  expect(screen.getByRole('heading', { name: 'Настройки' })).toBeInTheDocument()
  expect(auth.finishPasswordChange).not.toHaveBeenCalled()
})

it('explains empty and mismatched confirmation and focuses its field', async () => {
  vi.mocked(apiFetch).mockResolvedValue(undefined)
  mount()
  const user = userEvent.setup()
  const current = screen.getByLabelText('Действующий пароль')
  const next = screen.getByLabelText('Новый пароль')
  const confirm = screen.getByLabelText('Повторите новый пароль')
  await user.click(screen.getByRole('button', { name: 'Сменить пароль' }))
  expect(current).toHaveFocus()
  expect(current).toHaveAttribute('aria-invalid', 'true')
  await user.type(current, 'fictional-current')
  await user.type(next, 'fictional new phrase')
  await user.click(screen.getByRole('button', { name: 'Сменить пароль' }))
  expect(confirm).toHaveFocus()
  expect(confirm).toHaveAttribute('aria-describedby', 'confirm-password-error')
  expect(screen.getByText('Повторите новый пароль.')).toBeInTheDocument()
  await user.type(confirm, 'different confirmation')
  await user.click(screen.getByRole('button', { name: 'Сменить пароль' }))
  expect(confirm).toHaveFocus()
  expect(screen.getByText('Пароли не совпадают.')).toBeInTheDocument()
  expect(apiFetch).not.toHaveBeenCalled()
})

it('reveals only the password field whose visibility control is activated', async () => {
  vi.mocked(apiFetch).mockResolvedValue(undefined)
  mount()
  const user = userEvent.setup()
  const current = screen.getByLabelText('Действующий пароль')
  const next = screen.getByLabelText('Новый пароль')
  const confirm = screen.getByLabelText('Повторите новый пароль')
  await user.click(screen.getByRole('button', { name: 'Показать новый пароль' }))
  expect(next).toHaveAttribute('type', 'text')
  expect(current).toHaveAttribute('type', 'password')
  expect(confirm).toHaveAttribute('type', 'password')
})

it('keeps the student password form and drafts mounted during a temporary profile refetch failure', async () => {
  role.value = 'student'
  let unavailable = false
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (url === '/api/v1/users/me') {
      if (unavailable) throw new ApiClientError('Unavailable', 'http_error', 503)
      return { full_name: 'Вымышленный студент' }
    }
    throw new Error(`Unexpected API request: ${String(url)}`)
  })
  const queryClient = mount()
  const user = userEvent.setup()
  const current = await screen.findByLabelText('Действующий пароль')
  const next = screen.getByLabelText('Новый пароль')
  const confirm = screen.getByLabelText('Повторите новый пароль')
  await user.type(current, 'fictional-current')
  await user.type(next, 'fictional draft phrase')
  await user.type(confirm, 'fictional draft phrase')

  unavailable = true
  await queryClient.invalidateQueries({ queryKey: ['student-profile'] })
  expect(await screen.findByRole('region', { name: 'Восстановление доступа' })).toBeInTheDocument()
  expect(document.getElementById('current-password')).toBe(current)
  expect(current).toHaveValue('fictional-current')
  expect(next).toHaveValue('fictional draft phrase')
  expect(confirm).toHaveValue('fictional draft phrase')
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)

  unavailable = false
  await queryClient.invalidateQueries({ queryKey: ['student-profile'] })
  await waitFor(() =>
    expect(
      screen.queryByRole('region', { name: 'Восстановление доступа' }),
    ).not.toBeInTheDocument(),
  )
  expect(screen.getByLabelText('Действующий пароль')).toBe(current)
  expect(current).toHaveValue('fictional-current')
  expect(next).toHaveValue('fictional draft phrase')
  expect(confirm).toHaveValue('fictional draft phrase')
})

it.each([401, 403])('does not retain the student password form after HTTP %i', async (status) => {
  role.value = 'student'
  let denied = false
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (url === '/api/v1/users/me') {
      if (denied) throw new ApiClientError('Access denied', 'access_denied', status)
      return { full_name: 'Вымышленный студент' }
    }
    throw new Error(`Unexpected API request: ${String(url)}`)
  })
  const queryClient = mount()
  await screen.findByLabelText('Действующий пароль')
  denied = true
  await queryClient.invalidateQueries({ queryKey: ['student-profile'] })
  await waitFor(() => expect(screen.queryByLabelText('Действующий пароль')).not.toBeInTheDocument())
})
