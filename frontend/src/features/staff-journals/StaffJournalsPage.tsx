import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
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
  pageUrl,
  staffJournal,
  useJournalQuery,
  type JournalAccess,
  type Page,
} from './journalQueries'
import '../teacher/teacherJournals.css'
import './staffJournals.css'

type Schema = components['schemas']
type CatalogItem = Schema['StaffCatalogItem']
type HistoryTarget = { name: string; path: string }
type HistoryEvent = Schema['JournalEvent_ScoreSnapshot_'] | Schema['JournalEvent_FinalSnapshot_']
type Snapshot = HistoryEvent['before']
type Tab = 'work' | 'attendance' | 'finals'

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

function Search({
  label,
  onSearch,
  initial = '',
}: {
  label: string
  onSearch: (query: string) => void
  initial?: string
}) {
  const [draft, setDraft] = useState(initial)
  return (
    <form
      className="staff-journal-actions"
      role="search"
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault()
        onSearch(draft.trim())
      }}
    >
      <label>
        {label}
        <input
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={100}
        />
      </label>
      <button type="submit">Найти</button>
    </form>
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
  const coursePath = `${staffJournal}/courses/${course.course_offering_id}`
  const group = `${course.course_offering_id}/groups/${course.group.id}`
  const path = `${staffJournal}/courses/${group}`
  const assessments = useJournalQuery<Page<Schema['JournalAssessment']>>(
    access,
    tab === 'work' && resource
      ? pageUrl(`${path}/assessments`, null, { assessment_group_id: resource })
      : null,
  )
  const lessons = useJournalQuery<Page<Schema['JournalLesson']>>(
    access,
    tab === 'attendance' && resource
      ? pageUrl(`${path}/lessons`, null, { lesson_id: resource })
      : null,
  )
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
        <h3>
          Итоги аттестации ·{' '}
          {
            { exam: 'Экзамен', graded_pass: 'Дифференцированный зачёт', pass_fail: 'Зачёт' }[
              attestation
            ]
          }
        </h3>
        <Search label="Поиск по студентам группы" onSearch={setSearch} />
        <Pager<Schema['StaffFinalRow']>
          key={search}
          access={access}
          path={readPath}
          filters={{ q: search }}
        >
          {(items) => (
            <div className="journal-student-list">
              {items.map((row) => (
                <FinalRow
                  key={row.student_id}
                  row={row}
                  fullName={row.full_name}
                  attestation={attestation}
                  access={access}
                  readPath={readPath}
                  onHistory={() => finalHistory(row.student_id, row.full_name)}
                />
              ))}
            </div>
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
        <h3>Выбор работы</h3>
        <Pager<Schema['JournalAssessment']> access={access} path={`${path}/assessments`}>
          {(items) => (
            <div className="staff-journal-actions">
              {items.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  aria-pressed={resource === item.id}
                  onClick={() => onResource(item.id)}
                >
                  {item.title}
                </button>
              ))}
            </div>
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
                <div className="journal-student-list">
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
                    />
                  ))}
                </div>
              )}
            </Pager>
          </>
        )}
      </>
    )
  }

  const lesson = lessons.data?.items[0]
  const readPath = `${path}/lessons/${resource}/attendance`
  return (
    <>
      <h3>Выбор занятия</h3>
      <Pager<Schema['JournalLesson']> access={access} path={`${path}/lessons`}>
        {(items) => (
          <div className="staff-journal-actions">
            {items.map((item) => (
              <button
                type="button"
                key={item.id}
                aria-pressed={resource === item.id}
                onClick={() => onResource(item.id)}
              >
                {formatDateTime(item.starts_at)}
              </button>
            ))}
          </div>
        )}
      </Pager>
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
              <div className="journal-student-list">
                {items.map((row) => (
                  <AttendanceRow
                    key={row.student_id}
                    row={row}
                    lessonId={resource}
                    access={access}
                    readPath={readPath}
                  />
                ))}
              </div>
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
    setParams(next)
  }
  const historyScope = `${courseId}:${group}:${tab}:${resource}`
  const [openedScope, setOpenedScope] = useState('')
  return (
    <div className="staff-journal">
      <p className="section-eyebrow">Кабинет сотрудника</p>
      <h1>Журнал деканата</h1>
      <p className="service-subtitle">Дисциплины, группы, успеваемость и история изменений.</p>
      <section aria-labelledby="staff-journal-catalog">
        <h2 id="staff-journal-catalog">Дисциплины и группы</h2>
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
            <ul className="staff-journal-catalog">
              {items.map((item) => (
                <li key={`${item.course_offering_id}:${item.group.id}`}>
                  <button
                    type="button"
                    aria-pressed={courseId === item.course_offering_id && group === item.group.id}
                    onClick={() =>
                      set({ course: item.course_offering_id, group: item.group.id, resource: '' })
                    }
                  >
                    {item.discipline.name} · {item.group.name} · {item.term.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Pager>
      </section>
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
        <section>
          <h2>
            {course.discipline.name} · {course.group.name}
          </h2>
          <nav className="staff-journal-actions" aria-label="Разделы журнала">
            {(
              [
                ['attendance', 'Посещаемость', attendance],
                ['work', 'Работы и баллы', grades],
                ['finals', 'Итоги аттестации', grades],
              ] as const
            )
              .filter(([, , allowed]) => allowed)
              .map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={tab === value}
                  onClick={() => set({ tab: value, resource: '' })}
                >
                  {label}
                </button>
              ))}
          </nav>
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
        </section>
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
