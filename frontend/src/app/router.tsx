import { createBrowserRouter, Link, Navigate, Outlet } from 'react-router-dom'

import { LoginPage, ProtectedRoute, SchedulePage } from '../features/auth/AuthPages'
import { StudentLayout, UnavailableSection } from './StudentLayout'

function PublicLayout() {
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
      <main className="public-content">
        <Outlet />
      </main>
      <footer className="public-footer">Конкурсный прототип · Неофициальный сервис</footer>
    </div>
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

export const router = createBrowserRouter([
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
        element: <StudentLayout />,
        children: [
          { path: '/schedule', element: <SchedulePage /> },
          { path: '/academics', element: <UnavailableSection title="Успеваемость" /> },
          { path: '/services', element: <UnavailableSection title="Услуги и документы" /> },
          { path: '/news', element: <UnavailableSection title="Новости" /> },
          { path: '/notifications', element: <UnavailableSection title="Уведомления" /> },
          { path: '/profile', element: <UnavailableSection title="Мой профиль" /> },
          { path: '/settings', element: <UnavailableSection title="Настройки" /> },
        ],
      },
    ],
  },
])
