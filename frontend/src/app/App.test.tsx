import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../features/auth/AuthProvider', () => ({ useAuth: () => ({ logout: vi.fn() }) }))
import { StudentLayout } from './StudentLayout'

describe('public and student layouts', () => {
  it('renders the student shell without a separate dashboard home', () => {
    render(
      <MemoryRouter initialEntries={['/schedule']}>
        <Routes>
          <Route element={<StudentLayout />}>
            <Route path="/schedule" element={<h1>Расписание</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByRole('heading', { name: 'Расписание' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Разделы кабинета' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Главная' })).not.toBeInTheDocument()
  })
})
