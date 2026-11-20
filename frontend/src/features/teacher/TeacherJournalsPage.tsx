import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { apiFetch, ApiClientError } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/StatusStates'
import { TeacherAnnouncements } from '../announcements/TeacherAnnouncements'
import { useRoleContext } from '../auth/RoleContext'
import { formatDateTime, SaveLabel, statuses, type SaveState } from './journalControls'
import './teacherJournals.css'

type Assignment = components['schemas']['TeachingAssignmentResponse']
type Lesson = components['schemas']['JournalLesson']
type Attendance = components['schemas']['JournalAttendanceRow']
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
  const activeTab = params.get('tab') === 'work' ? 'work' : 'attendance'
  const lessonId = params.get('lesson') ?? ''
  const assessmentId = params.get('assessment') ?? ''
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [dirtyDrafts, setDirtyDrafts] = useState<Record<string, boolean>>({})
  const draftsRef = useRef(drafts)
  const dirtyDraftsRef = useRef(dirtyDrafts)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
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
  const selectedAssessment = assessments.find((item) => item.id === assessmentId)
  const resultsQueryKey = [
    'teacher-journal-results',
    userId,
    selectedCourse,
    selectedGroup,
    selectedAssessment?.id,
  ]
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
    queryKey: resultsQueryKey,
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
    setParams(next, { preventScrollReset: true })
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
    inputRevision: number,
  ) {
    try {
      const actual = await apiFetch<Page<Result>>(
        `${path}/assessments/${encodeURIComponent(selectedAssessment!.id)}/results?student_id=${encodeURIComponent(row.student_id)}&limit=1`,
        { authenticated: true, cache: 'no-store' },
      )
      const saved = actual.items[0]
      if ((saved?.score ?? null) === score) {
        if (currentInputRevision(key) !== inputRevision) return
        queryClient.setQueryData<Result[]>(resultsQueryKey, (current) =>
          current?.map((item) =>
            item.student_id === row.student_id
              ? { ...item, score: saved?.score ?? null, result_id: saved?.result_id ?? null }
              : item,
          ),
        )
        clearDraft(key, inputRevision)
        setSave(key, { phase: 'saved', value: score }, revision)
        void resultsQuery.refetch()
        return
      }
      if (currentInputRevision(key) === inputRevision)
        setSave(
          key,
          { phase: 'error', retry: () => void saveScore(row, value, inputRevision, true) },
          revision,
        )
    } catch {
      if (currentInputRevision(key) !== inputRevision) return
      setSave(
        key,
        {
          phase: 'error',
          uncertain: true,
          retry: () => void verifyScore(row, score, value, key, revision, inputRevision),
        },
        revision,
      )
    }
  }

  async function saveAttendance(row: Attendance, status: 'attended' | 'absent' | 'unmarked') {
    const key = scopedKey(`attendance:${selectedLesson?.id}:${row.student_id}`)
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

  async function saveScore(
    row: Result,
    value: string,
    inputRevision = currentInputRevision(
      scopedKey(`score:${selectedAssessment?.id}:${row.student_id}`),
    ) ?? 0,
    explicitRetry = false,
  ) {
    const key = scopedKey(`score:${selectedAssessment?.id}:${row.student_id}`)
    if (!dirtyDrafts[key] || currentInputRevision(key) !== inputRevision) return
    if (!explicitRetry && attemptedInputRevisions.current.get(key) === inputRevision) return
    attemptedInputRevisions.current.set(key, inputRevision)
    const score = value === '' ? null : Number(value)
    if (
      score !== null &&
      (!Number.isInteger(score) || score < 0 || score > (selectedAssessment?.max_score ?? 0))
    ) {
      setSaveStates((current) => ({
        ...current,
        [key]: {
          phase: 'error',
          retry: () => void saveScore(row, value, inputRevision, true),
        },
      }))
      return
    }
    await enqueue(key, async (revision) => {
      if (currentInputRevision(key) !== inputRevision) return
      try {
        const saved = await apiFetch<ScoreWriteResponse>(
          `${path}/assessments/${encodeURIComponent(selectedAssessment!.id)}/results/${encodeURIComponent(row.student_id)}`,
          { authenticated: true, method: 'PUT', body: JSON.stringify({ score }) },
        )
        if (currentInputRevision(key) === inputRevision) {
          queryClient.setQueryData<Result[]>(resultsQueryKey, (current) =>
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
        void resultsQuery.refetch()
      } catch {
        await verifyScore(row, score, value, key, revision, inputRevision)
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
        if (updated) {
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
        }
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
    const key = assignment.course_offering_id
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
          <nav className="teacher-journal__selectors" aria-label="Доступные журналы">
            {[...grouped].map(([offeringId, entries]) => {
              const offering = entries[0]
              const label = `${offering.discipline.name} · ${offering.term.name}`
              return (
                <details
                  key={offeringId}
                  data-course-id={offeringId}
                  open={selectedCourse === offeringId}
                >
                  <summary>{label}</summary>
                  <ul>
                    {entries.map((item) => (
                      <li key={item.group.id}>
                        <button
                          type="button"
                          data-course-id={offeringId}
                          data-group-id={item.group.id}
                          aria-current={
                            selectedCourse === offeringId && selectedGroup === item.group.id
                              ? 'page'
                              : undefined
                          }
                          onClick={() =>
                            setParams({
                              course: offeringId,
                              group: item.group.id,
                              tab: 'attendance',
                            })
                          }
                        >
                          {item.group.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              )
            })}
          </nav>
          {hasUnavailableDirectSelection && (
            <ErrorState
              title="Журнал недоступен"
              description="Назначение отозвано или ссылка устарела."
              onRetry={() => void assignmentsQuery.refetch()}
            />
          )}
          {chosen && (
            <>
              <TeacherAnnouncements
                key={identity}
                userId={userId}
                courseId={courseId}
                groupId={groupId}
              />
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
              <div
                className="teacher-journal__tabs"
                role="tablist"
                aria-label="Раздел журнала"
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                  event.preventDefault()
                  const next = activeTab === 'attendance' ? 1 : 0
                  setSelection('tab', next === 0 ? 'attendance' : 'work')
                  tabRefs.current[next]?.focus()
                }}
              >
                <button
                  ref={(node) => {
                    tabRefs.current[0] = node
                  }}
                  type="button"
                  role="tab"
                  id="teacher-journal-tab-attendance"
                  aria-controls="teacher-journal-panel-attendance"
                  tabIndex={activeTab === 'attendance' ? 0 : -1}
                  aria-selected={activeTab === 'attendance'}
                  onClick={() => setSelection('tab', 'attendance')}
                >
                  Посещаемость
                </button>
                <button
                  ref={(node) => {
                    tabRefs.current[1] = node
                  }}
                  type="button"
                  role="tab"
                  id="teacher-journal-tab-work"
                  aria-controls="teacher-journal-panel-work"
                  tabIndex={activeTab === 'work' ? 0 : -1}
                  aria-selected={activeTab === 'work'}
                  onClick={() => setSelection('tab', 'work')}
                >
                  Работы и баллы
                </button>
              </div>
              {activeTab === 'attendance' ? (
                <section
                  id="teacher-journal-panel-attendance"
                  aria-labelledby="teacher-journal-tab-attendance"
                  className="teacher-journal__panel"
                  role="tabpanel"
                  tabIndex={0}
                >
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
                              const key = scopedKey(
                                `attendance:${selectedLesson.id}:${row.student_id}`,
                              )
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
                <section
                  id="teacher-journal-panel-work"
                  aria-labelledby="teacher-journal-tab-work"
                  className="teacher-journal__panel"
                  role="tabpanel"
                  tabIndex={0}
                >
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
                                const value = event.target.value
                                changeDraft(
                                  scopedKey(`date:${selectedAssessment.id}:lesson`),
                                  value,
                                )
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
                            onRetry={saveStates[scopedKey(`date:${selectedAssessment.id}`)]?.retry}
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
                            const key = scopedKey(
                              `score:${selectedAssessment.id}:${row.student_id}`,
                            )
                            const value =
                              drafts[key] ?? (row.score === null ? '' : String(row.score))
                            const scoreSaveState = saveStates[key]
                            const visibleScoreSaveState =
                              scoreSaveState?.phase === 'saved' &&
                              scoreSaveState.value !== row.score &&
                              !dirtyDrafts[key]
                                ? undefined
                                : scoreSaveState
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
                                    onChange={(event) => void changeDraft(key, event.target.value)}
                                    onBlur={() => {
                                      if (dirtyDrafts[key]) void saveScore(row, value)
                                    }}
                                  />
                                  <span>/ {selectedAssessment.max_score}</span>
                                </label>
                                <SaveLabel
                                  state={visibleScoreSaveState}
                                  onRetry={visibleScoreSaveState?.retry}
                                />
                              </article>
                            )
                          })}
                        </div>
                      )}
                    </>
                  )}
                  <FinalResultsSection
                    key={scope}
                    rows={finalsQuery.data ?? []}
                    studentNames={studentNames}
                    attestationType={chosen.attestation_type}
                    loading={finalsQuery.isPending}
                    error={finalsQuery.error}
                    refetch={() => void finalsQuery.refetch()}
                    save={saveFinal}
                    states={saveStates}
                    scope={scope}
                    drafts={drafts}
                    dirtyDrafts={dirtyDrafts}
                    changeDraft={changeDraft}
                    inputRevision={currentInputRevision}
                    rosterLoading={rosterQuery.isPending}
                    rosterError={rosterQuery.error}
                    retryRoster={() => void rosterQuery.refetch()}
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
  scope,
  rosterLoading,
  rosterError,
  retryRoster,
  drafts,
  dirtyDrafts,
  changeDraft,
  inputRevision,
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
    inputRevision: number,
  ) => Promise<void>
  states: Record<string, SaveState>
  scope: string
  drafts: Record<string, string>
  dirtyDrafts: Record<string, boolean>
  changeDraft: (key: string, value: string) => number
  inputRevision: (key: string) => number
  rosterLoading: boolean
  rosterError: unknown
  retryRoster: () => void
}) {
  const title =
    attestationType === 'pass_fail'
      ? 'Зачёт'
      : attestationType === 'graded_pass'
        ? 'Дифференцированный зачёт'
        : 'Экзамен'
  return (
    <section className="journal-finals" aria-labelledby="journal-finals-title">
      <div className="journal-finals-intro">
        <h2 id="journal-finals-title">Итоги аттестации · {title}</h2>
        <p>Итог выставляется вручную; сумма баллов не преобразуется в оценку автоматически.</p>
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
        <div className="journal-student-list journal-student-list--final">
          {rows.map((row) => {
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
            const retakeDateKey = `${key}:retake_date`
            const retakeLocationKey = `${key}:retake_location`
            const retakeDate = drafts[retakeDateKey] ?? row.retake_date ?? ''
            const retakeLocation = drafts[retakeLocationKey] ?? row.retake_location ?? ''
            const draftedHasDebt = row.has_debt
            return (
              <article className="journal-student journal-student--final" key={row.student_id}>
                <div className="journal-student__identity">
                  <strong>{displayName}</strong>
                  <span>
                    {draftedHasDebt
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
                      disabled={!draftedHasDebt}
                      onChange={(event) => changeDraft(retakeDateKey, event.target.value)}
                      onBlur={() => {
                        if (!dirtyDrafts[retakeDateKey]) return
                        const patch = { retake_date: retakeDate || null }
                        const revision = inputRevision(retakeDateKey)
                        const retry = () => void save(row, patch, retakeDateKey, retry, revision)
                        void save(row, patch, retakeDateKey, retry, revision)
                      }}
                    />
                  </label>
                  <label>
                    Место пересдачи
                    <input
                      maxLength={200}
                      aria-label={`Место пересдачи: ${displayName}`}
                      value={retakeLocation}
                      disabled={!draftedHasDebt}
                      onChange={(event) => changeDraft(retakeLocationKey, event.target.value)}
                      onBlur={() => {
                        if (!dirtyDrafts[retakeLocationKey]) return
                        const patch = { retake_location: retakeLocation || null }
                        const revision = inputRevision(retakeLocationKey)
                        const retry = () =>
                          void save(row, patch, retakeLocationKey, retry, revision)
                        void save(row, patch, retakeLocationKey, retry, revision)
                      }}
                    />
                  </label>
                  <SaveLabel state={states[retakeDateKey]} onRetry={states[retakeDateKey]?.retry} />
                  <SaveLabel
                    state={states[retakeLocationKey]}
                    onRetry={states[retakeLocationKey]?.retry}
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
