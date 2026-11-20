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

it('keeps every tab panel linked, builds the reference overview, and loads tab data on demand', async () => {
  vi.mocked(getStudentRead).mockImplementation(async (path) => {
    if (path.endsWith('/assessments') || path.endsWith('/lessons')) {
      return { items: [], next_cursor: null } as never
    }
    return course as never
  })
  const user = userEvent.setup()
  show()

  const overview = await screen.findByRole('tab', { name: 'Обзор' })
  const tabNames = ['Обзор', 'Занятия', 'Работы и баллы', 'Посещаемость', 'Объявления']
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
  await screen.findByText('Отмеченных занятий')
  expect(getStudentRead).toHaveBeenCalledTimes(2)
  expect(getStudentRead).toHaveBeenCalledWith(
    '/api/v1/academics/courses/course-101',
    expect.any(AbortSignal),
    expect.objectContaining({ header: 'scope-1' }),
  )
  expect(panels[0]).not.toHaveAttribute('hidden')
  expect(panels[0]).toHaveAttribute('tabIndex', '0')
  expect(within(panels[0]).getByText('Экзамен')).toBeInTheDocument()
  for (const index of [1, 2, 3, 4]) {
    expect(panels[index]).toHaveAttribute('hidden')
    expect(panels[index]).toBeEmptyDOMElement()
    expect(tabs[index]).toHaveAttribute('aria-selected', 'false')
    expect(tabs[index]).toHaveAttribute('tabIndex', '-1')
  }
  expect(overview).toHaveAttribute('aria-selected', 'true')
  expect(overview).toHaveAttribute('tabIndex', '0')

  overview.focus()
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

  await user.keyboard('{ArrowRight}')
  expect(tabs[2]).toHaveFocus()
  expect(panels[2]).not.toHaveAttribute('hidden')
  expect(await within(panels[2]).findByText('Работ нет')).toBeInTheDocument()
  expect(getStudentRead).toHaveBeenCalledWith(
    '/api/v1/academics/courses/course-101/assessments',
    expect.any(AbortSignal),
    expect.objectContaining({ header: 'scope-1' }),
    'term-1',
  )

  await user.keyboard('{End}')
  expect(tabs[4]).toHaveFocus()
  expect(panels[4]).not.toHaveAttribute('hidden')
  expect(within(panels[4]).getByText('Объявления по проведению course-101')).toBeInTheDocument()
  expect(panels[2]).toHaveAttribute('hidden')

  await user.keyboard('{ArrowLeft}')
  expect(tabs[3]).toHaveFocus()
  expect(panels[3]).not.toHaveAttribute('hidden')
  expect(await within(panels[3]).findByText('Занятий нет')).toBeInTheDocument()
  await user.keyboard('{Home}')
  expect(tabs[0]).toHaveFocus()
  expect(panels[0]).not.toHaveAttribute('hidden')
  expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
})

it('shows marked attendance totals from the real lesson response in the overview', async () => {
  vi.mocked(getStudentRead).mockImplementation(async (path) => {
    if (path.endsWith('/lessons'))
      return {
        items: [{ attendance_status: 'attended' }, { attendance_status: 'unmarked' }],
        next_cursor: null,
      } as never
    return course as never
  })
  show()
  const overview = await screen.findByRole('tab', { name: 'Обзор' })
  expect(
    await within(document.getElementById(overview.getAttribute('aria-controls')!)!).findByText(
      '1 / 2',
    ),
  ).toBeInTheDocument()
})
