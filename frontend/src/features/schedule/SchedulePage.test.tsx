import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { focusManager, onlineManager, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '../../app/queryClient'
import { ApiClientError, apiFetch } from '../../shared/api/client'
import { SchedulePage } from './SchedulePage'
import { createLesson } from './testFixtures'
import type { components } from '../../shared/api/schema'

vi.mock('../../shared/api/client', async (original) => ({
  ...(await original<typeof import('../../shared/api/client')>()),
  apiFetch: vi.fn(),
}))
const request = vi.mocked(apiFetch)
const response = (items = [createLesson()]): components['schemas']['ScheduleResponse'] => ({
  date_from: '2026-11-09',
  date_to: '2026-11-15',
  timezone: 'Europe/Moscow',
  items,
})
function renderSchedule() {
  const queryClient = createQueryClient()
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SchedulePage />
    </QueryClientProvider>,
  )
  return { queryClient, ...view }
}
beforeEach(() => {
  vi.setSystemTime(new Date('2026-11-10T08:00:00Z'))
  request.mockReset()
  focusManager.setFocused(true)
  onlineManager.setOnline(true)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  focusManager.setFocused(undefined)
  onlineManager.setOnline(true)
})

it('loads the Moscow week, renders known details once and provides no dead discipline links', async () => {
  request.mockResolvedValue(
    response([
      createLesson({
        teacher: { id: '2', name: 'Вымышленный преподаватель' },
        rooms: [
          { id: '1', name: '101', building: { id: '1', name: 'Корпус А' } },
          { id: '2', name: '202', building: { id: '2', name: 'Корпус Б' } },
        ],
      }),
    ]),
  )
  renderSchedule()
  const card = await screen.findByRole('article')
  expect(card.querySelector('.lesson-card__time')).toHaveTextContent(/^09:00 — 10:30$/)
  expect(screen.getByRole('article')).toHaveTextContent('Корпус А · 101')
  expect(screen.getByRole('article')).toHaveTextContent('Корпус Б · 202')
  expect(screen.getByRole('article')).toHaveTextContent('Вымышленный преподаватель')
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
  expect(request).toHaveBeenCalledWith('/api/v1/schedule?date_from=2026-11-09&date_to=2026-11-15', {
    authenticated: true,
    signal: expect.any(AbortSignal),
  })
})

it('shows the selected ISO week and wide day headings above the lesson cards', async () => {
  request.mockResolvedValue(response([createLesson()]))
  renderSchedule()
  expect(await screen.findByRole('article')).toBeInTheDocument()
  expect(screen.getByText('Неделя 46 · 9–15 ноября')).toBeInTheDocument()
  const section = screen.getByRole('region', { name: 'вторник, 10 ноября' })
  expect(within(section).getByRole('heading', { name: /вторник, 10 ноября/i })).toBeInTheDocument()
  expect(within(section).getByRole('article')).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Дата'), { target: { value: '2026-12-31' } })
  expect(await screen.findByText('Неделя 53 · 28 декабря – 3 января 2027')).toBeInTheDocument()
})

it('supports Sunday, date selection, week arrows, today and keyboard mode selection', async () => {
  request.mockResolvedValue(response([]))
  renderSchedule()
  await screen.findAllByText('Занятий нет')
  const user = userEvent.setup()
  const sunday = within(screen.getByRole('group', { name: 'Дни недели' })).getAllByRole(
    'button',
  )[6]!
  await user.click(sunday)
  expect(sunday).toHaveAttribute('aria-pressed', 'true')
  fireEvent.change(screen.getByLabelText('Дата'), { target: { value: '2026-12-31' } })
  await waitFor(() =>
    expect(request).toHaveBeenLastCalledWith(
      '/api/v1/schedule?date_from=2026-12-28&date_to=2027-01-03',
      expect.anything(),
    ),
  )
  await user.click(screen.getByRole('button', { name: 'Следующая неделя' }))
  await waitFor(() =>
    expect(request).toHaveBeenLastCalledWith(
      '/api/v1/schedule?date_from=2027-01-04&date_to=2027-01-10',
      expect.anything(),
    ),
  )
  await user.click(screen.getByRole('button', { name: 'Сегодня' }))
  expect(screen.getByLabelText('Дата')).toHaveValue('2026-11-10')
  const week = screen.getByRole('button', { name: 'Неделя' })
  week.focus()
  await user.keyboard('{Enter}')
  expect(week).toHaveAttribute('aria-pressed', 'true')
})

