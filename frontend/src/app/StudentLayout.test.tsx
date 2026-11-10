import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StudentLayout } from './StudentLayout'

const auth = vi.hoisted(() => ({ logout: vi.fn() }))
vi.mock('../features/auth/AuthProvider', () => ({ useAuth: () => auth }))

function mockViewport(initialWidth: number) {
  let width = initialWidth
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const mediaQueryList = {
    media: '(min-width: 721px)',
    get matches() {
      return width > 720
    },
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.delete(listener),
    addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    dispatchEvent: () => true,
  } as unknown as MediaQueryList
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => mediaQueryList),
  )

  return (nextWidth: number) => {
    const wasDesktop = width > 720
    width = nextWidth
    const isDesktop = width > 720
    if (wasDesktop !== isDesktop) {
      listeners.forEach((listener) => listener({ matches: isDesktop } as MediaQueryListEvent))
    }
  }
}

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

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
beforeEach(() => {
  auth.logout.mockReset()
  mockViewport(360)
})

describe('student dashboard navigation', () => {
  it('uses the shared supplied emblem asset in the desktop brand and mobile drawer', async () => {
    const user = userEvent.setup()
    renderStudentLayout()
    expect(document.querySelectorAll('.brand-mark')).toHaveLength(1)
    expect(document.querySelector('.brand-mark')).toHaveAttribute(
      'src',
      '/assets/university-emblem.png',
    )
    await user.click(screen.getByRole('button', { name: 'Открыть меню' }))
    expect(document.querySelectorAll('.brand-mark')).toHaveLength(2)
    expect(
      Array.from(document.querySelectorAll('.brand-mark')).map((image) =>
        image.getAttribute('src'),
      ),
    ).toEqual(['/assets/university-emblem.png', '/assets/university-emblem.png'])
  })

  it('marks the current section and shows the unofficial prototype notice', () => {
    renderStudentLayout('/academics')
    expect(screen.getByRole('link', { name: 'Успеваемость' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getAllByText(/Конкурсный прототип/).length).toBeGreaterThan(0)
    expect(screen.getByRole('heading', { name: 'Успеваемость' })).toBeInTheDocument()
  })

  it('keeps the unofficial prototype notice visible when the desktop sidebar is collapsed', async () => {
    const user = userEvent.setup()
    renderStudentLayout()
    await user.click(screen.getByRole('button', { name: 'Свернуть меню' }))
    const notice = screen.getByTestId('prototype-disclaimer')
    expect(notice).toHaveTextContent('Конкурсный прототип')
    expect(notice).toHaveTextContent('Неофициальный сервис')
    expect(notice.closest('.desktop-sidebar')).toBeNull()
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

  it('closes the mobile drawer on desktop resize and keeps focus on visible content', async () => {
    const setViewport = mockViewport(360)
    const user = userEvent.setup()
    renderStudentLayout()
    const trigger = screen.getByRole('button', { name: 'Открыть меню' })
    await user.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Мобильная навигация' })).toBeInTheDocument()
    expect(document.body.style.overflow).toBe('hidden')

    setViewport(800)

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Мобильная навигация' })).not.toBeInTheDocument()
      expect(document.body.style.overflow).toBe('')
    })
    expect(window.matchMedia('(min-width: 721px)').matches).toBe(true)
    expect(screen.getByRole('main')).toHaveFocus()
    expect(trigger).not.toHaveFocus()

    setViewport(360)
    expect(window.matchMedia('(min-width: 721px)').matches).toBe(false)
    expect(screen.queryByRole('dialog', { name: 'Мобильная навигация' })).not.toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('main')).toHaveFocus()
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

  it('uses a native disclosure for the avatar actions and calls the existing logout action', async () => {
    const user = userEvent.setup()
    renderStudentLayout()
    const trigger = screen.getByRole('button', { name: 'Меню пользователя' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'Выйти' })).not.toBeInTheDocument()
    await user.click(trigger)
    const panel = screen.getByRole('link', { name: /Мой профиль/ }).parentElement!
    expect(within(panel).queryByRole('menu')).not.toBeInTheDocument()
    expect(within(panel).getByRole('link', { name: /Мой профиль/ })).toBeInTheDocument()
    expect(within(panel).getByRole('link', { name: /Настройки/ })).toBeInTheDocument()
    await user.click(within(panel).getByRole('button', { name: 'Выйти' }))
    expect(auth.logout).not.toHaveBeenCalled()
    await user.click(
      within(screen.getByRole('dialog', { name: 'Выйти из аккаунта?' })).getByRole('button', {
        name: 'Выйти',
      }),
    )
    expect(auth.logout).toHaveBeenCalledOnce()
  })

  it('supports native focus order, closes on Escape and restores focus to the avatar trigger', async () => {
    const user = userEvent.setup()
    renderStudentLayout()
    const trigger = screen.getByRole('button', { name: 'Меню пользователя' })
    await user.click(trigger)
    await user.tab()
    expect(screen.getByRole('link', { name: /Мой профиль/ })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('link', { name: /Настройки/ })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('link', { name: /Мой профиль/ })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('closes the avatar disclosure on outside click and when focus leaves it', async () => {
    const user = userEvent.setup()
    renderStudentLayout()
    await user.click(screen.getByRole('button', { name: 'Меню пользователя' }))
    await user.click(screen.getByRole('heading', { name: 'Расписание' }))
    expect(screen.queryByRole('link', { name: /Мой профиль/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Меню пользователя' }))
    await user.tab()
    await user.tab()
    await user.tab()
    await user.tab()
    expect(screen.queryByRole('link', { name: /Мой профиль/ })).not.toBeInTheDocument()
  })

  it('links notifications to the explicit unavailable page', () => {
    renderStudentLayout()
    expect(
      screen.getByRole('link', { name: 'Уведомления — функция пока недоступна' }),
    ).toHaveAttribute('href', '/notifications')
    expect(
      screen.getByRole('link', { name: 'Уведомления — функция пока недоступна' }),
    ).toHaveAccessibleName('Уведомления — функция пока недоступна')
  })
})
