import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '../../app/queryClient'
import { ApiClientError, apiFetch } from '../../shared/api/client'
import { SchedulePage } from './SchedulePage'
import { createLesson } from './testFixtures'
import { PREFERENCE_SAVE_DEADLINE_MS } from './useSchedulePreferences'

vi.mock('../../shared/api/client', async (original) => ({
  ...(await original<typeof import('../../shared/api/client')>()),
  apiFetch: vi.fn(),
}))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
})
const cancelled = createLesson({
  id: '3',
  status: 'cancelled',
  starts_at: '2026-11-10T08:00:00Z',
  ends_at: '2026-11-10T09:00:00Z',
})
const items = [
  createLesson(),
  cancelled,
  createLesson({ id: '2', starts_at: '2026-11-10T10:00:00Z', ends_at: '2026-11-10T11:00:00Z' }),
]
function mount(
  show = true,
  failRead = false,
  failSave = false,
  lessons = items,
  setupTransport = true,
) {
  vi.setSystemTime(new Date('2026-11-10T08:00:00Z'))
  if (setupTransport)
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).includes('/preferences')) {
        if (init?.method === 'PATCH') {
          if (failSave) throw new Error('save failed')
          return JSON.parse(String(init.body))
        }
        if (failRead) throw new Error('read failed')
        return { show_cancelled_lessons: show }
      }
      return { items: lessons }
    })
  const queryClient = createQueryClient()
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SchedulePage />
    </QueryClientProvider>,
  )
  return { queryClient, ...view }
}
it('shares the saved switch between dates and modes without changing gaps or moved rows', async () => {
  mount(true, false, false, [...items, createLesson({ id: '4', status: 'moved' })])
  const toggle = screen.getByRole('checkbox', { name: 'Показывать отменённые' })
  await waitFor(() => expect(toggle).toBeEnabled())
  expect(screen.getByText('Окно · 2 ч 30 мин')).toBeInTheDocument()
  fireEvent.click(toggle)
  await waitFor(() => expect(toggle).not.toBeChecked())
  expect(document.querySelectorAll('.lesson-card--cancelled')).toHaveLength(0)
  expect(document.querySelectorAll('.lesson-card--moved')).toHaveLength(1)
  expect(screen.getByText('Окно · 2 ч 30 мин')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Неделя' }))
  expect(toggle).not.toBeChecked()
  fireEvent.change(screen.getByLabelText('Дата'), { target: { value: '2026-11-11' } })
  expect(toggle).not.toBeChecked()
})
it('restores the confirmed switch and reports a failed save', async () => {
  mount(true, false, true)
  const toggle = screen.getByRole('checkbox')
  await waitFor(() => expect(toggle).toBeEnabled())
  fireEvent.click(toggle)
  expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось сохранить')
  expect(toggle).toBeChecked()
  expect(document.querySelectorAll('.lesson-card--cancelled')).toHaveLength(1)
})
it('reports read errors and prevents overwriting an unknown preference', async () => {
  mount(true, true)
  expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось загрузить')
  expect(screen.getByRole('checkbox')).toBeDisabled()
  expect(screen.getByRole('checkbox')).toBePartiallyChecked()
  expect(document.querySelectorAll('.lesson-card--cancelled')).toHaveLength(0)
  expect(document.querySelectorAll('.lesson-card--scheduled')).toHaveLength(2)
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
  vi.mocked(apiFetch).mockResolvedValueOnce({ show_cancelled_lessons: false })
  fireEvent.click(screen.getByRole('button', { name: 'Повторить загрузку настройки' }))
  await waitFor(() => expect(screen.getByRole('checkbox')).toBeEnabled())
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})
it('temporarily reveals a hidden cancelled transfer destination and focuses it', async () => {
  const source = createLesson({
    id: '5',
    status: 'moved',
    latest_lesson: {
      id: cancelled.id,
      starts_at: cancelled.starts_at,
      ends_at: cancelled.ends_at,
      status: 'cancelled',
    },
  })
  mount(false, false, false, [...items, source])
  await waitFor(() => expect(screen.getByRole('checkbox')).toBeEnabled())
  expect(document.querySelectorAll('.lesson-card--cancelled')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: /Перенесено на/ }))
  await waitFor(() =>
    expect(document.activeElement).toHaveAttribute('data-lesson-id', cancelled.id),
  )
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PATCH'),
  ).toHaveLength(0)
  fireEvent.change(screen.getByLabelText('Дата'), { target: { value: '2026-11-11' } })
  fireEvent.change(screen.getByLabelText('Дата'), { target: { value: '2026-11-10' } })
  expect(document.querySelectorAll('.lesson-card--cancelled')).toHaveLength(0)
})

it('shows the empty-day row when the only cancelled lesson is hidden', async () => {
  mount(false, false, false, [cancelled])
  await waitFor(() => expect(screen.getByRole('checkbox')).toBeEnabled())
  const day = document.querySelector('.schedule-day.is-selected')!
  expect(day).toHaveTextContent('Занятий нет')
  expect(day.querySelector('.schedule-gap')).toBeNull()
})

function installDelayedRead() {
  let finish!: (value: unknown) => void
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    String(url).includes('/preferences')
      ? new Promise((resolve) => {
          finish = resolve
        })
      : { items },
  )
  mount(true, false, false, items, false)
  return (show: boolean) =>
    act(async () => {
      finish({ show_cancelled_lessons: show })
    })
}

