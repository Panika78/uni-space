import { describe, expect, it } from 'vitest'
import { formatGapDuration, listDayGaps } from './calendar'
import { createLesson } from './testFixtures'

const day = '2026-11-10'
const lesson = (
  start: string,
  end: string,
  status: 'scheduled' | 'cancelled' | 'moved' = 'scheduled',
) => createLesson({ starts_at: `${day}T${start}+03:00`, ends_at: `${day}T${end}+03:00`, status })
const durations = (items: ReturnType<typeof createLesson>[]) =>
  listDayGaps(items, day).map(formatGapDuration)

describe('actual free time in a Moscow calendar day', () => {
  it('includes exactly 45 minutes, excludes shorter breaks and preserves exact duration', () => {
    expect(durations([lesson('09:00', '10:00'), lesson('10:44:59', '11:00')])).toEqual([])
    expect(durations([lesson('09:00', '10:00'), lesson('10:45', '11:00')])).toEqual(['45 мин'])
    expect(durations([lesson('09:00', '10:00'), lesson('10:45:00.001', '11:00')])).toEqual([
      '45 мин 0.001 с',
    ])
    expect(durations([lesson('09:00', '10:00'), lesson('12:17', '13:00')])).toEqual(['2 ч 17 мин'])
    expect(durations([lesson('09:00', '10:00'), lesson('11:00:01', '12:00')])).toEqual(['1 ч 1 с'])
  })
  it('unions nested, overlapping and touching intervals regardless of order', () => {
    expect(
      durations([
        lesson('12:00', '13:00'),
        lesson('09:00', '10:00'),
        lesson('09:30', '11:00'),
        lesson('09:40', '09:50'),
        lesson('11:00', '11:15'),
      ]),
    ).toEqual(['45 мин'])
  })
  it('ignores cancelled and old moved positions without splitting a window', () => {
    const active = [lesson('09:00', '10:00'), lesson('13:00', '14:00')]
    expect(
      durations([
        ...active,
        lesson('10:15', '12:00', 'cancelled'),
        lesson('11:00', '13:00', 'moved'),
      ]),
    ).toEqual(durations(active))
    expect(durations(active)).toEqual(['3 ч'])
  })
  it('does not create outer windows, including empty and wholly inactive days', () => {
    for (const items of [
      [],
      [lesson('09:00', '10:00')],
      [lesson('09:00', '10:00', 'cancelled'), lesson('11:00', '12:00', 'moved')],
    ]) {
      expect(durations(items)).toEqual([])
    }
  })
  it('uses overnight occupancy only in the intersected day, excluding midnight endings', () => {
    const overnight = createLesson({
      starts_at: '2026-11-09T23:00:00+03:00',
      ends_at: '2026-11-10T01:00:00+03:00',
    })
    const next = lesson('02:00', '03:00')
    expect(durations([overnight, next])).toEqual(['1 ч'])
    expect(listDayGaps([overnight, next], '2026-11-09')).toEqual([])
    expect(durations([{ ...overnight, ends_at: '2026-11-10T00:00:00+03:00' }, next])).toEqual([])
    expect(
      durations([
        lesson('22:00', '23:00'),
        createLesson({
          starts_at: '2026-11-10T23:45:00+03:00',
          ends_at: '2026-11-11T02:00:00+03:00',
        }),
      ]),
    ).toEqual(['45 мин'])
  })
})
