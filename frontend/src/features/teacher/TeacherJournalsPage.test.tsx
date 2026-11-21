import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '../../app/queryClient'
import { ApiClientError, apiFetch } from '../../shared/api/client'
import { TeacherJournalsPage } from './TeacherJournalsPage'

const fixtures = vi.hoisted(() => ({
  marks: [
    {
      student_id: '1',
      full_name: 'Анна Иванова',
      subgroup_id: null,
      academic_status: 'enrolled',
      status: 'attended',
      updated_at: '2026-11-16T10:00:00Z',
      can_edit: true,
    },
    {
      student_id: '2',
      full_name: 'Ёлкин Борис',
      subgroup_id: '4',
      academic_status: 'enrolled',
      status: 'absent',
      updated_at: '2026-11-16T10:01:00Z',
      can_edit: true,
    },
    {
      student_id: '3',
      full_name: 'Мария Петрова',
      subgroup_id: '4',
      academic_status: 'enrolled',
      status: 'unmarked',
      updated_at: null,
      can_edit: true,
    },
  ],
  scores: [
    {
      student_id: '1',
      full_name: 'Анна Иванова',
      result_id: null,
      score: null,
      graded_at: null,
      is_current_group_member: true,
    },
    {
      student_id: '2',
      full_name: 'Ёлкин Борис',
      result_id: '17',
      score: 0,
      graded_at: '2026-11-16T10:03:00Z',
      is_current_group_member: true,
    },
    {
      student_id: '3',
      full_name: 'Мария Петрова',
      result_id: null,
      score: null,
      graded_at: null,
      is_current_group_member: true,
    },
  ],
  final: {
    result_id: null,
    course_offering_id: '11',
    student_id: '1',
    grade_value: null,
    passed: null,
    retake_date: null,
    retake_location: null,
    has_debt: false,
  },
}))

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

let failNextFinalWrite = false
let failNextScoreWrite = false

function page<T>(items: T[]) {
  return { items, next_cursor: null }
}
const assignment = {
  id: '8',
  course_offering_id: '11',
  discipline: { id: '5', name: 'Алгебра' },
  term: { id: '7', name: 'Осень 2026' },
  group: { id: '21', name: 'М-101' },
  attestation_type: 'exam',
}
const lesson = {
  id: '31',
  starts_at: '2026-11-16T09:00:00Z',
  ends_at: '2026-11-16T10:30:00Z',
  kind: 'seminar',
  status: 'scheduled',
  is_additional: false,
  version: 1,
}
const assessment = {
  id: '44',
  assessment_id: '55',
  title: 'Контрольная',
  type: 'test',
  description: null,
  max_score: 10,
  planned_date: '2026-11-20',
  lesson_id: null,
  date_needs_confirmation: true,
}

