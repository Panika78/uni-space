import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CreateUserPage, UserDetailPage } from './UsersPage'
import type { components } from '../../shared/api/schema'
const actor = vi.hoisted(() => ({ user_id: '1', role: 'admin' }))
vi.mock('../auth/RoleContext', () => ({ useRoleContext: () => actor }))
import { apiFetch, ApiClientError } from '../../shared/api/client'
vi.mock('../../shared/api/client', async (original) => ({
  ...(await original<typeof import('../../shared/api/client')>()),
  apiFetch: vi.fn(),
}))
afterEach(() => {
  try {
    cleanup()
    expect(console.error).not.toHaveBeenCalled()
  } finally {
    actor.user_id = '1'
    vi.resetAllMocks()
    vi.restoreAllMocks()
  }
})
beforeEach(() => {
  // React Router can catch render exceptions; they must still fail these tests.
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(apiFetch).mockImplementation(async (_url, init) =>
    init?.method === 'POST'
      ? { user: { id: '9', login: 'selected-namesake' }, initial_password: 'fictional-secret' }
      : { items: [], next_after_id: null },
  )
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

it('distinguishes namesake teachers by ID and department and submits the selected ID', async () => {
  const teachers: components['schemas']['LookupPage'] = {
    items: [
      { id: '11', name: 'Вымышленный Однофамилец', context: 'Кафедра: Физика (ID 3)' },
      { id: '12', name: 'Вымышленный Однофамилец', context: 'Кафедра: Математика (ID 4)' },
    ],
    next_after_id: null,
  }
  const created: components['schemas']['CreatedUser'] = {
    user: {
      id: '9',
      login: 'selected-namesake',
      full_name: 'Вымышленный',
      role: 'teacher',
      is_active: true,
      teacher_id: '12',
      student_id: null,
      staff_profile_id: null,
      group_id: null,
      org_unit_id: null,
      permissions: [],
    },
    initial_password: 'fictional-teacher-initial-password',
  }
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url === '/api/v1/admin/lookups?kind=teachers&q=') return teachers
    if (method === 'POST' && url === '/api/v1/admin/users') return created
    throw new Error(`Unexpected API request: ${method} ${url}`)
  })
  mount()
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('Логин'), 'selected-namesake')
  await user.type(screen.getByLabelText('ФИО'), 'Вымышленный')
  await user.selectOptions(screen.getByLabelText('Роль'), 'teacher')
  const option = await screen.findByRole('option', { name: /Однофамилец · ID 12.*Математика/ })
  expect(screen.getByRole('option', { name: /Однофамилец · ID 11.*Физика/ })).toBeInTheDocument()
  await user.selectOptions(option.closest('select')!, '12')
  await user.click(screen.getByRole('button', { name: 'Создать' }))
  const post = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST')
  expect(JSON.parse(String(post?.[1]?.body)).teacher_id).toBe('12')
  expect(await screen.findByRole('heading', { name: 'Пользователь создан' })).toHaveFocus()
  expect(screen.getByText(created.user.login)).toBeInTheDocument()
  expect(screen.getByText(created.initial_password)).toBeInTheDocument()
  expect(console.error).not.toHaveBeenCalled()
})

