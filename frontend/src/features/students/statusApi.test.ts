import { afterEach, expect, it, vi } from 'vitest'
import { apiFetch } from '../../shared/api/client'
import { STATUS_WRITE_DEADLINE_MS, updateAcademicStatus } from './statusApi'
vi.mock('../../shared/api/client', () => ({ apiFetch: vi.fn() }))
afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})
it('bounds a hanging PATCH, includes one operation ID, aborts transport and never replays', async () => {
  vi.useFakeTimers()
  vi.mocked(apiFetch).mockImplementation(() => new Promise(() => {}))
  const operation = updateAcademicStatus(
    '21',
    'enrolled',
    'correction',
    '00000000-0000-4000-8000-000000000001',
    new AbortController().signal,
  )
  const rejected = expect(operation).rejects.toThrow('status_write_deadline')
  await vi.advanceTimersByTimeAsync(STATUS_WRITE_DEADLINE_MS)
  await rejected
  expect(apiFetch).toHaveBeenCalledTimes(1)
  const init = vi.mocked(apiFetch).mock.calls[0][1]!
  expect(init.method).toBe('PATCH')
  expect(JSON.parse(String(init.body))).toMatchObject({
    academic_status: 'enrolled',
    reason: 'correction',
    operation_id: '00000000-0000-4000-8000-000000000001',
  })
  expect(init.signal?.aborted).toBe(true)
})