it('shows skeletons, nullable details, overnight duplicates by date, and cancelled/moved states', async () => {
  let finish!: (value: unknown) => void
  request.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  renderSchedule()
  expect(screen.getByRole('status')).toHaveTextContent('Загружаем расписание')
  await act(async () => {
    finish(
      response([
        createLesson({ starts_at: '2026-11-10T20:30:00Z', ends_at: '2026-11-10T21:30:00Z' }),
        createLesson({ id: '2', status: 'cancelled' }),
        createLesson({
          id: '3',
          status: 'moved',
          latest_lesson: {
            id: '4',
            starts_at: '2026-12-20T06:00:00Z',
            ends_at: '2026-12-20T07:00:00Z',
            status: 'scheduled',
          },
        }),
      ]),
    )
  })
  expect(await screen.findAllByRole('article')).toHaveLength(4)
  expect(screen.getAllByText('Преподаватель не указан')).toHaveLength(2)
  for (const card of screen.getAllByRole('article')) {
    if (card.classList.contains('lesson-card--scheduled')) continue
    expect(card.querySelector('.lesson-card__kind')).toBeNull()
    expect(card.querySelector('.lesson-card__teacher')).toBeNull()
    expect(within(card).queryByText('Аудитория не указана')).not.toBeInTheDocument()
  }
  expect(screen.getByText('Отменено')).toBeInTheDocument()
  expect(screen.getByText('Отменено')).toHaveClass('lesson-card__status--cancelled')
  expect(screen.getByText(/Перенесено на/)).toHaveTextContent('09:00')
  expect(screen.getByText(/Перенесено на/)).toHaveClass('lesson-card__status--moved')
})

it.each([
  [new ApiClientError('private', 'forbidden', 403), 'Нет доступа к расписанию', false],
  [new ApiClientError('private', 'invalid_access', 401), 'Сессия завершена', false],
  [new ApiClientError('private', 'network_error'), 'Не удалось загрузить расписание', true],
  [new ApiClientError('private', 'internal_error', 500), 'Не удалось загрузить расписание', true],
  [new ApiClientError('private', 'validation_error', 422), 'Не удалось загрузить расписание', true],
])('distinguishes errors and never shows an empty result: %s', async (error, title, retry) => {
  request.mockRejectedValue(error)
  renderSchedule()
  expect(await screen.findByRole('alert')).toHaveTextContent(title)
  expect(screen.queryByText('Занятий нет')).not.toBeInTheDocument()
  expect(screen.queryByText('private')).not.toBeInTheDocument()
  expect(request).toHaveBeenCalledTimes(1)
  if (retry) {
    request.mockResolvedValue(response([]))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Повторить' }))
    expect(await screen.findAllByText('Занятий нет')).toHaveLength(7)
  } else expect(screen.queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument()
})

it('cancels pending previous week requests and removes private cache on session cleanup', async () => {
  request.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(response([]))
  const { queryClient, unmount } = renderSchedule()
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1))
  const oldSignal = request.mock.calls[0]![1]!.signal!
  await userEvent.setup().click(screen.getByRole('button', { name: 'Следующая неделя' }))
  await waitFor(() => expect(oldSignal.aborted).toBe(true))
  await screen.findAllByText('Занятий нет')
  unmount()
  await queryClient.cancelQueries()
  queryClient.clear()
  expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
})

it.each(['focus', 'reconnect'] as const)(
  'refreshes stale schedule on %s using local query options',
  async (event) => {
    request.mockResolvedValueOnce(response()).mockResolvedValue(
      response([
        createLesson({
          course_offering: { id: '1', discipline: { id: '1', name: 'Изменённое расписание' } },
        }),
      ]),
    )
    const { queryClient } = renderSchedule()
    await screen.findByRole('article', { name: 'Вымышленная дисциплина' })
    // These remain disabled globally; only schedule opts into refreshing.
    expect(queryClient.getDefaultOptions().queries).toMatchObject({
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: false,
      retryOnMount: false,
    })
    act(() => {
      if (event === 'focus') {
        focusManager.setFocused(false)
        focusManager.setFocused(true)
      } else {
        onlineManager.setOnline(false)
        onlineManager.setOnline(true)
      }
    })
    expect(
      await screen.findByRole('article', { name: 'Изменённое расписание' }),
    ).toBeInTheDocument()
    expect(request).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: 'Обновить' })).not.toBeInTheDocument()
  },
)

