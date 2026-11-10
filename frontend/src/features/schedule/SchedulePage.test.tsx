import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
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
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
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
  expect(await screen.findByRole('article')).toHaveTextContent('09:00 — 10:30')
  expect(screen.getByRole('article')).toHaveTextContent('Корпус А · 101')
  expect(screen.getByRole('article')).toHaveTextContent('Корпус Б · 202')
  expect(screen.getByRole('article')).toHaveTextContent('Вымышленный преподаватель')
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
  expect(request).toHaveBeenCalledWith('/api/v1/schedule?date_from=2026-11-09&date_to=2026-11-15', {
    authenticated: true,
    signal: expect.any(AbortSignal),
  })
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
  expect(screen.getAllByText('Преподаватель не указан')).toHaveLength(4)
  expect(screen.getByText('Отменено')).toBeInTheDocument()
  expect(screen.getByText(/Перенесено на/)).toHaveTextContent('09:00')
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
