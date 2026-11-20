import { useInfiniteQuery, useQueries, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useBlocker } from 'react-router-dom'
import { ApiClientError, apiFetch } from '../../shared/api/client'
import { ErrorState, LoadingState } from '../../shared/ui/StatusStates'
import type { components } from '../../shared/api/schema'
import {
  addDays,
  formatDate,
  formatLessonTimeRange,
  formatTime,
  groupLessonsByVisibleDays,
  getMoscowDate,
  getWeekStart,
  isValidCalendarDate,
} from './calendar'
import { useRoleContext } from '../auth/RoleContext'
import { useUnsavedChanges } from '../../app/UnsavedChangesContext'
import './staffSchedule.css'

type Kind = components['schemas']['EditorLesson']['kind']
type Lesson = components['schemas']['EditorLesson']
type LessonWrite = components['schemas']['LessonWrite']
type LessonChange = components['schemas']['LessonChange']
type CatalogItem = components['schemas']['CatalogItem']
type CatalogKind =
  'groups' | 'subgroups' | 'teachers' | 'rooms' | 'course-offerings' | 'teaching-assignments'
type Resource = 'group' | 'teacher' | 'room'
type Operation = 'create' | 'edit' | 'move'
type ParticipantSelection = { wholeGroup: boolean; subgroupIds: string[] }

function getInitialParticipantSelection(lesson: Lesson | null) {
  const grouped = new Map<string, string[]>()
  const wholeGroups = new Set<string>()
  for (const participant of lesson?.participants ?? []) {
    const groupId = participant.group_id
    const subgroupId = participant.subgroup_id ?? null
    if (subgroupId === null) wholeGroups.add(groupId)
    else grouped.set(groupId, [...(grouped.get(groupId) ?? []), subgroupId])
  }
  const groupIds = [...new Set(lesson?.participants.map((item) => item.group_id) ?? [])]
  const selections = Object.fromEntries(
    groupIds.map((groupId) => [
      groupId,
      wholeGroups.has(groupId)
        ? { wholeGroup: true, subgroupIds: [] }
        : { wholeGroup: false, subgroupIds: grouped.get(groupId) ?? [] },
    ]),
  ) as Record<string, ParticipantSelection>
  return { groupIds, selections }
}

async function fetchCatalogItems(
  kind: CatalogKind,
  filters: Record<string, string | undefined>,
  signal: AbortSignal,
) {
  const items: CatalogItem[] = []
  let afterId: string | null = null
  do {
    const result: components['schemas']['CatalogPage'] = await apiFetch<
      components['schemas']['CatalogPage']
    >(catalogUrl(kind, '', afterId, filters), { authenticated: true, signal })
    items.push(...result.items)
    afterId = result.next_after_id
  } while (afterId)
  return items
}

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

function describeLesson(lesson: Lesson) {
  const start = localDateTime(lesson.starts_at)
  const end = localDateTime(lesson.ends_at)
  return [
    [
      'Дисциплина и проведение',
      `${lesson.display.course_offering.discipline_name} · ${lesson.display.course_offering.term_name}`,
    ],
    ['Время', `${start.date} ${start.time}–${end.date} ${end.time} · Москва`],
    ['Вид занятия', kinds[lesson.kind]],
    ['Преподаватель', lesson.display.teacher?.full_name ?? 'Не указан'],
    [
      'Участники',
      lesson.display.participants
        .map((item) => `${item.group_name}${item.subgroup_name ? ` · ${item.subgroup_name}` : ''}`)
        .join(', '),
    ],
    [
      'Аудитории',
      lesson.display.rooms.map((room) => `${room.building_name} · ${room.name}`).join(', ') ||
        'Не указаны',
    ],
  ] as const
}

function getLessonResource(lesson: Lesson, preferred: Resource, selectedId: string) {
  const resources: Array<{ resource: Resource; id: string; name: string; search: string }> = [
    ...lesson.display.participants.map((item) => ({
      resource: 'group' as const,
      id: item.group_id,
      name: item.group_name,
      search: item.group_name,
    })),
    ...(lesson.display.teacher
      ? [
          {
            resource: 'teacher' as const,
            id: lesson.display.teacher.id,
            name: lesson.display.teacher.full_name,
            search: lesson.display.teacher.full_name,
          },
        ]
      : []),
    ...lesson.display.rooms.map((item) => ({
      resource: 'room' as const,
      id: item.id,
      name: `${item.building_name} · ${item.name}`,
      search: item.name,
    })),
  ]
  return (
    resources.find((item) => item.resource === preferred && item.id === selectedId) ??
    resources.find((item) => item.resource === preferred) ??
    resources[0] ??
    null
  )
}

function getResourceQuery(resource: Resource, params: URLSearchParams) {
  const query = params.get('q')
  if (query !== null) return query
  const unverifiedLabel = params.get('resource_name')
  if (!unverifiedLabel) return ''
  // The URL label is only a search hint. The selected ID must still resolve in
  // the protected catalog before a name is displayed as authoritative.
  return resource === 'room' ? (unverifiedLabel.split(' · ').at(-1)?.trim() ?? '') : unverifiedLabel
}

