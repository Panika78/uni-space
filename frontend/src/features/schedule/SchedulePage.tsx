import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch, ApiClientError } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'
import { ErrorState, LoadingState } from '../../shared/ui/StatusStates'
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

function LessonCard({ lesson }: { lesson: Lesson }) {
  const startsOn = getMoscowDate(new Date(lesson.starts_at))
  const endsOn = getMoscowDate(new Date(lesson.ends_at))
  const crossesMidnight = startsOn !== endsOn
  return (
    <article
      className={`lesson-card lesson-card--${lesson.status}`}
      aria-label={lesson.course_offering.discipline.name}
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
        <p className="lesson-card__kind">{kinds[lesson.kind]}</p>
        <p className="lesson-card__teacher">{lesson.teacher?.name ?? 'Преподаватель не указан'}</p>
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
        {lesson.status === 'cancelled' && (
          <p className="lesson-card__status lesson-card__status--cancelled">Отменено</p>
        )}
        {lesson.status === 'moved' && (
          <p className="lesson-card__status lesson-card__status--moved">
            {lesson.latest_lesson
              ? `Перенесено на ${formatDate(getMoscowDate(new Date(lesson.latest_lesson.starts_at)))}, ${formatTime(lesson.latest_lesson.starts_at)}`
              : 'Перенесено'}
          </p>
        )}
      </div>
    </article>
  )
}

export function SchedulePage() {
  const [date, setDate] = useState(getMoscowDate)
  const [mode, setMode] = useState<'day' | 'week'>('day')
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
  const days = [...new Set(Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)))]
  const error = query.error
  const denied = error instanceof ApiClientError && error.status === 403
  const expired = error instanceof ApiClientError && error.status === 401

  return (
    <section
      className={`section-page schedule-page schedule-page--${mode}`}
      aria-labelledby="schedule-title"
    >
      <div className="schedule-heading">
        <h1 id="schedule-title">Расписание</h1>
        <p className="schedule-week-label">
          Неделя {getIsoWeekNumber(date)} · {weekLabel}
        </p>
      </div>
      <div className="schedule-toolbar">
        <div className="schedule-modes" role="group" aria-label="Вид расписания">
          <button aria-pressed={mode === 'day'} onClick={() => setMode('day')}>
            День
          </button>
          <button aria-pressed={mode === 'week'} onClick={() => setMode('week')}>
            Неделя
          </button>
        </div>
        <button onClick={() => setDate(getMoscowDate())}>Сегодня</button>
        {mode === 'day' && (
          <div className="schedule-day-arrows" role="group" aria-label="Переключение даты">
            <button
              aria-label="Предыдущий день"
              disabled={date === '0001-01-01'}
              onClick={() => setDate(addDays(date, -1))}
            >
              ‹
            </button>
            <button
              aria-label="Следующий день"
              disabled={date === '9999-12-31'}
              onClick={() => setDate(addDays(date, 1))}
            >
              ›
            </button>
          </div>
        )}
        <label className="schedule-date">
          Дата
          <input
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
      <div className="schedule-period">
        <button
          aria-label="Предыдущая неделя"
          disabled={weekStart <= '0001-01-01'}
          onClick={() => setDate(addDays(date, -7))}
        >
          ‹
        </button>
        <p className="schedule-timezone">Московское время · Europe/Moscow</p>
        <button
          aria-label="Следующая неделя"
          disabled={dateTo >= '9999-12-31'}
          onClick={() => setDate(addDays(date, 7))}
        >
          ›
        </button>
      </div>
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
                  {formatDate(day)}
                </h2>
                <div className="schedule-day__lessons">
                  {lessons.length ? (
                    lessons.map((lesson) => <LessonCard key={lesson.id} lesson={lesson} />)
                  ) : (
                    <p className="schedule-empty">Занятий нет</p>
                  )}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </section>
  )
}
