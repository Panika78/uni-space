import type { ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '../../app/queryClient'
import type { components } from '../../shared/api/schema'
import { ProfileContext, StudentReadContext } from '../profile/profileContext'
import { getStudentRead } from '../profile/studentReads'
import { StudentCoursePage } from './StudentCoursePage'

vi.mock('../profile/studentReads', () => ({ getStudentRead: vi.fn() }))
vi.mock('../announcements/AnnouncementFeed', () => ({
  StudentAnnouncementFeed: ({ courseId }: { courseId: string }) => (
    <p>Объявления по проведению {courseId}</p>
  ),
}))

const course: components['schemas']['StudentCourse'] = {
  course_offering_id: 'course-101',
  discipline: { id: 'discipline-1', name: 'Вымышленная дисциплина' },
  term: {
    id: 'term-1',
    name: 'Осень 2026',
    starts_on: '2026-09-01',
    ends_on: '2027-01-31',
  },
  group: { id: 'group-1', name: 'Тестовая группа' },
  teachers: [{ id: 'teacher-1', name: 'Анна Тестовая' }],
  attestation_type: 'exam',
  assessment_count: 0,
  graded_assessment_count: 0,
  total_score: 0,
  max_score: 0,
  final_result: {
    grade_value: null,
    passed: null,
    has_debt: false,
    retake_date: null,
    retake_location: null,
  },
}

function show() {
  const queryClient = createQueryClient()
  const scope = {
    key: ['student', 'user-1', 'group-1', 'scope-1'] as const,
    header: 'scope-1',
  }
  const profile = {
    id: 'user-1',
    full_name: 'Вымышленный Студент',
    group: { id: 'group-1', name: 'Тестовая группа' },
  } as components['schemas']['StudentProfile']
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ProfileContext.Provider value={profile}>
        <StudentReadContext.Provider value={{ scope, isChecking: false }}>
          <MemoryRouter initialEntries={['/academics/courses/course-101']}>
            <Routes>
              <Route path="/academics/courses/:courseOfferingId" element={children} />
            </Routes>
          </MemoryRouter>
        </StudentReadContext.Provider>
      </ProfileContext.Provider>
    </QueryClientProvider>
  )
  render(<StudentCoursePage />, { wrapper })
}

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

it('starts with work and scores and omits overview and lesson tabs', async () => {
  vi.mocked(getStudentRead).mockImplementation(async (path) => {
    if (path.endsWith('/assessments') || path.endsWith('/lessons')) {
      return { items: [], next_cursor: null } as never
    }
    return course as never
  })
  const user = userEvent.setup()
  show()

  const work = await screen.findByRole('tab', { name: 'Работы и баллы' })
  expect(screen.queryByRole('tab', { name: 'Обзор' })).not.toBeInTheDocument()
  expect(screen.queryByRole('tab', { name: 'Занятия' })).not.toBeInTheDocument()
  const tabNames = ['Работы и баллы', 'Посещаемость', 'Объявления']
  const tabs = tabNames.map((name) => screen.getByRole('tab', { name }))
  const panels = tabNames.map((_, index) => {
    const id = tabs[index].getAttribute('aria-controls')
    expect(id).toBeTruthy()
    const panel = document.getElementById(id!)
    expect(panel).toHaveAttribute('role', 'tabpanel')
    expect(panel).toHaveAttribute('aria-labelledby', tabs[index].id)
    return panel!
  })

  expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
  expect(await within(panels[0]).findByText('Работ нет')).toBeInTheDocument()
  expect(getStudentRead).toHaveBeenCalledTimes(2)
  expect(getStudentRead).toHaveBeenCalledWith(
    '/api/v1/academics/courses/course-101',
    expect.any(AbortSignal),
    expect.objectContaining({ header: 'scope-1' }),
  )
  expect(panels[0]).not.toHaveAttribute('hidden')
  expect(panels[0]).toHaveAttribute('tabIndex', '0')
  for (const index of [1, 2]) {
    expect(panels[index]).toHaveAttribute('hidden')
    expect(panels[index]).toBeEmptyDOMElement()
    expect(tabs[index]).toHaveAttribute('aria-selected', 'false')
    expect(tabs[index]).toHaveAttribute('tabIndex', '-1')
  }
  expect(work).toHaveAttribute('aria-selected', 'true')
  expect(work).toHaveAttribute('tabIndex', '0')
  expect(document.querySelector('.student-course__tabs')?.getAttribute('style')).toContain(
    '--tab-width',
  )

  work.focus()
  await user.keyboard('{ArrowRight}')
  expect(tabs[1]).toHaveFocus()
  expect(tabs[1]).toHaveAttribute('aria-selected', 'true')
  expect(panels[1]).not.toHaveAttribute('hidden')
  expect(await within(panels[1]).findByText('Занятий нет')).toBeInTheDocument()
  expect(getStudentRead).toHaveBeenCalledWith(
    '/api/v1/academics/courses/course-101/lessons',
    expect.any(AbortSignal),
    expect.objectContaining({ header: 'scope-1' }),
    'term-1',
  )

  await user.keyboard('{End}')
  expect(tabs[2]).toHaveFocus()
  expect(panels[2]).not.toHaveAttribute('hidden')
  expect(within(panels[2]).getByText('Объявления по проведению course-101')).toBeInTheDocument()
  expect(panels[0]).toHaveAttribute('hidden')

  await user.keyboard('{ArrowLeft}')
  expect(tabs[1]).toHaveFocus()
  expect(panels[1]).not.toHaveAttribute('hidden')
  await user.keyboard('{Home}')
  expect(tabs[0]).toHaveFocus()
  expect(panels[0]).not.toHaveAttribute('hidden')
  expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
  expect(getStudentRead).toHaveBeenCalledWith(
    '/api/v1/academics/courses/course-101/assessments',
    expect.any(AbortSignal),
    expect.objectContaining({ header: 'scope-1' }),
    'term-1',
  )
})

