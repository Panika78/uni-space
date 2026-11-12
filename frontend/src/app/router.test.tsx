import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { createQueryClient } from './queryClient'
import { appRoutes } from './router'
import { apiFetch, ApiClientError } from '../shared/api/client'
import type { components } from '../shared/api/schema'
import { createLesson } from '../features/schedule/testFixtures'
import type { RouteObject } from 'react-router-dom'

const auth = vi.hoisted(() => ({
  status: 'unauthenticated' as 'initializing' | 'authenticated' | 'unauthenticated',
  message: '',
  busy: false,
  login: vi.fn(),
  logout: vi.fn(),
}))

vi.mock('../features/auth/AuthProvider', () => ({ useAuth: () => auth }))
vi.mock('../shared/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/api/client')>()),
  apiFetch: vi.fn(),
}))

const profile: components['schemas']['StudentProfile'] = {
  id: '1',
  student_id: '11',
  login: 'fictional-student',
  full_name: 'Тестовый Студент',
  group: { id: '21', name: 'ТЕСТ-1' },
  program: { id: '31', code: '01', name: 'Вымышленная программа' },
  faculty: { id: '41', name: 'Вымышленный факультет' },
  direction: { code: '01.01', name: 'Вымышленное направление' },
  course_number: 1,
  academic_status: 'enrolled',
}
const schedule: components['schemas']['ScheduleResponse'] = {
  date_from: '2026-11-09',
  date_to: '2026-11-15',
  timezone: 'Europe/Moscow',
  items: [createLesson({ groups: [profile.group] })],
}
beforeEach(() => {
  vi.setSystemTime(new Date('2026-11-10T08:00:00Z'))
  vi.mocked(apiFetch).mockImplementation((input) => {
    const url = new URL(String(input), window.location.href)
    if (url.pathname === '/api/v1/users/me' && !url.search) return Promise.resolve(profile)
    if (url.pathname === '/api/v1/notifications')
      return Promise.resolve({ items: [], next_cursor: null })
    if (
      url.pathname === '/api/v1/schedule' &&
      url.searchParams.has('date_from') &&
      url.searchParams.has('date_to') &&
      [...url.searchParams.keys()].every((key) => key === 'date_from' || key === 'date_to')
    ) {
      return Promise.resolve(schedule)
    }
    throw new Error(`Unexpected test API URL: ${url.pathname}`)
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.mocked(apiFetch).mockReset()
  auth.status = 'unauthenticated'
  auth.message = ''
  auth.busy = false
  auth.login.mockReset()
  auth.logout.mockReset()
})

function renderRouter(path: string) {
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] })
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('route fallbacks', () => {
  it('shows a branded 404 and sends an anonymous user to login without rendering protected UI', async () => {
    auth.status = 'unauthenticated'
    renderRouter('/unknown-page')
    expect(await screen.findByRole('heading', { name: 'Страница не найдена' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Перейти ко входу' })).toHaveAttribute('href', '/login')
    expect(screen.queryByRole('navigation', { name: 'Разделы кабинета' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Расписание' })).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('link', { name: 'Перейти ко входу' }))
    expect(await screen.findByRole('heading', { name: 'Вход в систему' })).toBeInTheDocument()
  })

  it('shows a 404 for a nested invalid path and returns an authenticated user to schedule', async () => {
    auth.status = 'authenticated'
    renderRouter('/schedule/nonexistent')
    expect(await screen.findByRole('heading', { name: 'Страница не найдена' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Вернуться к расписанию' })).toHaveAttribute(
      'href',
      '/schedule',
    )
    expect(screen.queryByRole('navigation', { name: 'Разделы кабинета' })).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('link', { name: 'Вернуться к расписанию' }))
    expect(await screen.findByRole('heading', { name: 'Расписание' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Разделы кабинета' })).toBeInTheDocument()
  })

  it.each([
    ['authenticated', 'Вернуться к расписанию', '/schedule'],
    ['unauthenticated', 'Перейти ко входу', '/login'],
  ] as const)(
    'hides technical details for unexpected route errors when %s',
    async (status, linkName, href) => {
      auth.status = status
      const failingRoutes: RouteObject[] = [
        {
          element: appRoutes[0]!.element,
          errorElement: appRoutes[0]!.errorElement,
          children: [
            ...(appRoutes[0]!.children ?? []),
            {
              path: '/broken',
              loader: () => {
                throw new Error('private database detail')
              },
              element: <h1>Unreachable</h1>,
            },
          ],
        },
      ]
      const router = createMemoryRouter(failingRoutes, { initialEntries: ['/broken'] })
      render(
        <QueryClientProvider client={createQueryClient()}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      )
      expect(
        await screen.findByRole('heading', { name: 'Не удалось открыть страницу' }),
      ).toBeInTheDocument()
      expect(screen.queryByText(/private database detail/)).not.toBeInTheDocument()
      expect(screen.queryByRole('navigation', { name: 'Разделы кабинета' })).not.toBeInTheDocument()
      expect(screen.getByRole('link', { name: linkName })).toHaveAttribute('href', href)
    },
  )
})

it('loads StudentAccess before the real schedule and keeps the working profile route', async () => {
  auth.status = 'authenticated'
  renderRouter('/schedule')
  expect(await screen.findByRole('article', { name: 'Вымышленная дисциплина' })).toBeInTheDocument()
  const urls = vi
    .mocked(apiFetch)
    .mock.calls.map(([input]) => new URL(String(input), window.location.href).pathname)
  expect(urls).toEqual(['/api/v1/users/me', '/api/v1/schedule'])
  await userEvent.setup().click(screen.getByRole('button', { name: 'Меню пользователя' }))
  await userEvent.setup().click(screen.getByRole('link', { name: 'Мой профиль' }))
  expect(await screen.findByRole('heading', { name: 'Мой профиль' })).toBeInTheDocument()
  expect(screen.getByRole('article')).toHaveTextContent(profile.full_name)
  expect(screen.getByRole('article')).toHaveTextContent(profile.program.name)
})

it('does not load or show schedule when StudentAccess rejects access', async () => {
  auth.status = 'authenticated'
  vi.mocked(apiFetch).mockRejectedValue(new ApiClientError('Denied', 'forbidden', 403))
  renderRouter('/schedule')
  expect(await screen.findByRole('alert')).toHaveTextContent('Доступ запрещён')
  expect(screen.queryByRole('heading', { name: 'Расписание' })).not.toBeInTheDocument()
  expect(vi.mocked(apiFetch).mock.calls.map(([input]) => String(input))).toEqual([
    '/api/v1/users/me',
  ])
})

it('opens the protected notification drawer directly from its route and closes back to schedule', async () => {
  auth.status = 'authenticated'
  renderRouter('/notifications')
  expect(await screen.findByRole('dialog', { name: 'Уведомления' })).toBeInTheDocument()
  expect(await screen.findByText('Пока нет уведомлений.')).toBeInTheDocument()
  await userEvent.setup().click(
    within(screen.getByRole('dialog', { name: 'Уведомления' })).getByRole('button', {
      name: 'Закрыть уведомления',
    }),
  )
  expect(await screen.findByRole('heading', { name: 'Расписание' })).toBeInTheDocument()
})

it('keeps the notification route behind the existing authentication guard', async () => {
  auth.status = 'unauthenticated'
  renderRouter('/notifications')
  expect(await screen.findByRole('heading', { name: 'Вход в систему' })).toBeInTheDocument()
  expect(screen.queryByRole('dialog', { name: 'Уведомления' })).not.toBeInTheDocument()
})
