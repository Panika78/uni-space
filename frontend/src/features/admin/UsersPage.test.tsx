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
  await user.click(screen.getByRole('combobox', { name: 'Свободный преподаватель' }))
  const option = await screen.findByRole('option', { name: /Однофамилец.*ID 12.*Математика/ })
  expect(screen.getByRole('option', { name: /ОднофамилецID 11.*Физика/ })).toBeInTheDocument()
  await user.click(option)
  await user.click(screen.getByRole('button', { name: 'Создать' }))
  const post = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST')
  expect(JSON.parse(String(post?.[1]?.body)).teacher_id).toBe('12')
  expect(await screen.findByRole('heading', { name: 'Пользователь создан' })).toHaveFocus()
  expect(screen.getByText(created.user.login)).toBeInTheDocument()
  expect(screen.getByText(created.initial_password)).toBeInTheDocument()
  expect(console.error).not.toHaveBeenCalled()
})

it('uses a single searchable lookup and updates ungranted permissions immediately', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  let detail: components['schemas']['UserDetail'] = {
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
    available_permission_codes: [
      'grades.edit',
      'applications.review',
      'news.publish',
      'students.status.edit',
      'students.read',
    ],
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
    if (String(url).endsWith('/permissions') && init?.method === 'PUT') {
      detail = {
        ...detail,
        permissions: [...detail.permissions, JSON.parse(String(init.body))],
      }
      return detail
    }
    if (String(url).endsWith('/permissions') && init?.method === 'DELETE') {
      const permission = JSON.parse(String(init.body))
      detail = {
        ...detail,
        permissions: detail.permissions.filter(
          (grant) => grant.permission_code !== permission.permission_code,
        ),
      }
      return detail
    }
    if (String(url).endsWith('/department') && init?.method === 'PUT') {
      const { org_unit_id } = JSON.parse(String(init.body))
      detail = {
        ...detail,
        org_unit_id,
        permissions: [],
        available_permission_codes:
          org_unit_id === '4'
            ? ['applications.review', 'news.publish', 'students.read']
            : ['grades.edit', 'applications.review', 'news.publish', 'students.read'],
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
  await screen.findByRole('heading', { name: 'Карточка пользователя' })
  const user = userEvent.setup()
  await user.click(screen.getByRole('combobox', { name: 'Подразделение' }))
  const dean = await screen.findByRole('option', { name: /Деканат.*ID 3/ })
  await user.click(dean)
  await user.selectOptions(screen.getByLabelText('Разрешение'), 'students.status.edit')
  await user.click(screen.getByRole('button', { name: 'Выдать разрешение' }))
  expect(screen.queryByRole('option', { name: /students.read/ })).not.toBeInTheDocument()
  await user.click(screen.getByRole('combobox', { name: 'Подразделение' }))
  const accounting = await screen.findByRole('option', { name: /Бухгалтерия.*ID 4/ })
  await user.click(accounting)
  await user.click(screen.getByRole('button', { name: 'Сменить подразделение и отозвать права' }))
  await screen.findByText('Текущее подразделение: 4')
  expect(screen.queryByRole('option', { name: /grades.edit/ })).not.toBeInTheDocument()
  expect(screen.getByLabelText('Разрешение')).toHaveValue('applications.review')
  await user.click(screen.getByRole('button', { name: 'Выдать разрешение' }))
  const grant = [...vi.mocked(apiFetch).mock.calls]
    .reverse()
    .find(([url, init]) => String(url).endsWith('/permissions') && init?.method === 'PUT')
  expect(JSON.parse(String(grant?.[1]?.body))).toEqual({
    permission_code: 'applications.review',
    scope_org_unit_id: '4',
  })
  expect(screen.queryByRole('option', { name: /applications.review/ })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Отозвать applications.review' }))
  expect(await screen.findByRole('option', { name: /applications.review/ })).toBeInTheDocument()
  await user.click(screen.getByRole('combobox', { name: 'Подразделение' }))
  const deanAgain = await screen.findByRole('option', { name: /Деканат.*ID 3/ })
  await user.click(deanAgain)
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
      return { password: 'abcdefghijklmnopqrstuvwxyzABCDEF' }
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
  expect(await screen.findByText('abcdefghijklmnopqrstuvwxyzABCDEF')).toBeInTheDocument()
  const request = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST')
  expect(request?.[1]).toMatchObject({ authenticated: true, replayAfterRefresh: false })
  await user.click(screen.getByRole('button', { name: 'Закрыть и удалить пароль с экрана' }))
  expect(screen.queryByText('abcdefghijklmnopqrstuvwxyzABCDEF')).not.toBeInTheDocument()
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(
    1,
  )
})

it('keeps a committed reset secret visible if its follow-up user GET fails', async () => {
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
  let userGetCount = 0
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (init?.method === 'POST' && String(url).endsWith('/password-reset'))
      return { password: 'abcdefghijklmnopqrstuvwxyz-123456' }
    if (String(url).endsWith('/users/9')) {
      userGetCount += 1
      if (userGetCount > 1) throw new ApiClientError('Unavailable', 'http_error', 503)
      return detail
    }
    throw new Error(`Unexpected API request: ${String(url)}`)
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
  expect(await screen.findByText('abcdefghijklmnopqrstuvwxyz-123456')).toBeInTheDocument()
  expect(await screen.findByRole('heading', { name: 'Пароль сброшен' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Закрыть и удалить пароль с экрана' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось выполнить запрос')
  expect(screen.queryByText('abcdefghijklmnopqrstuvwxyz-123456')).not.toBeInTheDocument()
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(
    1,
  )
})

it.each([
  ['empty response', {}],
  ['empty password', { password: '' }],
  ['non-string password', { password: 42 }],
  ['malformed password', { password: 'contains/not-a-token' }],
])('treats an HTTP 200 %s as an uncertain reset result', async (_name, response) => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (init?.method === 'POST' && String(url).endsWith('/password-reset')) return response
    if (String(url).endsWith('/users/9'))
      return {
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
    throw new Error(`Unexpected API request: ${String(url)}`)
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
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Сбросить пароль' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Пароль мог измениться')
  expect(screen.queryByText('Выданный пароль:')).not.toBeInTheDocument()
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(
    1,
  )
})

it('treats an invalid HTTP 200 reset body as uncertain rather than rejected', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (init?.method === 'POST' && String(url).endsWith('/password-reset'))
      throw new ApiClientError('Malformed success response', 'invalid_response', 200)
    if (String(url).endsWith('/users/9'))
      return {
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
    throw new Error(`Unexpected API request: ${String(url)}`)
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
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Сбросить пароль' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Пароль мог измениться')
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(
    1,
  )
})

it.each([
  [403, 'Сброс отклонён: недостаточно прав.'],
  [404, 'Сброс отклонён: учётная запись не найдена.'],
  [409, 'Сброс отклонён: операция недопустима для этой учётной записи.'],
  [422, 'Сброс отклонён: проверьте запрос.'],
])('shows HTTP %i as a definitive reset rejection', async (status, message) => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (init?.method === 'POST' && String(url).endsWith('/password-reset'))
      throw new ApiClientError('rejected', 'api_error', status)
    if (String(url).endsWith('/users/9'))
      return {
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
    throw new Error(`Unexpected API request: ${String(url)}`)
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
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Сбросить пароль' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(message)
  expect(screen.queryByText('Пароль мог измениться')).not.toBeInTheDocument()
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

const resetErrorDetail: components['schemas']['UserDetail'] = {
  id: '9',
  login: 'fictional-reset-target',
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

it.each([
  [403, 'Сброс отклонён: недостаточно прав.'],
  [404, 'Сброс отклонён: учётная запись не найдена.'],
  [409, 'Сброс отклонён: операция недопустима для этой учётной записи.'],
  [422, 'Сброс отклонён: проверьте запрос.'],
])('reports the definitive administrative reset rejection for HTTP %i', async (status, message) => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.mocked(apiFetch).mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') throw new ApiClientError('rejected', `http_${status}`, status)
    return resetErrorDetail
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
  await screen.findByRole('heading', { name: resetErrorDetail.full_name })
  await user.click(screen.getByRole('button', { name: 'Сбросить пароль' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(message)
  expect(screen.queryByText(/Пароль мог измениться/)).not.toBeInTheDocument()
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(
    1,
  )
})

it.each([undefined, 500, 503])(
  'shows uncertainty for a reset outcome with HTTP status %s and never retries',
  async (status) => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.mocked(apiFetch).mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') {
        if (status === undefined) throw new TypeError('network failure')
        throw new ApiClientError('Internal error', 'internal_error', status)
      }
      return resetErrorDetail
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
    await screen.findByRole('heading', { name: resetErrorDetail.full_name })
    await user.click(screen.getByRole('button', { name: 'Сбросить пароль' }))
    expect(await screen.findByText(/Пароль мог измениться/)).toBeInTheDocument()
    expect(
      vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(1)
  },
)
