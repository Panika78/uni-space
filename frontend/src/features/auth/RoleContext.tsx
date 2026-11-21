import { clearJournalStorage, readJournalStorage } from '../staff-journals/journalStorage'
import { authEpochStorageKey } from './authSession'
import { AccessRecovery, isTemporaryAccessError } from '../../shared/ui/AccessRecovery'
import { createContext, useContext, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, Navigate, Outlet, useLocation } from 'react-router-dom'
import { apiFetch, ApiClientError } from '../../shared/api/client'
import { ErrorState, LoadingState } from '../../shared/ui/StatusStates'
import { Icon } from '../../shared/ui/Icon'
import { CabinetLayout, UserMenu } from '../../app/CabinetLayout'
import '../../app/mvp2-unified.css'
import {
  getRoleNavigation,
  getStartRoute,
  getStaffJournalRoute,
  hasPermission,
  staffSections,
} from './roleNavigation'
import type { AuthorizationContext, PermissionCode } from './roleNavigation'

const RoleContext = createContext<AuthorizationContext | null>(null)
export function useRoleContext() {
  const context = useContext(RoleContext)
  if (!context) throw new Error('RoleAccess is required')
  return context
}

export function RoleAccess() {
  const location = useLocation()
  // Revalidate on every committed navigation, including history traversal.
  // Retain the mounted shell/forms during a read; errors never render stale data.
  const query = useQuery({
    queryKey: ['authorization-context'],
    queryFn: ({ signal }) =>
      apiFetch<AuthorizationContext>('/api/v1/auth/context', { authenticated: true, signal }),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
    refetchInterval: location.pathname === '/staff/journals' ? 15_000 : false,
  })
  const lastNavigation = useRef(location.key)
  const { refetch } = query
  useEffect(() => {
    if (lastNavigation.current === location.key) return
    lastNavigation.current = location.key
    void refetch()
  }, [location.key, refetch])
  useEffect(() => {
    const refreshContext = () => {
      void refetch()
    }
    window.addEventListener('focus', refreshContext)
    window.addEventListener('pageshow', refreshContext)
    return () => {
      window.removeEventListener('focus', refreshContext)
      window.removeEventListener('pageshow', refreshContext)
    }
  }, [refetch])
  useEffect(() => {
    const context = query.data
    if (query.isError && !isTemporaryAccessError(query.error)) {
      clearJournalStorage()
    } else if (context) {
      const saved = readJournalStorage()
      const scope = JSON.stringify([
        localStorage.getItem(authEpochStorageKey) ?? 'initial',
        context.user_id,
        context.role,
        hasPermission(context, 'grades.edit'),
        hasPermission(context, 'attendance.edit'),
      ])
      if (saved && saved.scope !== scope) clearJournalStorage()
    }
  }, [query.data, query.error, query.isError])
  if (query.isPending) return <LoadingState title="Проверяем доступ…" />
  let failure = null
  if (query.isError) {
    const status = query.error instanceof ApiClientError ? query.error.status : undefined
    if (status === 401) return <Navigate to="/login" replace />
    failure = (
      <ErrorState
        title={
          status === 403
            ? 'Доступ запрещён'
            : status && status >= 500
              ? 'Сервис временно недоступен'
              : 'Не удалось связаться с сервером'
        }
        description={
          status === 403
            ? 'Нет доступа к контексту кабинета.'
            : 'Не удалось получить сведения о доступе. Повторите попытку.'
        }
        onRetry={
          status === 403
            ? undefined
            : () => {
                void query.refetch()
              }
        }
      >
        <UserMenu logoutOnly />
      </ErrorState>
    )
    if (!query.data || !isTemporaryAccessError(query.error)) return failure
  }
  if (!query.data) return null
  return (
    <RoleContext.Provider value={query.data}>
      <AccessRecovery blocked={query.isError} fallback={failure}>
        <Outlet key={query.data.user_id + query.data.role} />
      </AccessRecovery>
    </RoleContext.Provider>
  )
}

export function RoleStart() {
  return <Navigate to={getStartRoute(useRoleContext())} replace />
}

export function RoleGuard({
  role,
  permission,
  anyOfPermissions,
}: {
  role: AuthorizationContext['role']
  permission?: PermissionCode
  anyOfPermissions?: readonly PermissionCode[]
}) {
  const context = useRoleContext()
  if (
    context.role !== role ||
    (permission && !hasPermission(context, permission)) ||
    (anyOfPermissions && !anyOfPermissions.some((code) => hasPermission(context, code)))
  )
    return <AccessDenied />
  return <Outlet />
}

