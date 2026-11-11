import { StudentAccess, StudentProfilePage } from '../features/profile/StudentProfile'
import { createBrowserRouter, Link, Navigate, Outlet } from 'react-router-dom'

import { LoginPage, ProtectedRoute } from '../features/auth/AuthPages'
import { SchedulePage } from '../features/schedule/SchedulePage'
import { useAuth } from '../features/auth/AuthProvider'
import { LoadingState } from '../shared/ui/StatusStates'
import { StudentLayout, UnavailableSection } from './StudentLayout'
import type { ReactNode } from 'react'
import type { RouteObject } from 'react-router-dom'

function PublicFrame({ children }: { children: ReactNode }) {
  return (
    <div className="public-shell">
      <header className="public-header">
        <Link to="/login" className="public-brand">
          Uni Space <span>РГУЧВ</span>
        </Link>
        <Link to="/about" className="public-about-link">
          О проекте
        </Link>
      </header>
      <main className="public-content">{children}</main>
      <footer className="public-footer">Конкурсный прототип · Неофициальный сервис</footer>
    </div>
  )
}

function PublicLayout() {
  return (
    <PublicFrame>
      <Outlet />
    </PublicFrame>
  )
}

function AboutPage() {
  return (
    <section className="welcome-card">
      <p className="section-eyebrow">О проекте</p>
      <h1>Uni Space</h1>
      <p>Студенческий кабинет для расписания, успеваемости и университетских услуг.</p>
      <p className="prototype-inline-note">Конкурсный прототип · Неофициальный сервис</p>
    </section>
  )
}

function RouteIssuePage({ notFound = false }: { notFound?: boolean }) {
  const { status } = useAuth()
  if (status === 'initializing')
    return <LoadingState title="Проверяем сессию…" variant="compact" className="auth-loading" />

  const destination = status === 'authenticated' ? '/schedule' : '/login'
  return (
    <section className="welcome-card route-issue-card" aria-labelledby="route-issue-title">
      <p className="section-eyebrow">Студенческий кабинет</p>
      <h1 id="route-issue-title">
        {notFound ? 'Страница не найдена' : 'Не удалось открыть страницу'}
      </h1>
      <p>
        {notFound
          ? 'Проверьте адрес или вернитесь к доступным страницам.'
          : 'Произошла ошибка. Попробуйте перейти к доступной странице.'}
      </p>
      <Link className="route-recovery-link" to={destination}>
        {status === 'authenticated' ? 'Вернуться к расписанию' : 'Перейти ко входу'}
      </Link>
    </section>
  )
}

export function RouteErrorPage() {
  return (
    <PublicFrame>
      <RouteIssuePage />
    </PublicFrame>
  )
}

function NotFoundPage() {
  return <RouteIssuePage notFound />
}

export const appRoutes: RouteObject[] = [
  {
    element: <Outlet />,
    errorElement: <RouteErrorPage />,
    children: [
      { path: '/', element: <Navigate to="/login" replace /> },
      {
        element: <PublicLayout />,
        children: [
          { path: '/login', element: <LoginPage /> },
          { path: '/about', element: <AboutPage /> },
        ],
      },
      {
        element: <ProtectedRoute />,
        children: [
          {
            element: <StudentAccess />,
            children: [
              {
                element: <StudentLayout />,
                children: [
                  { path: '/schedule', element: <SchedulePage /> },
                  { path: '/academics', element: <UnavailableSection title="Успеваемость" /> },
                  { path: '/services', element: <UnavailableSection title="Услуги и документы" /> },
                  { path: '/news', element: <UnavailableSection title="Новости" /> },
                  { path: '/notifications', element: <UnavailableSection title="Уведомления" /> },
                  { path: '/profile', element: <StudentProfilePage /> },
                  { path: '/settings', element: <UnavailableSection title="Настройки" /> },
                ],
              },
            ],
          },
        ],
      },
      {
        element: <PublicLayout />,
        children: [{ path: '*', element: <NotFoundPage /> }],
      },
    ],
  },
]

export const router = createBrowserRouter(appRoutes)
