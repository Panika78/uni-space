import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useBlocker } from 'react-router-dom'
import { ApiClientError, apiFetch } from '../../shared/api/client'
import { ErrorState, LoadingState } from '../../shared/ui/StatusStates'
import type { components } from '../../shared/api/schema'
import { addDays, formatDate, formatTime, getMoscowDate, getWeekStart } from './calendar'
import { useRoleContext } from '../auth/RoleContext'
import { useUnsavedChanges } from '../../app/UnsavedChangesContext'
import './staffSchedule.css'

type Kind = components['schemas']['EditorLesson']['kind']
type Lesson = components['schemas']['EditorLesson']
type LessonWrite = components['schemas']['LessonWrite']
type LessonChange = components['schemas']['LessonChange']
type CatalogKind =
  'groups' | 'subgroups' | 'teachers' | 'rooms' | 'course-offerings' | 'teaching-assignments'
type Resource = 'group' | 'teacher' | 'room'
type Operation = 'create' | 'edit' | 'move'

const kinds: Record<Kind, string> = {
  lecture: 'Лекция',
  seminar: 'Семинар',
  lab: 'Лабораторная работа',
  other: 'Занятие',
}
const resourceKinds: Record<Resource, CatalogKind> = {
  group: 'groups',
  teacher: 'teachers',
  room: 'rooms',
}
const resourceLabels: Record<Resource, string> = {
  group: 'Группы',
  teacher: 'Преподаватели',
  room: 'Аудитории',
}
const resourceSingular: Record<Resource, string> = {
  group: 'Группа',
  teacher: 'Преподаватель',
  room: 'Аудитория',
}
const base = '/api/v1/staff/schedule'

function dateAtMoscow(date: string, time: string) {
  return `${date}T${time}:00+03:00`
}

function localDateTime(timestamp: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp))
  const part = (name: string) => parts.find((item) => item.type === name)?.value ?? ''
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    time: `${part('hour')}:${part('minute')}`,
  }
}

function getErrorMessage(error: unknown) {
  if (!(error instanceof ApiClientError))
    return 'Не удалось связаться с сервером. Результат операции неизвестен.'
  if (error.status === 401) return 'Сессия завершилась. Войдите снова.'
  if (error.status === 403) return 'Доступ к редактору отозван. Данные расписания скрыты.'
  if (error.status === 404) return 'Запись не найдена или больше недоступна.'
  if (error.status === 422) return 'Проверьте заполнение полей и выбранный диапазон.'
  if (error.code === 'version_conflict')
    return 'Эту запись уже изменил другой сотрудник. Черновик сохранён; перечитайте запись перед повтором.'
  if (error.code === 'schedule_conflict')
    return 'Сохранение отклонено: найдены конфликты расписания.'
  if (error.code === 'invalid_transition')
    return 'Это действие больше недоступно для текущего состояния записи.'
  if (error.code === 'assessment_group_in_use')
    return 'Нельзя удалить последнюю группу, связанную с учебной работой.'
  if (error.code === 'assignment_conflict')
    return 'Проверьте проведение дисциплины, группы и назначение преподавателя.'
  if (error.code === 'concurrent_change')
    return 'Данные меняются одновременно. Обновите список и проверьте запись.'
  if (error.status && error.status >= 500)
    return 'Сервер не подтвердил результат. Перечитайте список; операция автоматически не повторялась.'
  return error.message
}

function isMutationOutcomeUncertain(error: unknown) {
  return (
    !(error instanceof ApiClientError) ||
    error.status === undefined ||
    error.status >= 500 ||
    (error.status >= 200 && error.status < 300)
  )
}

function catalogUrl(
  kind: CatalogKind,
  q: string,
  afterId: string | null,
  filters: Record<string, string | undefined> = {},
) {
  const params = new URLSearchParams({ limit: '50' })
  if (q.trim()) params.set('q', q.trim())
  if (afterId) params.set('after_id', afterId)
  Object.entries(filters).forEach(([key, value]) => {
    if (value) params.set(key, value)
  })
  return `${base}/catalog/${kind}?${params}`
}