it.each([false, true])(
  'keeps a delayed preference unknown without revealing cancellations, then restores %s',
  async (show) => {
    const finish = installDelayedRead()
    await screen.findByText('Окно · 2 ч 30 мин')
    expect(screen.getByRole('checkbox')).toBePartiallyChecked()
    expect(screen.getByRole('checkbox')).toBeDisabled()
    expect(document.querySelectorAll('.lesson-card--cancelled')).toHaveLength(0)
    expect(document.querySelectorAll('.lesson-card--scheduled')).toHaveLength(2)
    await finish(show)
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeEnabled())
    expect(screen.getByRole('checkbox')).toHaveProperty('checked', show)
    expect(screen.getByRole('checkbox')).not.toBePartiallyChecked()
    expect(screen.getByRole('checkbox')).toBeEnabled()
    expect(document.querySelectorAll('.lesson-card--cancelled')).toHaveLength(show ? 1 : 0)
  },
)

it.each(['timeout', 'network'] as const)(
  'reconciles an uncertain %s without retrying PATCH or claiming that a GET rules out a late commit',
  async (fault) => {
    vi.useFakeTimers()
    let serverValue = false
    let finishOldPatch!: (value: unknown) => void
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (!String(url).includes('/preferences')) return { items }
      if (init?.method === 'PATCH') {
        if (fault === 'network') throw new ApiClientError('lost response', 'network_error')
        return new Promise((resolve) => {
          finishOldPatch = resolve
        })
      }
      return { show_cancelled_lessons: serverValue }
    })
    await act(async () => mount(true, false, false, items, false))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(screen.getByRole('checkbox')).toBeEnabled()
    await act(async () => fireEvent.click(screen.getByRole('checkbox')))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    if (fault === 'timeout') {
      expect(screen.getByRole('checkbox')).toBeDisabled()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PREFERENCE_SAVE_DEADLINE_MS + 10)
      })
    }
    expect(screen.getByRole('alert')).toHaveTextContent('Предыдущий запрос ещё может завершиться')
    expect(screen.getByRole('alert')).not.toHaveTextContent('Восстановлено')
    expect(screen.getByRole('checkbox')).toBeEnabled()
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    const countPatches = () =>
      vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PATCH').length
    expect(countPatches()).toBe(1)
    // The first GET observed false, but the old server write can commit later.
    serverValue = true
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Проверить настройку' })),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(screen.getByRole('checkbox')).toBeChecked()
    expect(screen.getByRole('alert')).toHaveTextContent('Не удалось подтвердить сохранение')
    if (finishOldPatch) await act(async () => finishOldPatch({ show_cancelled_lessons: false }))
    expect(screen.getByRole('checkbox')).toBeChecked()
    serverValue = false
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(countPatches()).toBe(1)
  },
)

it('does not transfer a timed-out old-account mutation into the next account cache', async () => {
  vi.useFakeTimers()
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (init?.method === 'PATCH') return new Promise(() => {}) // Deliberately ignores cancellation.
    return String(url).includes('/preferences') ? { show_cancelled_lessons: false } : { items }
  })
  let view!: ReturnType<typeof mount>
  await act(async () => {
    view = mount(true, false, false, items, false)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  await act(async () => fireEvent.click(screen.getByRole('checkbox')))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  view.unmount()
  view.queryClient.clear() // The existing AuthSession account-change boundary.
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    String(url).includes('/preferences') ? { show_cancelled_lessons: true } : { items },
  )
  await act(async () => {
    render(
      <QueryClientProvider client={view.queryClient}>
        <SchedulePage />
      </QueryClientProvider>,
    )
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PREFERENCE_SAVE_DEADLINE_MS + 10)
  })
  expect(screen.getByRole('checkbox')).toBeChecked()
  expect(screen.getByRole('checkbox')).toBeEnabled()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(view.queryClient.getQueryData(['user-preferences'])).toMatchObject({
    hasUncertainSave: false,
  })
})

it('keeps transfer focus available while the preference read has failed', async () => {
  const source = createLesson({
    id: '5',
    status: 'moved',
    latest_lesson: {
      id: cancelled.id,
      starts_at: cancelled.starts_at,
      ends_at: cancelled.ends_at,
      status: 'cancelled',
    },
  })
  mount(false, true, false, [...items, source])
  await screen.findByRole('alert')
  expect(screen.getByRole('checkbox')).toBePartiallyChecked()
  expect(document.querySelector('.lesson-card--cancelled')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Перенесено на/ }))
  await waitFor(() =>
    expect(document.activeElement).toHaveAttribute('data-lesson-id', cancelled.id),
  )
  expect(screen.getByRole('checkbox')).toBePartiallyChecked()
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
})

it('offers read recovery when reconciliation fails after a timed-out PATCH', async () => {
  vi.useFakeTimers()
  let canRead = true
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (!String(url).includes('/preferences')) return { items }
    if (init?.method === 'PATCH') return new Promise(() => {})
    if (!canRead) throw new ApiClientError('read failed', 'internal_error', 500)
    return { show_cancelled_lessons: false }
  })
  await act(async () => mount(true, false, false, items, false))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  canRead = false
  await act(async () => fireEvent.click(screen.getByRole('checkbox')))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PREFERENCE_SAVE_DEADLINE_MS + 10)
  })
  expect(screen.getByRole('checkbox')).toBeDisabled()
  expect(screen.getByRole('checkbox')).toBePartiallyChecked()
  expect(screen.getByText(/Предыдущий запрос ещё может завершиться/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Проверить настройку' })).toBeEnabled()
  canRead = true
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Проверить настройку' })),
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  expect(screen.getByRole('checkbox')).toBeEnabled()
  expect(screen.getByRole('checkbox')).not.toBePartiallyChecked()
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  expect(screen.getByRole('alert')).toHaveTextContent('Предыдущий запрос ещё может завершиться')
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PATCH'),
  ).toHaveLength(1)
})
