import type { components } from '../../shared/api/schema'
export type Academics = components['schemas']['AcademicsResponse']
export function createAcademics(name = 'Вымышленная дисциплина'): Academics {
  return {
    term: { id: '1', name: 'Осень 2026', starts_on: '2026-09-01', ends_on: '2027-01-31' },
    items: [
      {
        course_offering_id: '1',
        discipline: { id: '1', name },
        total_score: 6,
        max_score: 30,
        graded_assessment_count: 2,
        assessment_count: 3,
        attestation_type: 'exam',
        final_result: {
          grade_value: null,
          passed: null,
          has_debt: false,
          retake_date: null,
          retake_location: null,
        },
      },
    ],
  }
}
