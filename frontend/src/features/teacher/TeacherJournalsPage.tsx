import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { apiFetch, ApiClientError } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/StatusStates'
import { useRoleContext } from '../auth/RoleContext'
import './teacherJournals.css'

type Assignment = components['schemas']['TeachingAssignmentResponse']
type Lesson = components['schemas']['JournalLesson']
type Attendance = components['schemas']['JournalAttendanceRow']
type Assessment = components['schemas']['JournalAssessment']
type Result = components['schemas']['JournalResult']
type FinalResult = components['schemas']['ManualFinalResultResponse']
type Student = components['schemas']['JournalStudent']
type Page<T> = { items: T[]; next_cursor: string | null }
type SavePhase = 'saving' | 'saved' | 'error'
type SaveState = { phase: SavePhase; uncertain?: boolean; retry?: () => void }

const base = '/api/v1/teaching'
const limit = 100
const statuses = [
  { value: 'attended', label: '✓', title: 'Присутствовал' },
  { value: 'absent', label: 'Н', title: 'Отсутствовал' },
  { value: 'unmarked', label: '—', title: 'Нет отметки' },
] as const

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Moscow',
  }).format(new Date(value))
}

function formatDate(value: string | null) {
  if (!value) return 'Дата не назначена'
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'long',
    timeZone: 'Europe/Moscow',
  }).format(new Date(`${value}T12:00:00Z`))
}

async function getAllPages<T>(path: string, signal?: AbortSignal): Promise<T[]> {
  const result: T[] = []
  let cursor: string | null = null
  const seen = new Set<string>()
  do {
    const params = new URLSearchParams({ limit: String(limit) })
    if (cursor) params.set('cursor', cursor)
    const page = await apiFetch<Page<T>>(`${path}?${params}`, {
      authenticated: true,
      signal,
      cache: 'no-store',
    })
    result.push(...page.items)
    cursor = page.next_cursor
    if (cursor && seen.has(cursor)) throw new Error('Invalid repeated page cursor')
    if (cursor) seen.add(cursor)
  } while (cursor)
  return result
}

function SaveLabel({ state, onRetry }: { state?: SaveState; onRetry?: () => void }) {
  if (!state) return null
  if (state.phase === 'saving')
    return (
      <span className="journal-save" role="status">
        Сохраняется
      </span>
    )
  if (state.phase === 'saved')
    return (
      <span className="journal-save journal-save--saved" role="status">
        Сохранено
      </span>
    )
  return (
    <span className="journal-save journal-save--error" role="status">
      Ошибка, повторить{' '}
      {onRetry && (
        <button type="button" className="journal-inline-action" onClick={onRetry}>
          {state.uncertain ? 'Проверить сохранение' : 'Повторить'}
        </button>
      )}
    </span>
  )
}

function errorMessage(error: unknown) {
  if (error instanceof ApiClientError) {
    if (error.status === 403) return 'Доступ запрещён. Проверьте роль и назначение преподавателя.'
    if (error.status === 404)
      return 'Журнал или выбранная запись больше недоступны. Обновите список.'
    if (error.status === 409)
      return 'Данные изменились или занятие уже нельзя редактировать. Перечитайте журнал.'
    if (error.status === 422) return 'Сервер отклонил данные. Проверьте значения и обновите журнал.'
  }
  return 'Не удалось связаться с сервером. Проверьте соединение и повторите запрос.'
}

function QueryError({ error, retry }: { error: unknown; retry: () => void }) {
  const status = error instanceof ApiClientError ? error.status : undefined
  return (
    <ErrorState
      title={
        status === 403
          ? 'Доступ запрещён'
          : status === 404
            ? 'Запись не найдена'
            : 'Не удалось загрузить журнал'
      }
      description={errorMessage(error)}
      onRetry={retry}
    />
  )
}

