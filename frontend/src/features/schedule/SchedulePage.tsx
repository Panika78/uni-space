import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch, ApiClientError } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'
import { ErrorState, LoadingState } from '../../shared/ui/StatusStates'
import { Icon } from '../../shared/ui/Icon'
import { AnimatedRegion } from '../../shared/ui/AnimatedRegion'
import {
  addDays,
  formatDate,
  formatTime,
  getIsoWeekNumber,
  getMoscowDate,
  getWeekStart,
  listDayLessons,
} from './calendar'
import type { Lesson } from './calendar'
import './schedule.css'

const kinds = {
  lecture: 'Лекция',
  seminar: 'Семинар',
  lab: 'Лабораторная работа',
  other: 'Занятие',
}
const weekdays = ['ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ', 'ВС']
function formatMonth(date: string): string {
  return formatDate(date)
    .split(', ')
    .slice(1)
    .join(', ')
    .replace(/^\d+\s/, '')
}

function formatWeekRange(start: string, end: string): string {
  const month = formatMonth(start)
  if (month === formatMonth(end))
    return `${Number(start.slice(8))}–${Number(end.slice(8))} ${month}`
  const endYear = Number(end.slice(0, 4))
  const startYear = Number(start.slice(0, 4))
  const endDate = new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    ...(startYear !== endYear ? { year: 'numeric' as const } : {}),
    timeZone: 'Europe/Moscow',
  })
    .format(new Date(`${end}T12:00:00Z`))
    .replace(/ г\.$/, '')
  return `${Number(start.slice(8))} ${month} – ${endDate}`
}

function LessonCard({
  lesson,
  onNavigate,
}: {
  lesson: Lesson
  onNavigate: (position: NonNullable<Lesson['latest_lesson']>) => void
}) {
  const startsOn = getMoscowDate(new Date(lesson.starts_at))
  const endsOn = getMoscowDate(new Date(lesson.ends_at))
  const crossesMidnight = startsOn !== endsOn
  const isCurrent = lesson.status === 'scheduled'
  const latest = lesson.latest_lesson
  return (
    <article
      className={`lesson-card lesson-card--${lesson.status}`}
      aria-label={lesson.course_offering.discipline.name}
      data-lesson-id={lesson.id}
      tabIndex={-1}
    >
      <div className="lesson-card__time">
        <span className="lesson-card__times">
          <time dateTime={lesson.starts_at}>
            {crossesMidnight && `${formatDate(startsOn)}, `}
            {formatTime(lesson.starts_at)}
          </time>
          <span aria-hidden="true"> — </span>
          <time dateTime={lesson.ends_at}>
            {crossesMidnight && `${formatDate(endsOn)}, `}
            {formatTime(lesson.ends_at)}
          </time>
        </span>
      </div>
      <div className="lesson-card__details">
        <h3>{lesson.course_offering.discipline.name}</h3>
        {isCurrent && (
          <>
            <p className="lesson-card__teacher">
              {lesson.teacher?.name ?? 'Преподаватель не указан'}
            </p>
            {lesson.rooms.length ? (
              <ul aria-label="Аудитории">
                {lesson.rooms.map((room) => (
                  <li key={room.id}>
                    {room.building.name} · {room.name}
                  </li>
                ))}
              </ul>
            ) : (
              <p>Аудитория не указана</p>
            )}
          </>
        )}
        {lesson.status === 'moved' &&
          (latest ? (
            <button
              className="lesson-card__navigate lesson-card__status--moved"
              onClick={() => onNavigate(latest)}
            >
              Перенесено на{' '}
              {formatDate(getMoscowDate(new Date(latest.starts_at)), true)
                .split(', ')
                .slice(1)
                .join(', ')}
              , {formatTime(latest.starts_at)}
              {latest.status === 'cancelled' ? ' · Отменено' : ''}
            </button>
          ) : (
            <p className="lesson-card__status">Перенесено</p>
          ))}
      </div>
      {lesson.status === 'cancelled' && (
        <span className="lesson-card__status lesson-card__status--cancelled lesson-card__tag">
          Отменено
        </span>
      )}
      {lesson.status === 'moved' && latest && (
        <span className="lesson-card__tag lesson-card__tag--moved">Перенесено</span>
      )}
      {isCurrent && (
        <span className={`lesson-card__tag lesson-card__tag--${lesson.kind}`}>
          {kinds[lesson.kind]}
        </span>
      )}
    </article>
  )
}

