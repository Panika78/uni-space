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
      return {
        items: [
          { id: '7', name: 'Иванов Иван' },
          { id: '8', name: 'Петров Пётр' },
        ],
        next_after_id: null,
      } as never
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
    if (url.pathname.endsWith('/catalog/subgroups'))
      return {
        items: [
          { id: '31', name: 'Подгруппа А' },
          { id: '32', name: 'Подгруппа Б' },
        ],
        next_after_id: null,
      } as never
    if (url.pathname.endsWith('/catalog/teaching-assignments'))
      return {
        items: [
          { id: '101', name: 'Иванов Иван', teacher_id: '7', group_id: '3' },
          { id: '102', name: 'Петров Пётр', teacher_id: '8', group_id: '3' },
        ],
        next_after_id: null,
      } as never
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

it('restores a direct resource URL with its protected catalog display name', async () => {
  mount('/staff/schedule?resource=group&resource_id=3&resource_name=ИВТ-21&date=2026-11-17')
  expect(await screen.findByRole('heading', { name: 'Алгоритмы' })).toBeInTheDocument()
  expect(screen.getByRole('combobox', { name: 'Поиск: группы' })).toHaveValue('ИВТ-21')
  expect(screen.getByText('Иванов Иван · Лекция')).toBeInTheDocument()
})

it('recovers once when fetching a later schedule page gets a stale cursor 422', async () => {
  const user = userEvent.setup()
  let firstPageReads = 0
  let cursorReads = 0
  const defaultImplementation = vi.mocked(apiFetch).getMockImplementation()!
  vi.mocked(apiFetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input), window.location.href)
    if (url.pathname.endsWith('/staff/schedule/lessons') && !init?.method) {
      if (url.searchParams.has('after_id')) {
        cursorReads += 1
        throw new ApiClientError('Cursor expired', 'invalid_cursor', 422)
      }
      firstPageReads += 1
      return {
        items: [lesson],
        next_after_id: firstPageReads === 1 ? 'expired-cursor' : null,
      } as never
    }
    return defaultImplementation(input, init) as never
  })
  mount('/staff/schedule?resource=group&resource_id=3&resource_name=ИВТ-21&date=2026-11-17')
  await screen.findByRole('heading', { name: 'Алгоритмы' })
  await user.click(screen.getByRole('button', { name: 'Показать ещё занятия' }))
  await waitFor(() => expect(firstPageReads).toBe(2))
  expect(cursorReads).toBe(1)
})

it('loads and saves a subgroup that exists only on a later catalog page', async () => {
  const user = userEvent.setup()
  const defaultImplementation = vi.mocked(apiFetch).getMockImplementation()!
  vi.mocked(apiFetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input), window.location.href)
    if (url.pathname.endsWith('/catalog/subgroups')) {
      return url.searchParams.has('after_id')
        ? ({ items: [{ id: '99', name: 'Подгруппа 51' }], next_after_id: null } as never)
        : ({
            items: Array.from({ length: 50 }, (_, index) => ({
              id: String(index + 1),
              name: `Подгруппа ${index + 1}`,
            })),
            next_after_id: '50',
          } as never)
    }
    return defaultImplementation(input, init) as never
  })
  mount()
  await user.selectOptions(await screen.findByLabelText('Выберите: группы'), '3')
  await user.click(screen.getByRole('button', { name: 'Добавить занятие' }))
  const dialog = screen.getByRole('dialog', { name: 'Добавить занятие' })
  await user.click(within(dialog).getByRole('combobox', { name: 'Дисциплина и проведение' }))
  await user.click(await within(dialog).findByRole('option', { name: /Алгоритмы/ }))
  await user.click(within(dialog).getByRole('combobox', { name: 'Группы' }))
  await user.click(await within(dialog).findByRole('option', { name: /^ИВТ-21$/ }))
  await user.click(within(dialog).getByLabelText('Вся группа'))
  await user.click(within(dialog).getByRole('button', { name: 'Показать ещё подгруппы' }))
  await user.click(await within(dialog).findByLabelText('Подгруппа 51'))
  await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
  await waitFor(() => expect(dialog).not.toBeInTheDocument())
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.some(
        ([url]) => new URL(String(url), window.location.href).searchParams.get('after_id') === '50',
      ),
  ).toBe(true)
  const create = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST')
  expect(JSON.parse(String(create?.[1]?.body)).participants).toEqual([
    { group_id: '3', subgroup_id: '99' },
  ])
})

