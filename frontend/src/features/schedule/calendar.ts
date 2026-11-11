import type { components } from '../../shared/api/schema'

export type Lesson = components['schemas']['LessonResponse']
const timezone = 'Europe/Moscow'

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
  value.setUTCDate(value.getUTCDate() + 4 - (value.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1))
  return Math.ceil(((value.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
}

export function formatDate(date: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    weekday: 'long',
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

export function listDayLessons(items: Lesson[], date: string): Lesson[] {
  return items.filter((lesson) => {
    const startDate = getMoscowDate(new Date(lesson.starts_at))
    const end = new Date(lesson.ends_at)
    const endDate = getMoscowDate(end)
    // Compare Moscow calendar dates, preserving IANA historical offsets and sub-ms ends.
    const fraction = lesson.ends_at.match(/\.(\d+)/)?.[1] ?? ''
    const endsAtMidnight = boundaryTime.format(end) === '00:00:00' && !/[1-9]/.test(fraction)
    return startDate <= date && (endDate > date || (endDate === date && !endsAtMidnight))
  })
}
