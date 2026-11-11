import { describe, expect, it } from 'vitest'
import {
  addDays,
  formatTime,
  getIsoWeekNumber,
  getMoscowDate,
  getWeekStart,
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
