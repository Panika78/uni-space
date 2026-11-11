import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { authEpochStorageKey } from '../auth/authSession'
import { AuthProvider } from '../auth/AuthProvider'
import { createQueryClient } from '../../app/queryClient'
import { appRoutes } from '../../app/router'
import { createLesson } from '../schedule/testFixtures'
import { addDays, getMoscowDate, getWeekStart } from '../schedule/calendar'

const profiles = {
  A: {
    id: '1',
    student_id: '11',
    login: 'student-a',
    full_name: 'Анна Альфа',
    faculty: { id: '21', name: 'Факультет Альфа' },
    program: { id: '31', code: '01', name: 'Программа Альфа' },
    direction: { code: '01.01', name: 'Направление Альфа' },
    group: { id: '41', name: 'Группа Альфа' },
    course_number: 1,
    academic_status: 'enrolled',
  },
  B: {
    id: '2',
    student_id: '12',
    login: 'student-b',
    full_name: 'Борис Бета',
    faculty: { id: '22', name: 'Факультет Бета' },
    program: { id: '32', code: '02', name: 'Программа Бета' },
    direction: { code: '02.02', name: 'Направление Бета' },
    group: { id: '42', name: 'Группа Бета' },
    course_number: 2,
    academic_status: 'academic_leave',
  },
}
function error(status: number, code: string) {
  return Response.json({ error: { code, message: 'Error', details: [] } }, { status })
}
let account: 'A' | 'B'
let profileError: number | undefined
let delayProfile: (() => Promise<Response>) | undefined
let delaySchedule: (() => Promise<Response>) | undefined
function scheduleResponse(token: 'A' | 'B') {
  const today = getMoscowDate()
  const weekStart = getWeekStart(today)
  return Response.json({
    date_from: weekStart,
    date_to: addDays(weekStart, 6),
    timezone: 'Europe/Moscow',
    items: [
      createLesson({
        groups: [profiles[token].group],
        // Keep the integration fixture inside one Moscow calendar day regardless
        // of when the test runner happens to execute it.
        starts_at: `${today}T09:00:00+03:00`,
        ends_at: `${today}T10:00:00+03:00`,
        course_offering: {
          id: token === 'A' ? '1' : '2',
          discipline: {
            id: token === 'A' ? '1' : '2',
            name: `Занятие ${token === 'A' ? 'Альфа' : 'Бета'}`,
          },
        },
      }),
    ],
  })
}
beforeEach(() => {
  localStorage.clear()
  account = 'A'
  profileError = undefined
  delayProfile = undefined
  delaySchedule = undefined
  vi.stubGlobal('navigator', {
    locks: {
      request: (_name: string, options: LockOptions, action: () => Promise<unknown>) => {
        options.signal?.throwIfAborted()
        return action()
      },
    },
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), window.location.href).pathname
      if (path.endsWith('/refresh')) return error(401, 'invalid_refresh')
      if (path.endsWith('/login')) {
        account = JSON.parse(String(init?.body)).login === 'student-a' ? 'A' : 'B'
        return Response.json({ access_token: account, token_type: 'bearer', expires_in: 600 })
      }
      if (path.endsWith('/logout')) return Response.json({ session_revoked: true })
      if (path.endsWith('/users/me')) {
        if (delayProfile) {
          const delayed = delayProfile
          delayProfile = undefined
          return delayed()
        }
        if (profileError)
          return error(profileError, profileError === 401 ? 'session_invalid' : 'forbidden')
        const token = new Headers(init?.headers).get('Authorization')?.slice(7) as 'A' | 'B'
        return Response.json(profiles[token])
      }
      if (path === '/api/v1/schedule') {
        if (delaySchedule) {
          const delayed = delaySchedule
          delaySchedule = undefined
          return delayed()
        }
        const token = new Headers(init?.headers).get('Authorization')?.slice(7) as 'A' | 'B'
        return scheduleResponse(token)
      }
      throw new Error(`Unexpected request ${path}`)
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
function mount() {
  const client = createQueryClient()
  const router = createMemoryRouter(appRoutes, { initialEntries: ['/login'] })
  render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  )
  return { client, router, user: userEvent.setup() }
}
async function login(user: ReturnType<typeof userEvent.setup>, loginName: string) {
  await screen.findByRole('heading', { name: 'Вход в систему' })
  await user.type(screen.getByLabelText('Логин'), loginName)
  await user.type(screen.getByLabelText('Пароль'), 'fictional-password')
  await user.click(screen.getByRole('button', { name: 'Войти' }))
  await screen.findByRole('button', { name: 'Меню пользователя' })
  await user.click(screen.getByRole('button', { name: 'Меню пользователя' }))
  const link = screen.getByRole('link', { name: 'Мой профиль' })
  expect(link).not.toHaveTextContent('Скоро')
  expect(screen.getByRole('link', { name: /Настройки/ })).toHaveTextContent('Скоро')
  await user.click(link)
  await screen.findByRole('heading', { name: 'Мой профиль' })
}
it.each(['logout', 'session-change'])(
  'isolates A → %s → B including a late response',
  async (mode) => {
    const { client, user } = mount()
    await login(user, 'student-a')
    expect(screen.getByRole('button', { name: 'Меню пользователя' })).toHaveTextContent('АА')
    let complete!: (response: Response) => void
    let started = false
    delayProfile = () => {
      started = true
      return new Promise((resolve) => {
        complete = resolve
      })
    }
    let refresh!: Promise<void>
    act(() => {
      refresh = client.invalidateQueries({ queryKey: ['student-profile'] })
    })
    await waitFor(() => expect(started).toBe(true))
    if (mode === 'logout') {
      await user.click(screen.getByRole('button', { name: 'Меню пользователя' }))
      await user.click(screen.getByRole('button', { name: 'Выйти' }))
      expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).endsWith('/logout'))).toBe(
        false,
      )
      await user.click(screen.getByRole('button', { name: 'Отмена' }))
      expect(screen.getByRole('article')).toHaveTextContent('Анна Альфа')
      expect(screen.getByRole('button', { name: 'Меню пользователя' })).toHaveFocus()
      expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).endsWith('/logout'))).toBe(
        false,
      )
      await user.click(screen.getByRole('button', { name: 'Меню пользователя' }))
      await user.click(screen.getByRole('button', { name: 'Выйти' }))
      await user.click(screen.getByRole('button', { name: 'Выйти' }))
    } else {
      act(() => {
        localStorage.setItem(authEpochStorageKey, 'other-tab-session-change')
        window.dispatchEvent(new StorageEvent('storage', { key: authEpochStorageKey }))
      })
    }
    expect(screen.queryByText('Анна Альфа')).not.toBeInTheDocument()
    await login(user, 'student-b')
    expect(screen.getByRole('button', { name: 'Меню пользователя' })).toHaveTextContent('ББ')
    await act(async () => {
      complete(Response.json(profiles.A))
      await refresh
    })
    for (const value of [
      'Анна Альфа',
      'Факультет Альфа',
      'Группа Альфа',
      'Программа Альфа',
      'Направление Альфа',
      'АА',
    ])
      expect(screen.queryByText(value, { exact: false })).not.toBeInTheDocument()
    const article = screen.getByRole('article')
    for (const value of [
      'Борис Бета',
      'Факультет Бета',
      'Группа Бета',
      'Программа Бета',
      'Направление Бета',
    ])
      expect(within(article).getAllByText(value, { exact: false }).length).toBeGreaterThan(0)
    expect(JSON.stringify(client.getQueryData(['student-profile']))).not.toContain('Альфа')
  },
)
it.each([401, 403, 500])(
  'hides cached profile and student shell after a new HTTP %s',
  async (status) => {
    const { client, user } = mount()
    await login(user, 'student-a')
    profileError = status
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['student-profile'] })
    })
    await waitFor(() => expect(screen.queryByRole('article')).not.toBeInTheDocument())
    expect(screen.queryByText('Анна Альфа')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Меню пользователя' })).not.toBeInTheDocument()
    if (status === 401)
      expect(await screen.findByRole('heading', { name: 'Вход в систему' })).toBeInTheDocument()
    else
      expect(await screen.findByRole('alert')).toHaveTextContent(
        status === 403 ? 'Доступ запрещён' : 'Не удалось загрузить профиль',
      )
    if (status === 403) {
      await user.click(screen.getByRole('button', { name: 'Выйти' }))
      expect(screen.getByRole('dialog', { name: 'Выйти из аккаунта?' })).toBeInTheDocument()
      expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).endsWith('/logout'))).toBe(
        false,
      )
      await user.click(screen.getByRole('button', { name: 'Отмена' }))
      expect(screen.getByRole('alert')).toHaveTextContent('Доступ запрещён')
      await user.click(screen.getByRole('button', { name: 'Выйти' }))
      await user.click(
        screen.getByRole('dialog').querySelector<HTMLButtonElement>('.logout-dialog__confirm')!,
      )
      expect(await screen.findByRole('heading', { name: 'Вход в систему' })).toBeInTheDocument()
      expect(
        vi.mocked(fetch).mock.calls.filter(([path]) => String(path).endsWith('/logout')),
      ).toHaveLength(1)
    }
  },
)