it('reuses group-scoped catalog queries while adding twenty groups in sequence', async () => {
  const user = userEvent.setup()
  const defaultImplementation = vi.mocked(apiFetch).getMockImplementation()!
  vi.mocked(apiFetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input), window.location.href)
    if (url.pathname.endsWith('/catalog/groups'))
      return {
        items: Array.from({ length: 20 }, (_, index) => ({
          id: String(index + 1),
          name: `Группа ${index + 1}`,
        })),
        next_after_id: null,
      } as never
    return defaultImplementation(input, init) as never
  })
  mount()
  await user.selectOptions(await screen.findByLabelText('Выберите: группы'), '3')
  await user.click(screen.getByRole('button', { name: 'Добавить занятие' }))
  const dialog = screen.getByRole('dialog', { name: 'Добавить занятие' })
  await user.click(within(dialog).getByRole('combobox', { name: 'Дисциплина и проведение' }))
  await user.click(await within(dialog).findByRole('option', { name: /Алгоритмы/ }))
  await user.click(within(dialog).getByRole('combobox', { name: 'Группы' }))
  const groupPicker = within(dialog)
    .getByRole('combobox', { name: 'Группы' })
    .closest<HTMLElement>('.staff-schedule__picker')!
  const options = within(groupPicker).getAllByRole('option')
  expect(options).toHaveLength(20)
  for (const option of options) await user.click(option)
  await waitFor(() => {
    const calls = vi
      .mocked(apiFetch)
      .mock.calls.map(([url]) => new URL(String(url), window.location.href))
    expect(calls.filter((url) => url.pathname.endsWith('/catalog/subgroups'))).toHaveLength(20)
    expect(
      calls.filter((url) => url.pathname.endsWith('/catalog/teaching-assignments')),
    ).toHaveLength(20)
  })
  const calls = vi
    .mocked(apiFetch)
    .mock.calls.map(([url]) => new URL(String(url), window.location.href))
  const subgroupGroups = calls
    .filter((url) => url.pathname.endsWith('/catalog/subgroups'))
    .map((url) => url.searchParams.get('group_id'))
  const assignmentGroups = calls
    .filter((url) => url.pathname.endsWith('/catalog/teaching-assignments'))
    .map((url) => url.searchParams.get('group_id'))
  expect(new Set(subgroupGroups).size).toBe(20)
  expect(new Set(assignmentGroups).size).toBe(20)
})

it('keeps a teacher eligible when its teaching assignment is on a later catalog page', async () => {
  const user = userEvent.setup()
  const defaultImplementation = vi.mocked(apiFetch).getMockImplementation()!
  vi.mocked(apiFetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input), window.location.href)
    if (url.pathname.endsWith('/catalog/teaching-assignments'))
      return url.searchParams.has('after_id')
        ? ({
            items: [{ id: 'assignment-51', name: 'Иванов Иван', teacher_id: '7', group_id: '3' }],
            next_after_id: null,
          } as never)
        : ({
            items: Array.from({ length: 50 }, (_, index) => ({
              id: `assignment-${index + 1}`,
              name: 'Петров Пётр',
              teacher_id: '8',
              group_id: '3',
            })),
            next_after_id: '50',
          } as never)
    return defaultImplementation(input, init) as never
  })
  mount()
  await user.selectOptions(await screen.findByLabelText('Выберите: группы'), '3')
  await user.click(screen.getByRole('button', { name: 'Добавить занятие' }))
  const dialog = screen.getByRole('dialog', { name: 'Добавить занятие' })
  await user.click(within(dialog).getByRole('combobox', { name: 'Дисциплина и проведение' }))
  await user.click(await within(dialog).findByRole('option', { name: /Алгоритмы/ }))
  await user.click(within(dialog).getByRole('combobox', { name: 'Группы' }))
  await user.click(await within(dialog).findByRole('option', { name: /^ИВТ-21$/ }))
  await waitFor(() => {
    expect(
      vi
        .mocked(apiFetch)
        .mock.calls.some(
          ([url]) =>
            new URL(String(url), window.location.href).pathname.endsWith(
              '/catalog/teaching-assignments',
            ) && new URL(String(url), window.location.href).searchParams.get('after_id') === '50',
        ),
    ).toBe(true)
  })
  await user.click(within(dialog).getByRole('combobox', { name: 'Преподаватель' }))
  await user.click(await within(dialog).findByRole('option', { name: 'Иванов Иван' }))
  expect(within(dialog).getByRole('combobox', { name: 'Преподаватель' })).toHaveValue('Иванов Иван')
})

