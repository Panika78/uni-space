import { afterEach, expect, it, vi } from 'vitest'
import { apiFetch } from '../../shared/api/client'
import { STATUS_WRITE_DEADLINE_MS, updateAcademicStatus } from './statusApi'
vi.mock('../../shared/api/client', () => ({ apiFetch: vi.fn() }))
afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})
it('bounds a hanging PATCH, aborts its transport and never replays the write', async () => {
  vi.useFakeTimers()
  vi.mocked(apiFetch).mockImplementation(() => new Promise(() => {}))
  const operation = updateAcademicStatus(
    '21',
    'enrolled',
    'correction',
    new AbortController().signal,
  )
  const rejected = expect(operation).rejects.toThrow('status_write_deadline')
  await vi.advanceTimersByTimeAsync(STATUS_WRITE_DEADLINE_MS)
  await rejected
  expect(apiFetch).toHaveBeenCalledTimes(1)
  const init = vi.mocked(apiFetch).mock.calls[0][1]!
  expect(init.method).toBe('PATCH')
  expect(init.signal?.aborted).toBe(true)
})
