import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '../../app/queryClient'
import { ApiClientError, apiFetch } from '../../shared/api/client'
import { AcademicsPage } from './AcademicsPage'
import { createAcademics } from './testFixtures'

vi.mock('../../shared/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/api/client')>()),
  apiFetch: vi.fn(),
}))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})
function show() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <AcademicsPage />
    </QueryClientProvider>,
  )
}

it('shows loading then exact numeric scores and a separate session below disciplines', async () => {
  let resolve!: (data: ReturnType<typeof createAcademics>) => void
  vi.mocked(apiFetch).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      }) as never,
  )
  show()
  expect(screen.getByText('Загружаем успеваемость…')).toBeInTheDocument()
  resolve(createAcademics())
  expect(await screen.findByText('6 / 30')).toBeInTheDocument()
  expect(screen.getByText('2 из 3')).toBeInTheDocument()
  expect(screen.getByText('Не выставлено')).toBeInTheDocument()
  const headings = screen.getAllByRole('heading', { level: 2 }).map((el) => el.textContent)
  expect(headings).toEqual(['Текущие дисциплины', 'Сессия'])
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/v1/academics',
    expect.objectContaining({ authenticated: true, signal: expect.any(AbortSignal) }),
  )
})

it.each([
  [2, 'Неудовлетворительно'],
  [3, 'Удовлетворительно'],
  [4, 'Хорошо'],
  [5, 'Отлично'],
  [true, 'Зачтено'],
  [false, 'Не зачтено'],
  [null, 'Не выставлено'],
] as const)(
  'renders final result %s with semantic label and known retake directly in its row',
  async (value, label) => {
    const data = createAcademics()
    const item = data.items[0]
    item.attestation_type = typeof value === 'boolean' ? 'pass_fail' : 'graded_pass'
    item.final_result = {
      grade_value: typeof value === 'number' ? value : null,
      passed: typeof value === 'boolean' ? value : null,
      has_debt: value === 2 || value === false,
      retake_date: '2026-12-01',
      retake_location: 'Тестовая аудитория',
    }
    vi.mocked(apiFetch).mockResolvedValue(data)
    show()
    const result = await screen.findByText(label)
    const row = result.closest('tr')!
    expect(within(row).getByText(/Пересдача/)).toHaveTextContent('Тестовая аудитория')
    expect(
      within(row)
        .getByText(/Пересдача/)
        .querySelector('time'),
    ).toHaveAttribute('dateTime', '2026-12-01')
    expect(within(row).queryByText('Задолженность') !== null).toBe(value === 2 || value === false)
  },
)

it.each([null, { id: '1', name: 'Осень', starts_on: '2026-09-01', ends_on: '2027-01-01' }])(
  'distinguishes absent term from empty curriculum',
  async (term) => {
    vi.mocked(apiFetch).mockResolvedValue({ term, items: [] })
    show()
    expect(
      await screen.findByText(
        term ? 'Нет дисциплин текущего семестра' : 'Нет текущего учебного периода',
      ),
    ).toBeInTheDocument()
  },
)

it('does not present absent scores as graded zeros and handles no works', async () => {
  const data = createAcademics()
  data.items[0].total_score = 0
  data.items[0].graded_assessment_count = 0
  data.items[0].final_result.grade_value = 5 // Never infer the final from totals.
  vi.mocked(apiFetch).mockResolvedValue(data)
  show()
  expect(await screen.findByText('0 / 30')).toBeInTheDocument()
  expect(screen.getByText('Не выставлено')).toBeInTheDocument()
  expect(screen.getByText('Отлично')).toBeInTheDocument()
  expect(screen.queryByText(/Пересдача/)).not.toBeInTheDocument()
  cleanup()
  data.items[0].max_score = data.items[0].assessment_count = 0
  show()
  expect(await screen.findByText('0 / 0')).toBeInTheDocument()
  expect(screen.getByText('Нет работ')).toBeInTheDocument()
})

it.each([401, 403, 500])(
  'shows %s without stale grades and retries only recoverable errors',
  async (status) => {
    vi.mocked(apiFetch).mockRejectedValue(new ApiClientError('Ошибка', 'internal_error', status))
    show()
    await screen.findByRole('alert')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    if (status === 500) {
      vi.mocked(apiFetch).mockResolvedValue(createAcademics())
      await userEvent.setup().click(screen.getByRole('button', { name: 'Повторить' }))
      expect(await screen.findByText('6 / 30')).toBeInTheDocument()
    } else expect(screen.queryByRole('button')).not.toBeInTheDocument()
  },
)