it('normalizes an impossible date in a direct URL to the current Moscow day', async () => {
  const { router } = mount('/staff/schedule?date=2026-02-30')
  expect(await screen.findByLabelText('Выбрать дату')).toHaveValue('2026-11-17')
  await waitFor(() => expect(router.state.location.search).toContain('date=2026-11-17'))
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

it.each([
  [401, 'Сессия завершилась. Войдите снова.'],
  [404, 'Запись не найдена или больше недоступна.'],
  [422, 'Проверьте заполнение полей и выбранный диапазон.'],
])('explains HTTP %i mutation failures without discarding the draft', async (status, message) => {
  const user = userEvent.setup()
  const defaultImplementation = vi.mocked(apiFetch).getMockImplementation()!
  vi.mocked(apiFetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input), window.location.href)
    if (url.pathname.endsWith('/staff/schedule/lessons/19') && init?.method === 'PATCH')
      throw new ApiClientError('Request rejected', 'request_rejected', status)
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
  expect(await within(dialog).findByText(message)).toBeInTheDocument()
  expect(start).toHaveValue('09:30')
})

it('keeps a network-failed mutation uncertain and never retries it automatically', async () => {
  const user = userEvent.setup()
  let patchCount = 0
  const defaultImplementation = vi.mocked(apiFetch).getMockImplementation()!
  vi.mocked(apiFetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input), window.location.href)
    if (url.pathname.endsWith('/staff/schedule/lessons/19') && init?.method === 'PATCH') {
      patchCount += 1
      throw new TypeError('connection lost after request')
    }
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
  expect(await within(dialog).findByText(/Результат операции неизвестен/)).toBeInTheDocument()
  expect(start).toHaveValue('09:30')
  expect(within(dialog).getByRole('button', { name: 'Перечитать данные' })).toBeInTheDocument()
  expect(patchCount).toBe(1)
  await user.click(within(dialog).getByRole('button', { name: 'Перечитать данные' }))
  await within(dialog).findByText(/Сверка завершена: показано текущее занятие/)
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.some(([url, init]) => String(url).endsWith('/lessons/19') && !init?.method),
  ).toBe(true)
  expect(patchCount).toBe(1)
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
  const current = {
    ...lesson,
    version: 4,
    starts_at: '2026-11-17T19:00:00+03:00',
    ends_at: '2026-11-17T20:30:00+03:00',
    kind: 'lab' as const,
  }
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
    within(dialog).getByRole('button', { name: 'Загрузить актуальную запись для сравнения' }),
  )
  expect(await within(dialog).findByText(/На сервере версия 4/)).toBeInTheDocument()
  expect(within(dialog).getAllByText('Дисциплина и проведение').length).toBeGreaterThan(1)
  expect(within(dialog).getAllByText('Преподаватель').length).toBeGreaterThan(1)
  expect(within(dialog).getAllByText('Участники').length).toBeGreaterThan(0)
  expect(within(dialog).getAllByText('Аудитории').length).toBeGreaterThan(1)
  expect(within(dialog).getAllByText('Лабораторная работа').length).toBeGreaterThan(1)
  expect(start).toHaveValue('20:15')
  await user.click(
    within(dialog).getByRole('button', {
      name: 'Я сравнил поля — показать подтверждение перезаписи',
    }),
  )
  await user.click(
    within(dialog).getByRole('button', { name: 'Подтвердить перезапись моим черновиком' }),
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

it('saves and reopens multiple subgroups from one group without collapsing the participant pairs', async () => {
  const user = userEvent.setup()
  mount()
  await user.selectOptions(await screen.findByLabelText('Выберите: группы'), '3')
  await user.click(screen.getByRole('button', { name: 'Добавить занятие' }))
  const dialog = screen.getByRole('dialog', { name: 'Добавить занятие' })
  await user.click(within(dialog).getByRole('combobox', { name: 'Дисциплина и проведение' }))
  await user.click(await within(dialog).findByRole('option', { name: /Алгоритмы/ }))
  await user.click(within(dialog).getByRole('combobox', { name: 'Группы' }))
  await user.click(await within(dialog).findByRole('option', { name: /^ИВТ-21$/ }))
  await user.click(within(dialog).getByLabelText('Вся группа'))
  await user.click(await within(dialog).findByLabelText('Подгруппа А'))
  await user.click(await within(dialog).findByLabelText('Подгруппа Б'))
  await user.click(within(dialog).getByRole('combobox', { name: 'Аудитории' }))
  await user.click(await within(dialog).findByRole('option', { name: /205/ }))
  await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
  await waitFor(() => expect(dialog).not.toBeInTheDocument())
  const create = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST')
  expect(JSON.parse(String(create?.[1]?.body)).participants).toEqual([
    { group_id: '3', subgroup_id: '31' },
    { group_id: '3', subgroup_id: '32' },
  ])

  // Reopen the returned lesson: both pairs must be selected and the whole-group checkbox off.
  const savedLesson = {
    ...lesson,
    participants: [
      { group_id: '3', subgroup_id: '31' },
      { group_id: '3', subgroup_id: '32' },
    ],
    display: {
      ...lesson.display,
      participants: [
        { group_id: '3', group_name: 'ИВТ-21', subgroup_id: '31', subgroup_name: 'Подгруппа А' },
        { group_id: '3', group_name: 'ИВТ-21', subgroup_id: '32', subgroup_name: 'Подгруппа Б' },
      ],
    },
  }
  scheduleResponse = { items: [savedLesson], next_after_id: null }
  const defaultImplementation = vi.mocked(apiFetch).getMockImplementation()!
  vi.mocked(apiFetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input), window.location.href)
    if (url.pathname.endsWith('/lessons/19') && !init?.method) return savedLesson as never
    return defaultImplementation(input, init) as never
  })
  await user.click(await screen.findByRole('button', { name: 'Изменить' }))
  const edit = await screen.findByRole('dialog', { name: 'Изменить занятие' })
  expect(within(edit).getByLabelText('Вся группа')).not.toBeChecked()
  expect(within(edit).getByLabelText('Подгруппа А')).toBeChecked()
  expect(within(edit).getByLabelText('Подгруппа Б')).toBeChecked()
})