beforeEach(() => {
  fixtures.marks[0]!.status = 'attended'
  fixtures.marks[1]!.status = 'absent'
  fixtures.marks[2]!.status = 'unmarked'
  fixtures.scores[0]!.score = null
  fixtures.scores[1]!.score = 0
  fixtures.scores[2]!.score = null
  Object.assign(fixtures.final, {
    grade_value: null,
    passed: null,
    retake_date: null,
    retake_location: null,
    has_debt: false,
  })
  failNextFinalWrite = false
  failNextScoreWrite = false
  vi.mocked(apiFetch).mockImplementation(async (input, init = {}) => {
    const url = String(input)
    if (url.startsWith('/api/v1/teaching/assignments')) return page([assignment])
    if (url.endsWith('/students?limit=100'))
      return page(
        fixtures.marks.map(({ student_id, full_name, subgroup_id, academic_status }) => ({
          id: student_id,
          full_name,
          subgroup_id,
          academic_status,
        })),
      )
    if (url.endsWith('/lessons?limit=100')) return page([lesson])
    if (url.endsWith('/assessments?limit=100')) return page([assessment])
    if (url.endsWith('/final-results?limit=100')) return page([fixtures.final])
    if (url.includes('/lessons/31/attendance?')) {
      const studentId = new URLSearchParams(url.split('?')[1]).get('student_id')
      const rows = fixtures.marks.filter((row) => !studentId || row.student_id === studentId)
      return page(rows)
    }
    if (url.endsWith('/lessons/31/attendance?limit=100')) return page(fixtures.marks)
    if (url.includes('/assessments/44/results?')) {
      const studentId = new URLSearchParams(url.split('?')[1]).get('student_id')
      return page(
        fixtures.scores
          .filter((row) => !studentId || row.student_id === studentId)
          .map((row) => ({ ...row })),
      )
    }
    if (url.includes('/attendance/lessons/31/students/')) {
      const studentId = url.split('/').at(-1)!
      const method = init.method
      const row = fixtures.marks.find((item) => item.student_id === studentId)!
      if (method === 'DELETE') row.status = 'unmarked'
      else row.status = JSON.parse(String(init.body)).status
      return { lesson_id: '31', student_id: studentId, status: row.status }
    }
    if (url.includes('/assessments/44/results/')) {
      const studentId = url.split('/').at(-1)!
      const row = fixtures.scores.find((item) => item.student_id === studentId)!
      if (failNextScoreWrite) {
        failNextScoreWrite = false
        throw new Error('simulated score write failure')
      }
      row.score = JSON.parse(String(init.body)).score
      return { result_id: row.score === null ? null : '17', score: row.score, graded_at: null }
    }
    if (url.includes('/final-results/courses/11/students/')) {
      const payload = init.body ? JSON.parse(String(init.body)) : null
      if (payload) {
        if (failNextFinalWrite) {
          failNextFinalWrite = false
          throw new Error('simulated final write failure')
        }
        Object.assign(fixtures.final, payload)
        if (payload.grade_value !== undefined) {
          fixtures.final.has_debt = payload.grade_value === 2
          if (!fixtures.final.has_debt) {
            fixtures.final.retake_date = null
            fixtures.final.retake_location = null
          }
        }
        if (payload.passed !== undefined) {
          fixtures.final.has_debt = payload.passed === false
          if (payload.passed === true) {
            fixtures.final.retake_date = null
            fixtures.final.retake_location = null
          }
        }
      }
      return { ...fixtures.final }
    }
    if (url.endsWith('/dates')) return { items: [] }
    throw new Error(`Unexpected journal request: ${url}`)
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderJournal(url = '/teacher/journals?course=11&group=21&tab=attendance&lesson=31') {
  const client = createQueryClient()
  const rendered = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <TeacherJournalsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...rendered, client }
}

async function openFinals(user: ReturnType<typeof userEvent.setup>) {
  const tab = await screen.findByRole('tab', { name: 'Итоги аттестации' })
  await user.click(tab)
  return screen.findByRole('region', { name: 'Таблица итоговой аттестации' })
}

it('restores all three attendance states from the server and saves individual changes', async () => {
  const user = userEvent.setup()
  renderJournal()
  expect(await screen.findByText('Анна Иванова')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Присутствовал: Анна Иванова' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(screen.getByRole('button', { name: 'Отсутствовал: Ёлкин Борис' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(screen.getByRole('button', { name: 'Нет отметки: Мария Петрова' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await user.click(screen.getByRole('button', { name: 'Нет отметки: Анна Иванова' }))
  await waitFor(() => expect(fixtures.marks[0]?.status).toBe('unmarked'))
  expect(await screen.findByText('Сохранено')).toBeInTheDocument()
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/v1/attendance/lessons/31/students/1',
    expect.objectContaining({ method: 'DELETE', authenticated: true }),
  )
  await user.click(screen.getByRole('button', { name: 'Присутствовал: Мария Петрова' }))
  await waitFor(() => expect(fixtures.marks[2]?.status).toBe('attended'))
})

it('offers only a timezone-correct calendar and filters lessons by selected date', async () => {
  const user = userEvent.setup()
  const original = vi.mocked(apiFetch).getMockImplementation()!
  const nextDayLesson = {
    ...lesson,
    id: '32',
    starts_at: '2026-11-18T22:30:00Z', // 19 November in Europe/Moscow
    ends_at: '2026-11-19T00:00:00Z',
  }
  const secondNextDayLesson = {
    ...lesson,
    id: '33',
    starts_at: '2026-11-19T08:30:00Z',
    ends_at: '2026-11-19T10:00:00Z',
  }
  vi.mocked(apiFetch).mockImplementation(async (input, init = {}) => {
    const url = String(input)
    if (url.endsWith('/lessons?limit=100'))
      return page([lesson, nextDayLesson, secondNextDayLesson])
    if (
      url.endsWith('/lessons/32/attendance?limit=100') ||
      url.endsWith('/lessons/33/attendance?limit=100')
    )
      return page([])
    return original(input, init)
  })

  renderJournal()
  const calendar = await screen.findByRole('region', { name: 'Календарь занятий' })
  expect(calendar.parentElement?.children).toHaveLength(1)
  expect(await within(calendar).findByRole('button', { name: /16.*занятий: 1/ })).toBeEnabled()
  expect(within(calendar).getByRole('button', { name: /17.*занятий нет/ })).toBeDisabled()
  await user.click(within(calendar).getByRole('button', { name: /19.*занятий: 2/ }))
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/v1/teaching/courses/11/groups/21/lessons/32/attendance?limit=100',
      expect.objectContaining({ authenticated: true }),
    ),
  )
  const lessonPicker = screen.getByRole('group', { name: 'Выбор занятия' })
  expect(
    calendar.compareDocumentPosition(lessonPicker) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()
  await user.click(within(lessonPicker).getByRole('button', { name: /19 нояб\. 2026 г\., 11:30/ }))
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/v1/teaching/courses/11/groups/21/lessons/33/attendance?limit=100',
      expect.objectContaining({ authenticated: true }),
    ),
  )
  expect(screen.queryByRole('combobox', { name: 'Занятие' })).not.toBeInTheDocument()
  expect(screen.getAllByText(/19 нояб\. 2026 г\./).length).toBeGreaterThan(0)
})