function CatalogPicker({
  kind,
  value,
  onChange,
  label,
  multiple = false,
  filters = {},
  labelOverrides = {},
  allowedIds,
  invalid = false,
}: {
  kind: CatalogKind
  value: string[]
  onChange: (ids: string[]) => void
  label: string
  multiple?: boolean
  filters?: Record<string, string | undefined>
  labelOverrides?: Record<string, string>
  allowedIds?: string[]
  invalid?: boolean
}) {
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState(false)
  const { user_id: userId } = useRoleContext()
  const query = useInfiniteQuery({
    queryKey: ['staff-schedule', userId, 'catalog-picker', kind, search, filters],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      apiFetch<components['schemas']['CatalogPage']>(catalogUrl(kind, search, pageParam, filters), {
        authenticated: true,
        signal,
      }),
    getNextPageParam: (lastPage) => lastPage.next_after_id,
    enabled: expanded,
  })
  const items = query.data?.pages.flatMap((page) => page.items) ?? []
  const toggle = (id: string) => {
    if (!multiple) {
      onChange([id])
      setSearch('')
      setExpanded(false)
      return
    }
    onChange(value.includes(id) ? value.filter((item) => item !== id) : [...value, id])
  }
  const selectedNames = value
    .map((id) => labelOverrides[id] ?? items.find((item) => item.id === id)?.name)
    .filter(Boolean)
  const visibleItems = allowedIds ? items.filter((item) => allowedIds.includes(item.id)) : items
  return (
    <div className="staff-schedule__picker">
      <label>
        {label}
        <input
          aria-label={label}
          role="combobox"
          aria-expanded={expanded}
          aria-autocomplete="list"
          aria-invalid={invalid || undefined}
          value={expanded ? search : selectedNames.join(', ')}
          placeholder="Поиск по названию"
          onFocus={() => {
            setExpanded(true)
            setSearch('')
          }}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setExpanded(false)
          }}
        />
      </label>
      {value.length > 0 && multiple && (
        <div className="staff-schedule__chips">
          {value.map((id) => (
            <button type="button" key={id} onClick={() => toggle(id)}>
              {labelOverrides[id] ?? items.find((item) => item.id === id)?.name ?? 'Выбрано'} ×
            </button>
          ))}
        </div>
      )}
      {expanded && (
        <div className="staff-schedule__options" role="listbox" aria-label={`${label}: варианты`}>
          {query.isPending ? (
            <p>Загрузка справочника…</p>
          ) : query.isError ? (
            <p role="alert">
              {getErrorMessage(query.error)}{' '}
              <button type="button" onClick={() => void query.refetch()}>
                Повторить
              </button>
            </p>
          ) : (
            <>
              {visibleItems.map((item) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={value.includes(item.id)}
                  key={item.id}
                  onClick={() => toggle(item.id)}
                >
                  {item.name}
                  {item.building_name ? ` · ${item.building_name}` : ''}
                  {item.term_name ? ` · ${item.term_name}` : ''}
                </button>
              ))}
              {items.length === 0 && <p>Ничего не найдено</p>}
              {query.hasNextPage && (
                <button
                  type="button"
                  disabled={query.isFetchingNextPage}
                  onClick={() => void query.fetchNextPage()}
                >
                  {query.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё'}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function ScheduleForm({
  lesson,
  operation,
  onClose,
  onSaved,
}: {
  lesson: Lesson | null
  operation: Operation
  onClose: () => void
  onSaved: () => void
}) {
  const queryClient = useQueryClient()
  const { user_id: userId } = useRoleContext()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeDialogRef = useRef<HTMLDialogElement>(null)
  const navigationDialogRef = useRef<HTMLDialogElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const continueCloseRef = useRef<HTMLButtonElement>(null)
  const continueNavigationRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const [courseOffering, setCourseOffering] = useState(lesson?.course_offering_id ?? '')
  const [teacherIds, setTeacherIds] = useState(lesson?.teacher_id ? [lesson.teacher_id] : [])
  const [groupIds, setGroupIds] = useState(lesson?.participants.map((item) => item.group_id) ?? [])
  const [subgroupIds, setSubgroupIds] = useState<Record<string, string>>(
    Object.fromEntries(
      lesson?.participants
        .filter((item) => item.subgroup_id)
        .map((item) => [item.group_id, item.subgroup_id!]) ?? [],
    ),
  )
  const [roomIds, setRoomIds] = useState(lesson?.room_ids ?? [])
  const initial = lesson
    ? { start: localDateTime(lesson.starts_at), end: localDateTime(lesson.ends_at) }
    : null
  const [startDate, setStartDate] = useState(initial?.start.date ?? getMoscowDate())
  const [startTime, setStartTime] = useState(initial?.start.time ?? '09:00')
  const [endDate, setEndDate] = useState(initial?.end.date ?? getMoscowDate())
  const [endTime, setEndTime] = useState(initial?.end.time ?? '10:30')
  const [kind, setKind] = useState<Kind>(lesson?.kind ?? 'lecture')
  const [error, setError] = useState('')
  const [errorCode, setErrorCode] = useState('')
  const [errorDetails, setErrorDetails] = useState<components['schemas']['ErrorDetail'][]>([])
  const [latestVersion, setLatestVersion] = useState<Lesson | null>(null)
  const [expectedVersion, setExpectedVersion] = useState(lesson?.version ?? 0)
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [dirty, setDirty] = useState(false)
  const exitStatus = busy ? 'submitting' : uncertain ? 'uncertain' : dirty ? 'draft' : 'none'
  const { setStatus: setExitStatus } = useUnsavedChanges()
  const blocker = useBlocker(exitStatus !== 'none')
  const subgroupsQuery = useQuery({
    queryKey: ['staff-schedule', userId, 'subgroups', groupIds],
    queryFn: async ({ signal }) =>
      Promise.all(
        groupIds.map(async (groupId) => {
          const result = await apiFetch<components['schemas']['CatalogPage']>(
            catalogUrl('subgroups', '', null, { group_id: groupId }),
            { authenticated: true, signal },
          )
          return [groupId, result.items] as const
        }),
      ),
    enabled: groupIds.length > 0,
  })
  const assignmentsQuery = useQuery({
    queryKey: ['staff-schedule', userId, 'assignments', courseOffering, groupIds],
    queryFn: async ({ signal }) =>
      Promise.all(
        groupIds.map(async (groupId) => {
          const result = await apiFetch<components['schemas']['CatalogPage']>(
            catalogUrl('teaching-assignments', '', null, {
              course_offering_id: courseOffering,
              group_id: groupId,
            }),
            { authenticated: true, signal },
          )
          return result.items
            .map((assignment) => assignment.teacher_id)
            .filter((id): id is string => !!id)
        }),
      ),
    enabled: !!courseOffering && groupIds.length > 0,
  })
  const eligibleTeacherIds = assignmentsQuery.data?.length
    ? assignmentsQuery.data.reduce(
        (eligible, groupTeachers) => eligible.filter((id) => groupTeachers.includes(id)),
        assignmentsQuery.data[0],
      )
    : undefined
  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    returnFocusRef.current = document.activeElement as HTMLElement | null
    dialog.showModal()
    closeRef.current?.focus()
    return () => {
      if (dialog.open) dialog.close()
      const returnFocus = returnFocusRef.current
      window.requestAnimationFrame(() => returnFocus?.focus())
    }
  }, [])
  useEffect(() => {
    setExitStatus(exitStatus)
    return () => setExitStatus('none')
  }, [exitStatus, setExitStatus])
  useEffect(() => {
    if (exitStatus === 'none') return
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [exitStatus])
  useLayoutEffect(() => {
    const dialog = navigationDialogRef.current
    if (blocker.state === 'blocked') {
      if (!dialog?.open) dialog?.showModal()
      continueNavigationRef.current?.focus()
    } else if (dialog?.open) dialog.close()
    return () => {
      if (dialog?.open) dialog.close()
    }
  }, [blocker.state])
  useLayoutEffect(() => {
    const dialog = closeDialogRef.current
    if (confirmLeave) {
      if (!dialog?.open) dialog?.showModal()
      continueCloseRef.current?.focus()
    } else if (dialog?.open) dialog.close()
    return () => {
      if (dialog?.open) dialog.close()
    }
  }, [confirmLeave])
  const detailFor = (field: string) => errorDetails.filter((item) => item.field === field)
  const fieldMessage = (field: string) =>
    detailFor(field)
      .map((item) => item.code.replaceAll('_', ' '))
      .join('; ')
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setErrorCode('')
    setErrorDetails([])
    setUncertain(false)
    if (!courseOffering || !groupIds.length) {
      setError('Выберите проведение дисциплины и хотя бы одну группу.')
      return
    }
    if (
      Date.parse(dateAtMoscow(endDate, endTime)) <= Date.parse(dateAtMoscow(startDate, startTime))
    ) {
      setError('Время окончания должно быть позже времени начала.')
      return
    }
    const body: LessonWrite = {
      course_offering_id: courseOffering,
      teacher_id: teacherIds[0] ?? null,
      starts_at: dateAtMoscow(startDate, startTime),
      ends_at: dateAtMoscow(endDate, endTime),
      kind,
      participants: groupIds.map((group_id) => ({
        group_id,
        subgroup_id: subgroupIds[group_id] || null,
      })),
      room_ids: roomIds,
    }
    if (
      operation === 'move' &&
      lesson &&
      body.starts_at === lesson.starts_at &&
      body.ends_at === lesson.ends_at
    ) {
      setError('Для переноса измените дату или время занятия.')
      return
    }
    setBusy(true)
    try {
      if (operation === 'create') {
        await apiFetch<Lesson>(`${base}/lessons`, {
          authenticated: true,
          method: 'POST',
          body: JSON.stringify(body),
        })
      } else if (lesson && operation === 'edit') {
        const change: LessonChange = { ...body, version: expectedVersion }
        await apiFetch<Lesson>(`${base}/lessons/${lesson.id}`, {
          authenticated: true,
          method: 'PATCH',
          body: JSON.stringify(change),
        })
      } else if (lesson && operation === 'move') {
        const change: LessonChange = { ...body, version: expectedVersion }
        await apiFetch<Lesson>(`${base}/lessons/${lesson.id}/move`, {
          authenticated: true,
          method: 'POST',
          body: JSON.stringify(change),
        })
      }
      onSaved()
      void queryClient.invalidateQueries({ queryKey: ['staff-schedule', userId, 'lessons'] })
    } catch (caught) {
      setError(getErrorMessage(caught))
      if (caught instanceof ApiClientError) {
        setErrorCode(caught.code)
        setErrorDetails(caught.details)
        setUncertain(isMutationOutcomeUncertain(caught))
        if (caught.status === 403) {
          queryClient.removeQueries({ queryKey: ['staff-schedule'] })
          onClose()
        }
      } else setUncertain(true)
      requestAnimationFrame(() =>
        dialogRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      )
    } finally {
      setBusy(false)
    }
  }
  const readBack = async () => {
    if (!lesson) {
      await queryClient.invalidateQueries({ queryKey: ['staff-schedule', userId, 'lessons'] })
      return
    }
    await queryClient.invalidateQueries({
      queryKey: ['staff-schedule', userId, 'lesson', lesson.id],
    })
    await queryClient.invalidateQueries({ queryKey: ['staff-schedule', userId, 'lessons'] })
  }
  const fetchLatestVersion = async () => {
    if (!lesson) return
    try {
      const latest = await apiFetch<Lesson>(`${base}/lessons/${lesson.id}`, { authenticated: true })
      setLatestVersion(latest)
    } catch (caught) {
      setError(getErrorMessage(caught))
      if (caught instanceof ApiClientError && caught.status === 403) {
        queryClient.removeQueries({ queryKey: ['staff-schedule'] })
        onClose()
      }
    }
  }
  const close = () => {
    if (busy) return
    if (dirty && !confirmLeave) setConfirmLeave(true)
    else onClose()
  }
  const fieldError = (field: string) =>
    fieldMessage(field) ? (
      <small className="staff-schedule__field-error">{fieldMessage(field)}</small>
    ) : null
  return (
    <>
      <dialog
        ref={dialogRef}
        className="staff-schedule__dialog"
        aria-labelledby="staff-schedule-dialog-title"
        onCancel={(event) => {
          event.preventDefault()
          close()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            close()
          }
        }}
      >
        <form
          onSubmit={(event) => void submit(event)}
          onChange={() => setDirty(true)}
          className="staff-schedule__form"
        >
          <header>
            <div>
              <p className="section-eyebrow">
                Расписание ·{' '}
                {operation === 'create'
                  ? 'новое занятие'
                  : operation === 'move'
                    ? 'перенос'
                    : 'редактирование'}
              </p>
              <h2 id="staff-schedule-dialog-title">
                {operation === 'create'
                  ? 'Добавить занятие'
                  : operation === 'move'
                    ? 'Перенести занятие'
                    : 'Изменить занятие'}
              </h2>
            </div>
            <button
              ref={closeRef}
              type="button"
              className="staff-schedule__icon-button"
              onClick={close}
              aria-label="Закрыть окно"
            >
              ×
            </button>
          </header>
          <div className="staff-schedule__form-fields">
            <CatalogPicker
              label="Дисциплина и проведение"
              kind="course-offerings"
              value={courseOffering ? [courseOffering] : []}
              invalid={!!fieldMessage('course_offering_id')}
              labelOverrides={
                lesson
                  ? {
                      [lesson.course_offering_id]: `${lesson.display.course_offering.discipline_name} · ${lesson.display.course_offering.term_name}`,
                    }
                  : {}
              }
              onChange={(ids) => {
                setDirty(true)
                setCourseOffering(ids[0] ?? '')
                setGroupIds([])
                setSubgroupIds({})
                setTeacherIds([])
              }}
            />
            {fieldError('course_offering_id')}
            <CatalogPicker
              label="Преподаватель"
              kind="teachers"
              value={teacherIds}
              invalid={!!fieldMessage('teacher_id')}
              allowedIds={eligibleTeacherIds}
              labelOverrides={
                lesson?.display.teacher
                  ? { [lesson.display.teacher.id]: lesson.display.teacher.full_name }
                  : {}
              }
              onChange={(ids) => {
                setDirty(true)
                setTeacherIds(ids)
              }}
            />
            {fieldError('teacher_id')}
            {assignmentsQuery.isError && (
              <p className="staff-schedule__field-error">
                Не удалось проверить предметные назначения. Сервер всё равно проверит преподавателя
                при сохранении.
              </p>
            )}
            <CatalogPicker
              label="Группы"
              kind="groups"
              filters={{ course_offering_id: courseOffering || undefined }}
              value={groupIds}
              invalid={!!(fieldMessage('participants') || fieldMessage('group_id'))}
              labelOverrides={Object.fromEntries(
                lesson?.display.participants.map((item) => [item.group_id, item.group_name]) ?? [],
              )}
              onChange={(ids) => {
                setDirty(true)
                setGroupIds(ids)
                setSubgroupIds((old) =>
                  Object.fromEntries(Object.entries(old).filter(([group]) => ids.includes(group))),
                )
              }}
              multiple
            />
            {fieldError('participants')}
            {fieldError('group_id')}
            {fieldError('subgroup_id')}
            {groupIds.map((groupId) => (
              <label key={groupId}>
                Подгруппа ·{' '}
                {subgroupsQuery.data
                  ?.find(([id]) => id === groupId)?.[1]
                  .find((sub) => sub.id === subgroupIds[groupId])?.name ?? 'вся группа'}
                <select
                  aria-invalid={!!fieldMessage('subgroup_id') || undefined}
                  value={subgroupIds[groupId] ?? ''}
                  onChange={(event) => {
                    setDirty(true)
                    setSubgroupIds((old) => ({ ...old, [groupId]: event.target.value }))
                  }}
                >
                  <option value="">Вся группа</option>
                  {subgroupsQuery.data
                    ?.find(([id]) => id === groupId)?.[1]
                    .map((sub) => (
                      <option key={sub.id} value={sub.id}>
                        {sub.name}
                      </option>
                    ))}
                </select>
                {subgroupsQuery.isError && (
                  <small className="staff-schedule__field-error">
                    Не удалось загрузить подгруппы. Сохранение может быть неполным.
                  </small>
                )}
              </label>
            ))}
            <CatalogPicker
              label="Аудитории"
              kind="rooms"
              value={roomIds}
              invalid={!!(fieldMessage('room_ids') || fieldMessage('rooms'))}
              labelOverrides={Object.fromEntries(
                lesson?.display.rooms.map((item) => [
                  item.id,
                  `${item.building_name} · ${item.name}`,
                ]) ?? [],
              )}
              onChange={(ids) => {
                setDirty(true)
                setRoomIds(ids)
              }}
              multiple
            />
            {fieldError('room_ids')}
            {fieldError('rooms')}
            <label>
              Дата начала
              <input
                aria-invalid={!!fieldMessage('starts_at')}
                type="date"
                value={startDate}
                onChange={(event) => {
                  setDirty(true)
                  setStartDate(event.target.value)
                }}
              />
              {fieldError('starts_at')}
            </label>
            <label>
              Время начала · Москва
              <input
                aria-invalid={!!fieldMessage('starts_at')}
                type="time"
                value={startTime}
                onChange={(event) => {
                  setDirty(true)
                  setStartTime(event.target.value)
                }}
              />
              {fieldError('starts_at')}
            </label>
            <label>
              Дата окончания
              <input
                aria-invalid={!!fieldMessage('ends_at')}
                type="date"
                value={endDate}
                onChange={(event) => {
                  setDirty(true)
                  setEndDate(event.target.value)
                }}
              />
              {fieldError('ends_at')}
            </label>
            <label>
              Время окончания · Москва
              <input
                aria-invalid={!!fieldMessage('ends_at')}
                type="time"
                value={endTime}
                onChange={(event) => {
                  setDirty(true)
                  setEndTime(event.target.value)
                }}
              />
              {fieldError('ends_at')}
            </label>
            <label>
              Тип занятия
              <select
                value={kind}
                onChange={(event) => {
                  setDirty(true)
                  setKind(event.target.value as Kind)
                }}
              >
                {Object.entries(kinds).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              {fieldError('kind')}
            </label>
          </div>
          {error && (
            <div className="staff-schedule__form-alert" role="alert">
              <p>{error}</p>
              {errorDetails
                .filter((detail) => !detail.field)
                .map((detail) => (
                  <p key={detail.code}>{detail.code.replaceAll('_', ' ')}</p>
                ))}
              {uncertain && (
                <button type="button" onClick={() => void readBack()}>
                  Перечитать данные
                </button>
              )}
              {errorCode === 'version_conflict' && (
                <button type="button" onClick={() => void fetchLatestVersion()}>
                  Загрузить актуальную версию отдельно
                </button>
              )}
              {errorCode === 'invalid_transition' && (
                <button type="button" onClick={() => void readBack()}>
                  Обновить расписание
                </button>
              )}
            </div>
          )}
          {latestVersion && (
            <div className="staff-schedule__form-alert" role="status">
              <p>
                На сервере сейчас версия {latestVersion.version}:{' '}
                {formatDate(getMoscowDate(new Date(latestVersion.starts_at)), true)},{' '}
                {formatTime(latestVersion.starts_at)}–{formatTime(latestVersion.ends_at)}; «
                {latestVersion.display.course_offering.discipline_name}».
              </p>
              <p>Ваш черновик остался без изменений.</p>
              <button
                type="button"
                onClick={() => {
                  setExpectedVersion(latestVersion.version)
                  setLatestVersion(null)
                  setError(
                    'Выбран актуальный номер версии. Проверьте черновик и явно нажмите «Сохранить» ещё раз.',
                  )
                }}
              >
                Использовать только номер версии {latestVersion.version}
              </button>
            </div>
          )}
          <footer>
            <button
              type="button"
              className="staff-schedule__secondary"
              onClick={close}
              disabled={busy}
            >
              Отмена
            </button>
            <button type="submit" className="staff-schedule__primary" disabled={busy}>
              {busy ? 'Сохраняем…' : 'Сохранить'}
            </button>
          </footer>
        </form>
      </dialog>
      {confirmLeave && (
        <dialog
          ref={closeDialogRef}
          className="staff-schedule__dialog staff-schedule__confirm"
          role="alertdialog"
          aria-labelledby="staff-schedule-close-title"
          onCancel={(event) => {
            event.preventDefault()
            setConfirmLeave(false)
          }}
        >
          <h2 id="staff-schedule-close-title">Закрыть черновик?</h2>
          <p>Черновик не сохранён. Введённые данные будут потеряны.</p>
          <footer>
            <button
              ref={continueCloseRef}
              type="button"
              className="staff-schedule__secondary"
              onClick={() => setConfirmLeave(false)}
            >
              Продолжить редактирование
            </button>
            <button type="button" className="staff-schedule__danger" onClick={onClose}>
              Закрыть без сохранения
            </button>
          </footer>
        </dialog>
      )}
      {blocker.state === 'blocked' && (
        <dialog
          ref={navigationDialogRef}
          className="staff-schedule__dialog staff-schedule__confirm"
          aria-labelledby="staff-schedule-navigation-title"
          onCancel={(event) => {
            event.preventDefault()
            blocker.reset?.()
          }}
        >
          <h2 id="staff-schedule-navigation-title">
            {busy || uncertain
              ? 'Покинуть форму с неподтверждённым результатом?'
              : 'Выйти без сохранения?'}
          </h2>
          <p>
            {busy || uncertain
              ? 'Изменение могло сохраниться. Сначала проверьте расписание; запрос не будет отправлен повторно.'
              : 'Черновик не сохранён. Введённые данные будут потеряны.'}
          </p>
          <footer>
            <button
              ref={continueNavigationRef}
              type="button"
              className="staff-schedule__secondary"
              onClick={() => blocker.reset?.()}
            >
              Продолжить редактирование
            </button>
            <button
              type="button"
              className="staff-schedule__danger"
              onClick={() => blocker.proceed?.()}
            >
              {busy || uncertain ? 'Покинуть форму' : 'Выйти без сохранения'}
            </button>
          </footer>
        </dialog>
      )}
    </>
  )
}

export function StaffSchedulePage() {
  const { user_id: userId } = useRoleContext()
  const [searchParams, setSearchParams] = useSearchParams()
  const resource = (
    ['group', 'teacher', 'room'].includes(searchParams.get('resource') ?? '')
      ? searchParams.get('resource')
      : 'group'
  ) as Resource
  const selectedResourceId = searchParams.get('resource_id') ?? ''
  const date = searchParams.get('date') ?? getMoscowDate()
  const mode = searchParams.get('view') === 'day' ? 'day' : 'week'
  const [form, setForm] = useState<{ operation: Operation; lesson: Lesson | null } | null>(null)
  const [confirmCancel, setConfirmCancel] = useState<Lesson | null>(null)
  const [actionError, setActionError] = useState('')
  const [actionUncertain, setActionUncertain] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const retriedCursor = useRef(new Set<string>())
  const weekStart = getWeekStart(date)
  const dateFrom = mode === 'day' ? date : weekStart
  const dateTo = mode === 'day' ? date : addDays(weekStart, 6)
  const queryClient = useQueryClient()
  const catalog = useInfiniteQuery({
    queryKey: ['staff-schedule', userId, 'catalog', resource, searchParams.get('q') ?? ''],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      apiFetch<components['schemas']['CatalogPage']>(
        catalogUrl(resourceKinds[resource], searchParams.get('q') ?? '', pageParam),
        { authenticated: true, signal },
      ),
    getNextPageParam: (lastPage) => lastPage.next_after_id,
  })
  const resourceItems =
    catalog.isError &&
    catalog.error instanceof ApiClientError &&
    [403, 404].includes(catalog.error.status ?? 0)
      ? []
      : (catalog.data?.pages.flatMap((page) => page.items) ?? [])
  const schedule = useInfiniteQuery({
    queryKey: ['staff-schedule', userId, 'lessons', resource, selectedResourceId, dateFrom, dateTo],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => {
      const params = new URLSearchParams({
        resource,
        resource_id: selectedResourceId,
        date_from: dateFrom,
        date_to: dateTo,
        limit: '100',
      })
      if (pageParam) params.set('after_id', pageParam)
      return apiFetch<components['schemas']['EditorSchedule']>(`${base}/lessons?${params}`, {
        authenticated: true,
        signal,
      })
    },
    getNextPageParam: (lastPage) => lastPage.next_after_id,
    enabled: !!selectedResourceId,
  })
  const unavailable =
    schedule.isError &&
    schedule.error instanceof ApiClientError &&
    [403, 404].includes(schedule.error.status ?? 0)
  const lessons = useMemo(
    () => (unavailable ? [] : (schedule.data?.pages.flatMap((page) => page.items) ?? [])),
    [schedule.data, unavailable],
  )
  useEffect(() => {
    if (
      !(schedule.error instanceof ApiClientError) ||
      schedule.error.status !== 422 ||
      (schedule.data?.pages.length ?? 0) < 2
    )
      return
    const selectionKey = `${userId}:${resource}:${selectedResourceId}:${dateFrom}:${dateTo}`
    if (retriedCursor.current.has(selectionKey)) return
    retriedCursor.current.add(selectionKey)
    void queryClient.resetQueries({
      queryKey: [
        'staff-schedule',
        userId,
        'lessons',
        resource,
        selectedResourceId,
        dateFrom,
        dateTo,
      ],
    })
  }, [
    schedule.error,
    schedule.data,
    queryClient,
    userId,
    resource,
    selectedResourceId,
    dateFrom,
    dateTo,
  ])
  const grouped = useMemo(() => {
    const sorted = [...lessons].sort(
      (a, b) => a.starts_at.localeCompare(b.starts_at) || a.id.localeCompare(b.id),
    )
    return sorted.reduce<Record<string, Lesson[]>>((acc, lesson) => {
      const day = getMoscowDate(new Date(lesson.starts_at))
      ;(acc[day] ??= []).push(lesson)
      return acc
    }, {})
  }, [lessons])
  const changeResource = (next: Resource) => {
    setSearchParams({ resource: next, date, view: mode })
  }
  const updateDate = (next: string) => {
    setSearchParams({ resource, resource_id: selectedResourceId, date: next, view: mode })
  }
  const changeMode = (next: 'day' | 'week') => {
    setSearchParams({ resource, resource_id: selectedResourceId, date, view: next })
  }
  const mutateStatus = async (lesson: Lesson, action: 'cancel' | 'restore') => {
    setBusyId(lesson.id)
    setActionError('')
    setActionUncertain(false)
    try {
      await apiFetch<Lesson>(`${base}/lessons/${lesson.id}/${action}`, {
        authenticated: true,
        method: 'POST',
        body: JSON.stringify({ version: lesson.version }),
      })
      setConfirmCancel(null)
      void queryClient.invalidateQueries({ queryKey: ['staff-schedule', userId, 'lessons'] })
    } catch (error) {
      setActionError(getErrorMessage(error))
      setActionUncertain(isMutationOutcomeUncertain(error))
      if (error instanceof ApiClientError && error.status === 403) {
        setForm(null)
        queryClient.removeQueries({ queryKey: ['staff-schedule'] })
      }
      if (error instanceof ApiClientError && (error.status === undefined || error.status >= 500))
        setActionError(`${getErrorMessage(error)} Повторно операция не отправлялась.`)
    } finally {
      setBusyId(null)
    }
  }
  const navigateHistory = async (id: string) => {
    try {
      const lesson = await apiFetch<Lesson>(`${base}/lessons/${id}`, { authenticated: true })
      const positionDate = getMoscowDate(new Date(lesson.starts_at))
      setSearchParams({ resource, resource_id: selectedResourceId, date: positionDate, view: mode })
    } catch (error) {
      setActionError(getErrorMessage(error))
      if (error instanceof ApiClientError && error.status === 403) {
        queryClient.removeQueries({ queryKey: ['staff-schedule'] })
      }
    }
  }
  const loadLessonForEdit = async (id: string) => {
    try {
      const lesson = await apiFetch<Lesson>(`${base}/lessons/${id}`, { authenticated: true })
      setForm({ operation: 'edit', lesson })
    } catch (error) {
      setActionError(getErrorMessage(error))
      if (error instanceof ApiClientError && error.status === 403) {
        queryClient.removeQueries({ queryKey: ['staff-schedule'] })
      }
    }
  }
  const prevWeek = () => updateDate(addDays(date, mode === 'day' ? -1 : -7))
  const nextWeek = () => updateDate(addDays(date, mode === 'day' ? 1 : 7))
  const resourceName = resourceItems.find((item) => item.id === selectedResourceId)?.name
  const refetch = () => {
    void queryClient.resetQueries({
      queryKey: [
        'staff-schedule',
        userId,
        'lessons',
        resource,
        selectedResourceId,
        dateFrom,
        dateTo,
      ],
    })
  }
  const dates = Object.keys(grouped).sort()
  return (
    <main className="section-page staff-schedule" aria-labelledby="staff-schedule-title">
      <div className="staff-schedule__heading">
        <div>
          <p className="section-eyebrow">Кабинет сотрудника</p>
          <h1 id="staff-schedule-title">Редактор расписания</h1>
        </div>
        <button
          className="staff-schedule__primary"
          type="button"
          onClick={() => setForm({ operation: 'create', lesson: null })}
        >
          Добавить занятие
        </button>
      </div>
      <section className="staff-schedule__filters" aria-label="Параметры расписания">
        <div className="staff-schedule__tabs" role="tablist" aria-label="Представление расписания">
          {(['group', 'teacher', 'room'] as Resource[]).map((item) => (
            <button
              type="button"
              role="tab"
              aria-selected={resource === item}
              className={resource === item ? 'is-active' : ''}
              key={item}
              onClick={() => changeResource(item)}
            >
              {resourceLabels[item]}
            </button>
          ))}
        </div>
        <label className="staff-schedule__resource">
          {resourceSingular[resource]}
          <input
            role="combobox"
            aria-label={`Поиск: ${resourceLabels[resource].toLowerCase()}`}
            aria-expanded="true"
            placeholder="Начните вводить название"
            value={
              resourceItems.find((item) => item.id === selectedResourceId)?.name ??
              searchParams.get('q') ??
              ''
            }
            onChange={(event) => {
              const params = new URLSearchParams(searchParams)
              params.set('q', event.target.value)
              params.delete('resource_id')
              setSearchParams(params, { replace: true })
            }}
          />
          {resourceItems.length ? (
            <select
              aria-label={`Выберите: ${resourceLabels[resource].toLowerCase()}`}
              value={selectedResourceId}
              onChange={(event) => {
                setSearchParams({ resource, resource_id: event.target.value, date, view: mode })
              }}
            >
              <option value="">Выберите объект</option>
              {resourceItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          ) : null}
          {catalog.hasNextPage && (
            <button
              type="button"
              className="staff-schedule__text-button"
              disabled={catalog.isFetchingNextPage}
              onClick={() => void catalog.fetchNextPage()}
            >
              {catalog.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё объекты'}
            </button>
          )}
        </label>
        <div className="staff-schedule__date-controls">
          <button type="button" aria-label="Предыдущий период" onClick={prevWeek}>
            ←
          </button>
          <label>
            Дата
            <input
              aria-label="Выбрать дату"
              type="date"
              value={date}
              onChange={(event) => updateDate(event.target.value)}
            />
          </label>
          <button type="button" aria-label="Следующий период" onClick={nextWeek}>
            →
          </button>
          <div
            className="staff-schedule__tabs staff-schedule__view"
            role="group"
            aria-label="Период"
          >
            {(['day', 'week'] as const).map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={mode === item}
                className={mode === item ? 'is-active' : ''}
                onClick={() => changeMode(item)}
              >
                {item === 'day' ? 'День' : 'Неделя'}
              </button>
            ))}
          </div>
        </div>
      </section>
      <p className="staff-schedule__caption">
        {resourceName ? `${resourceName} · ` : ''}
        {mode === 'day'
          ? formatDate(date, true)
          : `${formatDate(dateFrom, true)} — ${formatDate(dateTo, true)}`}{' '}
        · время указано по Москве
      </p>
      {catalog.isError && (
        <ErrorState
          title="Не удалось загрузить справочник"
          description={getErrorMessage(catalog.error)}
          onRetry={() => void catalog.refetch()}
        />
      )}
      {!selectedResourceId && (
        <p className="staff-schedule__empty">Выберите объект, чтобы открыть расписание.</p>
      )}
      {selectedResourceId && schedule.isPending && (
        <LoadingState title="Загружаем расписание…" variant="compact" />
      )}
      {actionError && (
        <p className="staff-schedule__notice" role="alert">
          {actionError}
          {actionUncertain && (
            <button type="button" onClick={refetch}>
              Перечитать расписание
            </button>
          )}
        </p>
      )}
      {schedule.isError && (
        <ErrorState
          title={
            schedule.error instanceof ApiClientError && schedule.error.status === 403
              ? 'Доступ запрещён'
              : 'Не удалось загрузить расписание'
          }
          description={getErrorMessage(schedule.error)}
          onRetry={refetch}
        />
      )}
      {selectedResourceId && !schedule.isPending && !schedule.isError && lessons.length === 0 && (
        <p className="staff-schedule__empty">На этот период занятий нет.</p>
      )}
      {dates.map((day) => (
        <section
          className="staff-schedule__day"
          key={day}
          aria-labelledby={`staff-schedule-day-${day}`}
        >
          <h2 id={`staff-schedule-day-${day}`}>
            <span>{formatDate(day, true)}</span>
            {new Intl.DateTimeFormat('ru-RU', {
              timeZone: 'Europe/Moscow',
              weekday: 'short',
            }).format(new Date(`${day}T12:00:00Z`))}
          </h2>
          <div className="staff-schedule__lessons">
            {grouped[day].map((lesson) => (
              <article key={lesson.id} className={`staff-schedule__lesson is-${lesson.status}`}>
                <time className="staff-schedule__time" dateTime={lesson.starts_at}>
                  {formatTime(lesson.starts_at)}–{formatTime(lesson.ends_at)}
                </time>
                <div className="staff-schedule__details">
                  <h3>{lesson.display.course_offering.discipline_name}</h3>
                  <p>
                    {lesson.display.course_offering.term_name}
                    {lesson.display.course_offering.discipline_code
                      ? ` · ${lesson.display.course_offering.discipline_code}`
                      : ''}
                  </p>
                  <p>
                    {lesson.display.teacher?.full_name ?? 'Преподаватель не указан'} ·{' '}
                    {kinds[lesson.kind]}
                  </p>
                  <p>
                    {lesson.display.participants
                      .map(
                        (item) =>
                          `${item.group_name}${item.subgroup_name ? ` · ${item.subgroup_name}` : ''}`,
                      )
                      .join(', ')}
                  </p>
                  <p>
                    {lesson.display.rooms.length
                      ? lesson.display.rooms
                          .map((room) => `${room.building_name} · ${room.name}`)
                          .join(', ')
                      : 'Аудитория не указана'}
                  </p>
                  <small>
                    {lesson.status === 'cancelled'
                      ? 'Отменено'
                      : lesson.status === 'moved'
                        ? 'Перенесено'
                        : `Версия ${lesson.version}`}
                    {lesson.previous_lesson_id && (
                      <>
                        {' '}
                        ·{' '}
                        <button
                          type="button"
                          className="staff-schedule__text-button"
                          onClick={() => void navigateHistory(lesson.previous_lesson_id!)}
                        >
                          Предыдущее занятие
                        </button>
                      </>
                    )}
                    {lesson.next_lesson_id && (
                      <>
                        {' '}
                        ·{' '}
                        <button
                          type="button"
                          className="staff-schedule__text-button"
                          onClick={() => void navigateHistory(lesson.next_lesson_id!)}
                        >
                          Следующее занятие
                        </button>
                      </>
                    )}
                  </small>
                </div>
                <div className="staff-schedule__actions">
                  {lesson.status === 'scheduled' ? (
                    <>
                      <button type="button" onClick={() => void loadLessonForEdit(lesson.id)}>
                        Изменить
                      </button>
                      <button type="button" onClick={() => setForm({ operation: 'move', lesson })}>
                        Перенести
                      </button>
                      <button type="button" onClick={() => setConfirmCancel(lesson)}>
                        Отменить
                      </button>
                    </>
                  ) : lesson.status === 'cancelled' ? (
                    <button
                      type="button"
                      disabled={busyId === lesson.id}
                      onClick={() => void mutateStatus(lesson, 'restore')}
                    >
                      {busyId === lesson.id ? 'Восстанавливаем…' : 'Восстановить'}
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}
      {schedule.hasNextPage && (
        <button
          type="button"
          className="staff-schedule__secondary staff-schedule__more"
          disabled={schedule.isFetchingNextPage}
          onClick={() => void schedule.fetchNextPage()}
        >
          {schedule.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё занятия'}
        </button>
      )}
      {confirmCancel && (
        <CancelDialog
          lesson={confirmCancel}
          busy={busyId === confirmCancel.id}
          onClose={() => setConfirmCancel(null)}
          onConfirm={() => void mutateStatus(confirmCancel, 'cancel')}
        />
      )}
      {form && (
        <ScheduleForm
          key={`${form.operation}-${form.lesson?.id ?? 'new'}`}
          {...form}
          onClose={() => setForm(null)}
          onSaved={() => setForm(null)}
        />
      )}
    </main>
  )
}

function CancelDialog({
  lesson,
  busy,
  onClose,
  onConfirm,
}: {
  lesson: Lesson
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    cancelRef.current?.focus()
    return () => {
      if (dialog?.open) dialog.close()
    }
  }, [])
  return (
    <dialog
      ref={ref}
      className="staff-schedule__dialog staff-schedule__confirm"
      aria-labelledby="staff-cancel-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <h2 id="staff-cancel-title">Отменить занятие?</h2>
      <p>
        {lesson.display.course_offering.discipline_name} ·{' '}
        {formatDate(getMoscowDate(new Date(lesson.starts_at)), true)},{' '}
        {formatTime(lesson.starts_at)}
      </p>
      <p>Запись останется в истории. Студенты увидят отметку «Отменено».</p>
      <footer>
        <button
          ref={cancelRef}
          type="button"
          className="staff-schedule__secondary"
          onClick={onClose}
          disabled={busy}
        >
          Оставить занятие
        </button>
        <button
          type="button"
          className="staff-schedule__danger"
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? 'Отменяем…' : 'Подтвердить отмену'}
        </button>
      </footer>
    </dialog>
  )
}
