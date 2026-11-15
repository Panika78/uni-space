import { apiFetch } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'

export type AcademicStatus = components['schemas']['AcademicStatusUpdate']['academic_status']
export const STATUS_WRITE_DEADLINE_MS = 15_000

// Only this write has a deadline. A timeout/abort cannot prove rollback.
export async function updateAcademicStatus(
  id: string,
  academicStatus: AcademicStatus,
  reason: 'administrative_change' | 'correction',
  signal: AbortSignal,
) {
  const deadline = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      deadline.abort()
      reject(new Error('status_write_deadline'))
    }, STATUS_WRITE_DEADLINE_MS)
  })
  try {
    return await Promise.race([
      apiFetch<{ academic_status: AcademicStatus }>(
        `/api/v1/staff/students/${id}/academic-status`,
        {
          method: 'PATCH',
          authenticated: true,
          signal: AbortSignal.any([signal, deadline.signal]),
          body: JSON.stringify({ academic_status: academicStatus, reason }),
        },
      ),
      expired,
    ])
  } finally {
    clearTimeout(timer)
  }
}
