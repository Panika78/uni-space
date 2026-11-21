import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { apiFetch, ApiClientError } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/StatusStates'
import { TeacherAnnouncements } from '../announcements/TeacherAnnouncements'
import { useRoleContext } from '../auth/RoleContext'
import {
  JournalCatalog,
  JournalCard,
  JournalCourseSection,
  JournalPageHeader,
  JournalTable,
  JournalSearch,
  JournalTabPanel,
  JournalTabs,
} from '../staff-journals/JournalWorkspace'
import { formatDateTime, SaveLabel, statuses, type SaveState } from './journalControls'
import './teacherJournals.css'
import '../staff-journals/staffJournals.css'

type Assignment = components['schemas']['TeachingAssignmentResponse']
type Lesson = components['schemas']['JournalLesson']
type Attendance = components['schemas']['JournalAttendanceRow']
type AttendanceResponse = components['schemas']['AttendanceResponse']
type Assessment = components['schemas']['JournalAssessment']
type Result = components['schemas']['JournalResult']
type FinalResult = components['schemas']['ManualFinalResultResponse']
type ScoreWriteResponse = components['schemas']['ScoreWriteResponse']
type Student = components['schemas']['JournalStudent']
type Page<T> = { items: T[]; next_cursor: string | null }
const base = '/api/v1/teaching'
const limit = 100
function formatDate(value: string | null) {
  if (!value) return 'Дата не назначена'
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'long',
    timeZone: 'Europe/Moscow',
  }).format(new Date(`${value}T12:00:00Z`))
}

function moscowCalendarDate(value: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value))
  const dateParts = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]))
  return `${dateParts.year}-${dateParts.month}-${dateParts.day}`
}

function dateFromKey(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(Date.UTC(year!, month! - 1, day!))
}