function getResourceLabel(resource: Resource, item: CatalogItem) {
  return resource === 'room' && item.building_name
    ? `${item.building_name} · ${item.name}`
    : item.name
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

function participantPairs(participants: LessonWrite['participants']) {
  return participants
    .map(({ group_id, subgroup_id }) => `${group_id}:${subgroup_id ?? ''}`)
    .sort()
    .join('|')
}

function matchesLessonWrite(lesson: Lesson, body: LessonWrite) {
  return (
    lesson.course_offering_id === body.course_offering_id &&
    Date.parse(lesson.starts_at) === Date.parse(body.starts_at) &&
    Date.parse(lesson.ends_at) === Date.parse(body.ends_at) &&
    lesson.kind === body.kind &&
    lesson.teacher_id === body.teacher_id &&
    participantPairs(lesson.participants) === participantPairs(body.participants) &&
    [...lesson.room_ids].sort().join('|') === [...body.room_ids].sort().join('|')
  )
}

async function listLessonsForCreateReconciliation(body: LessonWrite): Promise<Lesson[]> {
  const groupId = body.participants[0]?.group_id
  if (!groupId) return []
  const firstDate = getMoscowDate(new Date(body.starts_at))
  const lastDate = getMoscowDate(new Date(body.ends_at))
  const results = new Map<string, Lesson>()
  let rangeFrom = firstDate
  while (rangeFrom <= lastDate) {
    let rangeTo = lastDate
    for (let day = 0; day < 30; day++) {
      const candidate = addDays(rangeFrom, day + 1)
      if (candidate > lastDate || candidate === rangeFrom) break
      rangeTo = candidate
    }
    let recoveredCursor = false
    let rangeComplete = false
    while (!rangeComplete) {
      let afterId: string | null = null
      const seenCursors = new Set<string>()
      const rangeResults = new Map<string, Lesson>()
      try {
        do {
          const params = new URLSearchParams({
            resource: 'group',
            resource_id: groupId,
            date_from: rangeFrom,
            date_to: rangeTo,
            limit: '100',
          })
          if (afterId) params.set('after_id', afterId)
          const page = await apiFetch<components['schemas']['EditorSchedule']>(
            `${base}/lessons?${params}`,
            { authenticated: true },
          )
          page.items.forEach((item) => rangeResults.set(item.id, item))
          afterId = page.next_after_id
          if (afterId && seenCursors.has(afterId)) throw new Error('Repeated schedule cursor')
          if (afterId) seenCursors.add(afterId)
        } while (afterId)
        rangeResults.forEach((item) => results.set(item.id, item))
        rangeComplete = true
      } catch (error) {
        if (
          !recoveredCursor &&
          afterId !== null &&
          error instanceof ApiClientError &&
          error.status === 422 &&
          error.code === 'validation_error'
        ) {
          recoveredCursor = true
          continue
        }
        throw error
      }
    }
    if (rangeTo === lastDate) break
    rangeFrom = addDays(rangeTo, 1)
  }
  return [...results.values()]
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
  clearLabel,
  onForbidden,
  onResolvedItem,
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
  clearLabel?: string
  onForbidden?: () => void
  onResolvedItem?: (item: CatalogItem) => void
}) {
  const pickerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const skipFocusOpenRef = useRef(false)
  const selectInputAfterCloseRef = useRef(false)
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [resolvedLabels, setResolvedLabels] = useState<Record<string, string>>(labelOverrides)
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
  const items = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data])
  useEffect(() => {
    if (!expanded) return
    const closeWhenOutside = (event: Event) => {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target))
        setExpanded(false)
    }
    document.addEventListener('pointerdown', closeWhenOutside)
    document.addEventListener('focusin', closeWhenOutside)
    return () => {
      document.removeEventListener('pointerdown', closeWhenOutside)
      document.removeEventListener('focusin', closeWhenOutside)
    }
  }, [expanded])
  const selectedLabels = {
    ...resolvedLabels,
    ...Object.fromEntries(items.map((item) => [item.id, item.name])),
    ...labelOverrides,
  }
  useEffect(() => {
    if (query.error instanceof ApiClientError && query.error.status === 403) onForbidden?.()
  }, [query.error, onForbidden])
  const closeAndRestoreFocus = () => {
    setSearch('')
    setExpanded(false)
    selectInputAfterCloseRef.current = true
    if (document.activeElement !== inputRef.current) {
      skipFocusOpenRef.current = true
      inputRef.current?.focus()
    }
  }
  const toggle = (id: string) => {
    const selected = items.find((item) => item.id === id)
    if (selected) {
      setResolvedLabels((previous) => ({ ...previous, [id]: selected.name }))
      onResolvedItem?.(selected)
    }
    if (!multiple) {
      onChange([id])
      closeAndRestoreFocus()
      return
    }
    onChange(value.includes(id) ? value.filter((item) => item !== id) : [...value, id])
    closeAndRestoreFocus()
  }
  const selectedNames = value.map((id) => selectedLabels[id] ?? 'Название недоступно')
  const selectedValue = selectedNames.join(', ')
  useLayoutEffect(() => {
    if (
      !expanded &&
      selectInputAfterCloseRef.current &&
      document.activeElement === inputRef.current
    ) {
      inputRef.current?.select()
    }
    selectInputAfterCloseRef.current = false
  }, [expanded, selectedValue])
  const visibleItems = allowedIds ? items.filter((item) => allowedIds.includes(item.id)) : items
  return (
    <div
      ref={pickerRef}
      className="staff-schedule__picker"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && expanded) {
          event.preventDefault()
          event.stopPropagation()
          setExpanded(false)
          skipFocusOpenRef.current = true
          inputRef.current?.focus()
        }
      }}
    >
      <label>
        {label}
        <input
          ref={inputRef}
          aria-label={label}
          role="combobox"
          aria-expanded={expanded}
          aria-autocomplete="list"
          aria-invalid={invalid || undefined}
          value={expanded ? search : selectedValue}
          placeholder="Поиск по названию"
          onClick={() => {
            if (!expanded) {
              setExpanded(true)
              setSearch('')
            }
          }}
          onFocus={() => {
            if (skipFocusOpenRef.current) {
              skipFocusOpenRef.current = false
            } else {
              setExpanded(true)
              setSearch('')
            }
          }}
          onChange={(event) => {
            setSearch(event.target.value)
            if (!expanded) setExpanded(true)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && expanded) {
              event.preventDefault()
              event.stopPropagation()
              setExpanded(false)
            } else if (event.key === 'ArrowDown' && !expanded) {
              event.preventDefault()
              setSearch('')
              setExpanded(true)
            } else if (
              !expanded &&
              event.key.length === 1 &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.altKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault()
              setSearch(event.key)
              setExpanded(true)
            }
          }}
        />
      </label>
      {clearLabel && value.length > 0 && (
        <button type="button" className="staff-schedule__text-button" onClick={() => onChange([])}>
          {clearLabel}
        </button>
      )}
      {value.length > 0 && multiple && (
        <div className="staff-schedule__chips">
          {value.map((id) => (
            <button type="button" key={id} onClick={() => toggle(id)}>
              {selectedLabels[id] ?? 'Название недоступно'} ×
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

function GroupParticipantEditor({
  userId,
  groupId,
  groupName,
  selection,
  knownSubgroupNames,
  onChange,
  onForbidden,
}: {
  userId: string
  groupId: string
  groupName: string
  selection: ParticipantSelection
  knownSubgroupNames: Record<string, string>
  onChange: (selection: ParticipantSelection) => void
  onForbidden: () => void
}) {
  const query = useInfiniteQuery({
    queryKey: ['staff-schedule', userId, 'subgroups', groupId],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      apiFetch<components['schemas']['CatalogPage']>(
        catalogUrl('subgroups', '', pageParam, { group_id: groupId }),
        { authenticated: true, signal },
      ),
    getNextPageParam: (lastPage) => lastPage.next_after_id,
    retry: false,
  })
  const subgroups = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  )
  const hasNextPage = query.hasNextPage
  const isFetchingNextPage = query.isFetchingNextPage
  const fetchNextPage = query.fetchNextPage
  useEffect(() => {
    if (query.error instanceof ApiClientError && query.error.status === 403) onForbidden()
  }, [query.error, onForbidden])
  useEffect(() => {
    if (
      hasNextPage &&
      !isFetchingNextPage &&
      selection.subgroupIds.some((id) => !subgroups.some((item) => item.id === id))
    )
      void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, selection.subgroupIds, subgroups])
  const selectedLabels = selection.subgroupIds
    .map((id) => knownSubgroupNames[id] ?? subgroups.find((item) => item.id === id)?.name)
    .filter((name): name is string => !!name)
  return (
    <fieldset className="staff-schedule__participant-group">
      <legend>{groupName}</legend>
      <label>
        <input
          type="checkbox"
          checked={selection.wholeGroup}
          onChange={(event) =>
            onChange(
              event.target.checked
                ? { wholeGroup: true, subgroupIds: [] }
                : { wholeGroup: false, subgroupIds: [] },
            )
          }
        />
        Вся группа
      </label>
      {!selection.wholeGroup && selectedLabels.length > 0 && (
        <p>Выбраны подгруппы: {selectedLabels.join(', ')}</p>
      )}
      {query.isPending ? (
        <p>Загружаем подгруппы…</p>
      ) : query.isError ? (
        <p role="alert">
          Не удалось загрузить подгруппы.{' '}
          <button type="button" onClick={() => void query.refetch()}>
            Повторить
          </button>
        </p>
      ) : (
        <div className="staff-schedule__subgroup-options">
          {subgroups.map((subgroup) => (
            <label key={subgroup.id}>
              <input
                type="checkbox"
                checked={selection.subgroupIds.includes(subgroup.id)}
                disabled={selection.wholeGroup}
                onChange={(event) => {
                  const subgroupIds = event.target.checked
                    ? [...selection.subgroupIds, subgroup.id]
                    : selection.subgroupIds.filter((id) => id !== subgroup.id)
                  onChange({ wholeGroup: false, subgroupIds })
                }}
              />
              {subgroup.name}
            </label>
          ))}
          {hasNextPage && (
            <button
              type="button"
              className="staff-schedule__text-button"
              disabled={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            >
              {isFetchingNextPage ? 'Загружаем…' : 'Показать ещё подгруппы'}
            </button>
          )}
          {!subgroups.length && <p>Формальных подгрупп нет.</p>}
        </div>
      )}
    </fieldset>
  )
}

function ScheduleForm({
  lesson,
  operation,
  onClose,
  onSaved,
  onForbidden,
  onReadSchedule,
}: {
  lesson: Lesson | null
  operation: Operation
  onClose: () => void
  onSaved: () => void
  onForbidden: () => void
  onReadSchedule: () => Promise<Lesson[]>
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
  const lastFormFocusRef = useRef<HTMLElement | null>(null)
  const closeReturnFocusRef = useRef<HTMLElement | null>(null)
  const navigationReturnFocusRef = useRef<HTMLElement | null>(null)
  const [courseOffering, setCourseOffering] = useState(lesson?.course_offering_id ?? '')
  const [teacherIds, setTeacherIds] = useState(lesson?.teacher_id ? [lesson.teacher_id] : [])
  const [participantState, setParticipantState] = useState(() =>
    getInitialParticipantSelection(lesson),
  )
  const { groupIds, selections: participantSelections } = participantState
  const [groupLabels, setGroupLabels] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      lesson?.display.participants.map((item) => [item.group_id, item.group_name]) ?? [],
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
  const [readBackLesson, setReadBackLesson] = useState<Lesson | null>(null)
  const [readBackCandidates, setReadBackCandidates] = useState<Lesson[]>([])
  const [reconcileMessage, setReconcileMessage] = useState('')
  const [confirmOverwrite, setConfirmOverwrite] = useState(false)
  const [submittedBody, setSubmittedBody] = useState<LessonWrite | null>(null)
  const [expectedVersion, setExpectedVersion] = useState(lesson?.version ?? 0)
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [dirty, setDirty] = useState(false)
  const exitStatus = busy ? 'submitting' : uncertain ? 'uncertain' : dirty ? 'draft' : 'none'
  const { setStatus: setExitStatus } = useUnsavedChanges()
  const blocker = useBlocker(exitStatus !== 'none')
  const getDialogFocusTarget = useCallback(() => {
    const activeElement = document.activeElement as HTMLElement | null
    return activeElement && dialogRef.current?.contains(activeElement)
      ? activeElement
      : lastFormFocusRef.current
  }, [])
  const assignmentsQueries = useQueries({
    queries: groupIds.map((groupId) => ({
      queryKey: ['staff-schedule', userId, 'assignments', courseOffering, groupId],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchCatalogItems(
          'teaching-assignments',
          { course_offering_id: courseOffering, group_id: groupId },
          signal,
        ),
      enabled: !!courseOffering,
      retry: false,
    })),
  })
  const assignmentsForbidden = assignmentsQueries.some(
    (query) => query.error instanceof ApiClientError && query.error.status === 403,
  )
  useEffect(() => {
    if (assignmentsForbidden) onForbidden()
  }, [assignmentsForbidden, onForbidden])
  const assignmentResults = assignmentsQueries.map((query) => query.data)
  const eligibleTeacherIds =
    !courseOffering ||
    !groupIds.length ||
    assignmentsQueries.some((query) => query.isPending || query.isError) ||
    assignmentResults.some((items) => !items)
      ? undefined
      : (assignmentResults as CatalogItem[][]).reduce(
          (eligible, assignments) =>
            eligible.filter((id) => assignments.some((assignment) => assignment.teacher_id === id)),
          (assignmentResults[0] ?? [])
            .map((assignment) => assignment.teacher_id)
            .filter((id): id is string => !!id),
        )
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
      navigationReturnFocusRef.current = getDialogFocusTarget()
      if (!dialog?.open) dialog?.showModal()
      continueNavigationRef.current?.focus()
    } else if (dialog?.open) {
      dialog.close()
      if (dialogRef.current && !dialogRef.current.open) dialogRef.current.showModal()
      const returnFocus = navigationReturnFocusRef.current
      window.requestAnimationFrame(() => returnFocus?.focus())
    }
  }, [blocker.state, getDialogFocusTarget])
  useLayoutEffect(() => {
    const dialog = closeDialogRef.current
    if (confirmLeave) {
      if (!dialog?.open) dialog?.showModal()
      continueCloseRef.current?.focus()
    } else if (dialog?.open) {
      dialog.close()
      if (dialogRef.current && !dialogRef.current.open) dialogRef.current.showModal()
      const returnFocus = closeReturnFocusRef.current
      window.requestAnimationFrame(() => returnFocus?.focus())
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
    const participants = groupIds.flatMap<LessonWrite['participants'][number]>((group_id) => {
      const selection = participantSelections[group_id]
      if (!selection) return []
      if (selection.wholeGroup) return [{ group_id, subgroup_id: null }]
      return selection.subgroupIds.map((subgroup_id) => ({ group_id, subgroup_id }))
    })
    if (!courseOffering || !groupIds.length || !participants.length) {
      setError('Выберите проведение и хотя бы одну группу или подгруппу.')
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
      participants,
      room_ids: roomIds,
    }
    setSubmittedBody(body)
    setReadBackLesson(null)
    setReadBackCandidates([])
    setReconcileMessage('')
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
          onForbidden()
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
    setReconcileMessage('Проверяем актуальное состояние на сервере…')
    try {
      let actual: Lesson | null = null
      if (lesson) {
        actual = await apiFetch<Lesson>(`${base}/lessons/${lesson.id}`, { authenticated: true })
        if (operation === 'move' && actual.next_lesson_id) {
          actual = await apiFetch<Lesson>(`${base}/lessons/${actual.next_lesson_id}`, {
            authenticated: true,
          })
        }
        queryClient.setQueryData(['staff-schedule', userId, 'lesson', actual.id], actual)
        await onReadSchedule()
        setReadBackLesson(actual)
        setReadBackCandidates([actual])
        setUncertain(false)
        setReconcileMessage(
          operation === 'move' && actual.id !== lesson.id
            ? 'Сверка показала связанную текущую запись переноса. Новый запрос не отправлялся.'
            : 'Сверка показала текущее состояние записи. Черновик сохранён отдельно; мутация не повторялась.',
        )
        void queryClient.invalidateQueries({ queryKey: ['staff-schedule', userId, 'lessons'] })
        return
      }
      if (!submittedBody) {
        setReadBackLesson(null)
        setReadBackCandidates([])
        setUncertain(true)
        setReconcileMessage('Нет данных для сверки. Результат создания остаётся неопределённым.')
        return
      }
      const listed = await listLessonsForCreateReconciliation(submittedBody)
      const matches = listed.filter((item) => matchesLessonWrite(item, submittedBody))
      setReadBackCandidates(matches)
      setReadBackLesson(matches.length === 1 ? matches[0] : null)
      setUncertain(true)
      if (matches.length === 1) {
        setReconcileMessage(
          'Найдена одна запись с совпадающими полями. Существующий API не подтверждает, что её создал именно этот запрос; результат остаётся неопределённым. POST не повторялся.',
        )
      } else if (matches.length > 1) {
        setReconcileMessage(
          `Найдено ${matches.length} записей с совпадающими полями. Нельзя определить результат этого запроса; POST не повторялся.`,
        )
      } else {
        setReconcileMessage(
          'Совпадение не найдено в расписании выбранной группы за период занятия. Результат остаётся неопределённым; POST не повторялся.',
        )
      }
    } catch (caught) {
      setUncertain(true)
      setReconcileMessage(
        caught instanceof ApiClientError && caught.status === 422
          ? 'Сервер отклонил запрос при сверке расписания. Результат создания остаётся неопределённым; POST не повторялся.'
          : getErrorMessage(caught),
      )
      if (caught instanceof ApiClientError && caught.status === 403) onForbidden()
    }
  }
  const fetchLatestVersion = async () => {
    if (!lesson) return
    try {
      const latest = await apiFetch<Lesson>(`${base}/lessons/${lesson.id}`, { authenticated: true })
      setLatestVersion(latest)
      setConfirmOverwrite(false)
    } catch (caught) {
      setError(getErrorMessage(caught))
      if (caught instanceof ApiClientError && caught.status === 403) {
        queryClient.removeQueries({ queryKey: ['staff-schedule'] })
        onForbidden()
      }
    }
  }
  const close = () => {
    if (busy) return
    if (dirty && !confirmLeave) {
      closeReturnFocusRef.current = getDialogFocusTarget()
      setConfirmLeave(true)
    } else onClose()
  }
  const continueEditing = () => {
    if (closeDialogRef.current?.open) closeDialogRef.current.close()
    setConfirmLeave(false)
    if (dialogRef.current && !dialogRef.current.open) dialogRef.current.showModal()
    const returnFocus = closeReturnFocusRef.current
    window.requestAnimationFrame(() => returnFocus?.focus())
  }
  const continueNavigation = () => {
    if (navigationDialogRef.current?.open) navigationDialogRef.current.close()
    blocker.reset?.()
    if (dialogRef.current && !dialogRef.current.open) dialogRef.current.showModal()
    const returnFocus = navigationReturnFocusRef.current
    window.requestAnimationFrame(() => returnFocus?.focus())
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
        onFocusCapture={(event) => {
          if (event.target instanceof HTMLElement && event.target !== event.currentTarget)
            lastFormFocusRef.current = event.target
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
                setParticipantState({ groupIds: [], selections: {} })
                setTeacherIds([])
              }}
              onForbidden={onForbidden}
            />
            {fieldError('course_offering_id')}
            <CatalogPicker
              label="Преподаватель"
              kind="teachers"
              value={teacherIds}
              invalid={!!fieldMessage('teacher_id')}
              allowedIds={eligibleTeacherIds}
              clearLabel="Убрать преподавателя"
              labelOverrides={
                lesson?.display.teacher
                  ? { [lesson.display.teacher.id]: lesson.display.teacher.full_name }
                  : {}
              }
              onChange={(ids) => {
                setDirty(true)
                setTeacherIds(ids)
              }}
              onForbidden={onForbidden}
            />
            {fieldError('teacher_id')}
            {assignmentsQueries.some((query) => query.isError) && (
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
              labelOverrides={groupLabels}
              onChange={(ids) => {
                setDirty(true)
                setParticipantState((old) => ({
                  groupIds: ids,
                  selections: Object.fromEntries(
                    ids.map((id) => [
                      id,
                      old.selections[id] ?? { wholeGroup: true, subgroupIds: [] },
                    ]),
                  ),
                }))
              }}
              onResolvedItem={(item) =>
                setGroupLabels((previous) => ({ ...previous, [item.id]: item.name }))
              }
              onForbidden={onForbidden}
              multiple
            />
            {fieldError('participants')}
            {fieldError('group_id')}
            {fieldError('subgroup_id')}
            {groupIds.map((groupId) => (
              <GroupParticipantEditor
                key={groupId}
                userId={userId}
                groupId={groupId}
                groupName={groupLabels[groupId] ?? 'Название группы недоступно'}
                selection={participantSelections[groupId]}
                knownSubgroupNames={Object.fromEntries(
                  lesson?.display.participants
                    .filter((item) => item.group_id === groupId && item.subgroup_id)
                    .map((item) => [item.subgroup_id!, item.subgroup_name ?? '']) ?? [],
                )}
                onChange={(selection) => {
                  setDirty(true)
                  setParticipantState((previous) => ({
                    ...previous,
                    selections: { ...previous.selections, [groupId]: selection },
                  }))
                }}
                onForbidden={onForbidden}
              />
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
              onForbidden={onForbidden}
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
                  Загрузить актуальную запись для сравнения
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
                На сервере версия {latestVersion.version}. Поля формы слева — ваш локальный
                черновик; сверьте его с актуальными значениями:
              </p>
              <dl className="staff-schedule__snapshot">
                {describeLesson(latestVersion).map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <p>Повторное сохранение заменит перечисленные значения серверной записи.</p>
              {!confirmOverwrite ? (
                <button type="button" onClick={() => setConfirmOverwrite(true)}>
                  Я сравнил поля — показать подтверждение перезаписи
                </button>
              ) : (
                <div className="staff-schedule__overwrite-confirm" role="alert">
                  <p>Подтвердите перезапись версии {latestVersion.version} локальным черновиком.</p>
                  <button
                    type="button"
                    className="staff-schedule__danger"
                    onClick={() => {
                      setExpectedVersion(latestVersion.version)
                      setLatestVersion(null)
                      setConfirmOverwrite(false)
                      setError(
                        'Вы явно подтвердили перезапись. Проверьте черновик и нажмите «Сохранить».',
                      )
                    }}
                  >
                    Подтвердить перезапись моим черновиком
                  </button>
                  <button type="button" onClick={() => setConfirmOverwrite(false)}>
                    Отмена
                  </button>
                </div>
              )}
            </div>
          )}
          {readBackLesson && (
            <section
              className="staff-schedule__form-alert"
              aria-labelledby="staff-schedule-readback-title"
            >
              <h3 id="staff-schedule-readback-title">Актуальная запись на сервере</h3>
              <p>
                Версия {readBackLesson.version} · статус {readBackLesson.status}. Ваш черновик
                остался в полях формы.
              </p>
              <dl className="staff-schedule__snapshot">
                {describeLesson(readBackLesson).map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
          {readBackCandidates.length > 1 && (
            <ul aria-label="Записи с совпадающими полями">
              {readBackCandidates.map((candidate) => (
                <li key={candidate.id}>
                  {candidate.id} · {formatDate(getMoscowDate(new Date(candidate.starts_at)), true)}{' '}
                  · {formatTime(candidate.starts_at)}–{formatTime(candidate.ends_at)} ·{' '}
                  {candidate.status}
                </li>
              ))}
            </ul>
          )}
          {reconcileMessage && <p role="status">{reconcileMessage}</p>}
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
            continueEditing()
          }}
        >
          <h2 id="staff-schedule-close-title">Закрыть черновик?</h2>
          <p>Черновик не сохранён. Введённые данные будут потеряны.</p>
          <footer>
            <button
              ref={continueCloseRef}
              type="button"
              className="staff-schedule__secondary"
              onClick={continueEditing}
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
            continueNavigation()
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
              onClick={continueNavigation}
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
  return <StaffSchedulePageContent key={userId} />
}

function StaffSchedulePageContent() {
  const { user_id: userId } = useRoleContext()
  const [searchParams, setSearchParams] = useSearchParams()
  const rawDate = searchParams.get('date')
  const invalidDate = rawDate !== null && !isValidCalendarDate(rawDate)
  const resource = (
    ['group', 'teacher', 'room'].includes(searchParams.get('resource') ?? '')
      ? searchParams.get('resource')
      : 'group'
  ) as Resource
  const selectedResourceId = searchParams.get('resource_id') ?? ''
  const date = rawDate && !invalidDate ? rawDate : getMoscowDate()
  const mode = searchParams.get('view') === 'day' ? 'day' : 'week'
  const [form, setForm] = useState<{ operation: Operation; lesson: Lesson | null } | null>(null)
  const [confirmCancel, setConfirmCancel] = useState<Lesson | null>(null)
  const [actionReadBack, setActionReadBack] = useState<Lesson | null>(null)
  const [lastAction, setLastAction] = useState<{
    lessonId: string
    action: 'cancel' | 'restore'
  } | null>(null)
  const [accessDenied, setAccessDenied] = useState(false)
  const [actionError, setActionError] = useState('')
  const [actionUncertain, setActionUncertain] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const retriedCursor = useRef(new Set<string>())
  const weekStart = getWeekStart(date)
  const dateFrom = mode === 'day' ? date : weekStart
  const dateTo = mode === 'day' ? date : addDays(weekStart, 6)
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!invalidDate) return
    const params = new URLSearchParams(searchParams)
    params.set('date', date)
    setSearchParams(params, { replace: true })
  }, [date, invalidDate, searchParams, setSearchParams])
  const denyAccess = useCallback(() => {
    setAccessDenied(true)
    setForm(null)
    setConfirmCancel(null)
    setActionReadBack(null)
    setActionError('')
    setActionUncertain(false)
    queryClient.removeQueries({ queryKey: ['staff-schedule', userId] })
  }, [
    queryClient,
    userId,
    setAccessDenied,
    setForm,
    setConfirmCancel,
    setActionReadBack,
    setActionError,
    setActionUncertain,
  ])
  const resourceQuery = getResourceQuery(resource, searchParams)
  const catalog = useInfiniteQuery({
    queryKey: ['staff-schedule', userId, 'catalog', resource, resourceQuery],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      apiFetch<components['schemas']['CatalogPage']>(
        catalogUrl(resourceKinds[resource], resourceQuery, pageParam),
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
  const selectedResourceItem = resourceItems.find((item) => item.id === selectedResourceId)
  const selectedResourceName = selectedResourceItem
    ? getResourceLabel(resource, selectedResourceItem)
    : ''
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
    retry: false,
  })
  const queryAccessDenied = [catalog.error, schedule.error].some(
    (error) => error instanceof ApiClientError && error.status === 403,
  )
  useEffect(() => {
    if (queryAccessDenied) queryClient.removeQueries({ queryKey: ['staff-schedule', userId] })
  }, [queryAccessDenied, queryClient, userId])
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
      !schedule.isFetchNextPageError ||
      !(schedule.error instanceof ApiClientError) ||
      schedule.error.status !== 422
    )
      return
    const cursor = schedule.data?.pages.at(-1)?.next_after_id
    if (!cursor) return
    const retryKey = `${userId}:${resource}:${selectedResourceId}:${dateFrom}:${dateTo}:${cursor}`
    if (retriedCursor.current.has(retryKey)) return
    retriedCursor.current.add(retryKey)
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
    schedule.isFetchNextPageError,
    queryClient,
    userId,
    resource,
    selectedResourceId,
    dateFrom,
    dateTo,
  ])
  const grouped = groupLessonsByVisibleDays(lessons, dateFrom, dateTo)
  const changeResource = (next: Resource) => {
    setSearchParams({ resource: next, date, view: mode })
  }
  const updateDate = (next: string) => {
    if (!isValidCalendarDate(next)) return
    const params = new URLSearchParams(searchParams)
    params.set('resource', resource)
    params.set('date', next)
    params.set('view', mode)
    setSearchParams(params)
  }
  const changeMode = (next: 'day' | 'week') => {
    const params = new URLSearchParams(searchParams)
    params.set('resource', resource)
    params.set('date', date)
    params.set('view', next)
    setSearchParams(params)
  }
  const mutateStatus = async (lesson: Lesson, action: 'cancel' | 'restore') => {
    setBusyId(lesson.id)
    setActionError('')
    setActionUncertain(false)
    setActionReadBack(null)
    setLastAction({ lessonId: lesson.id, action })
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
        denyAccess()
      }
      if (error instanceof ApiClientError && (error.status === undefined || error.status >= 500))
        setActionError(`${getErrorMessage(error)} Повторно операция не отправлялась.`)
    } finally {
      setBusyId(null)
    }
  }
  const readActionBack = async (lessonId: string) => {
    setActionError('Проверяем актуальное состояние…')
    try {
      const actual = await apiFetch<Lesson>(`${base}/lessons/${lessonId}`, { authenticated: true })
      setActionReadBack(actual)
      setActionUncertain(false)
      queryClient.setQueryData(['staff-schedule', userId, 'lesson', actual.id], actual)
      if (
        (lastAction?.action === 'cancel' && actual.status === 'cancelled') ||
        (lastAction?.action === 'restore' && actual.status === 'scheduled')
      ) {
        setConfirmCancel(null)
        setActionError(
          lastAction.action === 'cancel'
            ? 'Сверка подтвердила отмену. Список обновлён; запрос повторно не отправлялся.'
            : 'Сверка подтвердила восстановление. Список обновлён; запрос повторно не отправлялся.',
        )
      } else {
        if (lastAction?.action === 'cancel' && actual.status === 'moved') {
          setConfirmCancel(null)
          setActionError(
            'Запись перенесена. Это не подтверждает отмену; запрос повторно не отправлялся.',
          )
          void queryClient.invalidateQueries({ queryKey: ['staff-schedule', userId, 'lessons'] })
          return
        }
        setActionError(
          'Сверка завершена. Запись не перешла в запрошенное состояние; повторное действие требует отдельного подтверждения.',
        )
      }
      void queryClient.invalidateQueries({ queryKey: ['staff-schedule', userId, 'lessons'] })
    } catch (error) {
      setActionError(getErrorMessage(error))
      if (error instanceof ApiClientError && error.status === 403) denyAccess()
    }
  }
  const useCurrentActionVersion = () => {
    if (!actionReadBack || actionReadBack.status !== 'scheduled') return
    setConfirmCancel(actionReadBack)
    setActionReadBack(null)
    setActionError(
      'Показана текущая версия. Повторите отмену только если подтверждаете это действие.',
    )
  }
  const retryRestoreWithCurrentVersion = () => {
    if (!actionReadBack || actionReadBack.status !== 'cancelled') return
    void mutateStatus(actionReadBack, 'restore')
  }
  const navigateHistory = async (id: string) => {
    try {
      const lesson = await apiFetch<Lesson>(`${base}/lessons/${id}`, { authenticated: true })
      const positionDate = getMoscowDate(new Date(lesson.starts_at))
      const target = getLessonResource(lesson, resource, selectedResourceId)
      if (!target) {
        setActionError('Связанное занятие не содержит доступного объекта для просмотра.')
        return
      }
      setActionError('')
      queryClient.setQueryData(['staff-schedule', userId, 'lesson', lesson.id], lesson)
      setSearchParams({
        resource: target.resource,
        resource_id: target.id,
        resource_name: target.name,
        q: target.search,
        date: positionDate,
        view: mode,
      })
    } catch (error) {
      setActionError(getErrorMessage(error))
      if (error instanceof ApiClientError && error.status === 403) {
        denyAccess()
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
        denyAccess()
      }
    }
  }
  const prevWeek = () => updateDate(addDays(date, mode === 'day' ? -1 : -7))
  const nextWeek = () => updateDate(addDays(date, mode === 'day' ? 1 : 7))
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
  if (accessDenied || queryAccessDenied) {
    return (
      <section
        className="section-page staff-schedule__forbidden"
        aria-labelledby="staff-schedule-forbidden-title"
      >
        <p className="section-eyebrow">Кабинет сотрудника</p>
        <h1 id="staff-schedule-forbidden-title">Доступ запрещён</h1>
        <p>Разрешение schedule.edit отозвано. Данные расписания скрыты.</p>
      </section>
    )
  }
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
            value={selectedResourceId ? selectedResourceName : resourceQuery}
            onChange={(event) => {
              const params = new URLSearchParams(searchParams)
              params.set('q', event.target.value)
              params.delete('resource_id')
              params.delete('resource_name')
              setSearchParams(params, { replace: true })
            }}
          />
          {resourceItems.length ? (
            <select
              aria-label={`Выберите: ${resourceLabels[resource].toLowerCase()}`}
              value={selectedResourceId}
              onChange={(event) => {
                const selectedItem = resourceItems.find((item) => item.id === event.target.value)
                const params = new URLSearchParams(searchParams)
                params.set('resource', resource)
                params.set('resource_id', event.target.value)
                if (selectedItem) {
                  params.set('resource_name', getResourceLabel(resource, selectedItem))
                  params.set('q', selectedItem.name)
                }
                params.set('date', date)
                params.set('view', mode)
                setSearchParams(params)
              }}
            >
              <option value="">Выберите объект</option>
              {resourceItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {getResourceLabel(resource, item)}
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
        {selectedResourceName ? `${selectedResourceName} · ` : ''}
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
      {actionError && !confirmCancel && (
        <div className="staff-schedule__notice" role="alert">
          <p>{actionError}</p>
          {actionUncertain && lastAction && (
            <button type="button" onClick={() => void readActionBack(lastAction.lessonId)}>
              Перечитать данные занятия
            </button>
          )}
          {actionReadBack && (
            <>
              <p>
                Сервер: версия {actionReadBack.version}, статус {actionReadBack.status}.
              </p>
              <dl className="staff-schedule__snapshot">
                {describeLesson(actionReadBack).map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              {actionReadBack.status === 'cancelled' && lastAction?.action === 'restore' && (
                <button type="button" onClick={retryRestoreWithCurrentVersion}>
                  Повторно подтвердить восстановление с актуальной версией
                </button>
              )}
            </>
          )}
        </div>
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
                  {formatLessonTimeRange(lesson.starts_at, lesson.ends_at)}
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
          error={actionError}
          uncertain={actionUncertain}
          currentLesson={actionReadBack}
          onClose={() => setConfirmCancel(null)}
          onConfirm={() => void mutateStatus(confirmCancel, 'cancel')}
          onReadBack={() => void readActionBack(confirmCancel.id)}
          onUseCurrent={useCurrentActionVersion}
        />
      )}
      {form && (
        <ScheduleForm
          key={`${form.operation}-${form.lesson?.id ?? 'new'}`}
          {...form}
          onClose={() => setForm(null)}
          onSaved={() => setForm(null)}
          onForbidden={denyAccess}
          onReadSchedule={async () => {
            const result = await schedule.refetch()
            return result.data?.pages.flatMap((page) => page.items) ?? []
          }}
        />
      )}
    </main>
  )
}

function CancelDialog({
  lesson,
  busy,
  error,
  uncertain,
  currentLesson,
  onClose,
  onConfirm,
  onReadBack,
  onUseCurrent,
}: {
  lesson: Lesson
  busy: boolean
  error: string
  uncertain: boolean
  currentLesson: Lesson | null
  onClose: () => void
  onConfirm: () => void
  onReadBack: () => void
  onUseCurrent: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const dialog = ref.current
    triggerRef.current = document.activeElement as HTMLElement | null
    dialog?.showModal()
    cancelRef.current?.focus()
    return () => {
      if (dialog?.open) dialog.close()
      const trigger = triggerRef.current
      window.requestAnimationFrame(() => trigger?.focus())
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
      {error && (
        <div className="staff-schedule__form-alert" role="alert">
          <p>{error}</p>
          {uncertain && <p>Отмена могла сохраниться. Повторно подтвердите только после сверки.</p>}
          <button type="button" onClick={onReadBack} disabled={busy}>
            Перечитать состояние занятия
          </button>
        </div>
      )}
      {currentLesson && (
        <div className="staff-schedule__form-alert" role="status">
          <p>
            На сервере: версия {currentLesson.version}, статус {currentLesson.status}. Проверьте
            актуальные поля:
          </p>
          <dl className="staff-schedule__snapshot">
            {describeLesson(currentLesson).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {currentLesson.status === 'scheduled' && (
            <button type="button" onClick={onUseCurrent} disabled={busy}>
              Использовать актуальную версию для нового подтверждения
            </button>
          )}
        </div>
      )}
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