it('supports the T1 to null to T2 teacher sequence without resetting other form fields', async () => {
  const user = userEvent.setup()
  let serverLesson = lesson
  const defaultImplementation = vi.mocked(apiFetch).getMockImplementation()!
  vi.mocked(apiFetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input), window.location.href)
    if (url.pathname.endsWith('/lessons/19') && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as components['schemas']['LessonWrite']
      serverLesson = {
        ...serverLesson,
        teacher_id: body.teacher_id,
        display: {
          ...serverLesson.display,
          teacher:
            body.teacher_id === '8'
              ? { id: '8', full_name: 'Петров Пётр' }
              : body.teacher_id === '7'
                ? { id: '7', full_name: 'Иванов Иван' }
                : null,
        },
      }
      return serverLesson as never
    }
    if (url.pathname.endsWith('/lessons/19') && !init?.method) return serverLesson as never
    if (url.pathname.endsWith('/staff/schedule/lessons'))
      return { items: [serverLesson], next_after_id: null } as never
    return defaultImplementation(input, init) as never
  })
  mount()
  await user.selectOptions(await screen.findByLabelText('Выберите: группы'), '3')
  await user.click(await screen.findByRole('button', { name: 'Изменить' }))
  let dialog = await screen.findByRole('dialog', { name: 'Изменить занятие' })
  await user.click(within(dialog).getByRole('button', { name: 'Убрать преподавателя' }))
  expect(within(dialog).getByRole('combobox', { name: 'Преподаватель' })).toHaveValue('')
  await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
  await waitFor(() => expect(dialog).not.toBeInTheDocument())
  expect(serverLesson.teacher_id).toBeNull()
  expect(serverLesson.participants).toEqual(lesson.participants)
  expect(serverLesson.room_ids).toEqual(lesson.room_ids)

  await user.click(await screen.findByRole('button', { name: 'Изменить' }))
  dialog = await screen.findByRole('dialog', { name: 'Изменить занятие' })
  await user.click(within(dialog).getByRole('combobox', { name: 'Преподаватель' }))
  await user.click(await within(dialog).findByRole('option', { name: 'Петров Пётр' }))
  await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
  await waitFor(() => expect(dialog).not.toBeInTheDocument())
  const patchBodies = vi
    .mocked(apiFetch)
    .mock.calls.filter(([, init]) => init?.method === 'PATCH')
    .map(([, init]) => JSON.parse(String(init?.body)))
  expect(patchBodies.map((body) => body.teacher_id)).toEqual([null, '8'])
  expect(serverLesson.display.teacher?.full_name).toBe('Петров Пётр')
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

