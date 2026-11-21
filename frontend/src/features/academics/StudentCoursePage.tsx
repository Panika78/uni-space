import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ApiClientError } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'
import { Icon } from '../../shared/ui/Icon'
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/StatusStates'
import { StudentAnnouncementFeed } from '../announcements/AnnouncementFeed'
import { useStudentReadScope } from '../profile/profileContext'
import { getStudentRead, type StudentReadScope } from '../profile/studentReads'
import { formatDate, formatTime, getMoscowDate } from '../schedule/calendar'
import './studentCourse.css'

type Course = components['schemas']['StudentCourse']
type Lesson = components['schemas']['StudentCourseLesson']
type Assessment = components['schemas']['StudentCourseAssessment']
type CoursePage<T> = { items: T[]; next_cursor: string | null }

const tabs = [
  ['assessments', 'Работы и баллы'],
  ['attendance', 'Посещаемость'],
  ['announcements', 'Объявления'],
] as const
type Tab = (typeof tabs)[number][0]
const readings = {
  refetchOnMount: 'always',
  refetchOnWindowFocus: 'always',
  refetchOnReconnect: 'always',
  gcTime: 0,
} as const
const assessmentTypes: Record<Assessment['type'], string> = {
  test: 'Контрольная',
  laboratory: 'Лабораторная',
  practical: 'Практическая',
  seminar: 'Семинар',
  independent: 'Самостоятельная',
  extended_homework: 'Расширенное домашнее задание',
  exam: 'Экзамен',
  other: 'Другое',
}
const lessonTypes: Record<Lesson['kind'], string> = {
  lecture: 'Лекция',
  seminar: 'Семинар',
  lab: 'Лабораторное занятие',
  other: 'Занятие',
}
const longDate = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})
const numericDate = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
})

function formatCourseDate(date: string) {
  return longDate.format(new Date(`${date}T12:00:00Z`)).replace(/\sг\.$/, '')
}

function formatAssessmentDate(date: string) {
  return numericDate.format(new Date(`${date}T12:00:00Z`))
}
function useRecoverStudentScope(error: unknown) {
  const client = useQueryClient()
  const changed = error instanceof ApiClientError && error.code === 'student_scope_changed'
  useEffect(() => {
    if (changed) void client.invalidateQueries({ queryKey: ['student-profile'] })
  }, [changed, client])
}

function CourseError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const status = error instanceof ApiClientError ? error.status : undefined
  const title =
    status === 401
      ? 'Сессия завершена'
      : status === 403
        ? 'Доступ запрещён'
        : status === 404
          ? 'Дисциплина недоступна'
          : status === 422
            ? 'Некорректный адрес или страница'
            : 'Не удалось загрузить данные дисциплины'
  return (
    <ErrorState
      title={title}
      description={
        status === 404
          ? 'Проверьте список дисциплин текущего семестра.'
          : status === 401
            ? 'Войдите в аккаунт заново.'
            : undefined
      }
      onRetry={status === 401 || status === 403 || status === 404 ? undefined : onRetry}
    />
  )
}

