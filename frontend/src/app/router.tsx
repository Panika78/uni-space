import { UsersPage, CreateUserPage, UserDetailPage } from '../features/admin/UsersPage'
import {
  RoleAccess,
  RoleStart,
  RoleGuard,
  RoleLayout,
  ModuleUnavailable,
  StaffHome,
} from '../features/auth/RoleContext'
import { StudentAccess, StudentProfilePage } from '../features/profile/StudentProfile'
import { createBrowserRouter, Link, Navigate, Outlet, ScrollRestoration } from 'react-router-dom'

import { LoginPage, ProtectedRoute } from '../features/auth/AuthPages'
import { PasswordSettingsPage } from '../features/auth/PasswordSettings'
import { AcademicsPage } from '../features/academics/AcademicsPage'
import { SchedulePage } from '../features/schedule/SchedulePage'
import { useAuth } from '../features/auth/AuthProvider'
import { Icon } from '../shared/ui/Icon'
import { LoadingState } from '../shared/ui/StatusStates'
import { StudentLayout } from './StudentLayout'
import { ApplicationDetailPage } from '../features/services/ApplicationsPages'
import { ApplicationFormPage, ServicesPage } from '../features/services/ServicesPages'
import { NewsDetailPage, NewsFeedPage } from '../features/news/NewsPages'
import {
  StaffStudentStatusPage,
  StaffStudentsPage,
  StaffStudentDetailPage,
} from '../features/students/StaffStudentsPage'
import { StaffNewsPage } from '../features/news/StaffNewsPage'
import {
  StaffApplicationsLayout,
  StaffApplicationQueue,
} from '../features/staffApplications/StaffApplicationQueue'
import { StaffApplicationDetail } from '../features/staffApplications/StaffApplicationDetail'
import { StaffSchedulePage } from '../features/schedule/StaffSchedulePage'
import { TeacherJournalsPage } from '../features/teacher/TeacherJournalsPage'
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

function RootLayout() {
  return (
    <>
      <ScrollRestoration />
      <Outlet />
    </>
  )
}

function AboutPage() {
  return (
    <section className="welcome-card">
      <p className="section-eyebrow">О проекте</p>
      <h1>Uni Space</h1>
      <p>Студенческий кабинет для расписания, успеваемости и университетских услуг.</p>
      <p className="prototype-inline-note">Конкурсный прототип · Неофициальный сервис</p>
      <p>
        <a href="/licenses.md">Лицензии сторонних компонентов</a>
      </p>
    </section>
  )
}

function RouteIssuePage({ notFound = false }: { notFound?: boolean }) {
  const { status } = useAuth()
  if (status === 'initializing')
    return <LoadingState title="Проверяем сессию…" variant="compact" className="auth-loading" />

  const destination = status === 'authenticated' ? '/cabinet' : '/login'
  return (
    <section
      className={`welcome-card route-issue-card${notFound ? ' route-issue-card--not-found' : ''}`}
      aria-labelledby="route-issue-title"
    >
      {notFound ? (
        <span className="route-issue-icon" aria-hidden="true">
          <Icon name="info" />
        </span>
      ) : (
        <p className="section-eyebrow">Кабинет Uni Space</p>
      )}
      <h1 id="route-issue-title">
        {notFound ? 'Страница не найдена' : 'Не удалось открыть страницу'}
      </h1>
      <p>
        {notFound
          ? 'Проверьте адрес или вернитесь к доступным страницам.'
          : 'Произошла ошибка. Попробуйте перейти к доступной странице.'}
      </p>
      <Link className="route-recovery-link" to={destination}>
        {status === 'authenticated' ? 'Вернуться в кабинет' : 'Перейти ко входу'}
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
    element: <RootLayout />,
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
            element: <RoleAccess />,
            children: [
              { path: '/cabinet', element: <RoleStart /> },
              { path: '/settings', element: <PasswordSettingsPage /> },
              {
                element: <RoleGuard role="student" />,
                children: [
                  {
                    element: <StudentAccess />,
                    children: [
                      {
                        element: <StudentLayout />,
                        children: [
                          { path: '/schedule', element: <SchedulePage /> },
                          { path: '/academics', element: <AcademicsPage /> },
                          { path: '/applications/:id', element: <ApplicationDetailPage /> },
                          { path: '/services', element: <ServicesPage /> },
                          { path: '/services/:serviceCode', element: <ApplicationFormPage /> },
                          { path: '/news', element: <NewsFeedPage /> },
                          { path: '/news/:id', element: <NewsDetailPage /> },
                          { path: '/notifications', element: null },
                          { path: '/profile', element: <StudentProfilePage /> },
                        ],
                      },
                    ],
                  },
                ],
              },
              {
                element: <RoleLayout />,
                children: [
                  {
                    element: <RoleGuard role="teacher" />,
                    children: [
                      {
                        path: '/teacher/journals',
                        element: <TeacherJournalsPage />,
                      },
                      {
                        path: '/teacher/schedule',
                        element: <ModuleUnavailable title="Расписание" />,
                      },
                    ],
                  },
                  {
                    element: <RoleGuard role="admin" />,
                    children: [
                      { path: '/admin/users', element: <UsersPage /> },
                      { path: '/admin/users/new', element: <CreateUserPage /> },
                      { path: '/admin/users/:id', element: <UserDetailPage /> },
                    ],
                  },
                  {
                    element: <RoleGuard role="staff" />,
                    children: [
                      { path: '/staff', element: <StaffHome /> },
                      {
                        element: <RoleGuard role="staff" permission="schedule.edit" />,
                        children: [{ path: '/staff/schedule', element: <StaffSchedulePage /> }],
                      },
                      {
                        element: <RoleGuard role="staff" permission="news.publish" />,
                        children: [
                          { path: '/staff/news', element: <StaffNewsPage /> },
                          { path: '/staff/news/:id', element: <StaffNewsPage /> },
                        ],
                      },
                      {
                        element: <RoleGuard role="staff" permission="applications.review" />,
                        children: [
                          {
                            path: '/staff/applications',
                            element: <StaffApplicationsLayout />,
                            children: [
                              { index: true, element: <StaffApplicationQueue /> },
                              { path: ':id', element: <StaffApplicationDetail /> },
                            ],
                          },
                        ],
                      },
                      {
                        element: <RoleGuard role="staff" permission="students.read" />,
                        children: [
                          { path: '/staff/students', element: <StaffStudentsPage /> },
                          { path: '/staff/students/:id', element: <StaffStudentDetailPage /> },
                        ],
                      },
                      {
                        element: <RoleGuard role="staff" permission="students.status.edit" />,
                        children: [
                          { path: '/staff/students/status', element: <StaffStudentStatusPage /> },
                        ],
                      },
                    ],
                  },
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
