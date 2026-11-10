import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StudentLayout } from './StudentLayout'

const auth = vi.hoisted(() => ({ logout: vi.fn() }))
vi.mock('../features/auth/AuthProvider', () => ({ useAuth: () => auth }))

function renderStudentLayout(path = '/schedule') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<StudentLayout />}>
          <Route path="/schedule" element={<h1>Расписание</h1>} />
          <Route path="/academics" element={<h1>Успеваемость</h1>} />
          <Route path="/profile" element={<h1>Мой профиль</h1>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

afterEach(cleanup)
beforeEach(() => auth.logout.mockReset())

describe('student dashboard navigation', () => {
  it('marks the current section and shows the unofficial prototype notice', () => {
    renderStudentLayout('/academics')
    expect(screen.getByRole('link', { name: 'Успеваемость' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getAllByText(/Конкурсный прототип/).length).toBeGreaterThan(0)
    expect(screen.getByRole('heading', { name: 'Успеваемость' })).toBeInTheDocument()
  })

  it('opens the mobile drawer and closes it on Escape, restoring focus', async () => {
    const user = userEvent.setup()
    renderStudentLayout()
    const trigger = screen.getByRole('button', { name: 'Открыть меню' })
    await user.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Мобильная навигация' })).toBeInTheDocument()
    expect(
      within(screen.getByRole('dialog', { name: 'Мобильная навигация' })).getByRole('button', {
        name: 'Закрыть меню',
      }),
    ).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Мобильная навигация' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('closes the mobile drawer when the backdrop is clicked', async () => {
    const user = userEvent.setup()
    renderStudentLayout()
    await user.click(screen.getByRole('button', { name: 'Открыть меню' }))
    const drawer = screen.getByRole('dialog', { name: 'Мобильная навигация' })
    await user.click(
      within(drawer.parentElement!).getAllByRole('button', { name: 'Закрыть меню' })[0],
    )
    expect(screen.queryByRole('dialog', { name: 'Мобильная навигация' })).not.toBeInTheDocument()
  })

  it('collapses the desktop sidebar to icon navigation', async () => {
    const user = userEvent.setup()
    renderStudentLayout()
    await user.click(screen.getByRole('button', { name: 'Свернуть меню' }))
    expect(screen.getByRole('button', { name: 'Развернуть меню' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(document.querySelector('.student-shell')).toHaveClass('sidebar-collapsed')
  })

  it('closes the mobile drawer after choosing a section', async () => {
    const user = userEvent.setup()
    renderStudentLayout()
    await user.click(screen.getByRole('button', { name: 'Открыть меню' }))
    const drawer = screen.getByRole('dialog', { name: 'Мобильная навигация' })
    await user.click(within(drawer).getByRole('link', { name: 'Успеваемость' }))
    expect(screen.queryByRole('dialog', { name: 'Мобильная навигация' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Успеваемость' })).toBeInTheDocument()
  })

  it('opens the avatar menu and calls the existing logout action', async () => {
    const user = userEvent.setup()
    renderStudentLayout()
    await user.click(screen.getByRole('button', { name: 'Меню пользователя' }))
    const menu = screen.getByRole('menu', { name: 'Меню пользователя' })
    expect(within(menu).getByRole('menuitem', { name: /Мой профиль/ })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: /Настройки/ })).toBeInTheDocument()
    await user.click(within(menu).getByRole('menuitem', { name: 'Выйти' }))
    expect(auth.logout).toHaveBeenCalledOnce()
  })

  it('closes the avatar menu on outside click', async () => {
    const user = userEvent.setup()
    renderStudentLayout()
    await user.click(screen.getByRole('button', { name: 'Меню пользователя' }))
    await user.click(screen.getByRole('heading', { name: 'Расписание' }))
    expect(screen.queryByRole('menu', { name: 'Меню пользователя' })).not.toBeInTheDocument()
  })
})