it('restores the previous attendance mark and explains a definitive API rejection', async () => {
  const user = userEvent.setup()
  const original = vi.mocked(apiFetch).getMockImplementation()!
  vi.mocked(apiFetch).mockImplementation(async (input, init = {}) => {
    if (String(input).includes('/attendance/lessons/31/students/1') && init.method === 'PUT')
      throw new ApiClientError('Conflict', 'invalid_transition', 409)
    return original(input, init)
  })

  renderJournal()
  const markPresent = await screen.findByRole('button', {
    name: 'Присутствовал: Анна Иванова',
  })
  await user.click(screen.getByRole('button', { name: 'Отсутствовал: Анна Иванова' }))
  expect(
    await screen.findByText(/Данные изменились или занятие уже нельзя редактировать/),
  ).toBeInTheDocument()
  expect(markPresent).toHaveAttribute('aria-pressed', 'true')
})

it('persists a linked lesson and reports the saved association', async () => {
  const user = userEvent.setup()
  let savedAssessment = { ...assessment, lesson_id: null }
  vi.mocked(apiFetch).mockImplementation(async (input, init = {}) => {
    const url = String(input)
    if (url.startsWith('/api/v1/teaching/assignments')) return page([assignment])
    if (url.endsWith('/students?limit=100')) return page([])
    if (url.endsWith('/lessons?limit=100')) return page([lesson])
    if (url.endsWith('/assessments?limit=100')) return page([savedAssessment])
    if (url.endsWith('/assessments/44/results?limit=100')) return page([])
    if (url.endsWith('/dates') && init.method === 'PATCH') {
      const item = JSON.parse(String(init.body)).items[0]
      savedAssessment = {
        ...savedAssessment,
        planned_date: item.planned_date,
        lesson_id: item.lesson_id,
        date_needs_confirmation: false,
      }
      return {
        items: [
          {
            assessment_group_id: '44',
            planned_date: item.planned_date,
            lesson_id: item.lesson_id,
            date_needs_confirmation: false,
          },
        ],
      }
    }
    if (url.includes('/assessments?assessment_group_id=')) return page([savedAssessment])
    if (url.endsWith('/dates')) return { items: [] }
    throw new Error(`Unexpected journal request: ${url}`)
  })

  renderJournal('/teacher/journals?course=11&group=21&tab=work&assessment=44')
  await user.click(await screen.findByText('Планирование и связь работ с занятиями'))
  await user.selectOptions(
    await screen.findByRole('combobox', { name: 'Связать с занятием' }),
    '31',
  )
  expect(await screen.findByText(/Не сохранено, выбрано занятие:/)).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Сохранить дату и связь' }))
  await waitFor(() => expect(savedAssessment.lesson_id).toBe('31'))
  expect(await screen.findByText('Сохранено')).toBeInTheDocument()
  expect(screen.getByText(/Связано с занятием:/)).toBeInTheDocument()
  expect(apiFetch).toHaveBeenCalledWith(
    expect.stringMatching(/\/dates$/),
    expect.objectContaining({ method: 'PATCH' }),
  )
})

