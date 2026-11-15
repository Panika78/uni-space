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
    if (url.includes('/academic-status')) return { academic_status: 'academic_leave' } as never
    if (url.startsWith('/api/v1/staff/students?'))
      return { items: [student], next_cursor: null } as never
    if (init?.method === 'PUT') return { academic_status: 'academic_leave' } as never
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
        method: 'PUT',
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