it('shows cancel version conflicts in the dialog and requires a fresh explicit confirmation', async () => {
  const user = userEvent.setup()
  let cancelCount = 0
  const latest = { ...lesson, version: 4, kind: 'lab' as const }
  const defaultImplementation = vi.mocked(apiFetch).getMockImplementation()!
  vi.mocked(apiFetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input), window.location.href)
    if (url.pathname.endsWith('/lessons/19/cancel') && init?.method === 'POST') {
      cancelCount += 1
      if (cancelCount === 1) throw new ApiClientError('Version changed', 'version_conflict', 409)
      return { ...latest, status: 'cancelled' } as never
    }
    if (url.pathname.endsWith('/lessons/19') && !init?.method) return latest as never
    return defaultImplementation(input, init) as never
  })
  mount()
  await user.selectOptions(await screen.findByLabelText('Выберите: группы'), '3')
  await user.click(await screen.findByRole('button', { name: 'Отменить' }))
  const dialog = screen.getByRole('dialog', { name: 'Отменить занятие?' })
  await user.click(within(dialog).getByRole('button', { name: 'Подтвердить отмену' }))
  expect(await within(dialog).findByText(/уже изменил другой сотрудник/)).toBeInTheDocument()
  await user.click(within(dialog).getByRole('button', { name: 'Перечитать состояние занятия' }))
  expect(await within(dialog).findByText(/На сервере: версия 4/)).toBeInTheDocument()
  expect(within(dialog).getByText('Лабораторная работа')).toBeInTheDocument()
  expect(cancelCount).toBe(1)
  await user.click(
    within(dialog).getByRole('button', {
      name: 'Использовать актуальную версию для нового подтверждения',
    }),
  )
  await user.click(within(dialog).getByRole('button', { name: 'Подтвердить отмену' }))
  await waitFor(() => expect(dialog).not.toBeInTheDocument())
  expect(cancelCount).toBe(2)
})

it('hides the cancel dialog and schedule data immediately when the server revokes permission', async () => {
  const user = userEvent.setup()
  const defaultImplementation = vi.mocked(apiFetch).getMockImplementation()!
  vi.mocked(apiFetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input), window.location.href)
    if (url.pathname.endsWith('/lessons/19/cancel') && init?.method === 'POST')
      throw new ApiClientError('Forbidden', 'forbidden', 403)
    return defaultImplementation(input, init) as never
  })
  mount()
  await user.selectOptions(await screen.findByLabelText('Выберите: группы'), '3')
  await user.click(await screen.findByRole('button', { name: 'Отменить' }))
  const dialog = screen.getByRole('dialog', { name: 'Отменить занятие?' })
  await user.click(within(dialog).getByRole('button', { name: 'Подтвердить отмену' }))
  expect(await screen.findByText('Доступ запрещён')).toBeInTheDocument()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.queryByText('Алгоритмы')).not.toBeInTheDocument()
})
