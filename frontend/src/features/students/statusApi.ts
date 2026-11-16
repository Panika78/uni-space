import { apiFetch } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'

export type AcademicStatus = components['schemas']['AcademicStatusUpdate']['academic_status']
export type StatusReason = 'administrative_change' | 'correction'
export type StatusOperationResult = {
  operation_id: string
  academic_status: AcademicStatus
  previous_academic_status: AcademicStatus | null
  changed: boolean
}
export const STATUS_WRITE_DEADLINE_MS = 15_000

// A timeout or abort cannot prove rollback, so callers retain this operation ID for reconciliation.
export async function updateAcademicStatus(
  id: string,
  academicStatus: AcademicStatus,
  reason: StatusReason,
  operationId: string,
  signal: AbortSignal,
): Promise<StatusOperationResult> {
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
      apiFetch<StatusOperationResult>(`/api/v1/staff/students/${id}/academic-status`, {
        method: 'PATCH',
        authenticated: true,
        signal: AbortSignal.any([signal, deadline.signal]),
        body: JSON.stringify({
          academic_status: academicStatus,
          reason,
          operation_id: operationId,
        }),
      }),
      expired,
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function checkStatusOperation(
  operationId: string,
  studentId: string,
  academicStatus: AcademicStatus,
  reason: StatusReason,
  signal: AbortSignal,
) {
  return apiFetch<components['schemas']['StatusOperationReceipt']>(
    `/api/v1/staff/students/status-operations/${operationId}?${new URLSearchParams({
      student_id: studentId,
      academic_status: academicStatus,
      reason,
    })}`,
    { authenticated: true, signal },
  )
}

export async function readAcademicStatus(id: string, signal: AbortSignal) {
  return apiFetch<{ id: string; academic_status: AcademicStatus }>(
    `/api/v1/staff/students/${id}/academic-status`,
    { authenticated: true, signal },
  )
}
