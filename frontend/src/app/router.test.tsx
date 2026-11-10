import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { appRoutes } from './router'
import type { RouteObject } from 'react-router-dom'

const auth = vi.hoisted(() => ({
  status: 'unauthenticated' as 'initializing' | 'authenticated' | 'unauthenticated',
  message: '',
  busy: false,
  login: vi.fn(),
  logout: vi.fn(),
}))

vi.mock('../features/auth/AuthProvider', () => ({ useAuth: () => auth }))

afterEach(() => {
  cleanup()
  auth.status = 'unauthenticated'
  auth.message = ''
  auth.busy = false
  auth.login.mockReset()
  auth.logout.mockReset()
})

function renderRouter(path: string) {
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
}

describe('route fallbacks', () => {
  it('shows a branded 404 and sends an anonymous user to login without rendering protected UI', async () => {
    auth.status = 'unauthenticated'
    renderRouter('/unknown-page')
    expect(await screen.findByRole('heading', { name: 'Страница не найдена' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Перейти ко входу' })).toHaveAttribute('href', '/login')
    expect(screen.queryByRole('navigation', { name: 'Разделы кабинета' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Расписание' })).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('link', { name: 'Перейти ко входу' }))
    expect(await screen.findByRole('heading', { name: 'Вход' })).toBeInTheDocument()
  })

  it('shows a 404 for a nested invalid path and returns an authenticated user to schedule', async () => {
    auth.status = 'authenticated'
    renderRouter('/schedule/nonexistent')
    expect(await screen.findByRole('heading', { name: 'Страница не найдена' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Вернуться к расписанию' })).toHaveAttribute(
      'href',
      '/schedule',
    )
    expect(screen.queryByRole('navigation', { name: 'Разделы кабинета' })).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('link', { name: 'Вернуться к расписанию' }))
    expect(await screen.findByRole('heading', { name: 'Расписание' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Разделы кабинета' })).toBeInTheDocument()
  })

  it.each([
    ['authenticated', 'Вернуться к расписанию', '/schedule'],
    ['unauthenticated', 'Перейти ко входу', '/login'],
  ] as const)(
    'hides technical details for unexpected route errors when %s',
    async (status, linkName, href) => {
      auth.status = status
      const failingRoutes: RouteObject[] = [
        {
          element: appRoutes[0]!.element,
          errorElement: appRoutes[0]!.errorElement,
          children: [
            ...(appRoutes[0]!.children ?? []),
            {
              path: '/broken',
              loader: () => {
                throw new Error('private database detail')
              },
              element: <h1>Unreachable</h1>,
            },
          ],
        },
      ]
      const router = createMemoryRouter(failingRoutes, { initialEntries: ['/broken'] })
      render(<RouterProvider router={router} />)
      expect(
        await screen.findByRole('heading', { name: 'Не удалось открыть страницу' }),
      ).toBeInTheDocument()
      expect(screen.queryByText(/private database detail/)).not.toBeInTheDocument()
      expect(screen.queryByRole('navigation', { name: 'Разделы кабинета' })).not.toBeInTheDocument()
      expect(screen.getByRole('link', { name: linkName })).toHaveAttribute('href', href)
    },
  )
})