it('separates an ungraded result from zero and supports scores and manual final grades', async () => {
  const user = userEvent.setup()
  renderJournal('/teacher/journals?course=11&group=21&tab=work&assessment=44')
  expect(await screen.findByText('Контрольная')).toBeInTheDocument()
  const zero = await screen.findByRole('spinbutton', {
    name: 'Баллы: Ёлкин Борис · Контрольная',
  })
  expect(zero).toHaveValue(0)
  const ungraded = screen.getByRole('spinbutton', {
    name: 'Баллы: Анна Иванова · Контрольная',
  })
  expect(ungraded).toHaveValue(null)
  await user.clear(ungraded)
  await user.type(ungraded, '10')
  await user.tab()
  await waitFor(() => expect(fixtures.scores[0]?.score).toBe(10))
  expect(apiFetch).toHaveBeenCalledWith(
    expect.stringContaining('/assessments/44/results/1'),
    expect.objectContaining({ method: 'PUT', body: JSON.stringify({ score: 10 }) }),
  )
  const finals = await openFinals(user)
  await user.selectOptions(within(finals).getByLabelText('Итог: Анна Иванова'), '4')
  await waitFor(() => expect(fixtures.final.grade_value).toBe(4))
  expect(
    screen.getByText(
      'Итоговая оценка выставляется вручную и не вычисляется автоматически из баллов.',
    ),
  ).toBeInTheDocument()
})

it('does not write an unchanged score on blur and displays a newer server score after refetch', async () => {
  const user = userEvent.setup()
  fixtures.scores[0]!.score = 5
  const { client } = renderJournal('/teacher/journals?course=11&group=21&tab=work&assessment=44')
  const score = await screen.findByRole('spinbutton', {
    name: 'Баллы: Анна Иванова · Контрольная',
  })
  expect(score).toHaveValue(5)
  vi.mocked(apiFetch).mockClear()

  await user.click(score)
  await user.tab()
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.filter(
        ([url, init]) =>
          String(url).includes('/assessments/44/results/1') && init?.method === 'PUT',
      ),
  ).toHaveLength(0)

  fixtures.scores[0]!.score = 7
  await client.invalidateQueries({ queryKey: ['teacher-journal-results'] })
  await waitFor(() => expect(score).toHaveValue(7))
  await user.click(score)
  await user.tab()
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.filter(
        ([url, init]) =>
          String(url).includes('/assessments/44/results/1') && init?.method === 'PUT',
      ),
  ).toHaveLength(0)
  expect(fixtures.scores[0]?.score).toBe(7)
})

it('clears a successfully saved score draft without clearing a newer edit', async () => {
  const user = userEvent.setup()
  const { client } = renderJournal('/teacher/journals?course=11&group=21&tab=work&assessment=44')
  const score = await screen.findByRole('spinbutton', {
    name: 'Баллы: Анна Иванова · Контрольная',
  })
  await user.clear(score)
  await user.type(score, '5')
  await user.tab()
  await waitFor(() => expect(fixtures.scores[0]?.score).toBe(5))
  await waitFor(() => expect(score).toHaveValue(5))

  fixtures.scores[0]!.score = 7
  await client.invalidateQueries({ queryKey: ['teacher-journal-results'] })
  await waitFor(() => expect(score).toHaveValue(7))
})