it('shows attendance marks as styled lesson rows', async () => {
  vi.mocked(getStudentRead).mockImplementation(async (path) => {
    if (path.endsWith('/lessons'))
      return {
        items: ['attended', 'unmarked'].map((attendance_status, index) => ({
          id: `lesson-${index}`,
          attendance_status,
          starts_at: `2026-11-${10 + index}T10:00:00+03:00`,
          ends_at: `2026-11-${10 + index}T11:30:00+03:00`,
          kind: 'seminar',
          latest_lesson: null,
          previous_lesson: null,
          rooms: [],
          status: 'scheduled',
          teacher: null,
        })),
        next_cursor: null,
      } as never
    if (path.endsWith('/assessments')) return { items: [], next_cursor: null } as never
    return course as never
  })
  show()
  const attendance = await screen.findByRole('tab', { name: 'Посещаемость' })
  await userEvent.click(attendance)
  expect(await screen.findByText('Присутствие')).toBeInTheDocument()
  expect(await screen.findByText('Не отмечено')).toBeInTheDocument()
  expect(document.querySelector('.student-course__rows--attendance svg')).toBeInTheDocument()
})

it('renders work and scores in the reference table layout', async () => {
  vi.mocked(getStudentRead).mockImplementation(async (path) => {
    if (path.endsWith('/assessments'))
      return {
        items: [
          {
            assessment_group_id: 'work-1',
            assessment_id: 'assessment-1',
            date_needs_confirmation: false,
            description: null,
            graded_at: null,
            lesson_id: null,
            max_score: 10,
            planned_date: '2026-09-10',
            score: 8,
            title: 'Лабораторная работа № 1',
            type: 'laboratory',
          },
        ],
        next_cursor: null,
      } as never
    if (path.endsWith('/lessons')) return { items: [], next_cursor: null } as never
    return course as never
  })
  show()

  const table = await screen.findByRole('table')
  expect(
    within(table)
      .getAllByRole('columnheader')
      .map((header) => header.textContent),
  ).toEqual(['Работа', 'Тип', 'Дата', 'Баллы'])
  expect(within(table).getByText('Лабораторная работа № 1')).toBeInTheDocument()
  expect(within(table).getByText('Лабораторная')).toBeInTheDocument()
  expect(within(table).getByText('10.09.2026')).toBeInTheDocument()
  expect(within(table).getByText('8 / 10')).toBeInTheDocument()
  expect(within(table).queryByRole('button')).not.toBeInTheDocument()
})
