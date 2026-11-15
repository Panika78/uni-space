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
import { formatDate } from '../schedule/calendar'

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
let accountBRole: 'student' | 'teacher'
let delayContext: (() => Promise<Response>) | undefined
let account: 'A' | 'B'
let contextError: number | undefined
let postCount: number
let submit: ((body: string) => Promise<Response>) | undefined
let profileError: number | undefined
let delayProfile: (() => Promise<Response>) | undefined
let delaySchedule: ((dateFrom: string, dateTo: string) => Promise<Response>) | undefined
let scheduleDates: Partial<Record<'A' | 'B', string[]>>
function scheduleResponse(token: 'A' | 'B', dateFrom: string, dateTo: string) {
  const dates = scheduleDates[token] ?? [dateFrom]
  return Response.json({
    date_from: dateFrom,
    date_to: dateTo,
    timezone: 'Europe/Moscow',
    items: [
      ...dates.map((date) =>
        createLesson({
          id: `${token}-${date}`,
          groups: [profiles[token].group],
          starts_at: `${date}T12:00:00+03:00`,
          ends_at: `${date}T13:00:00+03:00`,
          course_offering: {
            id: token === 'A' ? '1' : '2',
            discipline: {
              id: token === 'A' ? '1' : '2',
              name: `Занятие ${token === 'A' ? 'Альфа' : 'Бета'}`,
            },
          },
        }),
      ),
    ],
  })
}
beforeEach(() => {
  localStorage.clear()
  account = 'A'
  accountBRole = 'student'
  delayContext = undefined
  profileError = undefined
  contextError = undefined
  postCount = 0
  submit = undefined
  delayProfile = undefined
  delaySchedule = undefined
  scheduleDates = {}
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-10T12:00:00+03:00'))
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
      if (path.endsWith('/auth/context')) {
        if (contextError === 0) throw new TypeError('offline')
        if (contextError)
          return error(contextError, contextError === 401 ? 'session_invalid' : 'forbidden')
        if (delayContext) {
          const delayed = delayContext
          delayContext = undefined
          return delayed()
        }
        return Response.json({
          user_id: account === 'A' ? '1' : '2',
          role: account === 'A' ? 'student' : accountBRole,
          org_unit_id: null,
          permissions: [],
        })
      }
      if (path.endsWith('/users/me')) {
        if (delayProfile) {
          const delayed = delayProfile
          delayProfile = undefined
          return delayed()
        }
        if (profileError === 0) throw new TypeError('offline')
        if (profileError)
          return error(profileError, profileError === 401 ? 'session_invalid' : 'forbidden')
        const token = new Headers(init?.headers).get('Authorization')?.slice(7) as 'A' | 'B'
        return Response.json(profiles[token])
      }
      if (path === '/api/v1/applications' && init?.method === 'POST') {
        postCount++
        return submit!(String(init.body))
      }
      if (path === '/api/v1/schedule') {
        const requestUrl = new URL(String(input), window.location.href)
        const dateFrom = requestUrl.searchParams.get('date_from')!
        const dateTo = requestUrl.searchParams.get('date_to')!
        if (delaySchedule) {
          const delayed = delaySchedule
          delaySchedule = undefined
          return delayed(dateFrom, dateTo)
        }
        const token = new Headers(init?.headers).get('Authorization')?.slice(7) as 'A' | 'B'
        return scheduleResponse(token, dateFrom, dateTo)
      }
      throw new Error(`Unexpected request ${path}`)
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
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
    if (status === 500)
      screen.getAllByText('Анна Альфа').forEach((node) => expect(node).not.toBeVisible())
    else expect(screen.queryByText('Анна Альфа')).not.toBeInTheDocument()
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
  const alphaDay = within(screen.getByRole('region', { name: formatDate('2026-11-09') }))
  await alphaDay.findByRole('article', { name: 'Занятие Альфа' })
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
  const betaDay = within(screen.getByRole('region', { name: formatDate('2026-11-09') }))
  await betaDay.findByRole('article', { name: 'Занятие Бета' })
  await act(async () => {
    completeProfile(Response.json(profiles.A))
    completeSchedule(scheduleResponse('A', '2026-11-09', '2026-11-15'))
    await refresh
  })
  expect(screen.queryByText(/Альфа/)).not.toBeInTheDocument()
  expect(JSON.stringify(client.getQueryData(['student-profile']))).not.toContain('Альфа')
  expect(client.getQueryData(['student-profile'])).toEqual(
    expect.objectContaining({
      id: profiles.B.id,
      student_id: profiles.B.student_id,
      full_name: profiles.B.full_name,
      group: profiles.B.group,
    }),
  )
  expect(JSON.stringify(client.getQueriesData({ queryKey: ['schedule'] }))).not.toContain('Альфа')
  expect(betaDay.getByRole('article', { name: 'Занятие Бета' })).toBeInTheDocument()
  const scheduleCache = client.getQueryData<{
    items: {
      id: string
      groups: { id: string }[]
      course_offering: { discipline: { id: string; name: string } }
    }[]
  }>(['schedule', '2026-11-09', '2026-11-15'])
  expect(scheduleCache?.items).toContainEqual(
    expect.objectContaining({
      id: 'B-2026-11-09',
      groups: expect.arrayContaining([expect.objectContaining({ id: profiles.B.group.id })]),
      course_offering: expect.objectContaining({
        id: '2',
        discipline: expect.objectContaining({ id: '2', name: 'Занятие Бета' }),
      }),
    }),
  )
  expect(JSON.stringify(scheduleCache)).not.toContain('Альфа')
  await user.click(screen.getByRole('button', { name: 'Меню пользователя' }))
  await user.click(screen.getByRole('link', { name: 'Мой профиль' }))
  expect(await screen.findByRole('heading', { name: 'Мой профиль' })).toBeInTheDocument()
  expect(screen.getByRole('article')).toHaveTextContent('Группа Бета')
})