export function TeacherJournalsPage() {
  const { user_id: userId } = useRoleContext()
  const [params, setParams] = useSearchParams()
  const courseId = params.get('course') ?? ''
  const groupId = params.get('group') ?? ''
  const activeTab = params.get('tab') === 'work' ? 'work' : 'attendance'
  const lessonId = params.get('lesson') ?? ''
  const assessmentId = params.get('assessment') ?? ''
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const revisions = useRef(new Map<string, number>())
  const queues = useRef(new Map<string, Promise<void>>())
  const assignmentsQuery = useQuery({
    queryKey: ['teacher-journal-assignments', userId],
    queryFn: ({ signal }) => getAllPages<Assignment>(`${base}/assignments`, signal),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  })
  const assignments = assignmentsQuery.data ?? []
  const chosen = assignments.find(
    (item) => item.course_offering_id === courseId && item.group.id === groupId,
  )
  const selectedCourse = assignments.some((item) => item.course_offering_id === courseId)
    ? courseId
    : ''
  const selectedGroup = assignments.some(
    (item) => item.course_offering_id === selectedCourse && item.group.id === groupId,
  )
    ? groupId
    : ''
  const hasUnavailableDirectSelection = Boolean(courseId && groupId && !chosen)
  const path =
    selectedCourse && selectedGroup
      ? `${base}/courses/${encodeURIComponent(selectedCourse)}/groups/${encodeURIComponent(selectedGroup)}`
      : ''
  const lessonsQuery = useQuery({
    queryKey: ['teacher-journal-lessons', userId, selectedCourse, selectedGroup],
    enabled: Boolean(path),
    queryFn: ({ signal }) => getAllPages<Lesson>(`${path}/lessons`, signal),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  })
  const rosterQuery = useQuery({
    queryKey: ['teacher-journal-roster', userId, selectedCourse, selectedGroup],
    enabled: Boolean(path),
    queryFn: ({ signal }) => getAllPages<Student>(`${path}/students`, signal),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  })
  const assessmentsQuery = useQuery({
    queryKey: ['teacher-journal-assessments', userId, selectedCourse, selectedGroup],
    enabled: Boolean(path),
    queryFn: ({ signal }) => getAllPages<Assessment>(`${path}/assessments`, signal),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  })
  const finalsQuery = useQuery({
    queryKey: ['teacher-journal-finals', userId, selectedCourse, selectedGroup],
    enabled: Boolean(path),
    queryFn: ({ signal }) => getAllPages<FinalResult>(`${path}/final-results`, signal),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  })
  const lessons = lessonsQuery.data ?? []
  const assessments = assessmentsQuery.data ?? []
  const selectedLesson = lessons.find((item) => item.id === lessonId)
  const selectedAssessment = assessments.find((item) => item.id === assessmentId)
  const attendanceQuery = useQuery({
    queryKey: [
      'teacher-journal-attendance',
      userId,
      selectedCourse,
      selectedGroup,
      selectedLesson?.id,
    ],
    enabled: Boolean(path && selectedLesson),
    queryFn: ({ signal }) =>
      getAllPages<Attendance>(
        `${path}/lessons/${encodeURIComponent(selectedLesson!.id)}/attendance`,
        signal,
      ),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  })
  const resultsQuery = useQuery({
    queryKey: [
      'teacher-journal-results',
      userId,
      selectedCourse,
      selectedGroup,
      selectedAssessment?.id,
    ],
    enabled: Boolean(path && selectedAssessment),
    queryFn: ({ signal }) =>
      getAllPages<Result>(
        `${path}/assessments/${encodeURIComponent(selectedAssessment!.id)}/results`,
        signal,
      ),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  })
  const studentNames = useMemo(
    () => new Map((rosterQuery.data ?? []).map((student) => [student.id, student.full_name])),
    [rosterQuery.data],
  )

  function setSelection(key: string, value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    if (key === 'course') next.delete('group')
    if (key === 'group') {
      next.delete('lesson')
      next.delete('assessment')
    }
    if (key === 'tab') {
      next.delete('lesson')
      next.delete('assessment')
    }
    if (key === 'lesson' || key === 'assessment')
      next.set('tab', key === 'lesson' ? 'attendance' : 'work')
    setParams(next)
  }

  function setSave(key: string, state: SaveState, revision?: number) {
    if (revision !== undefined && revisions.current.get(key) !== revision) return
    setSaveStates((current) => ({ ...current, [key]: state }))
  }

  const enqueue = useCallback((key: string, action: (revision: number) => Promise<void>) => {
    const revision = (revisions.current.get(key) ?? 0) + 1
    revisions.current.set(key, revision)
    setSaveStates((current) => ({ ...current, [key]: { phase: 'saving' } }))
    const previous = queues.current.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() => action(revision))
    queues.current.set(key, next)
    void next.finally(() => {
      if (queues.current.get(key) === next) queues.current.delete(key)
    })
    return next
  }, [])

  async function verifyAttendance(
    row: Attendance,
    status: Attendance['status'],
    key: string,
    revision: number,
  ) {
    try {
      const actual = await apiFetch<Page<Attendance>>(
        `${path}/lessons/${encodeURIComponent(selectedLesson!.id)}/attendance?student_id=${encodeURIComponent(row.student_id)}&limit=1`,
        { authenticated: true, cache: 'no-store' },
      )
      if ((actual.items[0]?.status ?? 'unmarked') === status) {
        setSave(key, { phase: 'saved' }, revision)
        void attendanceQuery.refetch()
        return
      }
      setSave(key, { phase: 'error', retry: () => void saveAttendance(row, status) }, revision)
    } catch {
      setSave(
        key,
        {
          phase: 'error',
          uncertain: true,
          retry: () => void verifyAttendance(row, status, key, revision),
        },
        revision,
      )
    }
  }

  async function verifyScore(
    row: Result,
    score: number | null,
    value: string,
    key: string,
    revision: number,
  ) {
    try {
      const actual = await apiFetch<Page<Result>>(
        `${path}/assessments/${encodeURIComponent(selectedAssessment!.id)}/results?student_id=${encodeURIComponent(row.student_id)}&limit=1`,
        { authenticated: true, cache: 'no-store' },
      )
      if ((actual.items[0]?.score ?? null) === score) {
        setSave(key, { phase: 'saved' }, revision)
        void resultsQuery.refetch()
        return
      }
      setSave(key, { phase: 'error', retry: () => void saveScore(row, value) }, revision)
    } catch {
      setSave(
        key,
        {
          phase: 'error',
          uncertain: true,
          retry: () => void verifyScore(row, score, value, key, revision),
        },
        revision,
      )
    }
  }

  async function saveAttendance(row: Attendance, status: 'attended' | 'absent' | 'unmarked') {
    const key = `attendance:${selectedLesson?.id}:${row.student_id}`
    await enqueue(key, async (revision) => {
      try {
        await apiFetch(
          `/api/v1/attendance/lessons/${encodeURIComponent(selectedLesson!.id)}/students/${encodeURIComponent(row.student_id)}`,
          {
            authenticated: true,
            method: status === 'unmarked' ? 'DELETE' : 'PUT',
            ...(status === 'unmarked' ? {} : { body: JSON.stringify({ status }) }),
          },
        )
        setSave(key, { phase: 'saved' }, revision)
        void attendanceQuery.refetch()
      } catch {
        await verifyAttendance(row, status, key, revision)
      }
    })
  }

  async function saveScore(row: Result, value: string) {
    const key = `score:${selectedAssessment?.id}:${row.student_id}`
    const score = value === '' ? null : Number(value)
    if (
      score !== null &&
      (!Number.isInteger(score) || score < 0 || score > (selectedAssessment?.max_score ?? 0))
    ) {
      setSaveStates((current) => ({
        ...current,
        [key]: { phase: 'error', retry: () => void saveScore(row, value) },
      }))
      return
    }
    await enqueue(key, async (revision) => {
      try {
        await apiFetch(
          `${path}/assessments/${encodeURIComponent(selectedAssessment!.id)}/results/${encodeURIComponent(row.student_id)}`,
          { authenticated: true, method: 'PUT', body: JSON.stringify({ score }) },
        )
        setSave(key, { phase: 'saved' }, revision)
        void resultsQuery.refetch()
      } catch {
        await verifyScore(row, score, value, key, revision)
      }
    })
  }

  async function verifyAssessmentDate(date: string, lesson: string, key: string, revision: number) {
    try {
      const actual = await apiFetch<Page<Assessment>>(
        `${path}/assessments?assessment_group_id=${encodeURIComponent(selectedAssessment!.id)}&limit=1`,
        { authenticated: true, cache: 'no-store' },
      )
      const row = actual.items[0]
      if (row && row.planned_date === (date || null) && row.lesson_id === (lesson || null)) {
        setSave(key, { phase: 'saved' }, revision)
        void assessmentsQuery.refetch()
        return
      }
      setSave(key, { phase: 'error', retry: () => void saveAssessmentDate(date, lesson) }, revision)
    } catch {
      setSave(
        key,
        {
          phase: 'error',
          uncertain: true,
          retry: () => void verifyAssessmentDate(date, lesson, key, revision),
        },
        revision,
      )
    }
  }

  async function saveAssessmentDate(date: string, lesson: string) {
    if (!selectedAssessment) return
    const key = `date:${selectedAssessment.id}`
    await enqueue(key, async (revision) => {
      try {
        await apiFetch(
          `${base}/courses/${encodeURIComponent(selectedCourse)}/assessments/${encodeURIComponent(selectedAssessment.assessment_id)}/dates`,
          {
            authenticated: true,
            method: 'PATCH',
            body: JSON.stringify({
              items: [
                {
                  assessment_group_id: selectedAssessment.id,
                  planned_date: date || null,
                  lesson_id: lesson || null,
                },
              ],
            }),
          },
        )
        setSave(key, { phase: 'saved' }, revision)
        void assessmentsQuery.refetch()
      } catch {
        await verifyAssessmentDate(date, lesson, key, revision)
      }
    })
  }

  async function verifyFinal(
    row: FinalResult,
    patch: Record<string, unknown>,
    key: string,
    revision: number,
    retry: () => void,
  ) {
    try {
      const actual = await apiFetch<FinalResult>(
        `/api/v1/final-results/courses/${encodeURIComponent(selectedCourse)}/students/${encodeURIComponent(row.student_id)}`,
        { authenticated: true, cache: 'no-store' },
      )
      const matches = Object.entries(patch).every(
        ([name, value]) => actual[name as keyof FinalResult] === value,
      )
      if (matches) {
        setSave(key, { phase: 'saved' }, revision)
        void finalsQuery.refetch()
      } else {
        setSave(key, { phase: 'error', retry }, revision)
      }
    } catch {
      setSave(
        key,
        {
          phase: 'error',
          uncertain: true,
          retry: () => void verifyFinal(row, patch, key, revision, retry),
        },
        revision,
      )
    }
  }

  async function saveFinal(
    row: FinalResult,
    patch: Record<string, unknown>,
    key: string,
    retry: () => void,
  ) {
    await enqueue(key, async (revision) => {
      try {
        await apiFetch(
          `/api/v1/final-results/courses/${encodeURIComponent(selectedCourse)}/students/${encodeURIComponent(row.student_id)}`,
          { authenticated: true, method: 'PATCH', body: JSON.stringify(patch) },
        )
        setSave(key, { phase: 'saved' }, revision)
        void finalsQuery.refetch()
      } catch {
        await verifyFinal(row, patch, key, revision, retry)
      }
    })
  }

  useEffect(
    () => () => {
      // Do not retain student-specific state when leaving the page or switching sessions.
      queues.current.clear()
      revisions.current.clear()
    },
    [userId],
  )

  if (assignmentsQuery.isPending)
    return (
      <main className="section-page teacher-journal">
        <h1>Мои журналы</h1>
        <LoadingState title="Загружаем назначения…" />
      </main>
    )
  if (assignmentsQuery.isError)
    return (
      <main className="section-page teacher-journal">
        <h1>Мои журналы</h1>
        <QueryError error={assignmentsQuery.error} retry={() => void assignmentsQuery.refetch()} />
      </main>
    )

  const grouped = new Map<string, Assignment[]>()
  for (const assignment of assignments) {
    const key = assignment.discipline.name
    grouped.set(key, [...(grouped.get(key) ?? []), assignment])
  }
  const currentLessonQuery = attendanceQuery
  const currentWorkQuery = activeTab === 'work' && assessmentId ? resultsQuery : assessmentsQuery
  const queryError =
    (selectedLesson && currentLessonQuery.isError) ||
    (selectedAssessment && resultsQuery.isError) ||
    (activeTab === 'work' && assessmentsQuery.isError) ||
    (activeTab === 'work' && finalsQuery.isError) ||
    (selectedCourse && lessonsQuery.isError)

  return (
    <main className="section-page teacher-journal">
      <p className="section-eyebrow">Кабинет преподавателя</p>
      <h1>Мои журналы</h1>
      <p className="teacher-journal__intro">
        Выберите дисциплину и группу из ваших действующих назначений.
      </p>
      {!assignments.length && hasUnavailableDirectSelection ? (
        <ErrorState
          title="Журнал недоступен"
          description="Назначение отозвано или ссылка устарела."
          onRetry={() => void assignmentsQuery.refetch()}
        />
      ) : !assignments.length ? (
        <EmptyState
          title="Назначений пока нет"
          description="Журналы появятся после назначения преподавателя на дисциплину и группу."
        />
      ) : (
        <>
          <div className="teacher-journal__selectors">
            <label>
              Дисциплина
              <select
                aria-label="Дисциплина"
                value={selectedCourse}
                onChange={(event) => setSelection('course', event.target.value)}
              >
                <option value="">Выберите дисциплину</option>
                {[...grouped].map(([name, entries]) => (
                  <optgroup key={name} label={name}>
                    {[
                      ...new Map(entries.map((item) => [item.course_offering_id, item])).values(),
                    ].map((item) => (
                      <option key={item.course_offering_id} value={item.course_offering_id}>
                        {name} · {item.term.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label>
              Группа
              <select
                aria-label="Группа"
                value={selectedGroup}
                disabled={!selectedCourse}
                onChange={(event) => setSelection('group', event.target.value)}
              >
                <option value="">Выберите группу</option>
                {assignments
                  .filter((item) => item.course_offering_id === selectedCourse)
                  .map((item) => (
                    <option key={item.group.id} value={item.group.id}>
                      {item.group.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          {hasUnavailableDirectSelection && (
            <ErrorState
              title="Журнал недоступен"
              description="Назначение отозвано или ссылка устарела."
              onRetry={() => void assignmentsQuery.refetch()}
            />
          )}
          {chosen && (
            <>
              {(lessonsQuery.isPending || assessmentsQuery.isPending || finalsQuery.isPending) && (
                <LoadingState title="Загружаем журнал…" variant="compact" />
              )}
              {(lessonsQuery.isError ||
                (activeTab === 'work' && (assessmentsQuery.isError || finalsQuery.isError))) && (
                <QueryError
                  error={lessonsQuery.error ?? assessmentsQuery.error ?? finalsQuery.error}
                  retry={() => {
                    void lessonsQuery.refetch()
                    void assessmentsQuery.refetch()
                    void finalsQuery.refetch()
                  }}
                />
              )}
              <div className="teacher-journal__tabs" role="tablist" aria-label="Раздел журнала">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'attendance'}
                  onClick={() => setSelection('tab', 'attendance')}
                >
                  Посещаемость
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'work'}
                  onClick={() => setSelection('tab', 'work')}
                >
                  Работы и баллы
                </button>
              </div>
              {activeTab === 'attendance' ? (
                <section className="teacher-journal__panel" role="tabpanel">
                  <label>
                    Занятие
                    <select
                      aria-label="Занятие"
                      value={selectedLesson?.id ?? ''}
                      onChange={(event) => setSelection('lesson', event.target.value)}
                    >
                      <option value="">Выберите занятие</option>
                      {lessons.map((item) => (
                        <option key={item.id} value={item.id}>
                          {formatDateTime(item.starts_at)} · {item.kind}
                          {item.status !== 'scheduled'
                            ? ` · ${item.status === 'cancelled' ? 'Отменено' : 'Перенесено'}`
                            : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!lessons.length && !lessonsQuery.isPending && (
                    <EmptyState
                      title="Занятий нет"
                      description="Для этой группы пока не найдено занятий."
                    />
                  )}
                  {selectedLesson && (
                    <>
                      <div className="teacher-journal__selection">
                        <strong>{formatDateTime(selectedLesson.starts_at)}</strong>
                        <span>
                          {selectedLesson.status !== 'scheduled'
                            ? selectedLesson.status === 'cancelled'
                              ? 'Занятие отменено'
                              : 'Занятие перенесено'
                            : 'Отметки участников'}
                        </span>
                      </div>
                      {attendanceQuery.isPending ? (
                        <LoadingState title="Загружаем посещаемость…" variant="compact" />
                      ) : attendanceQuery.isError ? (
                        <QueryError
                          error={attendanceQuery.error}
                          retry={() => void attendanceQuery.refetch()}
                        />
                      ) : !attendanceQuery.data?.length ? (
                        <EmptyState
                          title="Участников нет"
                          description="У выбранного занятия нет участников в этой группе."
                        />
                      ) : (
                        <>
                          <p className="teacher-journal__count">
                            Отмечено:{' '}
                            {attendanceQuery.data.filter((row) => row.status !== 'unmarked').length}{' '}
                            из {attendanceQuery.data.length}
                          </p>
                          <div className="journal-student-list">
                            {attendanceQuery.data.map((row) => {
                              const key = `attendance:${selectedLesson.id}:${row.student_id}`
                              return (
                                <article className="journal-student" key={row.student_id}>
                                  <div className="journal-student__identity">
                                    <strong>{row.full_name}</strong>
                                    <span>{row.subgroup_id ? 'Подгруппа' : 'Участник группы'}</span>
                                  </div>
                                  <div
                                    className="journal-attendance-controls"
                                    role="group"
                                    aria-label={`Посещаемость: ${row.full_name}`}
                                  >
                                    {statuses.map((status) => (
                                      <button
                                        key={status.value}
                                        type="button"
                                        title={status.title}
                                        aria-label={`${status.title}: ${row.full_name}`}
                                        aria-pressed={row.status === status.value}
                                        disabled={!row.can_edit}
                                        onClick={() => void saveAttendance(row, status.value)}
                                      >
                                        {status.label}
                                      </button>
                                    ))}
                                  </div>
                                  <SaveLabel
                                    state={saveStates[key]}
                                    onRetry={saveStates[key]?.retry}
                                  />
                                </article>
                              )
                            })}
                          </div>
                        </>
                      )}
                    </>
                  )}
                </section>
              ) : (
                <section className="teacher-journal__panel" role="tabpanel">
                  <label>
                    Работа
                    <select
                      aria-label="Работа"
                      value={selectedAssessment?.id ?? ''}
                      onChange={(event) => setSelection('assessment', event.target.value)}
                    >
                      <option value="">Выберите работу</option>
                      {assessments.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title} · {item.max_score} б. · {formatDate(item.planned_date)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!assessments.length && !assessmentsQuery.isPending && (
                    <EmptyState
                      title="Утверждённых работ нет"
                      description="Для группы пока не назначены работы."
                    />
                  )}
                  {selectedAssessment && (
                    <>
                      <section className="journal-work-card" aria-label="Сведения о работе">
                        <div>
                          <h2>{selectedAssessment.title}</h2>
                          <p>
                            {selectedAssessment.type} · максимум {selectedAssessment.max_score}{' '}
                            баллов
                          </p>
                          <p>
                            {formatDate(selectedAssessment.planned_date)}
                            {selectedAssessment.date_needs_confirmation
                              ? ' · Дату нужно подтвердить'
                              : ''}
                          </p>
                          {selectedAssessment.description && (
                            <p>{selectedAssessment.description}</p>
                          )}
                        </div>
                        <div className="journal-work-card__date">
                          <label>
                            Дата
                            <input
                              type="date"
                              value={
                                drafts[`date:${selectedAssessment.id}:date`] ??
                                selectedAssessment.planned_date ??
                                ''
                              }
                              onChange={(event) =>
                                setDrafts((current) => ({
                                  ...current,
                                  [`date:${selectedAssessment.id}:date`]: event.target.value,
                                }))
                              }
                            />
                          </label>
                          <label>
                            Связать с занятием
                            <select
                              aria-label="Связать с занятием"
                              value={
                                drafts[`date:${selectedAssessment.id}:lesson`] ??
                                selectedAssessment.lesson_id ??
                                ''
                              }
                              onChange={(event) => {
                                const value = event.target.value
                                setDrafts((current) => ({
                                  ...current,
                                  [`date:${selectedAssessment.id}:lesson`]: value,
                                }))
                              }}
                            >
                              <option value="">Без связи с занятием</option>
                              {lessons
                                .filter((item) => item.status === 'scheduled')
                                .map((item) => (
                                  <option key={item.id} value={item.id}>
                                    {formatDateTime(item.starts_at)}
                                  </option>
                                ))}
                            </select>
                          </label>
                          <button
                            type="button"
                            className="journal-date-save"
                            onClick={() =>
                              void saveAssessmentDate(
                                drafts[`date:${selectedAssessment.id}:date`] ??
                                  selectedAssessment.planned_date ??
                                  '',
                                drafts[`date:${selectedAssessment.id}:lesson`] ??
                                  selectedAssessment.lesson_id ??
                                  '',
                              )
                            }
                          >
                            Сохранить дату и связь
                          </button>
                          <SaveLabel
                            state={saveStates[`date:${selectedAssessment.id}`]}
                            onRetry={saveStates[`date:${selectedAssessment.id}`]?.retry}
                          />
                        </div>
                      </section>
                      {resultsQuery.isPending ? (
                        <LoadingState title="Загружаем результаты…" variant="compact" />
                      ) : resultsQuery.isError ? (
                        <QueryError
                          error={resultsQuery.error}
                          retry={() => void resultsQuery.refetch()}
                        />
                      ) : (
                        <div className="journal-student-list">
                          {(resultsQuery.data ?? []).map((row) => {
                            const key = `score:${selectedAssessment.id}:${row.student_id}`
                            const value =
                              drafts[key] ?? (row.score === null ? '' : String(row.score))
                            return (
                              <article className="journal-student" key={row.student_id}>
                                <div className="journal-student__identity">
                                  <strong>{row.full_name}</strong>
                                  <span>
                                    {row.is_current_group_member
                                      ? 'Текущий участник'
                                      : 'Исторический результат · только просмотр'}
                                  </span>
                                </div>
                                <label className="journal-score">
                                  Баллы
                                  <input
                                    type="number"
                                    min={0}
                                    max={selectedAssessment.max_score}
                                    step={1}
                                    inputMode="numeric"
                                    aria-label={`Баллы: ${row.full_name}`}
                                    disabled={!row.is_current_group_member}
                                    value={value}
                                    onChange={(event) =>
                                      setDrafts((current) => ({
                                        ...current,
                                        [key]: event.target.value,
                                      }))
                                    }
                                    onBlur={() => void saveScore(row, value)}
                                  />
                                  <span>/ {selectedAssessment.max_score}</span>
                                </label>
                                <SaveLabel
                                  state={saveStates[key]}
                                  onRetry={saveStates[key]?.retry}
                                />
                              </article>
                            )
                          })}
                        </div>
                      )}
                    </>
                  )}
                  <FinalResultsSection
                    rows={finalsQuery.data ?? []}
                    studentNames={studentNames}
                    attestationType={chosen.attestation_type}
                    loading={finalsQuery.isPending}
                    error={finalsQuery.error}
                    refetch={() => void finalsQuery.refetch()}
                    save={saveFinal}
                    states={saveStates}
                  />
                </section>
              )}
            </>
          )}
          {queryError && !chosen && (
            <p role="alert">{errorMessage(lessonsQuery.error ?? currentWorkQuery.error)}</p>
          )}
        </>
      )}
    </main>
  )
}

function FinalResultsSection({
  rows,
  studentNames,
  attestationType,
  loading,
  error,
  refetch,
  save,
  states,
}: {
  rows: FinalResult[]
  studentNames: Map<string, string | undefined>
  attestationType: Assignment['attestation_type']
  loading: boolean
  error: unknown
  refetch: () => void
  save: (
    row: FinalResult,
    patch: Record<string, unknown>,
    key: string,
    retry: () => void,
  ) => Promise<void>
  states: Record<string, SaveState>
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const title =
    attestationType === 'pass_fail'
      ? 'Зачёт'
      : attestationType === 'graded_pass'
        ? 'Дифференцированный зачёт'
        : 'Экзамен'
  return (
    <section className="journal-finals" aria-labelledby="journal-finals-title">
      <h2 id="journal-finals-title">Итоги аттестации · {title}</h2>
      <p>Итог выставляется вручную; сумма баллов не преобразуется в оценку автоматически.</p>
      {loading ? (
        <LoadingState title="Загружаем итоги…" variant="compact" />
      ) : error ? (
        <QueryError error={error} retry={refetch} />
      ) : (
        <div className="journal-student-list">
          {rows.map((row) => {
            const key = `final:${row.student_id}`
            const value =
              drafts[key] ??
              (attestationType === 'pass_fail'
                ? row.passed === null
                  ? ''
                  : row.passed
                    ? 'true'
                    : 'false'
                : row.grade_value === null
                  ? ''
                  : String(row.grade_value))
            const displayName = studentNames.get(row.student_id) ?? `Студент ${row.student_id}`
            const setResult = (next: string) => {
              setDrafts((current) => ({ ...current, [key]: next }))
              const patch =
                attestationType === 'pass_fail'
                  ? { passed: next === '' ? null : next === 'true' }
                  : { grade_value: next === '' ? null : Number(next) }
              void save(row, patch, key, () => void save(row, patch, key, () => undefined))
            }
            const retakeDateKey = `${key}:retake_date`
            const retakeLocationKey = `${key}:retake_location`
            const retakeDate = drafts[retakeDateKey] ?? row.retake_date ?? ''
            const retakeLocation = drafts[retakeLocationKey] ?? row.retake_location ?? ''
            return (
              <article className="journal-student journal-student--final" key={row.student_id}>
                <div className="journal-student__identity">
                  <strong>{displayName}</strong>
                  <span>
                    {row.has_debt
                      ? 'Есть долг'
                      : value === ''
                        ? 'Оценка не выставлена'
                        : 'Долга нет'}
                  </span>
                </div>
                <label className="journal-score">
                  {attestationType === 'pass_fail' ? 'Результат' : 'Оценка'}
                  {attestationType === 'pass_fail' ? (
                    <select
                      aria-label={`Итог: ${displayName}`}
                      value={value}
                      onChange={(event) => setResult(event.target.value)}
                    >
                      <option value="">Не выставлено</option>
                      <option value="true">Зачтено</option>
                      <option value="false">Не зачтено</option>
                    </select>
                  ) : (
                    <select
                      aria-label={`Итог: ${displayName}`}
                      value={value}
                      onChange={(event) => setResult(event.target.value)}
                    >
                      <option value="">Не выставлено</option>
                      {[2, 3, 4, 5].map((grade) => (
                        <option key={grade} value={grade}>
                          {grade}
                        </option>
                      ))}
                    </select>
                  )}
                </label>
                <SaveLabel state={states[key]} onRetry={states[key]?.retry} />
                <div className="journal-retake-fields">
                  <label>
                    Дата пересдачи
                    <input
                      type="date"
                      aria-label={`Дата пересдачи: ${displayName}`}
                      value={retakeDate}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [retakeDateKey]: event.target.value,
                        }))
                      }
                      onBlur={() => {
                        const patch = { retake_date: retakeDate || null }
                        void save(
                          row,
                          patch,
                          retakeDateKey,
                          () => void save(row, patch, retakeDateKey, () => undefined),
                        )
                      }}
                    />
                  </label>
                  <label>
                    Место пересдачи
                    <input
                      maxLength={200}
                      aria-label={`Место пересдачи: ${displayName}`}
                      value={retakeLocation}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [retakeLocationKey]: event.target.value,
                        }))
                      }
                      onBlur={() => {
                        const patch = { retake_location: retakeLocation || null }
                        void save(
                          row,
                          patch,
                          retakeLocationKey,
                          () => void save(row, patch, retakeLocationKey, () => undefined),
                        )
                      }}
                    />
                  </label>
                  <SaveLabel
                    state={states[retakeDateKey] ?? states[retakeLocationKey]}
                    onRetry={states[retakeDateKey]?.retry ?? states[retakeLocationKey]?.retry}
                  />
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
