import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiClientError } from '../../shared/api/client'
import { JournalEdits } from './JournalEdits'
import { useSearchParams } from 'react-router-dom'
import type { components } from '../../shared/api/schema'
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/StatusStates'
import { useRoleContext } from '../auth/RoleContext'
import { hasPermission } from '../auth/roleNavigation'
import { formatDateTime } from '../teacher/journalControls'
import { AttendanceRow, FinalRow, ScoreRow, type Final } from './StaffJournalRows'
import {
  isAccessError,
  journalError,
  journalRequest,
  pageUrl,
  staffJournal,
  useJournalQuery,
  type JournalAccess,
  type Page,
} from './journalQueries'
import {
  JournalCatalog,
  JournalCard,
  JournalCourseSection,
  JournalPageHeader,
  JournalResourcePicker,
  JournalSearch as Search,
  JournalTable,
  JournalTabPanel,
  JournalTabs,
} from './JournalWorkspace'
import '../teacher/teacherJournals.css'
import './staffJournals.css'

type Schema = components['schemas']
type CatalogItem = Schema['StaffCatalogItem']
type HistoryTarget = { name: string; path: string }
type HistoryEvent = Schema['JournalEvent_ScoreSnapshot_'] | Schema['JournalEvent_FinalSnapshot_']
type Snapshot = HistoryEvent['before']
type Tab = 'work' | 'attendance' | 'finals'
type Lesson = Schema['JournalLesson']

function moscowDay(value: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value))
  const fields = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]))
  return `${fields.year}-${fields.month}-${fields.day}`
}

function dayFromKey(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(Date.UTC(year!, month! - 1, day!))
}

