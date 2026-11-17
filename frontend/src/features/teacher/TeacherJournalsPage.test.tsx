import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '../../app/queryClient'
import { apiFetch } from '../../shared/api/client'
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
  fixtures.marks.forEach((row) => Object.assign(row, { status: row.status }))
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
      return page(fixtures.scores.filter((row) => !studentId || row.student_id === studentId))
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
      row.score = JSON.parse(String(init.body)).score
      return { result_id: row.score === null ? null : '17', score: row.score, graded_at: null }
    }
    if (url.includes('/final-results/courses/11/students/')) {
      const payload = init.body ? JSON.parse(String(init.body)) : null
      if (payload) Object.assign(fixtures.final, payload)
      return fixtures.final
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
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <TeacherJournalsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
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
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/v1/attendance/lessons/31/students/1',
    expect.objectContaining({ method: 'DELETE', authenticated: true }),
  )
  await user.click(screen.getByRole('button', { name: 'Присутствовал: Мария Петрова' }))
  await waitFor(() => expect(fixtures.marks[2]?.status).toBe('attended'))
})

it('separates an ungraded result from zero and supports scores and manual final grades', async () => {
  const user = userEvent.setup()
  renderJournal('/teacher/journals?course=11&group=21&tab=work&assessment=44')
  expect(await screen.findByText('Контрольная')).toBeInTheDocument()
  const zero = await screen.findByRole('spinbutton', { name: 'Баллы: Ёлкин Борис' })
  expect(zero).toHaveValue(0)
  const ungraded = screen.getByRole('spinbutton', { name: 'Баллы: Анна Иванова' })
  expect(ungraded).toHaveValue(null)
  await user.clear(ungraded)
  await user.type(ungraded, '10')
  await user.tab()
  await waitFor(() => expect(fixtures.scores[0]?.score).toBe(10))
  expect(apiFetch).toHaveBeenCalledWith(
    expect.stringContaining('/assessments/44/results/1'),
    expect.objectContaining({ method: 'PUT', body: JSON.stringify({ score: 10 }) }),
  )
  const finals = screen.getByRole('region', { name: /Итоги аттестации/ })
  await user.selectOptions(within(finals).getByLabelText('Итог: Анна Иванова'), '4')
  await waitFor(() => expect(fixtures.final.grade_value).toBe(4))
  expect(
    within(finals).getByText(
      'Итог выставляется вручную; сумма баллов не преобразуется в оценку автоматически.',
    ),
  ).toBeInTheDocument()
})