it('finds same-discipline lessons in their respective day sections', async () => {
  scheduleDates.B = ['2026-11-09', '2026-11-10']
  const { user } = mount()
  await login(user, 'student-b')
  await user.click(screen.getByRole('link', { name: 'Расписание' }))

  for (const date of scheduleDates.B) {
    const day = within(screen.getByRole('region', { name: formatDate(date) }))
    expect(await day.findByRole('article', { name: 'Занятие Бета' })).toBeInTheDocument()
  }
})

it('keeps account B schedule isolated when a Sunday request resolves after Moscow midnight', async () => {
  vi.setSystemTime(new Date('2026-11-15T23:59:59+03:00'))
  const { client, user } = mount()
  await login(user, 'student-a')
  await user.click(screen.getByRole('link', { name: 'Расписание' }))
  expect(screen.getByText(/9–15 ноября/)).toBeInTheDocument()
  await within(screen.getByRole('region', { name: formatDate('2026-11-09') })).findByRole(
    'article',
    { name: 'Занятие Альфа' },
  )

  let completeSchedule!: (response: Response) => void
  let requestedRange: [string, string] | undefined
  delaySchedule = (dateFrom, dateTo) => {
    requestedRange = [dateFrom, dateTo]
    return new Promise((resolve) => {
      completeSchedule = resolve
    })
  }
  let refresh!: Promise<void>
  act(() => {
    refresh = client.invalidateQueries({ queryKey: ['schedule', '2026-11-09', '2026-11-15'] })
  })
  await waitFor(() => expect(requestedRange).toEqual(['2026-11-09', '2026-11-15']))

  vi.setSystemTime(new Date('2026-11-16T00:00:01+03:00'))
  await user.click(screen.getByRole('button', { name: 'Меню пользователя' }))
  await user.click(screen.getByRole('button', { name: 'Выйти' }))
  await user.click(
    screen.getByRole('dialog').querySelector<HTMLButtonElement>('.logout-dialog__confirm')!,
  )
  await login(user, 'student-b')
  await user.click(screen.getByRole('link', { name: 'Расписание' }))
  expect(screen.getByText(/16–22 ноября/)).toBeInTheDocument()
  const betaDay = within(screen.getByRole('region', { name: formatDate('2026-11-16') }))
  await betaDay.findByRole('article', { name: 'Занятие Бета' })

  await act(async () => {
    completeSchedule(scheduleResponse('A', ...requestedRange!))
    await refresh
  })
  expect(screen.queryByText(/Альфа/)).not.toBeInTheDocument()
  expect(betaDay.getByRole('article', { name: 'Занятие Бета' })).toBeInTheDocument()
  expect(client.getQueryData(['schedule', '2026-11-16', '2026-11-22'])).toEqual(
    expect.objectContaining({
      date_from: '2026-11-16',
      date_to: '2026-11-22',
      items: expect.arrayContaining([
        expect.objectContaining({
          id: 'B-2026-11-16',
          course_offering: {
            id: '2',
            discipline: expect.objectContaining({ name: 'Занятие Бета' }),
          },
        }),
      ]),
    }),
  )
})

