import { describe, expect, it } from 'vitest'
import { addDays, getWeekStart, isValidCalendarDate } from './calendar'

describe('calendar URL dates', () => {
  it.each(['not-a-date', '2026-02-30', '2026-13-01', '0000-01-01', '10000-01-01', '2026-1-01'])(
    'rejects invalid date %s',
    (date) => expect(isValidCalendarDate(date)).toBe(false),
  )

  it('accepts supported year boundaries and keeps week arithmetic bounded', () => {
    expect(isValidCalendarDate('0001-01-01')).toBe(true)
    expect(isValidCalendarDate('9999-12-31')).toBe(true)
    expect(addDays('0001-01-01', -7)).toBe('0001-01-01')
    expect(addDays('9999-12-31', 7)).toBe('9999-12-31')
    expect(getWeekStart('2026-01-01')).toBe('2025-12-29')
  })
})
