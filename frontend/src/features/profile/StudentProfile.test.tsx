import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiClientError, apiFetch } from '../../shared/api/client'
import { StudentAccess, StudentProfilePage } from './StudentProfile'
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({ logout: vi.fn() }) }))
vi.mock('../../shared/api/client', async (original) => ({
  ...(await original<object>()),
  apiFetch: vi.fn(),
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
const profile = {
  id: '1',
  student_id: '2',
  full_name: 'Тестовый Студент',
  login: 'student',
  faculty: { id: '3', name: 'Факультет' },
  program: { id: '4', code: '01', name: 'Программа' },
  direction: { code: '01', name: 'Направление' },
  group: { id: '5', name: 'Группа' },
  course_number: 2,
  academic_status: 'academic_leave',
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Routes>
          <Route element={<StudentAccess />}>
            <Route
              path="/"
              element={
                <>
                  <nav>Private navigation</nav>
                  <StudentProfilePage />
                </>
              }
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}
it('hides student UI until the profile is verified', () => {
  vi.mocked(apiFetch).mockReturnValue(new Promise(() => {}))
  mount()
  expect(screen.getByText('Загружаем профиль…')).toBeInTheDocument()
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
})
it.each([403, 500])('hides student UI on HTTP %s', async (status) => {
  vi.mocked(apiFetch).mockRejectedValue(new ApiClientError('Error', 'forbidden', status))
  mount()
  expect(await screen.findByRole('alert')).toHaveTextContent(
    status === 403 ? 'Доступ запрещён' : 'Не удалось загрузить профиль',
  )
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
})
it('renders academic status, initials and read-only fields', async () => {
  vi.mocked(apiFetch).mockResolvedValue(profile)
  mount()
  expect(await screen.findByText('Академический отпуск')).toBeInTheDocument()
  expect(screen.getByText('ТС')).toBeInTheDocument()
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
})
it('does not retain a previous account profile after the session clears its cache', async () => {
  vi.mocked(apiFetch).mockResolvedValue(profile)
  const client = mount()
  await screen.findByText('Академический отпуск')
  cleanup()
  client.clear()
  vi.mocked(apiFetch).mockResolvedValue({
    ...profile,
    full_name: 'Другой Студент',
    academic_status: 'enrolled',
  })
  mount()
  expect(await screen.findAllByText('Другой Студент')).toHaveLength(2)
  expect(screen.queryByText('Тестовый Студент')).not.toBeInTheDocument()
})
