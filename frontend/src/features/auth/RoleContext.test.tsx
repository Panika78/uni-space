import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider, focusManager } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appRoutes } from '../../app/router'
import { createQueryClient } from '../../app/queryClient'
import { apiFetch, ApiClientError } from '../../shared/api/client'
import type { AuthorizationContext } from './roleNavigation'
import { staffSections, getRoleNavigation, getStartRoute } from './roleNavigation'

const auth = vi.hoisted(() => ({ status: 'authenticated', logout: vi.fn() }))
vi.mock('./AuthProvider', () => ({ useAuth: () => auth }))
vi.mock('../../shared/api/client', async (original) => ({
  ...(await original<typeof import('../../shared/api/client')>()),
  apiFetch: vi.fn(),
}))
let context: AuthorizationContext
beforeEach(() => {
  auth.status = 'authenticated'
  vi.stubGlobal('innerWidth', 360)
  context = { user_id: '42', role: 'teacher', org_unit_id: null, permissions: [] }
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    url === '/api/v1/notifications/unread-count'
      ? { count: 0 }
      : String(url).startsWith('/api/v1/admin/users')
        ? { items: [], next_after_id: null }
        : String(url).startsWith('/api/v1/teaching/assignments') ||
            String(url).startsWith('/api/v1/staff/applications?')
          ? { items: [], next_cursor: null }
          : context,
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.resetAllMocks()
  focusManager.setFocused(undefined)
})
function mount(path = '/login') {
  const client = createQueryClient()
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { client, router }
}
it.each([
  ['teacher', '/teacher/journals', 'Мои журналы'],
  ['admin', '/admin/users', 'Пользователи'],
  ['staff', '/staff', 'Нет доступных разделов'],
] as const)('opens the %s start with empty effective staff grants', async (role, path, title) => {
  context.role = role
  const { router } = mount()
  expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument()
  expect(router.state.location.pathname).toBe(path)
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.every(
        ([url]) =>
          url === '/api/v1/auth/context' ||
          url === '/api/v1/notifications/unread-count' ||
          (role === 'teacher' && String(url).startsWith('/api/v1/teaching/assignments')) ||
          (role === 'admin' && String(url).startsWith('/api/v1/admin/users')),
      ),
  ).toBe(true)
  expect(screen.queryByRole('link', { name: 'Мой профиль' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Уведомления' })).toBeInTheDocument()
})
it('preserves the student start despite empty staff grants', () => {
  expect(getStartRoute({ ...context, role: 'student' })).toBe('/schedule')
})
it('opens the staff applications start only with its own effective permission', async () => {
  context = {
    ...context,
    role: 'staff',
    org_unit_id: '7',
    permissions: [{ permission_code: 'applications.review', scope_org_unit_id: '7' }],
  }
  const { router } = mount('/')
  expect(await screen.findByRole('heading', { name: 'Заявления' })).toBeInTheDocument()
  expect(router.state.location.pathname).toBe('/staff/applications')
  expect(
    screen.queryByRole('button', { name: /Создать|Принять|Отклонить|Удалить/ }),
  ).not.toBeInTheDocument()
})
it.each(staffSections.filter(({ visible, disabled }) => visible !== false && !disabled))(
  'keeps $permission independent from other staff grants',
  ({ permission, label }) => {
    context = {
      ...context,
      role: 'staff',
      permissions: [{ permission_code: permission, scope_org_unit_id: null }],
    }
    const navigation = getRoleNavigation(context)
    expect(
      navigation.filter((section) => !section.disabled).map((section) => section.label),
    ).toEqual(permission === 'students.status.edit' ? ['Поиск студентов', label] : [label])
    expect(navigation.find((section) => section.label === 'Учебные группы')).toMatchObject({
      disabled: true,
    })
    expect(getStartRoute(context)).toBe(
      permission === 'applications.review'
        ? '/staff/applications'
        : permission === 'students.read' || permission === 'students.status.edit'
          ? '/staff/students'
          : '/staff',
    )
  },
)
it('keeps the status editor route alongside the implied student search permission', () => {
  context = {
    ...context,
    role: 'staff',
    permissions: [{ permission_code: 'students.status.edit', scope_org_unit_id: null }],
  }
  const navigation = getRoleNavigation(context)
  expect(navigation.some((item) => item.label === 'Поиск студентов')).toBe(true)
  expect(navigation.some((item) => item.to === '/staff/students/status')).toBe(true)
  expect(navigation.some((item) => item.label === 'Академические сведения')).toBe(false)
  expect(navigation.some((item) => item.label === 'Академические статусы')).toBe(true)
  expect(navigation.some((item) => item.to === '/staff#students.edit')).toBe(false)
  expect(getStartRoute(context)).toBe('/staff/students')
})
it.each(['grades.edit', 'attendance.edit'] as const)(
  'shows one dean journal entry for %s',
  (permission) => {
    context = {
      ...context,
      role: 'staff',
      permissions: [{ permission_code: permission, scope_org_unit_id: null }],
    }
    const journals = getRoleNavigation(context).filter((item) =>
      item.to.startsWith('/staff/journals'),
    )
    expect(journals).toEqual([
      { to: '/staff/journals', label: 'Журнал деканата', icon: 'graduation', disabled: false },
    ])
    expect(getRoleNavigation(context).some((item) => item.label === 'Баллы')).toBe(false)
    expect(getRoleNavigation(context).some((item) => item.label === 'Посещаемость')).toBe(false)
  },
)
it('shows other effective staff sections with honest module states', async () => {
  context = {
    ...context,
    role: 'staff',
    permissions: [{ permission_code: 'schedule.edit', scope_org_unit_id: null }],
  }
  mount()
  expect(await screen.findByRole('heading', { name: 'Редактор расписания' })).toBeInTheDocument()
  expect(screen.queryByText('Нет доступных разделов')).not.toBeInTheDocument()
  expect(screen.queryByRole('link', { name: 'Заявления' })).not.toBeInTheDocument()
})
it.each([
  '/schedule',
  '/profile',
  '/services',
  '/applications/1',
  '/admin/users',
  '/staff/applications',
])('rejects a teacher direct visit to %s before student API calls', async (path) => {
  mount(path)
  expect(await screen.findByRole('alert')).toHaveTextContent('Доступ запрещён')
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.filter(([url]) => url !== '/api/v1/notifications/unread-count')
      .map(([url]) => url),
  ).toEqual(['/api/v1/auth/context'])
})
it('does not mount a shell before the initial context resolves', async () => {
  let resolve!: (value: AuthorizationContext) => void
  vi.mocked(apiFetch).mockReturnValue(
    new Promise((complete) => {
      resolve = complete
    }),
  )
  mount('/teacher/journals')
  expect(screen.getByRole('status')).toHaveTextContent('Проверяем доступ')
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  await act(async () => resolve(context))
  expect(await screen.findByRole('heading', { name: 'Мои журналы' })).toBeInTheDocument()
})
it.each([
  [403, 'forbidden', 'Доступ запрещён', false],
  [500, 'internal_error', 'Сервис временно недоступен', true],
  [undefined, 'network_error', 'Не удалось связаться с сервером', true],
] as const)(
  'distinguishes context error %s and only offers safe read retries',
  async (status, code, title, retry) => {
    vi.mocked(apiFetch).mockRejectedValue(new ApiClientError('private detail', code, status))
    mount('/teacher/journals')
    expect(await screen.findByRole('alert')).toHaveTextContent(title)
    expect(screen.queryByText('Нет доступных разделов')).not.toBeInTheDocument()
    expect(screen.queryByText('private detail')).not.toBeInTheDocument()
    expect(Boolean(screen.queryByRole('button', { name: 'Повторить' }))).toBe(retry)
    if (retry) {
      vi.mocked(apiFetch).mockResolvedValue(context)
      await userEvent.setup().click(screen.getByRole('button', { name: 'Повторить' }))
      expect(await screen.findByRole('heading', { name: 'Мои журналы' })).toBeInTheDocument()
    }
  },
)
it('returns to login on 401 instead of reporting missing permissions', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => {
    auth.status = 'unauthenticated'
    throw new ApiClientError('expired', 'session_invalid', 401)
  })
  mount('/teacher/journals')
  expect(await screen.findByRole('heading', { name: 'Вход в систему' })).toBeInTheDocument()
  expect(screen.queryByText('Нет доступных разделов')).not.toBeInTheDocument()
})
it('removes revoked permissions on focus and rejects the formerly allowed direct route', async () => {
  context = {
    ...context,
    role: 'staff',
    permissions: [{ permission_code: 'applications.review', scope_org_unit_id: '7' }],
  }
  const { router } = mount('/staff/applications')
  await screen.findByRole('heading', { name: 'Заявления' })
  context = {
    ...context,
    permissions: [{ permission_code: 'news.publish', scope_org_unit_id: '7' }],
  }
  act(() => {
    focusManager.setFocused(false)
    focusManager.setFocused(true)
  })
  expect(await screen.findByRole('alert')).toHaveTextContent('Доступ запрещён')
  expect(screen.queryByRole('link', { name: 'Заявления' })).not.toBeInTheDocument()
  await act(async () => router.navigate('/staff'))
  await screen.findByRole('heading', { name: 'Публикация новостей' })
  context = { ...context, permissions: [] }
  act(() => {
    focusManager.setFocused(false)
    focusManager.setFocused(true)
  })
  expect(await screen.findByRole('heading', { name: 'Нет доступных разделов' })).toBeInTheDocument()
})
it('revalidates grants on navigation and Back without using old context', async () => {
  const { router } = mount('/teacher/journals')
  await screen.findByRole('heading', { name: 'Мои журналы' })
  await act(async () => router.navigate('/teacher/schedule'))
  await screen.findByRole('heading', { name: 'Расписание' })
  context = { ...context, role: 'admin' }
  await act(async () => router.navigate(-1))
  expect(await screen.findByRole('alert')).toHaveTextContent('Доступ запрещён')
  expect(screen.queryByRole('heading', { name: 'Мои журналы' })).not.toBeInTheDocument()
})
it('reuses mobile keyboard navigation and closes the drawer on history traversal', async () => {
  const user = userEvent.setup()
  const { router } = mount('/teacher/journals')
  const trigger = await screen.findByRole('button', { name: 'Открыть меню' })
  await user.click(trigger)
  expect(
    within(screen.getByRole('dialog', { name: 'Мобильная навигация' })).getByRole('button', {
      name: 'Закрыть меню',
    }),
  ).toHaveFocus()
  await user.keyboard('{Escape}')
  expect(trigger).toHaveFocus()
  await user.click(trigger)
  await user.click(within(screen.getByRole('dialog')).getByRole('link', { name: 'Расписание' }))
  await screen.findByRole('heading', { name: 'Расписание' })
  await user.click(screen.getByRole('button', { name: 'Открыть меню' }))
  await act(async () => router.navigate(-1))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  await screen.findByRole('heading', { name: 'Мои журналы' })
})