function dateKey(value: Date) {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`
}

function isDateKey(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && dateKey(dateFromKey(value)) === value
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
  const requestedTab = params.get('tab')
  const activeTab =
    requestedTab === 'work' || requestedTab === 'finals' || requestedTab === 'announcements'
      ? requestedTab
      : 'attendance'
  const lessonId = params.get('lesson') ?? ''
  const requestedLessonDate = params.get('lesson_date') ?? ''
  const assessmentId = params.get('assessment') ?? ''
  const catalogSearch = params.get('q') ?? ''
  const [studentSearch, setStudentSearch] = useState('')
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [dirtyDrafts, setDirtyDrafts] = useState<Record<string, boolean>>({})
  const draftsRef = useRef(drafts)
  const dirtyDraftsRef = useRef(dirtyDrafts)
  const identity = JSON.stringify([userId, courseId, groupId])
  const scope = identity
  const scopedKey = (key: string) => `${scope}:${key}`
  const revisions = useRef(new Map<string, number>())
  const inputRevisions = useRef(new Map<string, number>())
  const attemptedInputRevisions = useRef(new Map<string, number>())
  const queues = useRef(new Map<string, Promise<void>>())
  const queryClient = useQueryClient()
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
  const assessmentsQueryKey = ['teacher-journal-assessments', userId, selectedCourse, selectedGroup]
  const assessmentsQuery = useQuery({
    queryKey: assessmentsQueryKey,
    enabled: Boolean(path),
    queryFn: ({ signal }) => getAllPages<Assessment>(`${path}/assessments`, signal),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  })
  const finalsQueryKey = ['teacher-journal-finals', userId, selectedCourse, selectedGroup]
  const finalsQuery = useQuery({
    queryKey: finalsQueryKey,
    enabled: Boolean(path),
    queryFn: ({ signal }) => getAllPages<FinalResult>(`${path}/final-results`, signal),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  })
  const lessons = lessonsQuery.data ?? []
  const assessments = assessmentsQuery.data ?? []
  const selectedLesson = lessons.find((item) => item.id === lessonId)
  const selectedLessonDate = selectedLesson ? moscowCalendarDate(selectedLesson.starts_at) : ''
  const firstLessonDate = lessons[0] ? moscowCalendarDate(lessons[0].starts_at) : ''
  const calendarDate =
    selectedLessonDate ||
    (isDateKey(requestedLessonDate) ? requestedLessonDate : '') ||
    firstLessonDate
  const [calendarNavigation, setCalendarNavigation] = useState<{
    selectedDate: string
    month: Date
  } | null>(null)
  const calendarMonth =
    calendarNavigation?.selectedDate === calendarDate
      ? calendarNavigation.month
      : dateFromKey(calendarDate || moscowCalendarDate(new Date().toISOString()))
  const lessonsByDate = new Map<string, Lesson[]>()
  for (const item of lessons) {
    const key = moscowCalendarDate(item.starts_at)
    lessonsByDate.set(key, [...(lessonsByDate.get(key) ?? []), item])
  }
  const calendarCells = (() => {
    const first = new Date(Date.UTC(calendarMonth.getUTCFullYear(), calendarMonth.getUTCMonth(), 1))
    const offset = (first.getUTCDay() + 6) % 7
    const days = new Date(
      Date.UTC(calendarMonth.getUTCFullYear(), calendarMonth.getUTCMonth() + 1, 0),
    ).getUTCDate()
    return [
      ...Array.from({ length: offset }, () => null),
      ...Array.from({ length: days }, (_, index) =>
        dateKey(
          new Date(
            Date.UTC(calendarMonth.getUTCFullYear(), calendarMonth.getUTCMonth(), index + 1),
          ),
        ),
      ),
    ]
  })()
  const calendarMonthLabel = new Intl.DateTimeFormat('ru-RU', {
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Moscow',
  }).format(calendarMonth)
  const selectedAssessment = assessments.find((item) => item.id === assessmentId)
  const assessmentDateDraft = selectedAssessment
    ? (drafts[scopedKey(`date:${selectedAssessment.id}:date`)] ??
      selectedAssessment.planned_date ??
      '')
    : ''
  const assessmentLessonDraft = selectedAssessment
    ? (drafts[scopedKey(`date:${selectedAssessment.id}:lesson`)] ??
      selectedAssessment.lesson_id ??
      '')
    : ''
  const linkedLessonDraft = lessons.find((item) => item.id === assessmentLessonDraft)
  const lessonDateMismatch = Boolean(
    linkedLessonDraft && moscowCalendarDate(linkedLessonDraft.starts_at) !== assessmentDateDraft,
  )
  const attendanceQueryKey = [
    'teacher-journal-attendance',
    userId,
    selectedCourse,
    selectedGroup,
    selectedLesson?.id,
  ]
  const attendanceQuery = useQuery({
    queryKey: attendanceQueryKey,
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
  const resultQueries = useQueries({
    queries: assessments.map((assessment) => ({
      queryKey: ['teacher-journal-results', userId, selectedCourse, selectedGroup, assessment.id],
      enabled: Boolean(path),
      queryFn: ({ signal }) =>
        getAllPages<Result>(
          `${path}/assessments/${encodeURIComponent(assessment.id)}/results`,
          signal,
        ),
      staleTime: 0,
      gcTime: 0,
      refetchOnMount: 'always' as const,
    })),
  })
  const resultQueryByAssessment = new Map(
    assessments.map((assessment, index) => [assessment.id, resultQueries[index]]),
  )
  const resultsQuery = resultQueryByAssessment.get(selectedAssessment?.id ?? '')
  const studentNames = useMemo(
    () => new Map((rosterQuery.data ?? []).map((student) => [student.id, student.full_name])),
    [rosterQuery.data],
  )
  const workRowsByStudent = new Map<
    string,
    { studentId: string; fullName: string; results: Map<string, Result> }
  >()
  for (const student of rosterQuery.data ?? []) {
    workRowsByStudent.set(student.id, {
      studentId: student.id,
      fullName: student.full_name,
      results: new Map(),
    })
  }
  for (const [assessmentId, query] of assessments.map(
    (assessment, index) => [assessment.id, resultQueries[index]] as const,
  )) {
    for (const result of query?.data ?? []) {
      const current = workRowsByStudent.get(result.student_id) ?? {
        studentId: result.student_id,
        fullName: result.full_name,
        results: new Map<string, Result>(),
      }
      current.results.set(assessmentId, result)
      workRowsByStudent.set(result.student_id, current)
    }
  }
  const workRows = [...workRowsByStudent.values()].filter((row) =>
    row.fullName.toLocaleLowerCase('ru-RU').includes(studentSearch.toLocaleLowerCase('ru-RU')),
  )
  const workPointsByStudent = new Map(
    [...workRowsByStudent.values()].map((row) => [
      row.studentId,
      {
        score: assessments.reduce((sum, item) => sum + (row.results.get(item.id)?.score ?? 0), 0),
        max: assessments.reduce((sum, item) => sum + item.max_score, 0),
      },
    ]),
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
      setStudentSearch('')
    }
    if (key === 'lesson' || key === 'assessment')
      next.set('tab', key === 'lesson' ? 'attendance' : 'work')
    setParams(next, { preventScrollReset: true })
  }

  function chooseLesson(item: Lesson) {
    const next = new URLSearchParams(params)
    next.set('lesson', item.id)
    next.set('lesson_date', moscowCalendarDate(item.starts_at))
    next.set('tab', 'attendance')
    setParams(next, { preventScrollReset: true })
  }

  function chooseLessonDate(value: string) {
    const available = lessonsByDate.get(value) ?? []
    if (!available.length) return
    const next = new URLSearchParams(params)
    next.set('lesson_date', value)
    next.set(
      'lesson',
      (available.find((item) => item.id === selectedLesson?.id) ?? available[0]!).id,
    )
    next.set('tab', 'attendance')
    setParams(next, { preventScrollReset: true })
  }

  function shiftCalendarMonth(delta: number) {
    setCalendarNavigation({
      selectedDate: calendarDate,
      month: new Date(
        Date.UTC(calendarMonth.getUTCFullYear(), calendarMonth.getUTCMonth() + delta, 1),
      ),
    })
  }

  function setSave(key: string, state: SaveState, revision?: number) {
    if (!key.startsWith(`${scope}:`)) return
    if (revision !== undefined && revisions.current.get(key) !== revision) return
    setSaveStates((current) => ({ ...current, [key]: state }))
  }

  function currentInputRevision(key: string) {
    return inputRevisions.current.get(key) ?? 0
  }

  function changeDraft(key: string, value: string) {
    const revision = (currentInputRevision(key) ?? 0) + 1
    inputRevisions.current.set(key, revision)
    draftsRef.current = { ...draftsRef.current, [key]: value }
    dirtyDraftsRef.current = { ...dirtyDraftsRef.current, [key]: true }
    setDrafts((current) => ({ ...current, [key]: value }))
    setDirtyDrafts((current) => ({ ...current, [key]: true }))
    setSaveStates((current) => {
      if (!(key in current)) return current
      const next = { ...current }
      delete next[key]
      return next
    })
    return revision
  }

  function clearSaveState(key: string) {
    setSaveStates((current) => {
      if (!(key in current)) return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  function clearDraft(key: string, expectedRevision: number) {
    if (currentInputRevision(key) !== expectedRevision) return false
    const nextDrafts = { ...draftsRef.current }
    delete nextDrafts[key]
    draftsRef.current = nextDrafts
    const nextDirtyDrafts = { ...dirtyDraftsRef.current }
    delete nextDirtyDrafts[key]
    dirtyDraftsRef.current = nextDirtyDrafts
    setDrafts((current) => {
      if (!(key in current)) return current
      const next = { ...current }
      delete next[key]
      return next
    })
    setDirtyDrafts((current) => {
      if (!(key in current)) return current
      const next = { ...current }
      delete next[key]
      return next
    })
    return true
  }

  function discardDraft(key: string) {
    inputRevisions.current.set(key, (currentInputRevision(key) ?? 0) + 1)
    const nextDrafts = { ...draftsRef.current }
    delete nextDrafts[key]
    draftsRef.current = nextDrafts
    const nextDirtyDrafts = { ...dirtyDraftsRef.current }
    delete nextDirtyDrafts[key]
    dirtyDraftsRef.current = nextDirtyDrafts
    setDrafts((current) => {
      if (!(key in current)) return current
      const next = { ...current }
      delete next[key]
      return next
    })
    setDirtyDrafts((current) => {
      if (!(key in current)) return current
      const next = { ...current }
      delete next[key]
      return next
    })
    setSaveStates((current) => {
      if (!(key in current)) return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  const enqueue = useCallback(
    (key: string, action: (revision: number) => Promise<void>, queueKey = key) => {
      const revision = (revisions.current.get(key) ?? 0) + 1
      revisions.current.set(key, revision)
      setSaveStates((current) => ({ ...current, [key]: { phase: 'saving' } }))
      const previous = queues.current.get(queueKey) ?? Promise.resolve()
      const next = previous
        .catch(() => undefined)
        .then(() => {
          if (revisions.current.get(key) !== revision) return
          return action(revision)
        })
      queues.current.set(queueKey, next)
      void next.finally(() => {
        if (queues.current.get(queueKey) === next) queues.current.delete(queueKey)
      })
      return next
    },
    [],
  )

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
        const confirmed = actual.items[0]
        queryClient.setQueryData<Attendance[]>(attendanceQueryKey, (current) =>
          current?.map((item) =>
            item.student_id === row.student_id
              ? { ...item, status, updated_at: confirmed?.updated_at ?? item.updated_at }
              : item,
          ),
        )
        setSave(key, { phase: 'saved' }, revision)
        void attendanceQuery.refetch()
        return
      }
      queryClient.setQueryData<Attendance[]>(attendanceQueryKey, (current) =>
        current?.map((item) => (item.student_id === row.student_id ? row : item)),
      )
      setSave(
        key,
        {
          phase: 'error',
          message: 'Изменение не сохранено. Возможно, занятие уже нельзя редактировать.',
          retry: () => void saveAttendance(row, status),
        },
        revision,
      )
    } catch (error) {
      setSave(
        key,
        {
          phase: 'error',
          uncertain: true,
          message: errorMessage(error),
          retry: () => void verifyAttendance(row, status, key, revision),
        },
        revision,
      )
    }
  }

  async function verifyScore(
    assessment: Assessment,
    row: Result,
    score: number | null,
    value: string,
    key: string,
    revision: number,
    inputRevision: number,
  ) {
    try {
      const actual = await apiFetch<Page<Result>>(
        `${path}/assessments/${encodeURIComponent(assessment.id)}/results?student_id=${encodeURIComponent(row.student_id)}&limit=1`,
        { authenticated: true, cache: 'no-store' },
      )
      const saved = actual.items[0]
      if ((saved?.score ?? null) === score) {
        if (currentInputRevision(key) !== inputRevision) return
        const keyForAssessment = [
          'teacher-journal-results',
          userId,
          selectedCourse,
          selectedGroup,
          assessment.id,
        ]
        queryClient.setQueryData<Result[]>(keyForAssessment, (current) =>
          current?.map((item) =>
            item.student_id === row.student_id
              ? { ...item, score: saved?.score ?? null, result_id: saved?.result_id ?? null }
              : item,
          ),
        )
        clearDraft(key, inputRevision)
        setSave(key, { phase: 'saved', value: score }, revision)
        void resultQueryByAssessment.get(assessment.id)?.refetch()
        return
      }
      if (currentInputRevision(key) === inputRevision)
        setSave(
          key,
          {
            phase: 'error',
            retry: () => void saveScore(assessment, row, value, inputRevision, true),
          },
          revision,
        )
    } catch {
      if (currentInputRevision(key) !== inputRevision) return
      setSave(
        key,
        {
          phase: 'error',
          uncertain: true,
          retry: () =>
            void verifyScore(assessment, row, score, value, key, revision, inputRevision),
        },
        revision,
      )
    }
  }

  async function saveAttendance(row: Attendance, status: 'attended' | 'absent' | 'unmarked') {
    if (!selectedLesson || !row.can_edit) return
    const key = scopedKey(`attendance:${selectedLesson?.id}:${row.student_id}`)
    await enqueue(key, async (revision) => {
      queryClient.setQueryData<Attendance[]>(attendanceQueryKey, (current) =>
        current?.map((item) => (item.student_id === row.student_id ? { ...item, status } : item)),
      )
      try {
        const saved = await apiFetch<AttendanceResponse>(
          `/api/v1/attendance/lessons/${encodeURIComponent(selectedLesson!.id)}/students/${encodeURIComponent(row.student_id)}`,
          {
            authenticated: true,
            method: status === 'unmarked' ? 'DELETE' : 'PUT',
            ...(status === 'unmarked' ? {} : { body: JSON.stringify({ status }) }),
          },
        )
        queryClient.setQueryData<Attendance[]>(attendanceQueryKey, (current) =>
          current?.map((item) =>
            item.student_id === row.student_id
              ? { ...item, status: saved.status, updated_at: saved.updated_at }
              : item,
          ),
        )
        setSave(key, { phase: 'saved' }, revision)
        void attendanceQuery.refetch()
      } catch (error) {
        // The write may have reached the server before a network failure; verify
        // against the authoritative attendance endpoint before showing an error.
        if (error instanceof ApiClientError && error.status !== undefined && error.status < 500) {
          queryClient.setQueryData<Attendance[]>(attendanceQueryKey, (current) =>
            current?.map((item) => (item.student_id === row.student_id ? row : item)),
          )
          setSave(
            key,
            {
              phase: 'error',
              message: errorMessage(error),
              retry: () => void saveAttendance(row, status),
            },
            revision,
          )
          return
        }
        await verifyAttendance(row, status, key, revision)
      }
    })
  }

  async function saveScore(
    assessment: Assessment,
    row: Result,
    value: string,
    inputRevision = currentInputRevision(scopedKey(`score:${assessment.id}:${row.student_id}`)) ??
      0,
    explicitRetry = false,
  ) {
    const key = scopedKey(`score:${assessment.id}:${row.student_id}`)
    if (!dirtyDrafts[key] || currentInputRevision(key) !== inputRevision) return
    if (!explicitRetry && attemptedInputRevisions.current.get(key) === inputRevision) return
    attemptedInputRevisions.current.set(key, inputRevision)
    const score = value === '' ? null : Number(value)
    if (score !== null && (!Number.isInteger(score) || score < 0 || score > assessment.max_score)) {
      setSaveStates((current) => ({
        ...current,
        [key]: {
          phase: 'error',
          retry: () => void saveScore(assessment, row, value, inputRevision, true),
        },
      }))
      return
    }
    await enqueue(key, async (revision) => {
      if (currentInputRevision(key) !== inputRevision) return
      try {
        const saved = await apiFetch<ScoreWriteResponse>(
          `${path}/assessments/${encodeURIComponent(assessment.id)}/results/${encodeURIComponent(row.student_id)}`,
          { authenticated: true, method: 'PUT', body: JSON.stringify({ score }) },
        )
        if (currentInputRevision(key) === inputRevision) {
          const keyForAssessment = [
            'teacher-journal-results',
            userId,
            selectedCourse,
            selectedGroup,
            assessment.id,
          ]
          queryClient.setQueryData<Result[]>(keyForAssessment, (current) =>
            current?.map((item) =>
              item.student_id === row.student_id
                ? {
                    ...item,
                    score: saved.score,
                    result_id: saved.result_id,
                    graded_at: saved.graded_at,
                  }
                : item,
            ),
          )
          clearDraft(key, inputRevision)
          setSave(key, { phase: 'saved', value: saved.score }, revision)
        }
        void resultQueryByAssessment.get(assessment.id)?.refetch()
      } catch {
        await verifyScore(assessment, row, score, value, key, revision, inputRevision)
      }
    })
  }

  async function verifyAssessmentDate(
    date: string,
    lesson: string,
    key: string,
    revision: number,
    dateKey: string,
    dateRevision: number,
    lessonKey: string,
    lessonRevision: number,
  ) {
    try {
      const actual = await apiFetch<Page<Assessment>>(
        `${path}/assessments?assessment_group_id=${encodeURIComponent(selectedAssessment!.id)}&limit=1`,
        { authenticated: true, cache: 'no-store' },
      )
      const row = actual.items[0]
      if (
        row &&
        row.planned_date === (date || null) &&
        row.lesson_id === (lesson || null) &&
        !row.date_needs_confirmation
      ) {
        queryClient.setQueryData<Assessment[]>(assessmentsQueryKey, (current) =>
          current?.map((item) =>
            item.id === row.id
              ? {
                  ...item,
                  planned_date: row.planned_date,
                  lesson_id: row.lesson_id,
                  date_needs_confirmation: row.date_needs_confirmation,
                }
              : item,
          ),
        )
        clearDraft(dateKey, dateRevision)
        clearDraft(lessonKey, lessonRevision)
        if (
          currentInputRevision(dateKey) === dateRevision &&
          currentInputRevision(lessonKey) === lessonRevision
        )
          setSave(key, { phase: 'saved' }, revision)
        void assessmentsQuery.refetch()
        return
      }
      if (
        currentInputRevision(dateKey) === dateRevision &&
        currentInputRevision(lessonKey) === lessonRevision
      )
        setSave(
          key,
          {
            phase: 'error',
            message: 'Сервер не подтвердил связь работы с занятием. Проверьте данные и повторите.',
            retry: () =>
              void saveAssessmentDate(
                date,
                lesson,
                dateKey,
                dateRevision,
                lessonKey,
                lessonRevision,
              ),
          },
          revision,
        )
    } catch {
      if (
        currentInputRevision(dateKey) !== dateRevision ||
        currentInputRevision(lessonKey) !== lessonRevision
      )
        return
      setSave(
        key,
        {
          phase: 'error',
          uncertain: true,
          retry: () =>
            void verifyAssessmentDate(
              date,
              lesson,
              key,
              revision,
              dateKey,
              dateRevision,
              lessonKey,
              lessonRevision,
            ),
        },
        revision,
      )
    }
  }

  async function saveAssessmentDate(
    date: string,
    lesson: string,
    dateKey: string,
    dateRevision: number,
    lessonKey: string,
    lessonRevision: number,
  ) {
    if (!selectedAssessment) return
    const key = scopedKey(`date:${selectedAssessment.id}`)
    await enqueue(key, async (revision) => {
      if (
        currentInputRevision(dateKey) !== dateRevision ||
        currentInputRevision(lessonKey) !== lessonRevision
      )
        return
      try {
        const saved = await apiFetch<components['schemas']['AssessmentDatesResponse']>(
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
        const updated = saved.items.find(
          (item) => item.assessment_group_id === selectedAssessment.id,
        )
        if (!updated) throw new Error('Assessment date update was not returned by the server')
        queryClient.setQueryData<Assessment[]>(assessmentsQueryKey, (current) =>
          current?.map((item) =>
            item.id === updated.assessment_group_id
              ? {
                  ...item,
                  planned_date: updated.planned_date,
                  lesson_id: updated.lesson_id,
                  date_needs_confirmation: updated.date_needs_confirmation,
                }
              : item,
          ),
        )
        clearDraft(dateKey, dateRevision)
        clearDraft(lessonKey, lessonRevision)
        if (
          currentInputRevision(dateKey) === dateRevision &&
          currentInputRevision(lessonKey) === lessonRevision
        )
          setSave(key, { phase: 'saved' }, revision)
        void assessmentsQuery.refetch()
      } catch {
        await verifyAssessmentDate(
          date,
          lesson,
          key,
          revision,
          dateKey,
          dateRevision,
          lessonKey,
          lessonRevision,
        )
      }
    })
  }

  async function verifyFinal(
    row: FinalResult,
    patch: Record<string, unknown>,
    key: string,
    revision: number,
    retry: () => void,
    inputRevision: number,
  ) {
    try {
      const actual = await apiFetch<FinalResult>(
        `/api/v1/final-results/courses/${encodeURIComponent(selectedCourse)}/students/${encodeURIComponent(row.student_id)}`,
        { authenticated: true, cache: 'no-store' },
      )
      const matches = Object.entries(patch).every(
        ([name, value]) => actual[name as keyof FinalResult] === value,
      )
      const expectsRetakeCleanup =
        (typeof patch.grade_value === 'number' && patch.grade_value >= 3) || patch.passed === true
      if (matches && (!expectsRetakeCleanup || (!actual.retake_date && !actual.retake_location))) {
        applyFinalServerResult(actual, row.student_id, key, inputRevision)
        if ('retake_date' in patch || 'retake_location' in patch) clearRetakeDrafts(row.student_id)
        if (currentInputRevision(key) === inputRevision) setSave(key, { phase: 'saved' }, revision)
        void finalsQuery.refetch()
      } else {
        reconcileFinalQuery(actual, row.student_id)
        if (currentInputRevision(key) === inputRevision)
          setSave(
            key,
            {
              phase: 'error',
              message: 'Сервер не подтвердил это изменение. Черновик оставлен.',
              retry,
            },
            revision,
          )
      }
    } catch {
      if (currentInputRevision(key) !== inputRevision) return
      setSave(
        key,
        {
          phase: 'error',
          uncertain: true,
          retry: () => void verifyFinal(row, patch, key, revision, retry, inputRevision),
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
    inputRevision: number,
  ) {
    const recordQueueKey = scopedKey(`final-record:${row.student_id}`)
    await enqueue(
      key,
      async (revision) => {
        if (currentInputRevision(key) !== inputRevision) return
        try {
          if ('retake_date' in patch || 'retake_location' in patch) {
            const confirmed = await apiFetch<FinalResult>(
              `/api/v1/final-results/courses/${encodeURIComponent(selectedCourse)}/students/${encodeURIComponent(row.student_id)}`,
              { authenticated: true, cache: 'no-store' },
            )
            if (!confirmed.has_debt) {
              reconcileFinalQuery(confirmed, row.student_id)
              if (currentInputRevision(key) === inputRevision)
                setSave(
                  key,
                  {
                    phase: 'error',
                    message:
                      'Пересдача недоступна: сервер не подтвердил задолженность. Сначала сохраните долг.',
                  },
                  revision,
                )
              return
            }
          }
          const actual = await apiFetch<FinalResult>(
            `/api/v1/final-results/courses/${encodeURIComponent(selectedCourse)}/students/${encodeURIComponent(row.student_id)}`,
            { authenticated: true, method: 'PATCH', body: JSON.stringify(patch) },
          )
          const matches = Object.entries(patch).every(
            ([name, value]) => actual[name as keyof FinalResult] === value,
          )
          const expectsRetakeCleanup =
            (typeof patch.grade_value === 'number' && patch.grade_value >= 3) ||
            patch.passed === true
          const retakeWasCleared =
            !expectsRetakeCleanup || (!actual.retake_date && !actual.retake_location)
          if (matches && retakeWasCleared) {
            applyFinalServerResult(actual, row.student_id, key, inputRevision)
            if ('retake_date' in patch || 'retake_location' in patch)
              clearRetakeDrafts(row.student_id)
            if (currentInputRevision(key) === inputRevision)
              setSave(key, { phase: 'saved' }, revision)
          } else {
            reconcileFinalQuery(actual, row.student_id)
            if (currentInputRevision(key) === inputRevision)
              setSave(
                key,
                {
                  phase: 'error',
                  message:
                    'Сервер сохранил другое значение. Черновик оставлен; проверьте итог и введите значение заново.',
                },
                revision,
              )
          }
          void finalsQuery.refetch()
        } catch {
          await verifyFinal(row, patch, key, revision, retry, inputRevision)
        }
      },
      recordQueueKey,
    )
  }

  function applyFinalServerResult(
    actual: FinalResult,
    studentId: string,
    changedKey: string,
    changedInputRevision: number,
  ) {
    reconcileFinalQuery(actual, studentId)
    clearDraft(changedKey, changedInputRevision)
    if (!actual.has_debt) {
      const baseKey = scopedKey(`final:${studentId}`)
      const gradeDraftIsDebt =
        dirtyDraftsRef.current[baseKey] &&
        (chosen?.attestation_type === 'pass_fail'
          ? draftsRef.current[baseKey] === 'false'
          : draftsRef.current[baseKey] === '2')
      if (!gradeDraftIsDebt) {
        for (const field of ['retake_date', 'retake_location']) {
          const fieldKey = `${baseKey}:${field}`
          discardDraft(fieldKey)
        }
      }
    }
  }

  function reconcileFinalQuery(actual: FinalResult, studentId: string) {
    queryClient.setQueryData<FinalResult[]>(finalsQueryKey, (current) =>
      current?.map((item) => (item.student_id === studentId ? actual : item)),
    )
  }

  function clearRetakeDrafts(studentId: string) {
    const baseKey = scopedKey(`final:${studentId}`)
    for (const field of ['retake_date', 'retake_location']) {
      const key = `${baseKey}:${field}`
      if (key in draftsRef.current) clearDraft(key, currentInputRevision(key))
    }
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
      <main className="section-page staff-journal teacher-journal">
        <JournalPageHeader
          eyebrow="Кабинет преподавателя"
          title="Мои журналы"
          description="Дисциплины, группы, успеваемость и история изменений."
        />
        <LoadingState title="Загружаем назначения…" />
      </main>
    )
  if (assignmentsQuery.isError)
    return (
      <main className="section-page staff-journal teacher-journal">
        <JournalPageHeader
          eyebrow="Кабинет преподавателя"
          title="Мои журналы"
          description="Дисциплины, группы, успеваемость и история изменений."
        />
        <QueryError error={assignmentsQuery.error} retry={() => void assignmentsQuery.refetch()} />
      </main>
    )

  const searchValue = catalogSearch.toLocaleLowerCase('ru-RU')
  const visibleAssignments = assignments.filter((assignment) =>
    [assignment.discipline.name, assignment.group.name, assignment.term.name]
      .join(' ')
      .toLocaleLowerCase('ru-RU')
      .includes(searchValue),
  )
  const currentLessonQuery = attendanceQuery
  const currentWorkQuery = resultsQuery
  const queryError =
    (selectedLesson && currentLessonQuery.isError) ||
    (selectedAssessment && resultsQuery?.isError) ||
    (activeTab === 'work' && resultQueries.some((query) => query?.isError)) ||
    (activeTab === 'finals' && finalsQuery.isError) ||
    (selectedCourse && lessonsQuery.isError)

  return (
    <main className="section-page staff-journal teacher-journal">
      <JournalPageHeader
        eyebrow="Кабинет преподавателя"
        title="Мои журналы"
        description="Дисциплины, группы, успеваемость и история изменений."
      />
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
          <JournalCard
            heading="Дисциплины и группы"
            description="Каталог сгруппирован по учебным периодам и группам."
          >
            <JournalSearch
              key={catalogSearch}
              label="Поиск дисциплины, группы или семестра"
              initial={catalogSearch}
              onSearch={(value) => setSelection('q', value)}
            />
            <JournalCatalog
              entries={visibleAssignments.map((item) => ({
                id: `${item.course_offering_id}:${item.group.id}`,
                label: `${item.discipline.name} · ${item.group.name} · ${item.term.name}`,
              }))}
              selected={chosen ? `${chosen.course_offering_id}:${chosen.group.id}` : ''}
              onSelect={(value) => {
                const [selectedCourseId, selectedGroupId] = value.split(':')
                if (!selectedCourseId || !selectedGroupId) return
                setParams(
                  {
                    course: selectedCourseId,
                    group: selectedGroupId,
                    tab: 'attendance',
                    ...(catalogSearch ? { q: catalogSearch } : {}),
                  },
                  { preventScrollReset: true },
                )
                setStudentSearch('')
              }}
            />
            {!visibleAssignments.length && <EmptyState title="Журналы не найдены" />}
          </JournalCard>
          {hasUnavailableDirectSelection && (
            <ErrorState
              title="Журнал недоступен"
              description="Назначение отозвано или ссылка устарела."
              onRetry={() => void assignmentsQuery.refetch()}
            />
          )}
          {chosen && (
            <>
              <JournalCourseSection heading={`${chosen.discipline.name} · ${chosen.group.name}`}>
                {(lessonsQuery.isPending ||
                  assessmentsQuery.isPending ||
                  (activeTab === 'finals' && finalsQuery.isPending) ||
                  (activeTab === 'work' && resultQueries.some((query) => query?.isPending))) && (
                  <LoadingState title="Загружаем журнал…" variant="compact" />
                )}
                {(lessonsQuery.isError ||
                  (activeTab === 'work' && resultQueries.some((query) => query?.isError)) ||
                  (activeTab === 'finals' && finalsQuery.isError)) && (
                  <QueryError
                    error={
                      lessonsQuery.error ??
                      resultQueries.find((query) => query?.error)?.error ??
                      finalsQuery.error
                    }
                    retry={() => {
                      void lessonsQuery.refetch()
                      void assessmentsQuery.refetch()
                      void finalsQuery.refetch()
                    }}
                  />
                )}
                <JournalTabs
                  ariaLabel="Разделы журнала"
                  idPrefix="teacher-journal"
                  options={[
                    { id: 'work', label: 'Работы и баллы' },
                    { id: 'attendance', label: 'Посещаемость' },
                    { id: 'finals', label: 'Итоги аттестации' },
                    { id: 'announcements', label: 'Объявления' },
                  ]}
                  selected={activeTab}
                  onSelect={(tab) => setSelection('tab', tab)}
                />
                {activeTab === 'attendance' ? (
                  <JournalTabPanel idPrefix="teacher-journal" tabId="attendance">
                    <JournalCard
                      heading="Посещаемость"
                      description={`Отмечайте присутствие на выбранном занятии · ${chosen.group.name}`}
                    >
                      <div className="journal-attendance-toolbar">
                        <section
                          className="teacher-journal-calendar"
                          aria-label="Календарь занятий"
                        >
                          <header>
                            <button
                              type="button"
                              aria-label="Предыдущий месяц"
                              onClick={() => shiftCalendarMonth(-1)}
                            >
                              ‹
                            </button>
                            <strong>{calendarMonthLabel}</strong>
                            <button
                              type="button"
                              aria-label="Следующий месяц"
                              onClick={() => shiftCalendarMonth(1)}
                            >
                              ›
                            </button>
                          </header>
                          <div
                            className="teacher-journal-calendar__grid"
                            aria-label={calendarMonthLabel}
                          >
                            {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((day) => (
                              <span key={day}>{day}</span>
                            ))}
                            {calendarCells.map((value, index) => {
                              if (!value) return <span key={`empty-${index}`} aria-hidden="true" />
                              const count = lessonsByDate.get(value)?.length ?? 0
                              const day = Number(value.slice(-2))
                              return (
                                <button
                                  key={value}
                                  type="button"
                                  aria-label={`${day} ${calendarMonthLabel}${count ? `, занятий: ${count}` : ', занятий нет'}`}
                                  aria-pressed={value === calendarDate}
                                  disabled={!count}
                                  className={count ? 'has-lessons' : undefined}
                                  onClick={() => chooseLessonDate(value)}
                                >
                                  {day}
                                  {count > 1 && <small>{count}</small>}
                                </button>
                              )
                            })}
                          </div>
                          <p>Даты с занятиями выделены; выберите дату, чтобы увидеть занятия.</p>
                        </section>
                        <section
                          className="teacher-journal__lesson-options"
                          aria-label="Занятия на выбранную дату"
                        >
                          <h3>{calendarDate ? formatDate(calendarDate) : 'Выберите дату'}</h3>
                          {(lessonsByDate.get(calendarDate) ?? []).length > 1 ? (
                            <div role="group" aria-label="Выбор занятия">
                              {(lessonsByDate.get(calendarDate) ?? []).map((item) => (
                                <button
                                  key={item.id}
                                  type="button"
                                  aria-pressed={selectedLesson?.id === item.id}
                                  onClick={() => chooseLesson(item)}
                                >
                                  <strong>{formatDateTime(item.starts_at)}</strong>
                                  <span>
                                    {item.kind}
                                    {item.status !== 'scheduled' ? ' · недоступно для отметки' : ''}
                                  </span>
                                </button>
                              ))}
                            </div>
                          ) : selectedLesson ? (
                            <p>
                              {formatDateTime(selectedLesson.starts_at)} · {selectedLesson.kind}
                            </p>
                          ) : (
                            <p>Выберите выделенную дату, чтобы открыть занятие.</p>
                          )}
                        </section>
                        <aside className="journal-attendance-note">
                          <strong>ⓘ Три состояния отметки</strong>
                          <span>Присутствовал, отсутствовал и нет отметки — разные значения.</span>
                        </aside>
                      </div>
                    </JournalCard>
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
                            {attendanceQuery.data.some((row) => !row.can_edit) && (
                              <p className="teacher-journal__edit-limit" role="status">
                                Неактивные отметки нельзя изменить: занятие ещё не началось,
                                отменено или студент не входит в доступный состав группы.
                              </p>
                            )}
                            <JournalSearch
                              key={selectedLesson.id}
                              label="Поиск по студентам"
                              onSearch={setStudentSearch}
                            />
                            <p className="teacher-journal__count">
                              Отмечено:{' '}
                              {
                                attendanceQuery.data.filter((row) => row.status !== 'unmarked')
                                  .length
                              }{' '}
                              из {attendanceQuery.data.length}
                            </p>
                            <JournalTable
                              label="Таблица посещаемости"
                              className="journal-table-scroll--mobile-cards"
                              columns={[
                                { id: 'student', label: 'Студент' },
                                { id: 'attendance', label: 'Посещаемость' },
                                { id: 'updated', label: 'Последнее изменение' },
                              ]}
                            >
                              {attendanceQuery.data
                                .filter((row) =>
                                  row.full_name
                                    .toLocaleLowerCase('ru-RU')
                                    .includes(studentSearch.toLocaleLowerCase('ru-RU')),
                                )
                                .map((row) => {
                                  const key = scopedKey(
                                    `attendance:${selectedLesson.id}:${row.student_id}`,
                                  )
                                  return (
                                    <tr key={row.student_id}>
                                      <td className="journal-table-student" data-label="Студент">
                                        {row.full_name}
                                        {row.subgroup_id && <small>Подгруппа</small>}
                                      </td>
                                      <td data-label="Посещаемость">
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
                                              disabled={
                                                !row.can_edit || saveStates[key]?.phase === 'saving'
                                              }
                                              onClick={() => void saveAttendance(row, status.value)}
                                            >
                                              {status.label}
                                            </button>
                                          ))}
                                        </div>
                                      </td>
                                      <td data-label="Последнее изменение">
                                        {row.updated_at ? formatDateTime(row.updated_at) : '—'}
                                        <SaveLabel
                                          state={saveStates[key]}
                                          onRetry={saveStates[key]?.retry}
                                        />
                                      </td>
                                    </tr>
                                  )
                                })}
                            </JournalTable>
                          </>
                        )}
                      </>
                    )}
                  </JournalTabPanel>
                ) : activeTab === 'work' ? (
                  <JournalTabPanel idPrefix="teacher-journal" tabId="work">
                    <JournalCard
                      heading="Рабочая ведомость: оценочные работы"
                      description={`${chosen.group.name} · ${chosen.term.name} · Максимумы утверждены заранее`}
                    >
                      {assessmentsQuery.isError ? (
                        <QueryError
                          error={assessmentsQuery.error}
                          retry={() => void assessmentsQuery.refetch()}
                        />
                      ) : !assessments.length && !assessmentsQuery.isPending ? (
                        <EmptyState
                          title="Утверждённых работ нет"
                          description="Для группы пока не назначены работы."
                        />
                      ) : (
                        <>
                          <JournalSearch
                            key={`${selectedCourse}:${selectedGroup}:${activeTab}`}
                            label="Поиск по студентам"
                            onSearch={setStudentSearch}
                          />
                          {resultQueries.some((query) => query?.isPending) ? (
                            <LoadingState title="Загружаем ведомость…" variant="compact" />
                          ) : resultQueries.some((query) => query?.isError) ? (
                            <QueryError
                              error={resultQueries.find((query) => query?.error)?.error}
                              retry={() => resultQueries.forEach((query) => void query?.refetch())}
                            />
                          ) : (
                            <JournalTable
                              label="Ведомость оценок"
                              className="journal-table-scroll--mobile-cards"
                              columns={[
                                { id: 'student', label: 'Студент' },
                                ...assessments.map((item) => ({
                                  id: item.id,
                                  label: item.title,
                                  hint: `из ${item.max_score} баллов`,
                                })),
                                { id: 'sum', label: 'Сумма' },
                              ]}
                            >
                              {workRows.map((row) => {
                                const total = assessments.reduce(
                                  (sum, item) => sum + (row.results.get(item.id)?.score ?? 0),
                                  0,
                                )
                                const maxTotal = assessments.reduce(
                                  (sum, item) => sum + item.max_score,
                                  0,
                                )
                                return (
                                  <tr key={row.studentId}>
                                    <td className="journal-table-student" data-label="Студент">
                                      {row.fullName}
                                    </td>
                                    {assessments.map((item) => {
                                      const result = row.results.get(item.id)
                                      if (!result)
                                        return (
                                          <td key={item.id} data-label={item.title}>
                                            —
                                          </td>
                                        )
                                      const key = scopedKey(`score:${item.id}:${row.studentId}`)
                                      const value =
                                        drafts[key] ??
                                        (result.score === null ? '' : String(result.score))
                                      const scoreSaveState = saveStates[key]
                                      const visibleScoreSaveState =
                                        scoreSaveState?.phase === 'saved' &&
                                        scoreSaveState.value !== result.score &&
                                        !dirtyDrafts[key]
                                          ? undefined
                                          : scoreSaveState
                                      return (
                                        <td key={item.id} data-label={item.title}>
                                          <div className="journal-score-cell">
                                            <input
                                              type="number"
                                              min={0}
                                              max={item.max_score}
                                              step={1}
                                              inputMode="numeric"
                                              aria-label={`Баллы: ${row.fullName} · ${item.title}`}
                                              disabled={!result.is_current_group_member}
                                              value={value}
                                              onChange={(event) =>
                                                void changeDraft(key, event.target.value)
                                              }
                                              onBlur={() => {
                                                if (dirtyDrafts[key])
                                                  void saveScore(item, result, value)
                                              }}
                                            />
                                            <span>/ {item.max_score}</span>
                                            <SaveLabel
                                              state={visibleScoreSaveState}
                                              onRetry={visibleScoreSaveState?.retry}
                                            />
                                          </div>
                                        </td>
                                      )
                                    })}
                                    <td className="journal-table-score" data-label="Сумма">
                                      {total} / {maxTotal}
                                    </td>
                                  </tr>
                                )
                              })}
                            </JournalTable>
                          )}
                          <button
                            type="button"
                            className="journal-table-save"
                            onClick={() => {
                              for (const row of workRows) {
                                for (const item of assessments) {
                                  const result = row.results.get(item.id)
                                  const key = scopedKey(`score:${item.id}:${row.studentId}`)
                                  if (result && dirtyDraftsRef.current[key])
                                    void saveScore(item, result, draftsRef.current[key] ?? '')
                                }
                              }
                            }}
                          >
                            ✓ &nbsp; Сохранить изменения
                          </button>
                        </>
                      )}
                    </JournalCard>
                    <details className="journal-assessment-settings">
                      <summary>Планирование и связь работ с занятиями</summary>
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
                      {selectedAssessment && (
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
                                  drafts[scopedKey(`date:${selectedAssessment.id}:date`)] ??
                                  selectedAssessment.planned_date ??
                                  ''
                                }
                                onChange={(event) => (
                                  changeDraft(
                                    scopedKey(`date:${selectedAssessment.id}:date`),
                                    event.target.value,
                                  ),
                                  clearSaveState(scopedKey(`date:${selectedAssessment.id}`))
                                )}
                              />
                            </label>
                            <label>
                              Связать с занятием
                              <select
                                aria-label="Связать с занятием"
                                value={
                                  drafts[scopedKey(`date:${selectedAssessment.id}:lesson`)] ??
                                  selectedAssessment.lesson_id ??
                                  ''
                                }
                                onChange={(event) => {
                                  const nextLessonId = event.target.value
                                  const selected = lessons.find((item) => item.id === nextLessonId)
                                  const dateKey = scopedKey(`date:${selectedAssessment.id}:date`)
                                  const lessonKey = scopedKey(
                                    `date:${selectedAssessment.id}:lesson`,
                                  )
                                  if (selected)
                                    changeDraft(dateKey, moscowCalendarDate(selected.starts_at))
                                  changeDraft(lessonKey, nextLessonId)
                                  clearSaveState(scopedKey(`date:${selectedAssessment.id}`))
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
                              {linkedLessonDraft && (
                                <span className="journal-date-link-status" role="status">
                                  {dirtyDrafts[scopedKey(`date:${selectedAssessment.id}:lesson`)] ||
                                  dirtyDrafts[scopedKey(`date:${selectedAssessment.id}:date`)]
                                    ? 'Не сохранено, выбрано занятие:'
                                    : 'Связано с занятием:'}{' '}
                                  {formatDateTime(linkedLessonDraft.starts_at)}
                                </span>
                              )}
                            </label>
                            <button
                              type="button"
                              className="journal-date-save"
                              disabled={
                                lessonDateMismatch ||
                                (!assessmentDateDraft && Boolean(assessmentLessonDraft))
                              }
                              onClick={() => {
                                const dateKey = scopedKey(`date:${selectedAssessment.id}:date`)
                                const lessonKey = scopedKey(`date:${selectedAssessment.id}:lesson`)
                                void saveAssessmentDate(
                                  drafts[dateKey] ?? selectedAssessment.planned_date ?? '',
                                  drafts[lessonKey] ?? selectedAssessment.lesson_id ?? '',
                                  dateKey,
                                  currentInputRevision(dateKey),
                                  lessonKey,
                                  currentInputRevision(lessonKey),
                                )
                              }}
                            >
                              Сохранить дату и связь
                            </button>
                            {lessonDateMismatch && (
                              <p role="status">
                                Дата работы и занятия должна совпадать по календарю Москвы.
                              </p>
                            )}
                            <SaveLabel
                              state={saveStates[scopedKey(`date:${selectedAssessment.id}`)]}
                              onRetry={
                                saveStates[scopedKey(`date:${selectedAssessment.id}`)]?.retry
                              }
                            />
                          </div>
                        </section>
                      )}
                    </details>
                  </JournalTabPanel>
                ) : activeTab === 'finals' ? (
                  <JournalTabPanel idPrefix="teacher-journal" tabId="finals">
                    <FinalResultsSection
                      key={scope}
                      rows={finalsQuery.data ?? []}
                      studentNames={studentNames}
                      pointsByStudent={workPointsByStudent}
                      attestationType={chosen.attestation_type}
                      studentSearch={studentSearch}
                      onStudentSearch={setStudentSearch}
                      loading={finalsQuery.isPending}
                      error={finalsQuery.error}
                      refetch={() => void finalsQuery.refetch()}
                      save={saveFinal}
                      states={saveStates}
                      scope={scope}
                      drafts={drafts}
                      changeDraft={changeDraft}
                      discardDraft={discardDraft}
                      inputRevision={currentInputRevision}
                      rosterLoading={rosterQuery.isPending}
                      rosterError={rosterQuery.error}
                      retryRoster={() => void rosterQuery.refetch()}
                    />
                  </JournalTabPanel>
                ) : (
                  <JournalTabPanel idPrefix="teacher-journal" tabId="announcements">
                    <TeacherAnnouncements
                      key={identity}
                      userId={userId}
                      courseId={courseId}
                      groupId={groupId}
                      expanded
                    />
                  </JournalTabPanel>
                )}
              </JournalCourseSection>
            </>
          )}
          {queryError && !chosen && (
            <p role="alert">{errorMessage(lessonsQuery.error ?? currentWorkQuery?.error)}</p>
          )}
        </>
      )}
    </main>
  )
}

function FinalResultsSection({
  rows,
  studentNames,
  pointsByStudent,
  attestationType,
  studentSearch,
  onStudentSearch,
  loading,
  error,
  refetch,
  save,
  states,
  scope,
  rosterLoading,
  rosterError,
  retryRoster,
  drafts,
  changeDraft,
  discardDraft,
  inputRevision,
}: {
  rows: FinalResult[]
  studentNames: Map<string, string | undefined>
  pointsByStudent: Map<string, { score: number; max: number }>
  attestationType: Assignment['attestation_type']
  studentSearch: string
  onStudentSearch: (query: string) => void
  loading: boolean
  error: unknown
  refetch: () => void
  save: (
    row: FinalResult,
    patch: Record<string, unknown>,
    key: string,
    retry: () => void,
    inputRevision: number,
  ) => Promise<void>
  states: Record<string, SaveState>
  scope: string
  drafts: Record<string, string>
  changeDraft: (key: string, value: string) => number
  discardDraft: (key: string) => void
  inputRevision: (key: string) => number
  rosterLoading: boolean
  rosterError: unknown
  retryRoster: () => void
}) {
  const [retakeStudentId, setRetakeStudentId] = useState<string | null>(null)
  const retakeDialog = useRef<HTMLDialogElement>(null)
  const retakeRow = rows.find((row) => row.student_id === retakeStudentId && row.has_debt)
  useEffect(() => {
    const dialog = retakeDialog.current
    if (retakeRow && dialog && !dialog.open) dialog.showModal()
    else if (!retakeRow && dialog?.open) dialog.close()
  }, [retakeRow])
  const retakeBaseKey = retakeRow ? `${scope}:final:${retakeRow.student_id}` : ''
  const dateKey = retakeRow ? `${retakeBaseKey}:retake_date` : ''
  const locationKey = retakeRow ? `${retakeBaseKey}:retake_location` : ''
  const saveKey = retakeRow ? `${retakeBaseKey}:retake-modal` : ''
  const retakeDate = retakeRow ? (drafts[dateKey] ?? retakeRow.retake_date ?? '') : ''
  const retakeLocation = retakeRow ? (drafts[locationKey] ?? retakeRow.retake_location ?? '') : ''
  const saveRetake = () => {
    if (!retakeRow || !retakeRow.has_debt) return
    const patch = {
      retake_date: retakeDate || null,
      retake_location: retakeLocation.trim() || null,
    }
    const revision = inputRevision(saveKey)
    const retry = () => void save(retakeRow, patch, saveKey, retry, revision)
    void save(retakeRow, patch, saveKey, retry, revision)
  }
  const cancelRetake = () => {
    if (states[saveKey]?.phase === 'saving') return
    if (dateKey) discardDraft(dateKey)
    if (locationKey) discardDraft(locationKey)
    if (saveKey) discardDraft(saveKey)
    setRetakeStudentId(null)
  }
  return (
    <section className="journal-finals" aria-labelledby="journal-finals-title">
      <div className="journal-finals-intro">
        <h2 id="journal-finals-title">Итоговая аттестация</h2>
        <p>Итоговая оценка выставляется вручную и не вычисляется автоматически из баллов.</p>
      </div>
      {loading ? (
        <LoadingState title="Загружаем итоги…" variant="compact" />
      ) : error ? (
        <QueryError error={error} retry={refetch} />
      ) : rosterLoading ? (
        <LoadingState title="Загружаем список студентов…" variant="compact" />
      ) : rosterError ? (
        <QueryError error={rosterError} retry={retryRoster} />
      ) : (
        <>
          <JournalSearch
            key="finals-search"
            label="Поиск по студентам"
            initial={studentSearch}
            onSearch={onStudentSearch}
          />
          <JournalTable
            label="Таблица итоговой аттестации"
            className="journal-table-scroll--mobile-cards"
            columns={[
              { id: 'student', label: 'Студент' },
              { id: 'points', label: 'Баллы за работы' },
              { id: 'result', label: 'Результат зачёта' },
              { id: 'comment', label: 'Комментарий' },
            ]}
          >
            {rows
              .filter((row) =>
                (studentNames.get(row.student_id) ?? `Студент ${row.student_id}`)
                  .toLocaleLowerCase('ru-RU')
                  .includes(studentSearch.toLocaleLowerCase('ru-RU')),
              )
              .map((row) => {
                const key = `${scope}:final:${row.student_id}`
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
                  const patch =
                    attestationType === 'pass_fail'
                      ? { passed: next === '' ? null : next === 'true' }
                      : { grade_value: next === '' ? null : Number(next) }
                  const revision = changeDraft(key, next)
                  const retry = () => void save(row, patch, key, retry, revision)
                  void save(row, patch, key, retry, revision)
                }
                const points = pointsByStudent.get(row.student_id)
                const retakeSaveKey = `${scope}:final:${row.student_id}:retake-modal`
                return (
                  <tr key={row.student_id}>
                    <td className="journal-table-student" data-label="Студент">
                      {displayName}
                    </td>
                    <td className="journal-table-score" data-label="Баллы за работы">
                      {points ? `${points.score} / ${points.max}` : '—'}
                    </td>
                    <td data-label="Результат зачёта">
                      <select
                        aria-label={`Итог: ${displayName}`}
                        value={value}
                        onChange={(event) => setResult(event.target.value)}
                      >
                        <option value="">Не выставлено</option>
                        {attestationType === 'pass_fail' ? (
                          <>
                            <option value="true">Зачтено</option>
                            <option value="false">Не зачтено</option>
                          </>
                        ) : (
                          [2, 3, 4, 5].map((grade) => (
                            <option key={grade} value={grade}>
                              {grade}
                            </option>
                          ))
                        )}
                      </select>
                      <SaveLabel state={states[key]} onRetry={states[key]?.retry} />
                    </td>
                    <td data-label="Комментарий">
                      <span>
                        {row.has_debt
                          ? 'Есть долг'
                          : value === ''
                            ? 'Итог записывается отдельно'
                            : 'Долга нет'}
                      </span>
                      {row.retake_date || row.retake_location ? (
                        <small className="teacher-journal__retake-summary">
                          Пересдача: {row.retake_date ?? 'дата не задана'} ·{' '}
                          {row.retake_location ?? 'место не задано'}
                        </small>
                      ) : null}
                      <button
                        type="button"
                        className="journal-retake-open"
                        disabled={!row.has_debt}
                        aria-label={`${row.retake_date || row.retake_location ? 'Изменить' : 'Назначить'} пересдачу: ${displayName}`}
                        title={!row.has_debt ? 'Доступно только при наличии долга' : undefined}
                        onClick={() => setRetakeStudentId(row.student_id)}
                      >
                        {row.retake_date || row.retake_location
                          ? 'Изменить пересдачу'
                          : 'Назначить пересдачу'}
                      </button>
                      <SaveLabel
                        state={states[retakeSaveKey]}
                        onRetry={states[retakeSaveKey]?.retry}
                      />
                    </td>
                  </tr>
                )
              })}
          </JournalTable>
        </>
      )}
      <dialog
        ref={retakeDialog}
        className="teacher-journal-dialog"
        aria-labelledby="teacher-retake-title"
        onCancel={(event) => {
          event.preventDefault()
          cancelRetake()
        }}
        onClose={() => setRetakeStudentId(null)}
      >
        {retakeRow && (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              saveRetake()
            }}
          >
            <h2 id="teacher-retake-title">
              Пересдача ·{' '}
              {studentNames.get(retakeRow.student_id) ?? `Студент ${retakeRow.student_id}`}
            </h2>
            <p>Назначение доступно студенту с долгом.</p>
            <label>
              Дата пересдачи
              <input
                type="date"
                value={retakeDate}
                onChange={(event) => {
                  changeDraft(dateKey, event.target.value)
                  changeDraft(saveKey, `${event.target.value}|${retakeLocation}`)
                }}
              />
            </label>
            <label>
              Место пересдачи
              <input
                value={retakeLocation}
                maxLength={200}
                onChange={(event) => {
                  changeDraft(locationKey, event.target.value)
                  changeDraft(saveKey, `${retakeDate}|${event.target.value}`)
                }}
              />
            </label>
            <SaveLabel state={states[saveKey]} onRetry={states[saveKey]?.retry} />
            <div className="teacher-journal-dialog__actions">
              <button type="submit" disabled={states[saveKey]?.phase === 'saving'}>
                Сохранить
              </button>
              <button
                type="button"
                onClick={cancelRetake}
                disabled={states[saveKey]?.phase === 'saving'}
              >
                Отмена
              </button>
            </div>
          </form>
        )}
      </dialog>
    </section>
  )
}
