import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appRoutes } from '../../app/router'
import { createQueryClient } from '../../app/queryClient'
import { ApiClientError, apiFetch } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'
import type { AuthorizationContext } from '../auth/roleNavigation'

const auth = vi.hoisted(() => ({ status: 'authenticated', logout: vi.fn() }))
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => auth }))
vi.mock('../../shared/api/client', async (original) => ({
  ...(await original<typeof import('../../shared/api/client')>()),
  apiFetch: vi.fn(),
}))

const lesson: components['schemas']['EditorLesson'] = {
  id: '19',
  course_offering_id: '15',
  created_by_user_id: '8',
  starts_at: '2026-11-17T06:00:00Z',
  ends_at: '2026-11-17T07:30:00Z',
  kind: 'lecture',
  status: 'scheduled',
  version: 3,
  teacher_id: '7',
  previous_lesson_id: null,
  next_lesson_id: null,
  room_ids: ['6'],
  participants: [{ group_id: '3', subgroup_id: null }],
  display: {
    course_offering: {
      id: '15',
      discipline_id: '11',
      discipline_name: 'Алгоритмы',
      discipline_code: 'ALG',
      term_id: '12',
      term_name: 'Осень 2026',
      term_starts_on: '2026-09-01',
      term_ends_on: '2027-01-31',
      attestation_type: 'exam',
      groups: [{ id: '3', name: 'ИВТ-21' }],
    },
    teacher: { id: '7', full_name: 'Иванов Иван' },
    participants: [{ group_id: '3', group_name: 'ИВТ-21', subgroup_id: null, subgroup_name: null }],
    rooms: [{ id: '6', name: '205', building_id: '4', building_name: 'Корпус А' }],
  },
}

let context: AuthorizationContext
let scheduleResponse: components['schemas']['EditorSchedule']

function mount(path = '/staff/schedule') {
  const client = createQueryClient()
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { client, router }
}

beforeEach(() => {
  vi.setSystemTime(new Date('2026-11-17T09:00:00Z'))
  auth.status = 'authenticated'
  context = {
    user_id: '40',
    role: 'staff',
    org_unit_id: '2',
    permissions: [{ permission_code: 'schedule.edit', scope_org_unit_id: null }],
  }
  scheduleResponse = { items: [lesson], next_after_id: null }
  vi.mocked(apiFetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input), window.location.href)
    if (url.pathname === '/api/v1/auth/context') return context as never
    if (url.pathname.endsWith('/catalog/groups'))
      return { items: [{ id: '3', name: 'ИВТ-21' }], next_after_id: null } as never
    if (url.pathname.endsWith('/catalog/teachers'))
      return { items: [{ id: '7', name: 'Иванов Иван' }], next_after_id: null } as never
    if (url.pathname.endsWith('/catalog/rooms'))
      return {
        items: [{ id: '6', name: '205', building_name: 'Корпус А' }],
        next_after_id: null,
      } as never
    if (url.pathname.endsWith('/catalog/course-offerings'))
      return {
        items: [{ id: '15', name: 'Алгоритмы', term_name: 'Осень 2026' }],
        next_after_id: null,
      } as never
    if (
      url.pathname.endsWith('/catalog/subgroups') ||
      url.pathname.endsWith('/catalog/teaching-assignments')
    )
      return { items: [], next_after_id: null } as never
    if (url.pathname.endsWith('/staff/schedule/lessons') && init?.method === 'POST')
      return lesson as never
    if (url.pathname.endsWith('/staff/schedule/lessons/19') && init?.method === 'PATCH')
      return lesson as never
    if (url.pathname.endsWith('/staff/schedule/lessons/19/cancel') && init?.method === 'POST')
      return { ...lesson, status: 'cancelled' } as never
    if (url.pathname.endsWith('/staff/schedule/lessons/19/restore') && init?.method === 'POST')
      return lesson as never
    if (url.pathname.endsWith('/staff/schedule/lessons/19/move') && init?.method === 'POST')
      return { ...lesson, id: '23', previous_lesson_id: '19' } as never
    if (url.pathname.endsWith('/staff/schedule/lessons/19')) return lesson as never
    if (url.pathname.endsWith('/staff/schedule/lessons')) return scheduleResponse as never
    throw new Error(`Unexpected staff schedule request: ${url.pathname}${url.search}`)
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
})