it('keeps a failed score draft for Retry and retries the same revision exactly once', async () => {
  const user = userEvent.setup()
  renderJournal('/teacher/journals?course=11&group=21&tab=work&assessment=44')
  const score = await screen.findByRole('spinbutton', {
    name: 'Баллы: Анна Иванова · Контрольная',
  })
  failNextScoreWrite = true
  await user.type(score, '6')
  await user.tab()
  const student = score.closest<HTMLElement>('tr')!
  const retry = await within(student).findByRole('button', { name: 'Повторить' })
  expect(score).toHaveValue(6)
  await user.click(retry)
  await waitFor(() => expect(fixtures.scores[0]?.score).toBe(6))
  expect(score).toHaveValue(6)
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.filter(
        ([url, init]) =>
          String(url).includes('/assessments/44/results/1') && init?.method === 'PUT',
      ),
  ).toHaveLength(2)
})

it('retains final grade drafts and retry across journal tabs, then reconciles cleared retake fields', async () => {
  const user = userEvent.setup()
  renderJournal('/teacher/journals?course=11&group=21&tab=work&assessment=44')
  const finals = await openFinals(user)
  const grade = await within(finals).findByLabelText('Итог: Анна Иванова')
  failNextFinalWrite = true
  await user.selectOptions(grade, '2')
  await screen.findByRole('button', { name: 'Повторить' })
  expect(grade).toHaveValue('2')

  await user.click(screen.getByRole('tab', { name: 'Посещаемость' }))
  await user.click(screen.getByRole('tab', { name: 'Работы и баллы' }))
  const remountedFinals = await openFinals(user)
  const retainedGrade = within(remountedFinals).getByLabelText('Итог: Анна Иванова')
  expect(retainedGrade).toHaveValue('2')
  await user.click(within(remountedFinals).getByRole('button', { name: 'Повторить' }))
  await waitFor(() => expect(fixtures.final.grade_value).toBe(2))

  await user.click(
    within(remountedFinals).getByRole('button', { name: 'Назначить пересдачу: Анна Иванова' }),
  )
  const dialog = await screen.findByRole('dialog')
  const date = within(dialog).getByLabelText('Дата пересдачи')
  const location = within(dialog).getByLabelText('Место пересдачи')
  await user.type(date, '2027-01-10')
  await user.type(location, 'A-101')
  await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
  await waitFor(() => expect(fixtures.final.retake_date).toBe('2027-01-10'))
  await waitFor(() => expect(fixtures.final.retake_location).toBe('A-101'))
  await user.click(within(dialog).getByRole('button', { name: 'Отмена' }))
  await user.click(
    within(remountedFinals).getByRole('button', { name: 'Изменить пересдачу: Анна Иванова' }),
  )
  const reopenedDialog = await screen.findByRole('dialog')
  expect(within(reopenedDialog).getByLabelText('Дата пересдачи')).toHaveValue('2027-01-10')
  expect(within(reopenedDialog).getByLabelText('Место пересдачи')).toHaveValue('A-101')
  await user.click(within(reopenedDialog).getByRole('button', { name: 'Отмена' }))

  await user.selectOptions(retainedGrade, '4')
  await waitFor(() => expect(fixtures.final.grade_value).toBe(4))
  await waitFor(() => expect(fixtures.final.retake_date).toBeNull())
  expect(
    within(remountedFinals).queryByRole('button', { name: /пересдачу: Анна Иванова/ }),
  ).not.toBeInTheDocument()
  await user.selectOptions(retainedGrade, '2')
  await waitFor(() => expect(fixtures.final.grade_value).toBe(2))
  await user.click(
    within(remountedFinals).getByRole('button', { name: 'Назначить пересдачу: Анна Иванова' }),
  )
  const newDialog = await screen.findByRole('dialog')
  expect(within(newDialog).getByLabelText('Дата пересдачи')).toHaveValue('')
  expect(within(newDialog).getByLabelText('Место пересдачи')).toHaveValue('')
  await user.click(within(newDialog).getByRole('button', { name: 'Отмена' }))
})

