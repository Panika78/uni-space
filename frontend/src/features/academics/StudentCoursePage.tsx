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
import {
  formatDate,
  formatLessonTimeRange,
  formatTime,
  getMoscowDate,
  lessonKinds,
} from '../schedule/calendar'
import { attestationLabels, SessionResult } from './AcademicsPage'
import { AttendanceMark } from './AttendanceMark'
import './studentCourse.css'

type Course = components['schemas']['StudentCourse']
type Lesson = components['schemas']['StudentCourseLesson']
type Assessment = components['schemas']['StudentCourseAssessment']
type CoursePage<T> = { items: T[]; next_cursor: string | null }

const tabs = [
  ['overview', 'Обзор'],
  ['lessons', 'Занятия'],
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
  test: 'Контрольные работы',
  laboratory: 'Лабораторные работы',
  practical: 'Практические работы',
  seminar: 'Семинары',
  independent: 'Самостоятельные работы',
  extended_homework: 'Расширенные домашние задания',
  exam: 'Экзамены',
  other: 'Другие работы',
}
const monthFormat = new Intl.DateTimeFormat('ru-RU', {
  month: 'long',
  year: 'numeric',
  timeZone: 'Europe/Moscow',
})

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
  const tab = tabs.find(([id]) => id === params.get('tab'))?.[0] ?? 'overview'
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
    setParams(next === 'overview' ? {} : { tab: next }, {
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

  return (
    <section className="section-page student-course" aria-labelledby="student-course-title">
      {previous ? (
        <button className="student-course__back" onClick={() => void navigate(-1)}>
          <Icon name="left" />
          {previous === '/schedule' ? 'К расписанию' : 'К успеваемости'}
        </button>
      ) : (
        <Link className="student-course__back" to="/academics">
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
              type="button"
              aria-disabled={passport.isFetching}
              onClick={() => {
                if (!passport.isFetching) void refresh()
              }}
            >
              {passport.isFetching ? 'Обновляем…' : 'Обновить'}
            </button>
          </header>
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
          <section
            className="student-course__panel"
            id={`course-panel-${tab}`}
            role="tabpanel"
            aria-labelledby={`course-tab-${tab}`}
            tabIndex={0}
          >
            {tab === 'overview' ? (
              <CourseOverview course={course} />
            ) : tab === 'announcements' ? (
              <StudentAnnouncementFeed courseId={courseOfferingId} />
            ) : tab === 'assessments' ? (
              <CourseList<Assessment>
                path={`${path}/assessments`}
                queryKey={[...rootKey, 'lists', course.term.id, 'assessments']}
                scope={scope}
                termId={course.term.id}
                empty="Работ нет"
              >
                {(items) => <CourseAssessments items={items} />}
              </CourseList>
            ) : (
              <CourseList<Lesson>
                path={`${path}/lessons`}
                queryKey={[...rootKey, 'lists', course.term.id, 'lessons']}
                scope={scope}
                termId={course.term.id}
                empty="Занятий нет"
              >
                {(items) =>
                  tab === 'lessons' ? (
                    <CourseLessons items={items} />
                  ) : (
                    <CourseAttendance items={items} />
                  )
                }
              </CourseList>
            )}
          </section>
        </>
      )}
    </section>
  )
}

function CourseOverview({ course }: { course: Course }) {
  return (
    <dl className="student-course__overview">
      <div>
        <dt>Форма аттестации</dt>
        <dd>{attestationLabels[course.attestation_type]}</dd>
      </div>
      <div>
        <dt>Полученные баллы</dt>
        <dd>
          {course.assessment_count ? (
            <>
              {course.graded_assessment_count ? (
                <strong>
                  {course.total_score} / {course.max_score}
                </strong>
              ) : (
                <>
                  <strong>Не выставлено</strong>
                  <p>Максимум {course.max_score}</p>
                </>
              )}
              <p>
                Оценено {course.graded_assessment_count} из {course.assessment_count}
              </p>
            </>
          ) : (
            'Работ нет'
          )}
        </dd>
      </div>
      <div>
        <dt>Итог аттестации</dt>
        <dd>
          <SessionResult item={course} />
        </dd>
      </div>
    </dl>
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

function LessonTime({ lesson }: { lesson: Lesson }) {
  return (
    <>
      <time dateTime={lesson.starts_at}>
        {formatDate(getMoscowDate(new Date(lesson.starts_at)))}
      </time>
      {' · '}
      {formatLessonTimeRange(lesson.starts_at, lesson.ends_at)}
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

function groupItems<T, K>(items: T[], key: (item: T) => K) {
  const groups = new Map<K, T[]>()
  for (const item of items) {
    const group = key(item)
    const list = groups.get(group)
    if (list) list.push(item)
    else groups.set(group, [item])
  }
  return groups
}

function CourseLessons({ items }: { items: Lesson[] }) {
  const months = groupItems(items, (lesson) =>
    getMoscowDate(new Date(lesson.starts_at)).slice(0, 7),
  )
  return Array.from(months, ([month, lessons]) => (
    <details className="student-course__group" key={month} open>
      <summary>{monthFormat.format(new Date(`${month}-15T12:00:00Z`))}</summary>
      <ul className="student-course__rows">
        {lessons.map((lesson) => (
          <li key={lesson.id}>
            <strong>
              <LessonTime lesson={lesson} />
            </strong>
            <span>
              {lessonKinds[lesson.kind]}
              {lesson.teacher && ` · ${lesson.teacher.name}`}
            </span>
            {lesson.rooms.length > 0 && (
              <span>
                {lesson.rooms.map((room) => `${room.building.name} · ${room.name}`).join(', ')}
              </span>
            )}
            <LessonStatus lesson={lesson} />
          </li>
        ))}
      </ul>
    </details>
  ))
}

function CourseAttendance({ items }: { items: Lesson[] }) {
  return (
    <ul className="student-course__rows student-course__rows--attendance">
      {items.map((lesson) => (
        <li key={lesson.id}>
          <div>
            <strong>
              <LessonTime lesson={lesson} />
            </strong>
            <span>{lessonKinds[lesson.kind]}</span>
            <LessonStatus lesson={lesson} />
          </div>
          {lesson.status === 'scheduled' ? (
            <AttendanceMark status={lesson.attendance_status} />
          ) : lesson.attendance_status !== 'unmarked' ? (
            <AttendanceMark status={lesson.attendance_status} historical />
          ) : (
            <AttendanceMark status="unmarked" />
          )}
        </li>
      ))}
    </ul>
  )
}

function CourseAssessments({ items }: { items: Assessment[] }) {
  const groups = groupItems(items, (item) => item.type)
  return Array.from(groups, ([type, assessments]) => (
    <details className="student-course__group" key={type} open>
      <summary>{assessmentTypes[type]}</summary>
      <ul className="student-course__rows student-course__rows--assessments">
        {assessments.map((work) => (
          <li key={work.assessment_group_id}>
            <div>
              <strong>{work.title}</strong>
              {work.date_needs_confirmation && <span>Дата требует подтверждения</span>}
              <span>
                {work.planned_date ? (
                  <>
                    {work.date_needs_confirmation && 'Последняя известная дата · '}
                    <time dateTime={work.planned_date}>{formatDate(work.planned_date, true)}</time>
                  </>
                ) : (
                  'Дата не назначена'
                )}
              </span>
              {work.description && <span>{work.description}</span>}
            </div>
            <div className="student-course__score">
              <strong>
                {work.score === null ? 'Не выставлено' : `${work.score} / ${work.max_score}`}
              </strong>
              {work.score === null && <span>Максимум {work.max_score}</span>}
            </div>
          </li>
        ))}
      </ul>
    </details>
  ))
}
