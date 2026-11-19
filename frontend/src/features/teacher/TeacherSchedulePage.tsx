import { useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { apiFetch, ApiClientError } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/StatusStates'
import { useRoleContext } from '../auth/RoleContext'
import {
  addDays,
  formatDate,
  formatLessonTimeRange,
  formatTime,
  getMoscowDate,
  getWeekStart,
  groupLessonsByVisibleDays,
  isValidCalendarDate,
  lessonKinds,
} from '../schedule/calendar'
import '../schedule/schedule.css'
import './teacherSchedule.css'

type Schedule = components['schemas']['TeacherScheduleResponse']
type Item = Schedule['items'][number]
const emptyItems: Item[] = []
const endpoint = '/api/v1/teaching/schedule'

function errorTitle(error: unknown) {
  if (error instanceof ApiClientError && error.status === 401) return 'Сессия завершена'
  if (error instanceof ApiClientError && error.status === 403) return 'Доступ запрещён'
  return 'Не удалось загрузить расписание'
}

export function TeacherSchedulePage() {
  const { user_id: userId } = useRoleContext()
  const [search, setSearch] = useSearchParams()
  const today = getMoscowDate()
  const requestedDate = search.get('date') ?? today
  const date = isValidCalendarDate(requestedDate) ? requestedDate : today
  const mode = search.get('mode') === 'week' ? 'week' : 'day'
  const from = mode === 'week' ? getWeekStart(date) : date
  const to = mode === 'week' ? addDays(from, 6) : date
  const heading = useRef<HTMLHeadingElement>(null)
  const [calendarValue, setCalendarValue] = useState<string | null>(null)
  const query = useQuery({
    queryKey: ['teacher-schedule', userId, from, to],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ date_from: from, date_to: to })
      return apiFetch<Schedule>(`${endpoint}?${params}`, {
        authenticated: true,
        signal,
        cache: 'no-store',
      })
    },
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    placeholderData: undefined,
  })
  const items = query.isFetching ? emptyItems : (query.data?.items ?? emptyItems)
  const groups = useMemo(() => {
    const visibleDays = groupLessonsByVisibleDays(items, from, to)
    for (const lessons of Object.values(visibleDays)) {
      lessons.sort((left, right) => {
        const timeOrder = left.starts_at.localeCompare(right.starts_at)
        if (timeOrder) return timeOrder
        const leftId = BigInt(left.id)
        const rightId = BigInt(right.id)
        return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
      })
    }
    return visibleDays
  }, [items, from, to])

  function navigate(nextDate: string, nextMode = mode) {
    setCalendarValue(null)
    setSearch({ date: nextDate, mode: nextMode }, { replace: true })
  }

  function move(delta: number) {
    navigate(addDays(date, nextModeSpan * delta))
  }

  const nextModeSpan = mode === 'week' ? 7 : 1
  const visibleDays =
    mode === 'week' ? Array.from({ length: 7 }, (_, index) => addDays(from, index)) : [date]

  return (
    <main className="teacher-schedule-page schedule-page">
      <header className="schedule-heading">
        <div>
          <p className="section-eyebrow">Преподаватель</p>
          <h1 ref={heading} tabIndex={-1}>
            Расписание
          </h1>
          <p className="schedule-week-label">{formatDate(date, true)}</p>
        </div>
      </header>
      <div className="schedule-toolbar" aria-label="Управление расписанием">
        <div className="schedule-modes" data-mode={mode} aria-label="Режим отображения">
          <button type="button" aria-pressed={mode === 'day'} onClick={() => navigate(date, 'day')}>
            День
          </button>
          <button
            type="button"
            aria-pressed={mode === 'week'}
            onClick={() => navigate(date, 'week')}
          >
            Неделя
          </button>
        </div>
        <div className="schedule-day-arrows">
          <button type="button" aria-label="Предыдущий период" onClick={() => move(-1)}>
            ←
          </button>
          <button type="button" onClick={() => navigate(today)}>
            Сегодня
          </button>
          <button type="button" aria-label="Следующий период" onClick={() => move(1)}>
            →
          </button>
        </div>
        <label className="schedule-date">
          <span>Дата</span>
          <input
            type="date"
            value={calendarValue ?? date}
            onChange={(event) => {
              const value = event.target.value
              setCalendarValue(value)
              if (isValidCalendarDate(value)) navigate(value)
            }}
            aria-label="Выбрать дату"
          />
        </label>
      </div>
      <p className="schedule-timezone">Время указано по Москве · Europe/Moscow</p>
      {query.isPending || query.isFetching ? <LoadingState title="Загружаем расписание…" /> : null}
      {!query.isFetching && query.isError ? (
        <ErrorState
          title={errorTitle(query.error)}
          description={
            query.error instanceof ApiClientError && query.error.status === 403
              ? 'Для этой страницы нужна активная учётная запись преподавателя.'
              : 'Проверьте соединение и повторите загрузку.'
          }
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {!query.isFetching && query.isSuccess && items.length === 0 ? (
        <EmptyState title="Занятий нет" />
      ) : null}
      {!query.isFetching && query.isSuccess && items.length > 0 ? (
        <div className="teacher-schedule-days">
          {visibleDays.map((day) => (
            <section className="teacher-schedule-day" key={day} aria-labelledby={`day-${day}`}>
              <h2 id={`day-${day}`}>{formatDate(day, true)}</h2>
              {(groups[day] ?? []).length === 0 ? (
                <p className="teacher-schedule-empty">Занятий нет</p>
              ) : null}
              {(groups[day] ?? []).map((item) => (
                <LessonCard key={item.id} item={item} />
              ))}
            </section>
          ))}
        </div>
      ) : null}
    </main>
  )
}

function LessonCard({ item }: { item: Item }) {
  const moved = item.status === 'moved'
  const cancelled = item.status === 'cancelled'
  return (
    <article
      className={`teacher-lesson-card${cancelled ? ' is-cancelled' : ''}${moved ? ' is-moved' : ''}`}
    >
      <p className="teacher-lesson-time">{formatLessonTimeRange(item.starts_at, item.ends_at)}</p>
      <h3
        className={cancelled || moved ? 'teacher-lesson-title is-inactive' : 'teacher-lesson-title'}
      >
        {item.course_offering.discipline.name}
      </h3>
      <p className="teacher-lesson-meta">{lessonKinds[item.kind]}</p>
      <p className="teacher-lesson-groups">
        {item.groups
          .map(({ name, subgroup }) => `${name}${subgroup ? ` · ${subgroup.name}` : ''}`)
          .join(', ')}
      </p>
      <p className="teacher-lesson-rooms">
        {item.rooms.length
          ? item.rooms.map((room) => `${room.building.name}, ${room.name}`).join(' · ')
          : 'Аудитория не назначена'}
      </p>
      {cancelled ? <p className="teacher-lesson-status">Отменено</p> : null}
      {moved ? (
        <p className="teacher-lesson-status">
          {item.latest_lesson ? (
            <>
              <Link
                to={`/teacher/schedule?date=${getMoscowDate(new Date(item.latest_lesson.starts_at))}&mode=day`}
              >
                Перенесено на {formatDate(getMoscowDate(new Date(item.latest_lesson.starts_at)))} ·{' '}
                {formatTime(item.latest_lesson.starts_at)}
              </Link>
              {item.latest_lesson.status === 'cancelled' ? ' · отменено' : null}
            </>
          ) : (
            'Перенесено'
          )}
        </p>
      ) : null}
    </article>
  )
}