it('keeps resit assignment unavailable until debt is confirmed by the server', async () => {
  const user = userEvent.setup()
  Object.assign(fixtures.final, { grade_value: 4, has_debt: false })
  renderJournal('/teacher/journals?course=11&group=21&tab=work&assessment=44')
  const finals = await openFinals(user)
  const grade = await within(finals).findByLabelText('Итог: Анна Иванова')
  expect(
    within(finals).queryByRole('button', { name: 'Назначить пересдачу: Анна Иванова' }),
  ).not.toBeInTheDocument()
  expect(grade).toHaveValue('4')

  failNextFinalWrite = true
  await user.selectOptions(grade, '2')
  await screen.findByRole('button', { name: 'Повторить' })
  expect(grade).toHaveValue('2')
  expect(
    within(finals).queryByRole('button', { name: 'Назначить пересдачу: Анна Иванова' }),
  ).not.toBeInTheDocument()
  expect(fixtures.final.grade_value).toBe(4)

  await user.click(screen.getByRole('button', { name: 'Повторить' }))
  await waitFor(() => expect(fixtures.final.grade_value).toBe(2))
  const resitButton = await within(finals).findByRole('button', {
    name: 'Назначить пересдачу: Анна Иванова',
  })
  await waitFor(() => expect(resitButton).toBeEnabled())
  await user.click(resitButton)
  const dialog = await screen.findByRole('dialog')
  await user.type(within(dialog).getByLabelText('Дата пересдачи'), '2027-01-10')
  await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
  await waitFor(() => expect(fixtures.final.retake_date).toBe('2027-01-10'))
})

it('does not confirm or clear a final draft when a successful response normalizes it', async () => {
  const user = userEvent.setup()
  Object.assign(fixtures.final, { grade_value: 2, has_debt: true })
  let normalizeRetakeResponse = true
  vi.mocked(apiFetch).mockImplementation(async (input, init = {}) => {
    const url = String(input)
    if (url.startsWith('/api/v1/teaching/assignments')) return page([assignment])
    if (url.endsWith('/students?limit=100')) return page(fixtures.marks.map((row) => ({ ...row })))
    if (url.endsWith('/lessons?limit=100')) return page([lesson])
    if (url.endsWith('/assessments?limit=100')) return page([assessment])
    if (url.endsWith('/final-results?limit=100')) return page([{ ...fixtures.final }])
    if (url.includes('/final-results/courses/11/students/')) {
      if (init.body) {
        Object.assign(fixtures.final, JSON.parse(String(init.body)))
        return {
          ...fixtures.final,
          retake_date: normalizeRetakeResponse ? null : fixtures.final.retake_date,
        }
      }
      return { ...fixtures.final }
    }
    if (url.endsWith('/lessons/31/attendance?limit=100')) return page(fixtures.marks)
    if (url.includes('/lessons/31/attendance?')) return page([])
    if (url.endsWith('/assessments/44/results?limit=100')) return page(fixtures.scores)
    if (url.includes('/assessments/44/results?')) return page([])
    if (url.endsWith('/dates')) return { items: [] }
    throw new Error(`Unexpected journal request: ${url}`)
  })

  renderJournal('/teacher/journals?course=11&group=21&tab=work&assessment=44')
  const finals = await openFinals(user)
  await user.click(within(finals).getByRole('button', { name: 'Назначить пересдачу: Студент 1' }))
  const dialog = await screen.findByRole('dialog')
  const date = within(dialog).getByLabelText('Дата пересдачи')
  await user.type(date, '2027-01-10')
  await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
  await waitFor(() =>
    expect(screen.getAllByText(/Сервер сохранил другое значение/).length).toBeGreaterThan(0),
  )
  expect(date).toHaveValue('2027-01-10')
  expect(fixtures.final.retake_date).toBe('2027-01-10')
  expect(screen.queryByText('Сохранено')).not.toBeInTheDocument()

  normalizeRetakeResponse = false
  await user.clear(date)
  await user.type(date, '2027-01-10')
  await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
  await waitFor(() => expect(within(dialog).getByText('Сохранено')).toBeInTheDocument())
})
