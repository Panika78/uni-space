import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appRoutes } from '../../app/router'
import { createQueryClient } from '../../app/queryClient'
import { ApiClientError, apiFetch } from '../../shared/api/client'
import type { AuthorizationContext } from '../auth/roleNavigation'

const auth = vi.hoisted(() => ({ status: 'authenticated', logout: vi.fn() }))
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => auth }))
vi.mock('../../shared/api/client', async (original) => ({
  ...(await original<typeof import('../../shared/api/client')>()),
  apiFetch: vi.fn(),
}))

const student = {
  id: '21',
  full_name: 'Ёлкина Вымышленная',
  group: { id: '3', name: 'ИВТ-21' },
  course_number: 2,
  program: { id: '2', name: 'Программа' },
  faculty: { id: '1', name: 'Факультет' },
  academic_status: 'enrolled' as const,
}
let context: AuthorizationContext

function mount(path = '/staff/students') {
  const queryClient = createQueryClient()
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

beforeEach(() => {
  auth.status = 'authenticated'
  context = {
    user_id: '9',
    role: 'staff',
    org_unit_id: '4',
    permissions: [
      { permission_code: 'students.read', scope_org_unit_id: null },
      { permission_code: 'students.status.edit', scope_org_unit_id: null },
    ],
  }
  vi.mocked(apiFetch).mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/auth/context')) return context as never
    if (url.endsWith('/staff/students/filters'))
      return {
        faculties: [{ id: '1', name: 'Факультет' }],
        programs: [{ id: '2', name: 'Программа' }],
        course_numbers: [2],
      } as never
    if (url === '/api/v1/staff/students/21') return student as never
    if (url.includes('/academic-status')) return { academic_status: 'academic_leave' } as never
    if (url.startsWith('/api/v1/staff/students?'))
      return { items: [student], next_cursor: null } as never
    if (init?.method === 'PATCH') return { academic_status: 'academic_leave' } as never
    return undefined as never
  })
})

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

it('searches and filters staff students and requires external-basis confirmation', async () => {
  const user = userEvent.setup()
  mount()
  expect(await screen.findByText('Ёлкина Вымышленная')).toBeInTheDocument()
  await user.type(screen.getByLabelText('ФИО или группа'), 'Ёлкина')
  await user.selectOptions(screen.getByLabelText('Факультет'), '1')
  await user.click(screen.getByRole('button', { name: 'Найти' }))
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith(
      expect.stringContaining('q=%D0%81%D0%BB%D0%BA%D0%B8%D0%BD%D0%B0'),
      expect.anything(),
    ),
  )
  await user.click(screen.getByRole('button', { name: 'Изменить статус' }))
  const dialog = screen.getByRole('dialog', { name: 'Изменение статуса' })
  const submit = screen.getByRole('button', { name: 'Подтвердить изменение' })
  expect(submit).toBeDisabled()
  await user.selectOptions(within(dialog).getByLabelText('Новый статус'), 'academic_leave')
  await user.click(within(dialog).getByLabelText('Подтверждаю, что внешнее основание оформлено'))
  expect(submit).toBeEnabled()
  await user.click(submit)
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/v1/staff/students/21/academic-status',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          academic_status: 'academic_leave',
          reason: 'administrative_change',
        }),
      }),
    ),
  )
})

it('lets a status-only staff user enter a known ID without reading the student profile', async () => {
  context.permissions = [{ permission_code: 'students.status.edit', scope_org_unit_id: null }]
  mount('/staff/students/status')
  expect(
    await screen.findByRole('heading', { name: 'Изменение академического статуса' }),
  ).toBeInTheDocument()
  expect(screen.queryByText('Ёлкина Вымышленная')).not.toBeInTheDocument()
  await userEvent.setup().type(screen.getByLabelText('ID студента'), '21')
  expect(await screen.findByText('Студент ID 21')).toBeInTheDocument()
  expect(vi.mocked(apiFetch).mock.calls.map(([url]) => String(url))).not.toContain(
    '/api/v1/staff/students/21',
  )
})

it.each([403, 500])('shows a clear search error for HTTP %s', async (status) => {
  vi.mocked(apiFetch).mockImplementation(async (input) => {
    if (String(input).endsWith('/auth/context')) return context as never
    if (String(input).endsWith('/staff/students/filters'))
      throw new ApiClientError('', status === 403 ? 'forbidden' : 'internal_error', status)
    return { items: [], next_cursor: null } as never
  })
  mount()
  expect(await screen.findByRole('alert')).toHaveTextContent(
    status === 403 ? 'Доступ запрещён' : 'Не удалось загрузить студентов',
  )
})