function dayKey(value: Date) {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`
}

function monthName(value: Date) {
  return new Intl.DateTimeFormat('ru-RU', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(value)
}

function Pager<T>({
  access,
  path,
  filters,
  children,
}: {
  access: JournalAccess
  path: string
  filters?: Record<string, string>
  children: (items: T[]) => ReactNode
}) {
  const [stack, setStack] = useState<string[]>([])
  const query = useJournalQuery<Page<T>>(access, pageUrl(path, stack.at(-1) ?? null, filters))
  if (query.isError) {
    return (
      <ErrorState
        title="Не удалось загрузить журнал"
        description={journalError(query.error)}
        onRetry={() => void query.refetch()}
      />
    )
  }
  if (query.isPending) return <LoadingState title="Загружаем журнал…" />
  return (
    <>
      {query.data.items.length ? children(query.data.items) : <EmptyState title="Записей нет" />}
      {(stack.length > 0 || query.data.next_cursor) && (
        <nav className="staff-journal-actions" aria-label="Страницы журнала">
          <button
            type="button"
            disabled={!stack.length}
            onClick={() => setStack(stack.slice(0, -1))}
          >
            Назад
          </button>
          <button
            type="button"
            disabled={!query.data.next_cursor}
            onClick={() => {
              const next = query.data.next_cursor
              if (next && !stack.includes(next)) setStack([...stack, next])
            }}
          >
            Далее
          </button>
        </nav>
      )}
    </>
  )
}

function snapshotText(snapshot: Snapshot) {
  if (snapshot === null) return 'Записи нет'
  if ('score' in snapshot) return String(snapshot.score)
  const grade =
    snapshot.grade_value ??
    (snapshot.passed === null ? 'Не выставлен' : snapshot.passed ? 'Зачтено' : 'Не зачтено')
  return [grade, snapshot.retake_date, snapshot.retake_location]
    .filter((value) => value !== null)
    .join(' · ')
}

function HistoryDialog({
  target,
  access,
  onClose,
}: {
  target: HistoryTarget
  access: JournalAccess
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    const trigger = document.activeElement
    element?.showModal()
    return () => {
      element?.close()
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus()
    }
  }, [])
  return (
    <dialog
      ref={dialog}
      aria-labelledby="staff-journal-history-title"
      className="staff-journal-history"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <h2 id="staff-journal-history-title">История изменений</h2>
      <p>{target.name}</p>
      <button type="button" autoFocus onClick={onClose}>
        Закрыть
      </button>
      <Pager<HistoryEvent> access={access} path={target.path}>
        {(items) => (
          <ol className="staff-journal-history-list">
            {items.map((event) => (
              <li key={event.event_id}>
                <time dateTime={event.created_at}>{formatDateTime(event.created_at)}</time>
                <p>
                  {event.actor_name ??
                    (event.actor_user_id
                      ? `Пользователь №${event.actor_user_id}`
                      : 'Автор не указан')}{' '}
                  ·{' '}
                  {
                    {
                      create: 'Создание',
                      update: 'Изменение',
                      delete: 'Удаление',
                    }[event.action]
                  }
                </p>
                <dl>
                  <dt>Было</dt>
                  <dd>{snapshotText(event.before)}</dd>
                  <dt>Стало</dt>
                  <dd>{snapshotText(event.after)}</dd>
                </dl>
              </li>
            ))}
          </ol>
        )}
      </Pager>
    </dialog>
  )
}

function HistoricalFinal({
  student,
  course,
  access,
  onHistory,
}: {
  student: Schema['HistoricalFinalStudent']
  course: CatalogItem
  access: JournalAccess
  onHistory: () => void
}) {
  const [open, setOpen] = useState(false)
  const readPath = `/api/v1/final-results/courses/${course.course_offering_id}/students/${student.student_id}`
  const query = useJournalQuery<Final>(access, open && !student.history_only ? readPath : null)
  const client = useQueryClient()
  const missing =
    open &&
    ((query.isSuccess && !query.data.result_id) ||
      (query.error instanceof ApiClientError && query.error.status === 404))
  const coursePath = `${staffJournal}/courses/${course.course_offering_id}`
  const historyList = `${coursePath}/historical-final-students`
  useEffect(() => {
    if (!missing || student.history_only) return
    void client.invalidateQueries({
      queryKey: ['staff-journal', ...access],
      predicate: ({ queryKey }) => {
        const path = String(queryKey.at(-1))
        return (
          path.startsWith(`${historyList}?`) ||
          (path.startsWith(`${coursePath}/groups/`) && path.includes('/final-results?'))
        )
      },
    })
  }, [client, access, coursePath, historyList, missing, student.history_only])
  const denied = !student.history_only && isAccessError(query.error)
  if (
    open &&
    !student.history_only &&
    query.isSuccess &&
    query.data.result_id &&
    course.attestation_type
  ) {
    return (
      <FinalRow
        row={query.data}
        fullName={student.full_name}
        attestation={course.attestation_type}
        access={access}
        readPath={readPath}
        onHistory={onHistory}
      />
    )
  }
  return (
    <article className="journal-student">
      <div className="journal-student__identity">
        <strong>{student.full_name}</strong>
        {student.history_only && <small>Итог удалён</small>}
        {!student.history_only && missing && <small>Итог больше недоступен</small>}
      </div>
      {open && !student.history_only && query.isError && (
        <ErrorState
          title="Не удалось загрузить итог"
          description={journalError(query.error)}
          onRetry={denied || missing ? undefined : () => void query.refetch()}
        />
      )}
      {!denied && (
        <div className="staff-journal-actions">
          <button type="button" onClick={onHistory}>
            История изменений
          </button>
          {!student.history_only && !missing && !query.isError && (
            <button type="button" disabled={open && query.isPending} onClick={() => setOpen(true)}>
              {open && query.isPending ? 'Загружаем итог…' : 'Открыть итог'}
            </button>
          )}
        </div>
      )}
    </article>
  )
}

function GroupJournal({
  course,
  tab,
  resource,
  access,
  onResource,
  onHistory,
}: {
  course: CatalogItem
  tab: Tab
  resource: string
  access: JournalAccess
  onResource: (id: string) => void
  onHistory: (target: HistoryTarget) => void
}) {
  const [search, setSearch] = useState('')
  const [historicalSearch, setHistoricalSearch] = useState('')
  const [calendarSelection, setCalendarSelection] = useState<{ day: string; month: Date } | null>(
    null,
  )
  const coursePath = `${staffJournal}/courses/${course.course_offering_id}`
  const group = `${course.course_offering_id}/groups/${course.group.id}`
  const path = `${staffJournal}/courses/${group}`
  const assessments = useJournalQuery<Page<Schema['JournalAssessment']>>(
    access,
    tab === 'work' && resource
      ? pageUrl(`${path}/assessments`, null, { assessment_group_id: resource })
      : null,
  )
  const lessons = useQuery({
    queryKey: ['staff-journal-lessons-calendar', ...access, tab === 'attendance' ? path : null],
    enabled: tab === 'attendance',
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: 'always',
    queryFn: async ({ signal }) => {
      const items: Lesson[] = []
      const seen = new Set<string>()
      let cursor: string | null = null
      do {
        const params = new URLSearchParams({ limit: '100' })
        if (cursor) params.set('cursor', cursor)
        const page = await journalRequest<Page<Lesson>>(`${path}/lessons?${params}`, { signal })
        items.push(...page.items)
        cursor = page.next_cursor
        if (cursor && seen.has(cursor)) throw new Error('Invalid repeated journal cursor')
        if (cursor) seen.add(cursor)
      } while (cursor)
      return { items, next_cursor: null }
    },
  })
  const finalHistory = (studentId: string, name: string) =>
    onHistory({
      name,
      path: `${coursePath}/students/${studentId}/final-result/history`,
    })
  if (tab === 'finals' && course.attestation_type) {
    const attestation = course.attestation_type
    const readPath = `${path}/final-results`
    return (
      <>
        <div className="journal-finals-intro">
          <h3>Итоговая аттестация</h3>
          <p>Итоговая оценка выставляется вручную и не вычисляется автоматически из баллов.</p>
        </div>
        <Search label="Поиск по студентам группы" onSearch={setSearch} />
        <Pager<Schema['StaffFinalRow']>
          key={search}
          access={access}
          path={readPath}
          filters={{ q: search }}
        >
          {(items) => (
            <JournalTable
              label="Итоговая аттестация группы"
              className="journal-table-scroll--mobile-cards"
              columns={[
                { id: 'student', label: 'Студент' },
                {
                  id: 'result',
                  label: 'Результат',
                  hint: {
                    exam: 'Экзамен',
                    graded_pass: 'Дифференцированный зачёт',
                    pass_fail: 'Зачёт',
                  }[attestation],
                },
                { id: 'date', label: 'Дата пересдачи' },
                { id: 'location', label: 'Место пересдачи' },
                { id: 'actions', label: 'Действия' },
              ]}
            >
              {items.map((row) => (
                <FinalRow
                  key={row.student_id}
                  row={row}
                  fullName={row.full_name}
                  attestation={attestation}
                  access={access}
                  readPath={readPath}
                  onHistory={() => finalHistory(row.student_id, row.full_name)}
                  display="table-row"
                />
              ))}
            </JournalTable>
          )}
        </Pager>
        <section className="journal-finals">
          <h3>История итогов по дисциплине</h3>
          <Search label="Поиск по истории итогов" onSearch={setHistoricalSearch} />
          <Pager<Schema['HistoricalFinalStudent']>
            key={historicalSearch}
            access={access}
            path={`${coursePath}/historical-final-students`}
            filters={{ q: historicalSearch }}
          >
            {(items) => (
              <div className="journal-student-list">
                {items.map((student) => (
                  <HistoricalFinal
                    key={student.student_id}
                    student={student}
                    course={course}
                    access={access}
                    onHistory={() => finalHistory(student.student_id, student.full_name)}
                  />
                ))}
              </div>
            )}
          </Pager>
        </section>
      </>
    )
  }

  if (tab === 'work') {
    const assessment = assessments.data?.items[0]
    const readPath = `${path}/assessments/${resource}/results`
    return (
      <>
        <Pager<Schema['JournalAssessment']> access={access} path={`${path}/assessments`}>
          {(items) => (
            <JournalResourcePicker
              heading="Выбор работы"
              resources={items.map((item) => ({ id: item.id, label: item.title }))}
              selected={resource}
              onSelect={onResource}
            />
          )}
        </Pager>
        {assessments.isError && (
          <ErrorState
            title="Работа недоступна"
            description={journalError(assessments.error)}
            onRetry={() => void assessments.refetch()}
          />
        )}
        {resource && assessments.isSuccess && !assessment && (
          <EmptyState title="Работа не найдена" />
        )}
        {assessment && !assessments.isError && (
          <>
            <h3>{assessment.title}</h3>
            <p>Максимум {assessment.max_score}</p>
            <Search label="Поиск по студентам" onSearch={setSearch} />
            <Pager<Schema['StaffScoreRow']>
              key={`${resource}:${search}`}
              access={access}
              path={readPath}
              filters={{ q: search }}
            >
              {(items) => (
                <JournalTable
                  label="Таблица оценок"
                  className="journal-table-scroll--mobile-cards"
                  columns={[
                    { id: 'student', label: 'Студент' },
                    { id: 'work', label: 'Работа' },
                    { id: 'date', label: 'Дата' },
                    { id: 'score', label: 'Баллы' },
                  ]}
                >
                  {items.map((row) => (
                    <ScoreRow
                      key={row.student_id}
                      row={row}
                      assessment={assessment}
                      group={group}
                      access={access}
                      readPath={readPath}
                      onHistory={() =>
                        onHistory({
                          name: row.full_name,
                          path: `${readPath}/${row.student_id}/history`,
                        })
                      }
                      display="table-row"
                    />
                  ))}
                </JournalTable>
              )}
            </Pager>
          </>
        )}
      </>
    )
  }

  const availableLessons = lessons.data?.items ?? []
  const lesson = availableLessons.find((item) => item.id === resource)
  const selectedDay = lesson
    ? moscowDay(lesson.starts_at)
    : (calendarSelection?.day ??
      (availableLessons[0] ? moscowDay(availableLessons[0].starts_at) : ''))
  const calendarMonth =
    calendarSelection?.day === selectedDay
      ? calendarSelection.month
      : selectedDay
        ? dayFromKey(selectedDay)
        : dayFromKey(moscowDay(new Date().toISOString()))
  const lessonsByDay = new Map<string, Lesson[]>()
  for (const item of availableLessons) {
    const key = moscowDay(item.starts_at)
    lessonsByDay.set(key, [...(lessonsByDay.get(key) ?? []), item])
  }
  const monthStart = new Date(
    Date.UTC(calendarMonth.getUTCFullYear(), calendarMonth.getUTCMonth(), 1),
  )
  const monthOffset = (monthStart.getUTCDay() + 6) % 7
  const monthDays = new Date(
    Date.UTC(calendarMonth.getUTCFullYear(), calendarMonth.getUTCMonth() + 1, 0),
  ).getUTCDate()
  const calendarCells: (string | null)[] = [
    ...Array.from({ length: monthOffset }, () => null),
    ...Array.from({ length: monthDays }, (_, index) =>
      dayKey(
        new Date(Date.UTC(calendarMonth.getUTCFullYear(), calendarMonth.getUTCMonth(), index + 1)),
      ),
    ),
  ]
  const readPath = `${path}/lessons/${resource}/attendance`
  const shiftMonth = (amount: number) => {
    const month = new Date(
      Date.UTC(calendarMonth.getUTCFullYear(), calendarMonth.getUTCMonth() + amount, 1),
    )
    setCalendarSelection({ day: selectedDay, month })
  }
  return (
    <>
      <JournalCard
        heading="Посещаемость"
        description="Даты с доступными занятиями выделены календарём."
      >
        {lessons.isPending ? (
          <LoadingState title="Загружаем календарь занятий…" />
        ) : (
          <div className="journal-attendance-toolbar">
            <section className="teacher-journal-calendar" aria-label="Календарь занятий">
              <header>
                <button type="button" aria-label="Предыдущий месяц" onClick={() => shiftMonth(-1)}>
                  ‹
                </button>
                <strong>{monthName(calendarMonth)}</strong>
                <button type="button" aria-label="Следующий месяц" onClick={() => shiftMonth(1)}>
                  ›
                </button>
              </header>
              <div className="teacher-journal-calendar__grid" aria-label={monthName(calendarMonth)}>
                {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((day) => (
                  <span key={day}>{day}</span>
                ))}
                {calendarCells.map((value, index) => {
                  if (!value) return <span key={`empty-${index}`} aria-hidden="true" />
                  const count = lessonsByDay.get(value)?.length ?? 0
                  return (
                    <button
                      key={value}
                      type="button"
                      aria-label={`${Number(value.slice(-2))} ${monthName(calendarMonth)}${count ? `, занятий: ${count}` : ', занятий нет'}`}
                      aria-pressed={value === selectedDay}
                      disabled={!count}
                      className={count ? 'has-lessons' : undefined}
                      onClick={() => {
                        const dayLessons = lessonsByDay.get(value) ?? []
                        setCalendarSelection({ day: value, month: calendarMonth })
                        if (dayLessons[0]) onResource(dayLessons[0].id)
                      }}
                    >
                      {Number(value.slice(-2))}
                      {count > 1 && <small>{count}</small>}
                    </button>
                  )
                })}
              </div>
              <p>Выберите выделенную дату, чтобы увидеть занятие.</p>
            </section>
            <section
              className="teacher-journal__lesson-options"
              aria-label="Занятия на выбранную дату"
            >
              <h3>
                {selectedDay
                  ? formatDateTime(`${selectedDay}T09:00:00+03:00`).split(' · ')[0]
                  : 'Выберите дату'}
              </h3>
              {(lessonsByDay.get(selectedDay) ?? []).length > 1 ? (
                <div role="group" aria-label="Выбор занятия">
                  {(lessonsByDay.get(selectedDay) ?? []).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={item.id === resource}
                      onClick={() => onResource(item.id)}
                    >
                      <strong>{formatDateTime(item.starts_at)}</strong>
                      <span>{item.kind}</span>
                    </button>
                  ))}
                </div>
              ) : lesson ? (
                <p>
                  {formatDateTime(lesson.starts_at)} · {lesson.kind}
                </p>
              ) : (
                <p>Для выбранной даты занятий нет.</p>
              )}
            </section>
          </div>
        )}
      </JournalCard>
      {lessons.isError && (
        <ErrorState
          title="Занятие недоступно"
          description={journalError(lessons.error)}
          onRetry={() => void lessons.refetch()}
        />
      )}
      {resource && lessons.isSuccess && !lesson && <EmptyState title="Занятие не найдено" />}
      {lesson && !lessons.isError && (
        <>
          <h3>{formatDateTime(lesson.starts_at)}</h3>
          <Search label="Поиск по студентам" onSearch={setSearch} />
          <Pager<Schema['StaffAttendanceRow']>
            key={`${resource}:${search}`}
            access={access}
            path={readPath}
            filters={{ q: search }}
          >
            {(items) => (
              <JournalTable
                label="Таблица посещаемости"
                className="journal-table-scroll--mobile-cards"
                columns={[
                  { id: 'student', label: 'Студент' },
                  { id: 'attendance', label: 'Посещаемость' },
                  { id: 'updated', label: 'Последнее изменение' },
                ]}
              >
                {items.map((row) => (
                  <AttendanceRow
                    key={row.student_id}
                    row={row}
                    lessonId={resource}
                    access={access}
                    readPath={readPath}
                    display="table-row"
                  />
                ))}
              </JournalTable>
            )}
          </Pager>
        </>
      )}
    </>
  )
}

export function StaffJournalsPage() {
  const context = useRoleContext()
  const grades = hasPermission(context, 'grades.edit')
  const attendance = hasPermission(context, 'attendance.edit')
  const access: JournalAccess = [context.user_id, 'staff', grades, attendance]
  return (
    <JournalEdits key={JSON.stringify(access)} access={access}>
      <StaffJournal access={access} />
    </JournalEdits>
  )
}

function StaffJournal({ access }: { access: JournalAccess }) {
  const [, , grades, attendance] = access
  const [params, setParams] = useSearchParams()
  const courseId = params.get('course') ?? ''
  const group = params.get('group') ?? ''
  const q = params.get('q') ?? ''
  const savedTab = params.get('tab')
  const tab =
    savedTab === 'finals' && grades
      ? 'finals'
      : (savedTab === 'attendance' || !grades) && attendance
        ? 'attendance'
        : 'work'
  const resource = !savedTab || savedTab === tab ? (params.get('resource') ?? '') : ''
  const [history, setHistory] = useState<HistoryTarget>()
  const selected = useJournalQuery<Page<CatalogItem>>(
    access,
    courseId && group
      ? pageUrl(`${staffJournal}/catalog`, null, { course_offering_id: courseId, group_id: group })
      : null,
  )
  const course = selected.data?.items[0]
  const set = (values: Record<string, string>) => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value)
      else next.delete(key)
    }
    setParams(next, { preventScrollReset: true })
  }
  const historyScope = `${courseId}:${group}:${tab}:${resource}`
  const [openedScope, setOpenedScope] = useState('')
  return (
    <div className="staff-journal">
      <JournalPageHeader
        eyebrow="Кабинет сотрудника"
        title="Журнал деканата"
        description="Дисциплины, группы, успеваемость и история изменений."
      />
      <JournalCard
        heading="Дисциплины и группы"
        description="Каталог сгруппирован по учебным периодам и группам."
      >
        <Search
          key={q}
          label="Поиск дисциплины, группы или семестра"
          initial={q}
          onSearch={(value) => set({ q: value })}
        />
        <Pager<CatalogItem>
          key={q}
          access={access}
          path={`${staffJournal}/catalog`}
          filters={{ q }}
        >
          {(items) => (
            <JournalCatalog
              entries={items.map((item) => ({
                id: `${item.course_offering_id}:${item.group.id}`,
                label: `${item.discipline.name} · ${item.group.name} · ${item.term.name}`,
              }))}
              selected={`${courseId}:${group}`}
              onSelect={(value) => {
                const [course, selectedGroup] = value.split(':')
                if (course && selectedGroup) set({ course, group: selectedGroup, resource: '' })
              }}
            />
          )}
        </Pager>
      </JournalCard>
      {selected.isError && (
        <ErrorState
          title="Журнал недоступен"
          description={journalError(selected.error)}
          onRetry={() => void selected.refetch()}
        />
      )}
      {courseId && group && selected.isSuccess && !course && (
        <EmptyState title="Журнал не найден" />
      )}
      {course && !selected.isError && (
        <JournalCourseSection
          heading={`${course.discipline.name} · ${course.group.name}`}
          status="Журнал открыт"
        >
          <JournalTabs
            ariaLabel="Разделы журнала"
            idPrefix="staff-journal"
            selected={tab}
            onSelect={(value) => set({ tab: value, resource: '' })}
            options={(
              [
                ['work', 'Работы и баллы', grades],
                ['attendance', 'Посещаемость', attendance],
                ['finals', 'Итоги аттестации', grades],
              ] as const
            )
              .filter(([, , allowed]) => allowed)
              .map(([id, label]) => ({ id, label }))}
          />
          <JournalTabPanel idPrefix="staff-journal" tabId={tab}>
            <GroupJournal
              key={`${courseId}:${group}:${tab}`}
              course={course}
              tab={tab}
              resource={resource}
              access={access}
              onResource={(value) => set({ tab, resource: value })}
              onHistory={(target) => {
                setOpenedScope(historyScope)
                setHistory(target)
              }}
            />
          </JournalTabPanel>
        </JournalCourseSection>
      )}
      {grades && history && openedScope === historyScope && (
        <HistoryDialog
          key={history.path}
          target={history}
          access={access}
          onClose={() => setHistory(undefined)}
        />
      )}
    </div>
  )
}
