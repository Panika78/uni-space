import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '../../app/queryClient'
import { apiFetch } from '../../shared/api/client'
import { SchedulePage } from './SchedulePage'
import { createLesson } from './testFixtures'

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
function mount(show = true, failRead = false, failSave = false, lessons = items) {
  vi.setSystemTime(new Date('2026-11-10T08:00:00Z'))
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
  render(
    <QueryClientProvider client={createQueryClient()}>
      <SchedulePage />
    </QueryClientProvider>,
  )
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