it('blocks the direct route without the effective schedule permission', async () => {
  context = { ...context, permissions: [] }
  mount()
  expect(await screen.findByText('Доступ запрещён')).toBeInTheDocument()
  expect(
    vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).includes('/staff/schedule/')),
  ).toBe(false)
})

it('loads searchable group schedule and shows readable display values with Moscow times', async () => {
  const user = userEvent.setup()
  mount()
  await user.selectOptions(await screen.findByLabelText('Выберите: группы'), '3')
  expect(await screen.findByRole('heading', { name: 'Алгоритмы' })).toBeInTheDocument()
  expect(screen.getByText('Иванов Иван · Лекция')).toBeInTheDocument()
  expect(screen.getByText('Корпус А · 205')).toBeInTheDocument()
  expect(screen.getByText('09:00–10:30')).toBeInTheDocument()
  const request = vi
    .mocked(apiFetch)
    .mock.calls.find(([url]) => String(url).includes('/staff/schedule/lessons?'))
  expect(String(request?.[0])).toContain('date_from=2026-11-16')
  expect(String(request?.[0])).toContain('date_to=2026-11-22')
  await user.click(screen.getByRole('tab', { name: 'Аудитории' }))
  expect(screen.getByRole('heading', { name: 'Редактор расписания' })).toBeInTheDocument()
})

it('shows a save-time server conflict next to its field and retains the user draft', async () => {
  const user = userEvent.setup()
  const defaultImplementation = vi.mocked(apiFetch).getMockImplementation()!
  vi.mocked(apiFetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input), window.location.href)
    if (url.pathname.endsWith('/staff/schedule/lessons/19') && init?.method === 'PATCH') {
      throw new ApiClientError('Conflict', 'schedule_conflict', 409, [
        { code: 'teacher_conflict', field: 'teacher_id' },
      ])
    }
    if (url.pathname.endsWith('/staff/schedule/lessons/19') && !init?.method) return lesson as never
    return defaultImplementation(input, init) as never
  })
  mount()
  await user.selectOptions(await screen.findByLabelText('Выберите: группы'), '3')
  await user.click(await screen.findByRole('button', { name: 'Изменить' }))
  const dialog = await screen.findByRole('dialog', { name: 'Изменить занятие' })
  const start = within(dialog).getByLabelText('Время начала · Москва')
  await user.clear(start)
  await user.type(start, '09:30')
  await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
  expect(await within(dialog).findByText('teacher conflict')).toBeInTheDocument()
  expect(start).toHaveValue('09:30')
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.some(
        ([url, init]) => String(url).endsWith('/lessons/19') && init?.method === 'PATCH',
      ),
  ).toBe(true)
  expect(screen.queryByText('Изменения сохранены')).not.toBeInTheDocument()
})