it('reports a revoked status-edit permission after the explicit confirmation', async () => {
  vi.mocked(apiFetch).mockImplementation(async (input) => {
    if (String(input).endsWith('/auth/context')) return context as never
    if (String(input).endsWith('/staff/students/filters'))
      return {
        faculties: [{ id: '1', name: 'Факультет' }],
        programs: [{ id: '2', name: 'Программа' }],
        course_numbers: [2],
      } as never
    if (String(input).startsWith('/api/v1/staff/students?'))
      return { items: [student], next_cursor: null } as never
    throw new ApiClientError('', 'forbidden', 403)
  })
  const user = userEvent.setup()
  mount()
  await screen.findByText('Ёлкина Вымышленная')
  await user.click(screen.getByRole('button', { name: 'Изменить статус' }))
  const dialog = screen.getByRole('dialog', { name: 'Изменение статуса' })
  await user.selectOptions(within(dialog).getByLabelText('Новый статус'), 'academic_leave')
  await user.click(within(dialog).getByLabelText('Подтверждаю, что внешнее основание оформлено'))
  await user.click(within(dialog).getByRole('button', { name: 'Подтвердить изменение' }))
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'Доступ к изменению статуса отозван',
  )
})

it('blocks a route after its permission is revoked from the effective context', async () => {
  context.permissions = []
  mount()
  expect(await screen.findByRole('alert')).toHaveTextContent('Доступ запрещён')
  expect(screen.queryByText('Ёлкина Вымышленная')).not.toBeInTheDocument()
})

it('requires an explicit target for status-only and clears success when the operation changes', async () => {
  context.permissions = [{ permission_code: 'students.status.edit', scope_org_unit_id: null }]
  const user = userEvent.setup()
  mount('/staff/students/status')
  await screen.findByRole('heading', { name: 'Изменение академического статуса' })
  await user.type(screen.getByLabelText('ID студента'), '21')
  const submit = screen.getByRole('button', { name: 'Подтвердить изменение' })
  expect(screen.getByLabelText('Новый статус')).toHaveValue('')
  await user.click(screen.getByLabelText('Подтверждаю, что внешнее основание оформлено'))
  expect(submit).toBeDisabled()
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PATCH'),
  ).toHaveLength(0)
  await user.selectOptions(screen.getByLabelText('Новый статус'), 'academic_leave')
  expect(screen.getByText(/Будет установлен статус:/)).toHaveTextContent('В академическом отпуске')
  await user.click(screen.getByLabelText('Подтверждаю, что внешнее основание оформлено'))
  await user.click(submit)
  expect(await screen.findByText(/Статус сохранён:/)).toHaveTextContent('В академическом отпуске')
  await user.selectOptions(screen.getByLabelText('Основание изменения'), 'correction')
  expect(screen.queryByText(/Статус сохранён:/)).not.toBeInTheDocument()
  expect(submit).toBeDisabled()
  expect(screen.queryByText('Ёлкина Вымышленная')).not.toBeInTheDocument()
})

it('identifies the selected student and traps/restores keyboard focus', async () => {
  const user = userEvent.setup()
  mount()
  await screen.findByText(student.full_name)
  const trigger = screen.getByRole('button', { name: 'Изменить статус' })
  await user.click(trigger)
  const dialog = screen.getByRole('dialog', { name: 'Изменение статуса' })
  expect(within(dialog).getByText(/Ёлкина Вымышленная · ИВТ-21/)).toBeInTheDocument()
  expect(within(dialog).getByText('Текущий статус: Обучается')).toBeInTheDocument()
  const target = within(dialog).getByLabelText('Новый статус')
  expect(target).toHaveFocus()
  await user.tab({ shift: true })
  expect(within(dialog).getByRole('button', { name: 'Отмена' })).toHaveFocus()
  await user.tab()
  expect(target).toHaveFocus()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(trigger).toHaveFocus()
})

it.each([undefined, 500])(
  'keeps an uncertain write locked without replay or hidden read (%s)',
  async (status) => {
    context.permissions = [{ permission_code: 'students.status.edit', scope_org_unit_id: null }]
    const original = vi.mocked(apiFetch).getMockImplementation()!
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (init?.method === 'PATCH')
        throw new ApiClientError('', status ? 'internal_error' : 'network_error', status)
      return original(url, init)
    })
    const user = userEvent.setup()
    mount('/staff/students/status')
    await screen.findByRole('heading', { name: 'Изменение академического статуса' })
    await user.type(screen.getByLabelText('ID студента'), '21')
    await user.selectOptions(screen.getByLabelText('Новый статус'), 'enrolled')
    await user.click(screen.getByLabelText('Подтверждаю, что внешнее основание оформлено'))
    await user.click(screen.getByRole('button', { name: 'Подтвердить изменение' }))
    expect(await screen.findByText(/Результат изменения неизвестен/)).toBeInTheDocument()
    expect(screen.queryByText(/Не удалось сохранить статус/)).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Сверить актуальное состояние' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Подтвердить изменение' })).toBeDisabled()
    expect(
      vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PATCH'),
    ).toHaveLength(1)
    expect(vi.mocked(apiFetch).mock.calls.map(([url]) => String(url))).not.toContain(
      '/api/v1/staff/students/21',
    )
  },
)

