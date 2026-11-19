import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../features/auth/AuthProvider', () => ({ useAuth: () => ({ logout: vi.fn() }) }))
vi.mock('../features/auth/RoleContext', () => ({
  useRoleContext: () => ({ user_id: '1', role: 'student', org_unit_id: null, permissions: [] }),
}))
vi.mock('../shared/api/client', () => ({
  apiFetch: vi.fn(async (url: string) => {
    if (url === '/api/v1/notifications/unread-count') return { count: 0 }
    if (url.startsWith('/api/v1/notifications?')) return { items: [], next_cursor: null }
    throw new Error(`Unexpected API request: ${url}`)
  }),
}))
import { StudentLayout } from './StudentLayout'

describe('public and student layouts', () => {
  it('renders the student shell without a separate dashboard home', () => {
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter initialEntries={['/schedule']}>
          <Routes>
            <Route element={<StudentLayout />}>
              <Route path="/schedule" element={<h1>Расписание</h1>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(screen.getByRole('heading', { name: 'Расписание' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Разделы кабинета' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Главная' })).not.toBeInTheDocument()
  })
})
