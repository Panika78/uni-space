import type { Lesson } from './calendar'

export function createLesson(overrides: Partial<Lesson> = {}): Lesson {
  return {
    id: '1',
    starts_at: '2026-11-10T06:00:00Z',
    ends_at: '2026-11-10T07:30:00Z',
    status: 'scheduled',
    course_offering: { id: '1', discipline: { id: '1', name: 'Вымышленная дисциплина' } },
    kind: 'lecture',
    teacher: null,
    groups: [{ id: '1', name: 'ТЕСТ-1' }],
    rooms: [],
    previous_lesson: null,
    latest_lesson: null,
    ...overrides,
  }
}