it.each([403, 404])(
  'renders direct detail GET error %s without stale student data',
  async (status) => {
    const original = vi.mocked(apiFetch).getMockImplementation()!
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url) === '/api/v1/staff/students/21')
        throw new ApiClientError('', status === 403 ? 'forbidden' : 'not_found', status)
      return original(url, init)
    })
    mount('/staff/students/21')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      status === 403 ? 'Доступ запрещён' : 'Студент не найден',
    )
    expect(screen.queryByText(student.full_name)).not.toBeInTheDocument()
  },
)

it('opens a direct read-only detail and preserves a filter URL on return', async () => {
  context.permissions = [{ permission_code: 'students.read', scope_org_unit_id: null }]
  mount('/staff/students/21?q=Ёлкина&faculty_id=1')
  expect(await screen.findByRole('heading', { name: student.full_name })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Изменить статус' })).not.toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'К результатам поиска' })).toHaveAttribute(
    'href',
    '/staff/students?q=%D0%81%D0%BB%D0%BA%D0%B8%D0%BD%D0%B0&faculty_id=1',
  )
})

it('confirms the identity, group and old/new statuses of the specifically selected student', async () => {
  const second = {
    ...student,
    id: '22',
    full_name: 'Жуков Вымышленный',
    group: { id: '4', name: 'ФИЛ-11' },
    academic_status: 'graduated',
  }
  const original = vi.mocked(apiFetch).getMockImplementation()!
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url).startsWith('/api/v1/staff/students?'))
      return { items: [student, second], next_cursor: null } as never
    return original(url, init)
  })
  mount()
  const user = userEvent.setup()
  await screen.findByText(second.full_name)
  await user.click(screen.getAllByRole('button', { name: 'Изменить статус' })[1])
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText('Жуков Вымышленный · ФИЛ-11')).toBeInTheDocument()
  expect(within(dialog).getByText('Студент ID 22')).toBeInTheDocument()
  expect(within(dialog).getByText('Текущий статус: Выпускник')).toBeInTheDocument()
  await user.selectOptions(within(dialog).getByLabelText('Новый статус'), 'academic_leave')
  expect(within(dialog).getByText(/Будет установлен статус:/)).toHaveTextContent(
    'В академическом отпуске',
  )
  await user.click(within(dialog).getByLabelText('Подтверждаю, что внешнее основание оформлено'))
  await user.click(within(dialog).getByRole('button', { name: 'Подтвердить изменение' }))
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/v1/staff/students/22/academic-status',
      expect.objectContaining({ method: 'PATCH' }),
    ),
  )
})

it('identifies a by-ID target and permits reconciliation when the actor separately has read', async () => {
  mount('/staff/students/status')
  await screen.findByRole('heading', { name: 'Изменение академического статуса' })
  await userEvent.setup().type(screen.getByLabelText('ID студента'), '21')
  expect(await screen.findByText('Ёлкина Вымышленная · ИВТ-21')).toBeInTheDocument()
  expect(screen.getByText('Текущий статус: Обучается')).toBeInTheDocument()
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/v1/staff/students/21',
    expect.objectContaining({ authenticated: true }),
  )
})

it('preserves all rapid filter selections in the URL and clears page boundaries', async () => {
  const router = mount('/staff/students?q=Тест&cursor=old&back=')
  await screen.findByText(student.full_name)
  const user = userEvent.setup()
  await user.selectOptions(screen.getByLabelText('Факультет'), '1')
  await user.selectOptions(screen.getByLabelText('Программа'), '2')
  await user.selectOptions(screen.getByLabelText('Курс'), '2')
  const params = new URLSearchParams(router.state.location.search)
  expect(params.get('q')).toBe('Тест')
  expect(params.get('faculty_id')).toBe('1')
  expect(params.get('program_id')).toBe('2')
  expect(params.get('course_number')).toBe('2')
  expect(params.has('cursor')).toBe(false)
  expect(params.has('back')).toBe(false)
})