it('isolates profile and schedule together when both old student responses arrive after account change', async () => {
  const { client, user } = mount()
  await login(user, 'student-a')
  expect(screen.getByRole('article')).toHaveTextContent('Анна Альфа')
  await user.click(screen.getByRole('link', { name: 'Расписание' }))
  await screen.findByRole('article', { name: 'Занятие Альфа' })
  let completeProfile!: (response: Response) => void
  let completeSchedule!: (response: Response) => void
  let profileStarted = false
  let scheduleStarted = false
  delayProfile = () => {
    profileStarted = true
    return new Promise((resolve) => {
      completeProfile = resolve
    })
  }
  delaySchedule = () => {
    scheduleStarted = true
    return new Promise((resolve) => {
      completeSchedule = resolve
    })
  }
  let refresh!: Promise<unknown>
  act(() => {
    refresh = Promise.all([
      client.invalidateQueries({ queryKey: ['student-profile'] }),
      client.invalidateQueries({ queryKey: ['schedule'] }),
    ])
  })
  await waitFor(() => {
    expect(profileStarted).toBe(true)
    expect(scheduleStarted).toBe(true)
  })
  await user.click(screen.getByRole('button', { name: 'Меню пользователя' }))
  await user.click(screen.getByRole('button', { name: 'Выйти' }))
  await user.click(
    screen.getByRole('dialog').querySelector<HTMLButtonElement>('.logout-dialog__confirm')!,
  )
  expect(screen.queryByText(/Альфа/)).not.toBeInTheDocument()
  await login(user, 'student-b')
  expect(screen.getByRole('article')).toHaveTextContent('Борис Бета')
  await user.click(screen.getByRole('link', { name: 'Расписание' }))
  await screen.findByRole('article', { name: 'Занятие Бета' })
  await act(async () => {
    completeProfile(Response.json(profiles.A))
    completeSchedule(scheduleResponse('A'))
    await refresh
  })
  expect(screen.queryByText(/Альфа/)).not.toBeInTheDocument()
  expect(JSON.stringify(client.getQueryData(['student-profile']))).not.toContain('Альфа')
  expect(JSON.stringify(client.getQueriesData({ queryKey: ['schedule'] }))).not.toContain('Альфа')
  await user.click(screen.getByRole('button', { name: 'Меню пользователя' }))
  await user.click(screen.getByRole('link', { name: 'Мой профиль' }))
  expect(await screen.findByRole('heading', { name: 'Мой профиль' })).toBeInTheDocument()
  expect(screen.getByRole('article')).toHaveTextContent('Группа Бета')
})