export function StudentCoursePage() {
  const { courseOfferingId = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const tab = tabs.find(([id]) => id === params.get('tab'))?.[0] ?? 'assessments'
  const access = useStudentReadScope()
  const scope = access?.scope ?? null
  const location = useLocation()
  const navigate = useNavigate()
  const client = useQueryClient()
  const heading = useRef<HTMLHeadingElement>(null)
  const tabButtons = useRef<Array<HTMLButtonElement | null>>([])
  const path = `/api/v1/academics/courses/${encodeURIComponent(courseOfferingId)}`
  const rootKey = ['student-course', ...(scope?.key ?? []), courseOfferingId] as const
  const passport = useQuery({
    ...readings,
    queryKey: [...rootKey, 'passport'],
    queryFn: ({ signal }) => getStudentRead<Course>(path, signal, scope),
  })
  useRecoverStudentScope(passport.error)
  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
  }, [courseOfferingId])

  function selectTab(next: Tab) {
    setParams(next === 'assessments' ? {} : { tab: next }, {
      state: location.state,
      replace: true,
      preventScrollReset: true,
    })
  }

  function handleTabKey(event: KeyboardEvent, index: number) {
    const last = tabs.length - 1
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? last
          : event.key === 'ArrowRight'
            ? (index + 1) % tabs.length
            : event.key === 'ArrowLeft'
              ? (index + last) % tabs.length
              : null
    if (next === null) return
    event.preventDefault()
    selectTab(tabs[next][0])
    tabButtons.current[next]?.focus()
  }

  async function refresh() {
    const result = await passport.refetch()
    if (result.isError) return
    await Promise.all([
      client.resetQueries({ queryKey: [...rootKey, 'lists'] }),
      client.invalidateQueries({
        queryKey: ['course-announcements', scope?.key[1], 'student', courseOfferingId],
      }),
    ])
  }
  const source: unknown = location.state?.courseSource
  const previous = source === '/schedule' || source === '/academics' ? source : null
  const course = !access?.isChecking && passport.isSuccess ? passport.data : undefined
  function renderPanelContent(panelTab: Tab) {
    if (panelTab === 'announcements') {
      return <StudentAnnouncementFeed courseId={courseOfferingId} />
    }
    if (panelTab === 'assessments') {
      return (
        <CourseList<Assessment>
          path={`${path}/assessments`}
          queryKey={[...rootKey, 'lists', course!.term.id, 'assessments']}
          scope={scope}
          termId={course!.term.id}
          empty="Работ нет"
        >
          {(items) => <CourseAssessments items={items} />}
        </CourseList>
      )
    }
    return (
      <CourseList<Lesson>
        path={`${path}/lessons`}
        queryKey={[...rootKey, 'lists', course!.term.id, 'lessons']}
        scope={scope}
        termId={course!.term.id}
        empty="Занятий нет"
      >
        {(items) => <CourseAttendance items={items} />}
      </CourseList>
    )
  }

  return (
    <section className="section-page student-course" aria-labelledby="student-course-title">
      {previous ? (
        <button
          className="ui-back-link student-course__back"
          type="button"
          onClick={() => void navigate(-1)}
        >
          <Icon name="left" />
          {previous === '/schedule' ? 'К расписанию' : 'К успеваемости'}
        </button>
      ) : (
        <Link className="ui-back-link student-course__back" to="/academics">
          <Icon name="left" />К успеваемости
        </Link>
      )}
      <h1 id="student-course-title" ref={heading} tabIndex={-1}>
        {course?.discipline.name ?? 'Дисциплина'}
      </h1>
      {passport.isPending || access?.isChecking ? (
        <LoadingState title="Загружаем дисциплину…" />
      ) : !course ? (
        <CourseError error={passport.error} onRetry={() => void refresh()} />
      ) : (
        <>
          <header className="student-course__header">
            <div>
              <p>
                {course.term.name} · {course.group.name}
              </p>
              {course.teachers.length > 0 && (
                <p>{course.teachers.map((teacher) => teacher.name).join(', ')}</p>
              )}
            </div>
            <button
              className="student-course__refresh"
              type="button"
              aria-disabled={passport.isFetching}
              onClick={() => {
                if (!passport.isFetching) void refresh()
              }}
            >
              {passport.isFetching ? 'Обновляем…' : 'Обновить'}
            </button>
          </header>
          <h2 className="student-course__details-heading">Сведения по дисциплине</h2>
          <div className="student-course__tabs" role="tablist" aria-label="Дисциплина">
            {tabs.map(([id, label], index) => (
              <button
                key={id}
                type="button"
                id={`course-tab-${id}`}
                ref={(button) => {
                  tabButtons.current[index] = button
                }}
                role="tab"
                aria-selected={id === tab}
                aria-controls={`course-panel-${id}`}
                tabIndex={id === tab ? 0 : -1}
                onClick={() => selectTab(id)}
                onKeyDown={(event) => handleTabKey(event, index)}
              >
                {label}
              </button>
            ))}
          </div>
          {tabs.map(([panelTab]) => (
            <section
              key={panelTab}
              className={`student-course__panel student-course__panel--${panelTab}`}
              id={`course-panel-${panelTab}`}
              role="tabpanel"
              aria-labelledby={`course-tab-${panelTab}`}
              tabIndex={0}
              hidden={panelTab !== tab}
            >
              {panelTab === tab ? renderPanelContent(panelTab) : null}
            </section>
          ))}
        </>
      )}
    </section>
  )
}