it('creates a complete lesson with a timezone-aware Moscow timestamp', async () => {
  const user = userEvent.setup()
  mount()
  await user.selectOptions(await screen.findByLabelText('Выберите: группы'), '3')
  await user.click(screen.getByRole('button', { name: 'Добавить занятие' }))
  const dialog = screen.getByRole('dialog', { name: 'Добавить занятие' })
  const offeringPicker = within(dialog).getByRole('combobox', { name: 'Дисциплина и проведение' })
  await user.click(offeringPicker)
  await user.click(await within(dialog).findByRole('option', { name: /Алгоритмы/ }))
  const groupPicker = within(dialog).getByRole('combobox', { name: 'Группы' })
  await user.click(groupPicker)
  await user.click(await within(dialog).findByRole('option', { name: /^ИВТ-21$/ }))
  const roomPicker = within(dialog).getByRole('combobox', { name: 'Аудитории' })
  await user.click(roomPicker)
  await user.click(await within(dialog).findByRole('option', { name: /205/ }))
  await user.clear(within(dialog).getByLabelText('Время начала · Москва'))
  await user.type(within(dialog).getByLabelText('Время начала · Москва'), '13:00')
  await user.clear(within(dialog).getByLabelText('Время окончания · Москва'))
  await user.type(within(dialog).getByLabelText('Время окончания · Москва'), '14:15')
  await user.selectOptions(within(dialog).getByLabelText('Тип занятия'), 'lab')
  await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
  await waitFor(() => expect(dialog).not.toBeInTheDocument())
  const create = vi
    .mocked(apiFetch)
    .mock.calls.find(
      ([, init]) =>
        init?.method === 'POST' &&
        !String(vi.mocked(apiFetch).mock.calls[0]?.[0]).includes('cancel'),
    )
  expect(create?.[1]).toEqual(
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        course_offering_id: '15',
        teacher_id: null,
        starts_at: '2026-11-17T13:00:00+03:00',
        ends_at: '2026-11-17T14:15:00+03:00',
        kind: 'lab',
        participants: [{ group_id: '3', subgroup_id: null }],
        room_ids: ['6'],
      }),
    }),
  )
})

it('keeps a version-conflict draft until the user explicitly adopts the fresh version', async () => {
  const user = userEvent.setup()
  let patchCount = 0
  const current = { ...lesson, version: 4, starts_at: '2026-11-17T19:00:00+03:00' }
  const defaultImplementation = vi.mocked(apiFetch).getMockImplementation()!
  vi.mocked(apiFetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input), window.location.href)
    if (url.pathname.endsWith('/staff/schedule/lessons/19') && init?.method === 'PATCH') {
      patchCount += 1
      if (patchCount === 1) throw new ApiClientError('Version changed', 'version_conflict', 409)
      return current as never
    }
    if (url.pathname.endsWith('/staff/schedule/lessons/19') && !init?.method)
      return current as never
    return defaultImplementation(input, init) as never
  })
  mount()
  await user.selectOptions(await screen.findByLabelText('Выберите: группы'), '3')
  await user.click(await screen.findByRole('button', { name: 'Изменить' }))
  const dialog = await screen.findByRole('dialog', { name: 'Изменить занятие' })
  const start = within(dialog).getByLabelText('Время начала · Москва')
  await user.clear(start)
  await user.type(start, '20:15')
  const end = within(dialog).getByLabelText('Время окончания · Москва')
  await user.clear(end)
  await user.type(end, '21:15')
  await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
  expect(await within(dialog).findByText(/уже изменил другой сотрудник/)).toBeInTheDocument()
  expect(start).toHaveValue('20:15')
  await user.click(
    within(dialog).getByRole('button', { name: 'Загрузить актуальную версию отдельно' }),
  )
  expect(await within(dialog).findByText(/На сервере сейчас версия 4/)).toBeInTheDocument()
  expect(start).toHaveValue('20:15')
  await user.click(
    within(dialog).getByRole('button', { name: 'Использовать только номер версии 4' }),
  )
  expect(start).toHaveValue('20:15')
  await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
  await waitFor(() => expect(dialog).not.toBeInTheDocument())
  const patchCalls = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PATCH')
  expect(patchCalls).toHaveLength(2)
  expect(JSON.parse(String(patchCalls[1][1]?.body))).toMatchObject({
    version: 4,
    starts_at: '2026-11-17T20:15:00+03:00',
  })
})

it('requires confirmation before cancelling and sends the read version without a reason', async () => {
  const user = userEvent.setup()
  mount()
  await user.selectOptions(await screen.findByLabelText('Выберите: группы'), '3')
  await user.click(await screen.findByRole('button', { name: 'Отменить' }))
  const dialog = screen.getByRole('dialog', { name: 'Отменить занятие?' })
  await user.click(within(dialog).getByRole('button', { name: 'Подтвердить отмену' }))
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/v1/staff/schedule/lessons/19/cancel',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ version: 3 }) }),
    ),
  )
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
})