it.each([
  ['student', '/teacher/journals'],
  ['student', '/staff/applications'],
  ['admin', '/teacher/journals'],
  ['staff', '/admin/users'],
] as const)('rejects %s access to %s using only the server context', async (role, path) => {
  context = { ...context, role }
  mount(path)
  expect(await screen.findByRole('alert')).toHaveTextContent('Доступ запрещён')
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.every(
        ([url]) => url === '/api/v1/auth/context' || url === '/api/v1/notifications/unread-count',
      ),
  ).toBe(true)
})
it('preserves shell navigation state while revalidating and navigating within a role', async () => {
  const user = userEvent.setup()
  const { router } = mount('/teacher/journals')
  await user.click(await screen.findByRole('button', { name: 'Свернуть меню' }))
  let resolve!: (value: AuthorizationContext) => void
  vi.mocked(apiFetch).mockReturnValueOnce(
    new Promise((complete) => {
      resolve = complete
    }),
  )
  act(() => window.dispatchEvent(new Event('focus')))
  expect(screen.getByRole('heading', { name: 'Мои журналы' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Развернуть меню' })).toBeInTheDocument()
  await act(async () => resolve(context))
  await act(async () => router.navigate('/teacher/schedule'))
  await screen.findByRole('heading', { name: 'Расписание' })
  expect(screen.getByRole('button', { name: 'Развернуть меню' })).toBeInTheDocument()
})