function CourseList<T>({
  path,
  queryKey,
  scope,
  termId,
  empty,
  children,
}: {
  path: string
  queryKey: readonly unknown[]
  scope: StudentReadScope | null
  termId: string
  empty: string
  children: (items: T[]) => ReactNode
}) {
  const client = useQueryClient()
  const query = useInfiniteQuery({
    ...readings,
    queryKey,
    initialPageParam: null as string | null,
    getNextPageParam: (page: CoursePage<T>) => page.next_cursor,
    queryFn: ({ pageParam, signal }) =>
      getStudentRead<CoursePage<T>>(
        pageParam ? `${path}?${new URLSearchParams({ cursor: pageParam })}` : path,
        signal,
        scope,
        termId,
      ),
  })
  useRecoverStudentScope(query.error)
  if (query.isPending) return <LoadingState title="Загружаем данные…" variant="compact" />
  if (query.isError) {
    return (
      <CourseError
        error={query.error}
        onRetry={() => void client.resetQueries({ queryKey, exact: true })}
      />
    )
  }
  const items = query.data.pages.flatMap((page) => page.items)
  if (!items.length) return <EmptyState title={empty} />
  return (
    <>
      {children(items)}
      {query.hasNextPage && (
        <button
          type="button"
          className="student-course__more"
          aria-disabled={query.isFetching}
          onClick={() => {
            if (!query.isFetching) void query.fetchNextPage()
          }}
        >
          {query.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё'}
        </button>
      )}
      <span role="status" className="student-course__status">
        {query.isFetchingNextPage ? 'Загружаем следующую страницу' : ''}
      </span>
    </>
  )
}

function LessonStatus({ lesson }: { lesson: Lesson }) {
  const location = lesson.latest_lesson?.starts_at
  const previous = lesson.previous_lesson?.starts_at
  return (
    <>
      {lesson.status === 'cancelled' && (
        <span className="student-course__lesson-status">Отменено</span>
      )}
      {lesson.status === 'moved' && (
        <span className="student-course__lesson-status">
          {location
            ? `Перенесено на ${formatDate(getMoscowDate(new Date(location)))}, ${formatTime(location)}`
            : 'Перенесено'}
          {lesson.latest_lesson?.status === 'cancelled' && ' · Отменено'}
        </span>
      )}
      {lesson.status !== 'moved' && previous && (
        <span className="student-course__lesson-status">
          Перенесено с {formatDate(getMoscowDate(new Date(previous)))}, {formatTime(previous)}
        </span>
      )}
    </>
  )
}

function CourseAttendance({ items }: { items: Lesson[] }) {
  return (
    <ul className="student-course__rows student-course__rows--attendance">
      {items.map((lesson) => (
        <li key={lesson.id}>
          <Icon name="calendar" />
          <div className="student-course__lesson-info">
            <strong>
              <time dateTime={lesson.starts_at}>
                {formatCourseDate(getMoscowDate(new Date(lesson.starts_at)))}
              </time>
            </strong>
            <span>{lessonTypes[lesson.kind]}</span>
            <LessonStatus lesson={lesson} />
          </div>
          <span
            className="student-course__attendance-status"
            data-status={lesson.attendance_status}
          >
            {lesson.attendance_status !== 'unmarked' && (
              <span className="student-course__status-dot" aria-hidden="true" />
            )}
            {lesson.attendance_status === 'attended'
              ? 'Присутствие'
              : lesson.attendance_status === 'absent'
                ? 'Отсутствие'
                : 'Не отмечено'}
            {lesson.status !== 'scheduled' && lesson.attendance_status !== 'unmarked' && (
              <span className="student-course__historical-mark"> · Историческая отметка</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

function CourseAssessments({ items }: { items: Assessment[] }) {
  return (
    <table className="student-course__assessment-table">
      <thead>
        <tr>
          <th scope="col">Работа</th>
          <th scope="col">Тип</th>
          <th scope="col">Дата</th>
          <th scope="col">Баллы</th>
        </tr>
      </thead>
      <tbody>
        {items.map((work) => (
          <tr key={work.assessment_group_id}>
            <th scope="row">
              <span className="student-course__assessment-title">{work.title}</span>
              {work.description && (
                <small className="student-course__assessment-description">{work.description}</small>
              )}
            </th>
            <td data-label="Тип">{assessmentTypes[work.type]}</td>
            <td data-label="Дата">
              {work.planned_date ? (
                <>
                  <time dateTime={work.planned_date}>
                    {formatAssessmentDate(work.planned_date)}
                  </time>
                  {work.date_needs_confirmation && (
                    <small className="student-course__assessment-note">
                      Дата требует подтверждения
                    </small>
                  )}
                </>
              ) : (
                <>
                  <span>—</span>
                  {work.date_needs_confirmation && (
                    <small className="student-course__assessment-note">
                      Дата требует подтверждения
                    </small>
                  )}
                </>
              )}
            </td>
            <td data-label="Баллы" className="student-course__assessment-score">
              <strong>{work.score === null ? '—' : `${work.score} / ${work.max_score}`}</strong>
              {work.score === null && (
                <span className="sr-only">
                  Не выставлено. <span>Максимум {work.max_score}</span>
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