it('shows both Moscow dates and times for the same overnight lesson on adjacent days', async () => {
  request.mockResolvedValue(
    response([
      createLesson({ starts_at: '2026-11-10T20:30:00Z', ends_at: '2026-11-10T21:30:00Z' }),
    ]),
  )
  const { container } = renderSchedule()
  await screen.findAllByRole('article')
  for (const day of ['2026-11-10', '2026-11-11']) {
    fireEvent.change(screen.getByLabelText('Дата'), { target: { value: day } })
    const card = within(
      container.querySelector('.schedule-day.is-selected')! as HTMLElement,
    ).getByRole('article')
    const times = card.querySelectorAll('time')
    expect(times[0]).toHaveAttribute('datetime', '2026-11-10T20:30:00Z')
    expect(times[0]).toHaveTextContent('вторник, 10 ноября, 23:30')
    expect(times[1]).toHaveAttribute('datetime', '2026-11-10T21:30:00Z')
    expect(times[1]).toHaveTextContent('среда, 11 ноября, 00:30')
  }
})

it.each(['day', 'week'] as const)(
  'navigates by keyboard to the Moscow start date across years preserving %s mode',
  async (mode) => {
    const latest = {
      id: '30',
      starts_at: '2027-01-02T21:30:00Z',
      ends_at: '2027-01-03T00:30:00Z',
      status: 'scheduled' as const,
    }
    const a = createLesson({ id: '10', status: 'moved', latest_lesson: latest })
    const b = createLesson({ id: '20', status: 'moved', latest_lesson: latest, previous_lesson: a })
    const c = createLesson({ ...latest, previous_lesson: b })
    request.mockImplementation(async (url) =>
      String(url).includes('2026-12-28') ? response([c]) : response([a, b]),
    )
    const { container } = renderSchedule()
    await screen.findAllByRole('article')
    if (mode === 'week')
      await userEvent.setup().click(screen.getByRole('button', { name: 'Неделя' }))
    const source = screen.getAllByRole('article')[0]!
    expect(within(source).getByText(/Перенесено на/)).toHaveTextContent('3 января 2027 г., 00:30')
    const action = within(source).getByRole('button', { name: 'Показать конечную позицию' })
    action.focus()
    await userEvent.setup().keyboard('{Enter}')
    await waitFor(() => expect(screen.getByLabelText('Дата')).toHaveValue('2027-01-03'))
    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith(
        '/api/v1/schedule?date_from=2026-12-28&date_to=2027-01-03',
        expect.anything(),
      ),
    )
    const target = await screen.findByRole('article')
    await waitFor(() => expect(target).toHaveFocus())
    expect(target).toHaveClass('lesson-card--scheduled')
    expect(within(target).queryByText(/Перенесено/)).not.toBeInTheDocument()
    expect(within(target).getByText('Преподаватель не указан')).toBeInTheDocument()
    expect(container.querySelector('.schedule-page')).toHaveClass(`schedule-page--${mode}`)
  },
)

it('shows cancelled terminal positions explicitly and never invents unavailable relationships', async () => {
  const latest = {
    id: '3',
    starts_at: '2026-12-20T06:00:00Z',
    ends_at: '2026-12-20T07:00:00Z',
    status: 'cancelled' as const,
  }
  request.mockResolvedValue(
    response([
      createLesson({ id: '1', status: 'moved', latest_lesson: latest }),
      createLesson({ id: '2', status: 'moved', latest_lesson: latest }),
      createLesson({ id: '4', status: 'moved', latest_lesson: null, previous_lesson: null }),
      createLesson({ id: '5', status: 'cancelled', previous_lesson: null }),
    ]),
  )
  renderSchedule()
  const cards = await screen.findAllByRole('article')
  for (const card of cards.slice(0, 2)) {
    expect(within(card).getByText(/Перенесено на/)).toHaveTextContent('09:00 · Отменено')
    expect(card).toHaveClass('lesson-card--moved')
  }
  expect(within(cards[2]!).getByText('Перенесено')).toBeInTheDocument()
  expect(within(cards[2]!).queryByRole('button')).not.toBeInTheDocument()
  expect(within(cards[3]!).getByText('Отменено')).toBeInTheDocument()
  expect(within(cards[3]!).queryByText(/Перенесено/)).not.toBeInTheDocument()
  expect(screen.queryByText('Неактуально')).not.toBeInTheDocument()
})

it('focuses a single move target within the same day without reloading the week', async () => {
  const a = createLesson({ id: '1', status: 'moved' })
  const b = createLesson({ id: '2', starts_at: '2026-11-10T10:00:00Z', previous_lesson: a })
  a.latest_lesson = b
  request.mockResolvedValue(response([a, b]))
  renderSchedule()
  await screen.findAllByRole('article')
  await userEvent.setup().click(screen.getByRole('button', { name: 'Показать конечную позицию' }))
  expect(screen.getAllByRole('article')[1]).toHaveFocus()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Показать конечную позицию' }))
  expect(screen.getAllByRole('article')[1]).toHaveFocus()
  expect(request).toHaveBeenCalledTimes(1)
})
