import type { components } from '../../shared/api/schema'

export type Lesson = components['schemas']['LessonResponse']
export type TimedLesson = {
  id: string
  starts_at: string
  ends_at: string
  status: string
}
const timezone = 'Europe/Moscow'

export function isValidCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false
  const parsed = new Date(0)
  parsed.setUTCFullYear(year, month - 1, day)
  parsed.setUTCHours(12, 0, 0, 0)
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  )
}

export function getMoscowDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const get = (type: string) => parts.find((part) => part.type === type)!.value
  return `${get('year').padStart(4, '0')}-${get('month')}-${get('day')}`
}

// Calendar arithmetic uses UTC placeholders, never the browser's local timezone.
export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  const bounded = Math.max(
    Date.parse('0001-01-01T12:00:00Z'),
    Math.min(Date.parse('9999-12-31T12:00:00Z'), value.getTime()),
  )
  return new Date(bounded).toISOString().slice(0, 10)
}

export function getWeekStart(date: string): string {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay()
  return addDays(date, -((weekday + 6) % 7))
}

export function getIsoWeekNumber(date: string): number {
  const value = new Date(`${date}T12:00:00Z`)
  const weekday = value.getUTCDay() || 7
  value.setUTCDate(value.getUTCDate() + 4 - weekday)
  const isoYear = value.getUTCFullYear()
  const yearStart = new Date(`${String(isoYear).padStart(4, '0')}-01-01T12:00:00Z`)
  const dayOfYear = Math.floor((value.getTime() - yearStart.getTime()) / 86400000) + 1
  return Math.floor((dayOfYear - 1) / 7) + 1
}

export function formatDate(date: string, includeYear = false): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    weekday: 'long',
    ...(includeYear ? { year: 'numeric' as const } : {}),
    day: 'numeric',
    month: 'long',
  }).format(new Date(`${date}T12:00:00Z`))
}

export function formatTime(timestamp: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

const boundaryTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: timezone,
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

export function listDayLessons<T extends TimedLesson>(items: T[], date: string): T[] {
  return items.filter((lesson) => {
    const startDate = getMoscowDate(new Date(lesson.starts_at))
    if (lesson.status !== 'scheduled') return startDate === date
    const end = new Date(lesson.ends_at)
    const endDate = getMoscowDate(end)
    // Compare Moscow calendar dates, preserving IANA historical offsets and sub-ms ends.
    const fraction = lesson.ends_at.match(/\.(\d+)/)?.[1] ?? ''
    const endsAtMidnight = boundaryTime.format(end) === '00:00:00' && !/[1-9]/.test(fraction)
    return startDate <= date && (endDate > date || (endDate === date && !endsAtMidnight))
  })
}

export function groupLessonsByVisibleDays<T extends TimedLesson>(
  items: T[],
  dateFrom: string,
  dateTo: string,
): Record<string, T[]> {
  const sorted = [...items].sort(
    (a, b) => a.starts_at.localeCompare(b.starts_at) || a.id.localeCompare(b.id),
  )
  const grouped: Record<string, T[]> = {}
  for (let day = dateFrom, count = 0; day <= dateTo && count < 31; day = addDays(day, 1), count++) {
    const matching = listDayLessons(sorted, day)
    if (matching.length) grouped[day] = matching
  }
  return grouped
}

export interface ScheduleGap {
  startsAt: number
  endsAt: number
}

export function listDayGaps(items: Lesson[], date: string): ScheduleGap[] {
  const intervals = listDayLessons(items, date)
    .filter((lesson) => lesson.status === 'scheduled')
    .map((lesson) => ({
      startsAt: Date.parse(lesson.starts_at),
      endsAt: Date.parse(lesson.ends_at),
    }))
    .sort((a, b) => a.startsAt - b.startsAt)
  const merged: ScheduleGap[] = []
  for (const interval of intervals) {
    const previous = merged.at(-1)
    if (previous && interval.startsAt <= previous.endsAt) {
      previous.endsAt = Math.max(previous.endsAt, interval.endsAt)
    } else merged.push({ ...interval })
  }
  // Both occupied intervals intersect this Moscow day, so every interior gap
  // already lies within its calendar boundaries, including overnight lessons.
  return merged.slice(1).flatMap((interval, index) => {
    const startsAt = merged[index].endsAt
    return interval.startsAt - startsAt >= 45 * 60_000
      ? [{ startsAt, endsAt: interval.startsAt }]
      : []
  })
}

export function formatGapDuration(gap: ScheduleGap): string {
  const milliseconds = gap.endsAt - gap.startsAt
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000)
  const remainder = (milliseconds % 60_000) / 1000
  return [hours && `${hours} ч`, minutes && `${minutes} мин`, remainder && `${remainder} с`]
    .filter(Boolean)
    .join(' ')
}