function AccessDenied() {
  return (
    <ErrorState title="Доступ запрещён" description="Этот раздел недоступен вашей учётной записи.">
      <Link to="/cabinet">Перейти в свой кабинет</Link>
      <UserMenu logoutOnly />
    </ErrorState>
  )
}

export function RoleLayout() {
  const context = useRoleContext()
  return (
    <div className="mvp2-role-surface">
      <CabinetLayout
        student={false}
        notificationScope={`${context.user_id}:${context.role}`}
        navigation={getRoleNavigation(context)}
        home={getStartRoute(context)}
      />
    </div>
  )
}

export function ModuleUnavailable({ title }: { title: string }) {
  return (
    <section className="section-page">
      <h1>{title}</h1>
      <p>Модуль пока недоступен. Он будет подключён на следующем этапе MVP2.</p>
    </section>
  )
}

export function StaffHome() {
  const context = useRoleContext()
  const sections = staffSections.filter(
    ({ permission, disabled, visible }) =>
      disabled || (visible !== false && hasPermission(context, permission)),
  )
  const hasWorkingSections = sections.some(({ disabled }) => !disabled)
  return (
    <section className="section-page staff-home">
      <p className="section-eyebrow">Кабинет сотрудника</p>
      <h1>{hasWorkingSections ? 'Кабинет сотрудника' : 'Нет доступных разделов'}</h1>
      <p className="service-subtitle">Рабочее пространство деканата и учебных подразделений.</p>
      {!hasWorkingSections && (
        <article className="staff-home__empty">
          <span aria-hidden="true">
            <Icon name="info" />
          </span>
          <div>
            <h2>Разделы пока не назначены</h2>
            <p>
              Обратитесь к администратору, чтобы получить доступ к рабочим разделам. Вы можете
              завершить сеанс через меню пользователя.
            </p>
          </div>
        </article>
      )}
      {hasWorkingSections && <h2 className="staff-home__section-title">Быстрый доступ</h2>}
      <div className="staff-home__grid">
        {sections.map(({ permission, label, icon }) => {
          const href =
            permission === 'grades.edit' || permission === 'attendance.edit'
              ? getStaffJournalRoute(permission)
              : permission === 'news.publish'
                ? '/staff/news'
                : permission === 'applications.review'
                  ? '/staff/applications'
                  : permission === 'schedule.edit'
                    ? '/staff/schedule'
                    : permission === 'students.read'
                      ? '/staff/students'
                      : permission === 'students.status.edit'
                        ? '/staff/students/status'
                        : null
          const action =
            permission === 'grades.edit' || permission === 'attendance.edit'
              ? 'Открыть журнал'
              : permission === 'news.publish'
                ? 'Открыть редактор новостей'
                : permission === 'applications.review'
                  ? 'Открыть очередь заявлений'
                  : permission === 'schedule.edit'
                    ? 'Открыть редактор расписания'
                    : permission === 'students.read'
                      ? 'Открыть поиск студентов'
                      : permission === 'students.status.edit'
                        ? 'Открыть академические статусы'
                        : 'Модуль пока недоступен'
          const description =
            permission === 'applications.review'
              ? 'Рассмотрение заявлений, возвраты и решения.'
              : permission === 'schedule.edit'
                ? 'Создание, перенос и отмена официальных занятий.'
                : permission === 'grades.edit'
                  ? 'Баллы, посещаемость и история изменений.'
                  : permission === 'attendance.edit'
                    ? 'Посещаемость и история изменений.'
                    : permission === 'news.publish'
                      ? 'Редактор объявлений для студенческой ленты.'
                      : permission === 'students.read'
                        ? 'Поиск, просмотр и доступные действия в карточке студента.'
                        : permission === 'students.status.edit'
                          ? 'Просмотр и изменение академических статусов студентов.'
                          : 'Раздел доступен согласно выданным полномочиям.'
          return (
            <section
              key={permission}
              id={permission}
              className={`staff-home__card${permission === 'groups.manage' ? ' is-disabled' : ''}`}
              aria-disabled={permission === 'groups.manage' ? 'true' : undefined}
            >
              <span className="staff-home__icon" aria-hidden="true">
                <Icon name={icon} />
              </span>
              <div className="staff-home__card-content">
                <h3>
                  {label}
                  {permission === 'groups.manage' && <span>В разработке</span>}
                </h3>
                <p>
                  {permission === 'groups.manage'
                    ? 'Управление учебными группами появится в следующем этапе.'
                    : href
                      ? description
                      : 'Модуль пока недоступен.'}
                </p>
                {href && (
                  <Link aria-label={`${action}: ${label}`} to={href}>
                    {action} <span aria-hidden="true">→</span>
                  </Link>
                )}
              </div>
            </section>
          )
        })}
      </div>
    </section>
  )
}