export function SchedulePage() {
  const [date, setDate] = useState(getMoscowDate)
  const [mode, setMode] = useState<'day' | 'week'>('day')
  const [navigation, setNavigation] = useState<Lesson['latest_lesson']>(null)
  const pageRef = useRef<HTMLElement>(null)
  const [todayRequest, setTodayRequest] = useState(0)
  const pendingToday = useRef(false)
  const pendingPosition = useRef<string | null>(null)
  function navigateToLesson(position: NonNullable<Lesson['latest_lesson']>) {
    pendingPosition.current = position.id
    setNavigation({ ...position })
    setDate(getMoscowDate(new Date(position.starts_at)))
  }
  const weekStart = getWeekStart(date)
  // A whole week also supplies the mobile day selector, including Sunday.
  const dateTo = addDays(weekStart, 6)
  const weekLabel = formatWeekRange(weekStart, dateTo)
  const query = useQuery({
    queryKey: ['schedule', weekStart, dateTo],
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    queryFn: ({ signal }) =>
      apiFetch<components['schemas']['ScheduleResponse']>(
        `/api/v1/schedule?date_from=${weekStart}&date_to=${dateTo}`,
        { authenticated: true, signal },
      ),
  })
  useEffect(() => {
    if (!navigation || getMoscowDate(new Date(navigation.starts_at)) !== date) {
      pendingPosition.current = null
      return
    }
    // Keep the requested position across transient failures; wait for fresh week data.
    if (!pendingPosition.current || !query.isSuccess || query.isFetching) return
    const cards = pageRef.current?.querySelectorAll<HTMLElement>(
      '.schedule-day.is-selected [data-lesson-id]',
    )
    const target = Array.from(cards ?? []).find(
      (card) => card.dataset.lessonId === pendingPosition.current,
    )
    if (target) {
      target.focus()
      target.scrollIntoView?.({ block: 'nearest' })
      pendingPosition.current = null
    }
  }, [date, navigation, query.data, query.isSuccess, query.isFetching])
  useEffect(() => {
    if (!pendingToday.current || mode !== 'week' || !query.isSuccess || query.isFetching) return
    const target = pageRef.current?.querySelector<HTMLElement>('.schedule-day.is-selected')
    if (!target) return
    if (date !== getMoscowDate()) {
      pendingToday.current = false
      return
    }
    let cancelled = false
    let frame = 0
    // ResizeObserver can start the height animation after this effect. Recheck
    // on the next frame so scrolling uses the final layout, including cached data.
    function settleLayout() {
      if (cancelled) return
      const animations = (pageRef.current?.getAnimations?.({ subtree: true }) ?? []).filter(
        (animation) =>
          animation.playState === 'running' &&
          animation.effect?.getTiming().iterations !== Infinity,
      )
      if (animations.length) {
        void Promise.all(animations.map((animation) => animation.finished.catch(() => {}))).then(
          () => {
            if (!cancelled) frame = requestAnimationFrame(settleLayout)
          },
        )
        return
      }
      frame = requestAnimationFrame(() => {
        if (cancelled) return
        const running = pageRef.current
          ?.getAnimations?.({ subtree: true })
          .some(
            (animation) =>
              animation.playState === 'running' &&
              animation.effect?.getTiming().iterations !== Infinity,
          )
        if (running) return settleLayout()
        target?.scrollIntoView({
          block: 'start',
          behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
            ? 'instant'
            : 'smooth',
        })
        pendingToday.current = false
      })
    }
    settleLayout()
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [todayRequest, mode, date, query.isSuccess, query.isFetching, query.data])
  const isPositionUnavailable =
    navigation !== null &&
    getMoscowDate(new Date(navigation.starts_at)) === date &&
    query.isSuccess &&
    !query.isFetching &&
    !listDayLessons(query.data.items, date).some((lesson) => lesson.id === navigation.id)
  const days = [...new Set(Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)))]
  const error = query.error
  const denied = error instanceof ApiClientError && error.status === 403
  const expired = error instanceof ApiClientError && error.status === 401

  return (
    <section
      ref={pageRef}
      className={`section-page schedule-page schedule-page--${mode}`}
      aria-labelledby="schedule-title"
    >
      <div className="schedule-heading">
        <div>
          <p className="section-eyebrow">Учебный календарь</p>
          <h1 id="schedule-title">Расписание</h1>
          <p className="schedule-week-label">
            Неделя {getIsoWeekNumber(date)} · {weekLabel}
          </p>
        </div>
      </div>
      <div className="schedule-toolbar">
        <div className="schedule-modes" data-mode={mode} role="group" aria-label="Вид расписания">
          <button aria-pressed={mode === 'day'} onClick={() => setMode('day')}>
            День
          </button>
          <button aria-pressed={mode === 'week'} onClick={() => setMode('week')}>
            Неделя
          </button>
        </div>
        <button
          className="schedule-today"
          onClick={() => {
            pendingToday.current = mode === 'week'
            setDate(getMoscowDate())
            setTodayRequest((request) => request + 1)
          }}
        >
          Сегодня
        </button>
        <div className="schedule-week-arrows" role="group" aria-label="Переключение недели">
          <button
            aria-label="Предыдущая неделя"
            disabled={weekStart <= '0001-01-01'}
            onClick={() => setDate(addDays(date, -7))}
          >
            <Icon name="left" />
          </button>
          <button
            aria-label="Следующая неделя"
            disabled={dateTo >= '9999-12-31'}
            onClick={() => setDate(addDays(date, 7))}
          >
            <Icon name="right" />
          </button>
        </div>
        <label className="schedule-date">
          <span className="schedule-date-label">Дата</span>
          <span className="schedule-calendar-icon">
            <Icon name="calendar" />
          </span>
          <input
            aria-label="Дата"
            type="date"
            value={date}
            min="0001-01-01"
            max="9999-12-31"
            onChange={(event) => {
              if (event.target.validity.valid && /^\d{4}-\d{2}-\d{2}$/.test(event.target.value))
                setDate(event.target.value)
            }}
          />
        </label>
      </div>
      <p className="schedule-timezone">Московское время · Europe/Moscow</p>
      <AnimatedRegion className="schedule-selectors" contentKey={mode}>
        {mode === 'day' ? (
          <div className="schedule-days" role="group" aria-label="Дни недели">
            {days.map((day, index) => (
              <button
                key={day}
                aria-label={formatDate(day)}
                aria-pressed={date === day}
                onClick={() => setDate(day)}
              >
                {weekdays[index]}
                <span>{Number(day.slice(8))}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="schedule-week-overview">
            <Icon name="calendar" />
            <div>
              <strong>Неделя целиком</strong>
              <p>{weekLabel}</p>
            </div>
            <span>Нажмите на день ниже, чтобы открыть его отдельно</span>
          </div>
        )}
      </AnimatedRegion>
      {isPositionUnavailable && (
        <p role="status" className="schedule-empty">
          Не удалось найти выбранную позицию в расписании. Возможно, расписание изменилось.
        </p>
      )}
      <AnimatedRegion className="schedule-stage" contentKey={`${mode}-${date}-${query.status}`}>
        {query.isPending ? (
          <LoadingState title="Загружаем расписание…" />
        ) : query.isError ? (
          <ErrorState
            title={
              denied
                ? 'Нет доступа к расписанию'
                : expired
                  ? 'Сессия завершена'
                  : 'Не удалось загрузить расписание'
            }
            description={
              denied
                ? 'Расписание доступно только студентам.'
                : expired
                  ? 'Войдите в аккаунт заново.'
                  : 'Проверьте подключение и повторите запрос.'
            }
            onRetry={
              denied || expired
                ? undefined
                : () => {
                    void query.refetch()
                  }
            }
          />
        ) : (
          <div className="schedule-list" aria-live="polite">
            {days.map((day) => {
              const lessons = listDayLessons(query.data.items, day)
              return (
                <section
                  key={day}
                  className={`schedule-day${day === date ? ' is-selected' : ''}`}
                  aria-label={formatDate(day)}
                >
                  <h2>
                    <svg aria-hidden="true" viewBox="0 0 20 20" focusable="false">
                      <rect x="3" y="5" width="14" height="12" rx="2" />
                      <path d="M6 3v4M14 3v4M3 9h14" />
                    </svg>
                    {mode === 'week' ? (
                      <button
                        className="schedule-open-day"
                        onClick={() => {
                          setDate(day)
                          setMode('day')
                        }}
                      >
                        {formatDate(day)}
                        <Icon name="right" />
                      </button>
                    ) : (
                      formatDate(day)
                    )}
                  </h2>
                  <div className="schedule-day__lessons">
                    {lessons.length ? (
                      lessons.map((lesson) => (
                        <LessonCard key={lesson.id} lesson={lesson} onNavigate={navigateToLesson} />
                      ))
                    ) : (
                      <p className="schedule-empty">Занятий нет</p>
                    )}
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </AnimatedRegion>
    </section>
  )
}
