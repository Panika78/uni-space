import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { PasswordSettingsPage } from './PasswordSettings'
import { apiFetch } from '../../shared/api/client'

const auth = vi.hoisted(() => ({ finishPasswordChange: vi.fn() }))
vi.mock('./AuthProvider', () => ({ useAuth: () => auth }))
vi.mock('../../shared/api/client', async (original) => ({
  ...(await original<typeof import('../../shared/api/client')>()),
  apiFetch: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

function mount() {
  const router = createMemoryRouter(
    [
      { path: '/settings', element: <PasswordSettingsPage /> },
      { path: '/login', element: <h1>Вход</h1> },
    ],
    { initialEntries: ['/settings'] },
  )
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
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
  const phrase = '  пароль phrase  '
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