it('uses the server permission catalogue and replaces an invalid selection after transfer', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  let detail = {
    id: '9',
    login: 'fictional-staff',
    full_name: 'Вымышленный сотрудник',
    role: 'staff',
    is_active: true,
    student_id: null,
    teacher_id: null,
    staff_profile_id: '7',
    group_id: null,
    org_unit_id: '3',
    permissions: [],
    available_permission_codes: ['grades.edit', 'applications.review', 'news.publish'],
  }
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url).includes('/lookups'))
      return {
        items: [
          { id: '3', name: 'Деканат', type: 'dean_office' },
          { id: '4', name: 'Бухгалтерия', type: 'accounting' },
        ],
        next_after_id: null,
      }
    if (String(url).endsWith('/department') && init?.method === 'PUT') {
      const { org_unit_id } = JSON.parse(String(init.body))
      detail = {
        ...detail,
        org_unit_id,
        available_permission_codes:
          org_unit_id === '4'
            ? ['applications.review', 'news.publish']
            : ['grades.edit', 'applications.review', 'news.publish'],
      }
    }
    return detail
  })
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RouterProvider
        router={createMemoryRouter([{ path: '/admin/users/:id', element: <UserDetailPage /> }], {
          initialEntries: ['/admin/users/9'],
        })}
      />
    </QueryClientProvider>,
  )
  const user = userEvent.setup()
  await screen.findByRole('option', { name: /grades.edit/ })
  await user.selectOptions(screen.getByLabelText('Разрешение'), 'grades.edit')
  const accounting = await screen.findByRole('option', { name: /Бухгалтерия · ID 4/ })
  const departments = accounting.closest('select')!
  await user.selectOptions(departments, '4')
  await user.click(screen.getByRole('button', { name: 'Сменить подразделение и отозвать права' }))
  await screen.findByText('Текущее подразделение: 4')
  expect(screen.queryByRole('option', { name: /grades.edit/ })).not.toBeInTheDocument()
  expect(screen.getByLabelText('Разрешение')).toHaveValue('applications.review')
  await user.click(screen.getByRole('button', { name: 'Выдать разрешение' }))
  const grant = vi
    .mocked(apiFetch)
    .mock.calls.find(
      ([url, init]) => String(url).endsWith('/permissions') && init?.method === 'PUT',
    )
  expect(JSON.parse(String(grant?.[1]?.body))).toEqual({
    permission_code: 'applications.review',
    scope_org_unit_id: '4',
  })
  await user.selectOptions(departments, '3')
  await user.click(screen.getByRole('button', { name: 'Сменить подразделение и отозвать права' }))
  await screen.findByRole('option', { name: /grades.edit/ })
})

it('shows an administrative reset secret once without placing it in a retryable cache', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  const detail: components['schemas']['UserDetail'] = {
    id: '9',
    login: 'fictional-reset-user',
    full_name: 'Вымышленный пользователь',
    role: 'student',
    is_active: true,
    student_id: '19',
    group_id: '29',
    teacher_id: null,
    staff_profile_id: null,
    org_unit_id: null,
    permissions: [],
    available_permission_codes: [],
  }
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (init?.method === 'POST' && String(url).endsWith('/password-reset'))
      return { password: 'fictional-one-time-reset-secret' }
    return detail
  })
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RouterProvider
        router={createMemoryRouter([{ path: '/admin/users/:id', element: <UserDetailPage /> }], {
          initialEntries: ['/admin/users/9'],
        })}
      />
    </QueryClientProvider>,
  )
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Сбросить пароль' }))
  expect(await screen.findByText('fictional-one-time-reset-secret')).toBeInTheDocument()
  const request = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST')
  expect(request?.[1]).toMatchObject({ authenticated: true, replayAfterRefresh: false })
  await user.click(screen.getByRole('button', { name: 'Закрыть и удалить пароль с экрана' }))
  expect(screen.queryByText('fictional-one-time-reset-secret')).not.toBeInTheDocument()
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(
    1,
  )
})

it('hides the administrative reset action on the current administrator account', async () => {
  actor.user_id = '9'
  vi.mocked(apiFetch).mockResolvedValue({
    id: '9',
    login: 'fictional-admin',
    full_name: 'Вымышленный администратор',
    role: 'admin',
    is_active: true,
    student_id: null,
    group_id: null,
    teacher_id: null,
    staff_profile_id: null,
    org_unit_id: null,
    permissions: [],
    available_permission_codes: [],
  })
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider
        router={createMemoryRouter([{ path: '/admin/users/:id', element: <UserDetailPage /> }], {
          initialEntries: ['/admin/users/9'],
        })}
      />
    </QueryClientProvider>,
  )
  await screen.findByRole('heading', { name: 'Вымышленный администратор' })
  expect(screen.queryByRole('button', { name: 'Сбросить пароль' })).not.toBeInTheDocument()
})
