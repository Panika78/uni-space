import { describe, expect, it } from 'vitest'
import {
  addDays,
  formatTime,
  groupLessonsByVisibleDays,
  getIsoWeekNumber,
  getMoscowDate,
  getWeekStart,
  isValidCalendarDate,
  listDayLessons,
} from './calendar'

import { createLesson } from './testFixtures'

describe('Moscow calendar independent of browser timezone', () => {
  it('uses Moscow today across UTC midnight and formats Moscow hours', () => {
    expect(getMoscowDate(new Date('2026-12-31T21:01:00Z'))).toBe('2027-01-01')
    expect(getMoscowDate(new Date('0001-01-01T12:00:00Z'))).toBe('0001-01-01')
    expect(getMoscowDate(new Date('2026-11-10T20:59:59Z'))).toBe('2026-11-10')
    expect(formatTime('2026-11-10T21:30:00Z')).toBe('00:30')
  })
  it('finds Monday for Sunday and crosses month/year/leap boundaries', () => {
    expect(getWeekStart('2027-01-03')).toBe('2026-12-28')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('9999-12-31', 7)).toBe('9999-12-31')
    expect(addDays('0001-01-01', -7)).toBe('0001-01-01')
  })
  it('uses ISO week numbers across year boundaries', () => {
    expect(getIsoWeekNumber('2026-11-10')).toBe(46)
    expect(getIsoWeekNumber('2021-01-01')).toBe(53)
    expect(getIsoWeekNumber('2024-12-31')).toBe(1)
    expect(getIsoWeekNumber('2025-01-01')).toBe(1)
    expect(getIsoWeekNumber('2026-12-31')).toBe(53)
    expect(getIsoWeekNumber('2027-01-01')).toBe(53)
    expect(getIsoWeekNumber('2027-01-03')).toBe(53)
    expect(getIsoWeekNumber('2027-01-04')).toBe(1)
    expect(getIsoWeekNumber('2027-11-10')).toBe(45)
    expect(getIsoWeekNumber('2027-12-31')).toBe(52)
    expect(getIsoWeekNumber('0001-01-01')).toBe(1)
  })
  it('places overnight lessons in both days and excludes exact boundaries', () => {
    const crossing = createLesson({
      starts_at: '2026-11-10T20:30:00Z',
      ends_at: '2026-11-10T21:30:00Z',
    })
    expect(listDayLessons([crossing], '2026-11-10')).toEqual([crossing])
    expect(listDayLessons([crossing], '2026-11-11')).toEqual([crossing])
    const boundary = createLesson({
      starts_at: '2026-11-10T20:00:00Z',
      ends_at: '2026-11-10T21:00:00Z',
    })
    expect(listDayLessons([boundary], '2026-11-11')).toEqual([])
    expect(
      listDayLessons([createLesson({ starts_at: '2026-11-11T21:00:00Z' })], '2026-11-11'),
    ).toEqual([])
  })
  it.each([
    ['12:00', '2026-11-10T09:00:00Z', '2026-11-10T10:00:00Z', ['2026-11-10']],
    ['22:59', '2026-11-10T19:59:00Z', '2026-11-10T20:59:00Z', ['2026-11-10']],
    ['23:00', '2026-11-10T20:00:00Z', '2026-11-10T21:00:00Z', ['2026-11-10']],
    ['23:30', '2026-11-10T20:30:00Z', '2026-11-10T21:30:00Z', ['2026-11-10', '2026-11-11']],
    ['00:01', '2026-11-10T21:01:00Z', '2026-11-10T22:01:00Z', ['2026-11-11']],
  ])(
    'handles Moscow start time %s without timezone assumptions',
    (_time, starts_at, ends_at, dates) => {
      const lesson = createLesson({ starts_at, ends_at })
      for (const date of ['2026-11-10', '2026-11-11'])
        expect(listDayLessons([lesson], date)).toEqual(dates.includes(date) ? [lesson] : [])
    },
  )
  it('excludes a lesson that ends exactly at Moscow midnight from the next day', () => {
    const lesson = createLesson({
      starts_at: '2026-11-10T20:00:00Z',
      ends_at: '2026-11-10T21:00:00Z',
    })
    expect(listDayLessons([lesson], '2026-11-10')).toEqual([lesson])
    expect(listDayLessons([lesson], '2026-11-11')).toEqual([])
  })
})

it('uses historical Moscow summer time and keeps sub-millisecond midnight overlaps', () => {
  const summer = createLesson({
    starts_at: '2010-07-01T20:30:00Z',
    ends_at: '2010-07-01T21:30:00Z',
  })
  expect(listDayLessons([summer], '2010-07-01')).toEqual([])
  expect(listDayLessons([summer], '2010-07-02')).toEqual([summer])
  const fraction = createLesson({
    starts_at: '2026-11-10T20:30:00Z',
    ends_at: '2026-11-10T21:00:00.000001Z',
  })
  expect(listDayLessons([fraction], '2026-11-11')).toEqual([fraction])
})

it.each(['scheduled', 'moved', 'cancelled'] as const)(
  'places an overnight %s lesson on the appropriate Moscow dates',
  (status) => {
    const lesson = createLesson({
      status,
      starts_at: '2026-12-31T20:30:00Z',
      ends_at: '2026-12-31T21:30:00Z',
    })
    expect(listDayLessons([lesson], '2026-12-31')).toEqual([lesson])
    expect(listDayLessons([lesson], '2027-01-01')).toEqual(status === 'scheduled' ? [lesson] : [])
    expect(formatTime(lesson.ends_at)).toBe('00:30')
  },
)

it('groups scheduled lessons by visible Moscow day without extending the range', () => {
  const overnight = createLesson({
    id: 'overnight',
    starts_at: '2026-11-17T20:30:00Z',
    ends_at: '2026-11-17T21:30:00Z',
  })
  const midnight = createLesson({
    id: 'midnight',
    starts_at: '2026-11-17T20:00:00Z',
    ends_at: '2026-11-17T21:00:00Z',
  })
  const grouped = groupLessonsByVisibleDays([overnight, midnight], '2026-11-18', '2026-11-18')
  expect(Object.keys(grouped)).toEqual(['2026-11-18'])
  expect(grouped['2026-11-18']).toEqual([overnight])
})

it('groups week and year boundary dates once, retaining historical status placement', () => {
  const overnight = createLesson({
    id: 'week-overnight',
    starts_at: '2026-12-31T20:30:00Z',
    ends_at: '2026-12-31T21:30:00Z',
  })
  const moved = createLesson({ id: 'moved', status: 'moved', starts_at: '2026-12-31T20:30:00Z' })
  const grouped = groupLessonsByVisibleDays([moved, overnight], '2026-12-28', '2027-01-03')
  expect(Object.keys(grouped)).toEqual(['2026-12-31', '2027-01-01'])
  expect(grouped['2026-12-31']).toEqual([moved, overnight])
  expect(grouped['2027-01-01']).toEqual([overnight])
  expect(groupLessonsByVisibleDays([overnight], '2027-01-01', '2027-01-01')).toEqual({
    '2027-01-01': [overnight],
  })
})

it('validates real calendar dates and accepts supported year boundaries', () => {
  for (const date of ['2026-02-29', '2026-13-01', '2026-04-31', '2026-1-01', ''])
    expect(isValidCalendarDate(date)).toBe(false)
  expect(isValidCalendarDate('2024-02-29')).toBe(true)
  expect(isValidCalendarDate('0001-01-01')).toBe(true)
  expect(isValidCalendarDate('9999-12-31')).toBe(true)
})