it('isolates a late role context and populated student cache from the next teacher account', async () => {
  const { client, user } = mount()
  await login(user, 'student-a')
  expect(client.getQueryData(['student-profile'])).toEqual(profiles.A)
  let complete!: (response: Response) => void
  let started = false
  delayContext = () => {
    started = true
    return new Promise((resolve) => {
      complete = resolve
    })
  }
  let pending!: Promise<void>
  act(() => {
    pending = client.invalidateQueries({ queryKey: ['authorization-context'] })
  })
  await waitFor(() => expect(started).toBe(true))
  await user.click(screen.getByRole('button', { name: 'Меню пользователя' }))
  await user.click(screen.getByRole('button', { name: 'Выйти' }))
  await user.click(screen.getByRole('button', { name: 'Выйти' }))
  await screen.findByRole('heading', { name: 'Вход в систему' })
  expect(client.getQueryCache().getAll()).toHaveLength(0)
  accountBRole = 'teacher'
  await user.type(screen.getByLabelText('Логин'), 'teacher-b')
  await user.type(screen.getByLabelText('Пароль'), 'fictional-password')
  await user.click(screen.getByRole('button', { name: 'Войти' }))
  await screen.findByRole('heading', { name: 'Мои журналы' })
  await act(async () => {
    complete(Response.json({ user_id: '1', role: 'student', org_unit_id: null, permissions: [] }))
    await pending
  })
  expect(client.getQueryData(['authorization-context'])).toMatchObject({
    user_id: '2',
    role: 'teacher',
  })
  expect(client.getQueryData(['student-profile'])).toBeUndefined()
  expect(screen.queryByText('Анна Альфа')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Меню пользователя' })).toHaveTextContent('—')
  await user.click(screen.getByRole('button', { name: 'Меню пользователя' }))
  expect(screen.queryByRole('link', { name: 'Мой профиль' })).not.toBeInTheDocument()
})

for (const key of ['authorization-context', 'student-profile']) {
  it.each([0, 503])(
    `retains a draft and navigation protection through ${key} error %s`,
    async (status) => {
      const { client, router, user } = mount()
      await login(user, 'student-a')
      await act(async () => router.navigate('/services/study_certificate'))
      const field = await screen.findByRole('textbox', { name: /Место предоставления/ })
      await user.type(field, 'Несохранённый текст')
      field.focus()
      if (key === 'authorization-context') contextError = status
      else profileError = status
      await act(async () => {
        await client.invalidateQueries({ queryKey: [key] })
      })
      await screen.findByRole('region', { name: 'Восстановление доступа' })
      expect(field).not.toBeVisible()
      expect(field.closest('[inert]')).not.toBeNull()
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
      expect(screen.getByRole('region', { name: 'Восстановление доступа' })).toHaveFocus()
      const unload = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(unload)
      expect(unload.defaultPrevented).toBe(true)
      await act(async () => router.navigate('/profile'))
      expect(router.state.location.pathname).toBe('/services/study_certificate')
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      contextError = undefined
      profileError = undefined
      await user.click(screen.getByRole('button', { name: 'Повторить' }))
      await screen.findByRole('dialog', { name: 'Выйти без сохранения?' })
      await user.click(screen.getByRole('button', { name: 'Продолжить заполнение' }))
      expect(screen.getByRole('textbox')).toBe(field)
      expect(field).toHaveValue('Несохранённый текст')
      expect(postCount).toBe(0)
    },
  )
  it.each(['pending', 'uncertain', 'confirmed', 'validation'])(
    `keeps %s submission state through a ${key} failure without another POST`,
    async (mode) => {
      const { client, router, user } = mount()
      await login(user, 'student-a')
      await act(async () => router.navigate('/services/study_certificate'))
      const field = await screen.findByRole('textbox', { name: /Место предоставления/ })
      await user.type(field, 'Только одно заявление')
      let complete!: (response: Response) => void
      submit = () =>
        new Promise((resolve) => {
          complete = resolve
        })
      await user.click(screen.getByRole('button', { name: 'Отправить заявление' }))
      expect(postCount).toBe(1)
      if (key === 'authorization-context') contextError = 503
      else profileError = 503
      await act(async () => {
        await client.invalidateQueries({ queryKey: [key] })
      })
      await screen.findByRole('region', { name: 'Восстановление доступа' })
      const confirmation = {
        id: '91',
        service: { id: '1', code: 'study_certificate', title: 'Справка об обучении' },
        form_data: { place_of_submission: 'Только одно заявление' },
        review_status: 'submitted',
        document_status: 'pending',
        feedback: null,
        created_at: '2026-11-10T12:00:00Z',
        updated_at: '2026-11-10T12:00:00Z',
      }
      if (mode !== 'pending')
        await act(async () =>
          complete(
            mode === 'confirmed'
              ? Response.json(confirmation, { status: 201 })
              : mode === 'validation'
                ? Response.json(
                    {
                      error: {
                        code: 'validation_error',
                        message: '',
                        details: [{ field: 'form_data.place_of_submission', code: 'required' }],
                      },
                    },
                    { status: 422 },
                  )
                : error(500, 'internal_error'),
          ),
        )
      expect(screen.getByRole('region', { name: 'Восстановление доступа' })).toHaveFocus()
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
      contextError = undefined
      profileError = undefined
      await user.click(screen.getByRole('button', { name: 'Повторить' }))
      if (mode === 'confirmed') await screen.findByRole('heading', { name: 'Заявление создано' })
      else {
        const restored = await screen.findByRole('textbox')
        expect(restored).toBe(field)
        expect(restored).toHaveValue('Только одно заявление')
        if (mode === 'validation') expect(restored).toHaveAttribute('aria-invalid', 'true')
        else {
          expect(
            screen.getByRole('button', {
              name: mode === 'pending' ? 'Отправляем…' : 'Отправить заявление',
            }),
          ).toBeDisabled()
          // Even a programmatic submit cannot duplicate an in-flight/uncertain POST.
          restored
            .closest('form')!
            .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        }
      }
      expect(postCount).toBe(1)
      if (mode === 'pending')
        await act(async () => complete(Response.json(confirmation, { status: 201 })))
    },
  )
}

for (const key of ['authorization-context', 'student-profile']) {
  it.each([401, 403])(`destroys a retained draft when ${key} confirms HTTP %s`, async (status) => {
    const { client, router, user } = mount()
    await login(user, 'student-a')
    await act(async () => router.navigate('/services/study_certificate'))
    const field = await screen.findByRole('textbox')
    await user.type(field, 'Данные отозванного доступа')
    if (key === 'authorization-context') contextError = 500
    else profileError = 500
    await act(async () => {
      await client.invalidateQueries({ queryKey: [key] })
    })
    await screen.findByRole('region', { name: 'Восстановление доступа' })
    if (key === 'authorization-context') contextError = status
    else profileError = status
    await user.click(screen.getByRole('button', { name: 'Повторить' }))
    await waitFor(() => expect(field).not.toBeInTheDocument())
    if (status === 401) {
      await screen.findByRole('heading', { name: 'Вход в систему' })
      expect(client.getQueryCache().getAll()).toHaveLength(0)
    } else expect(await screen.findByRole('alert')).toHaveTextContent('Доступ запрещён')
  })
}

it('clears a suspended pending form on logout and rejects its late POST after teacher login', async () => {
  const { client, router, user } = mount()
  await login(user, 'student-a')
  await act(async () => router.navigate('/services/study_certificate'))
  const field = await screen.findByRole('textbox')
  await user.type(field, 'Личные данные старой сессии')
  let complete!: (response: Response) => void
  submit = () =>
    new Promise((resolve) => {
      complete = resolve
    })
  await user.click(screen.getByRole('button', { name: 'Отправить заявление' }))
  contextError = 503
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['authorization-context'] })
  })
  await screen.findByRole('region', { name: 'Восстановление доступа' })
  await user.click(screen.getByRole('button', { name: 'Выйти' }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Выйти' }))
  await screen.findByRole('heading', { name: 'Вход в систему' })
  expect(field).not.toBeInTheDocument()
  expect(client.getQueryCache().getAll()).toHaveLength(0)
  contextError = undefined
  accountBRole = 'teacher'
  await user.type(screen.getByLabelText('Логин'), 'teacher-b')
  await user.type(screen.getByLabelText('Пароль'), 'fictional-password')
  await user.click(screen.getByRole('button', { name: 'Войти' }))
  await screen.findByRole('heading', { name: 'Мои журналы' })
  await act(async () => complete(Response.json({ id: 'old-application' }, { status: 201 })))
  expect(screen.queryByText('Заявление создано')).not.toBeInTheDocument()
  expect(field).not.toBeInTheDocument()
  expect(client.getQueryData(['student-profile'])).toBeUndefined()
  expect(client.getQueryData(['authorization-context'])).toMatchObject({
    user_id: '2',
    role: 'teacher',
  })
  expect(postCount).toBe(1)
})
