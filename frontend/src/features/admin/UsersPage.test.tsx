import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CreateUserPage } from './UsersPage'
import { apiFetch, ApiClientError } from '../../shared/api/client'
vi.mock('../../shared/api/client', async (original) => ({
  ...(await original<typeof import('../../shared/api/client')>()),
  apiFetch: vi.fn(),
}))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})
beforeEach(() => {
  vi.mocked(apiFetch).mockResolvedValue({ items: [], next_after_id: null })
})
function mount() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RouterProvider router={createMemoryRouter([{ path: '/', element: <CreateUserPage /> }])} />
    </QueryClientProvider>,
  )
}
async function submit() {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('Логин'), 'fictional')
  await user.type(screen.getByLabelText('ФИО'), 'Fictional User')
  await user.selectOptions(screen.getByLabelText('Роль'), 'admin')
  await user.click(screen.getByRole('button', { name: 'Создать' }))
  return user
}
it('shows the initial password once without caching it and removes it on close', async () => {
  vi.mocked(apiFetch).mockImplementation(async (_url, init) =>
    init?.method === 'POST'
      ? { user: { id: '9', login: 'fictional' }, initial_password: 'fictional-one-time-secret' }
      : { items: [], next_after_id: null },
  )
  mount()
  const user = await submit()
  expect(await screen.findByText('fictional-one-time-secret')).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Пользователь создан' })).toHaveFocus()
  await user.click(screen.getByRole('button', { name: 'Закрыть и удалить пароль с экрана' }))
  expect(screen.queryByText('fictional-one-time-secret')).not.toBeInTheDocument()
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(
    1,
  )
})
it('never repeats a create after a lost response and directs the administrator to login search', async () => {
  vi.mocked(apiFetch).mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') throw new ApiClientError('lost response', 'network_error')
    return { items: [], next_after_id: null }
  })
  mount()
  await submit()
  expect(await screen.findByRole('link', { name: 'Проверить список по логину' })).toHaveAttribute(
    'href',
    '/admin/users?q=fictional',
  )
  expect(screen.queryByRole('button', { name: 'Создать' })).not.toBeInTheDocument()
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(
    1,
  )
})
it('reports a rejected duplicate without inventing a password', async () => {
  vi.mocked(apiFetch).mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') throw new ApiClientError('exists', 'login_exists', 409)
    return { items: [], next_after_id: null }
  })
  mount()
  await submit()
  expect(await screen.findByRole('alert')).toHaveTextContent('Действие отклонено')
  expect(screen.queryByText('Первоначальный пароль:')).not.toBeInTheDocument()
})
