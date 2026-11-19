import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '../../app/queryClient'
import { apiFetch, ApiClientError } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'
import { TeacherSchedulePage } from './TeacherSchedulePage'

vi.mock('../../shared/api/client', async (original) => ({
  ...(await original<typeof import('../../shared/api/client')>()),
  apiFetch: vi.fn(),
}))
vi.mock('../auth/RoleContext', () => ({
  useRoleContext: () => ({
    user_id: 'teacher-a',
    role: 'teacher',
    permissions: [],
    org_unit_id: null,
  }),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const response: components['schemas']['TeacherScheduleResponse'] = {
  date_from: '2026-11-10',
  date_to: '2026-11-10',
  timezone: 'Europe/Moscow',
  items: [
    {
      id: '31',
      starts_at: '2026-11-10T06:00:00Z',
      ends_at: '2026-11-10T07:30:00Z',
      kind: 'seminar',
      status: 'moved',
      course_offering: { id: '11', discipline: { id: '5', name: 'Алгебра' } },
      groups: [{ id: '21', name: 'М-101', subgroup: { id: '4', name: 'А' } }],
      rooms: [{ id: '9', name: '204', building: { id: '8', name: 'Корпус 1' } }],
      previous_lesson: null,
      latest_lesson: null,
    },
  ],
}

it('loads the teacher schedule and safely renders a moved lesson', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response)
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/teacher/schedule?date=2026-11-10&mode=day']}>
        <TeacherSchedulePage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  expect(await screen.findByText('Алгебра')).toBeInTheDocument()
  expect(screen.getByText('М-101 · А')).toBeInTheDocument()
  expect(screen.getByText('Корпус 1, 204')).toBeInTheDocument()
  expect(screen.getByText('Перенесено')).toBeInTheDocument()
  expect(apiFetch).toHaveBeenCalledWith(
    expect.stringContaining('/api/v1/teaching/schedule?date_from=2026-11-10&date_to=2026-11-10'),
    expect.objectContaining({ authenticated: true, cache: 'no-store' }),
  )
})

it('shows a forbidden response safely and retries only the read request', async () => {
  vi.mocked(apiFetch)
    .mockRejectedValueOnce(new ApiClientError('Запрещено', 'forbidden', 403))
    .mockResolvedValueOnce({ ...response, items: [] })
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/teacher/schedule?date=2026-11-10&mode=day']}>
        <TeacherSchedulePage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  expect(await screen.findByRole('alert')).toHaveTextContent('Доступ запрещён')
  await userEvent.click(screen.getByRole('button', { name: 'Повторить' }))
  expect(await screen.findByText('Занятий нет')).toBeInTheDocument()
  expect(apiFetch).toHaveBeenCalledTimes(2)
})

it('orders same-time lessons by numeric ID', async () => {
  const lessonTen = {
    ...response.items[0],
    id: '10',
    course_offering: {
      ...response.items[0].course_offering,
      discipline: { id: '20', name: 'Урок десять' },
    },
  }
  const lessonTwo = {
    ...response.items[0],
    id: '2',
    course_offering: {
      ...response.items[0].course_offering,
      discipline: { id: '21', name: 'Урок два' },
    },
  }
  vi.mocked(apiFetch).mockResolvedValue({ ...response, items: [lessonTen, lessonTwo] })
  const rendered = render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/teacher/schedule?date=2026-11-10&mode=day']}>
        <TeacherSchedulePage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  await screen.findByText('Урок два')
  expect(
    [...rendered.container.querySelectorAll('.teacher-lesson-title')].map(
      (element) => element.textContent,
    ),
  ).toEqual(['Урок два', 'Урок десять'])
})
