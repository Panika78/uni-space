import { createContext, useContext, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, Navigate, Outlet, useLocation } from 'react-router-dom'
import { apiFetch, ApiClientError } from '../../shared/api/client'
import { ErrorState, LoadingState } from '../../shared/ui/StatusStates'
import { CabinetLayout, UserMenu } from '../../app/CabinetLayout'
import { getRoleNavigation, getStartRoute, hasPermission, staffSections } from './roleNavigation'
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
  if (query.isPending) return <LoadingState title="Проверяем доступ…" />
  if (query.isError) {
    const status = query.error instanceof ApiClientError ? query.error.status : undefined
    if (status === 401) return <Navigate to="/login" replace />
    return (
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
  }
  return (
    <RoleContext.Provider value={query.data}>
      <Outlet key={query.data.user_id + query.data.role} />
    </RoleContext.Provider>
  )
}

export function RoleStart() {
  return <Navigate to={getStartRoute(useRoleContext())} replace />
}

export function RoleGuard({
  role,
  permission,
}: {
  role: AuthorizationContext['role']
  permission?: PermissionCode
}) {
  const context = useRoleContext()
  if (context.role !== role || (permission && !hasPermission(context, permission)))
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
    <CabinetLayout
      student={false}
      navigation={getRoleNavigation(context)}
      home={getStartRoute(context)}
    />
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
  const sections = staffSections.filter(({ permission }) => hasPermission(context, permission))
  return (
    <section className="section-page">
      <h1>{sections.length ? 'Кабинет сотрудника' : 'Нет доступных разделов'}</h1>
      {!sections.length && (
        <p>
          Обратитесь к администратору для назначения полномочий. Вы можете выйти через меню
          пользователя.
        </p>
      )}
      {sections.map(({ permission, label }) => (
        <section key={permission} id={permission}>
          <h2>{label}</h2>
          <p>
            Модуль пока недоступен. Полномочие предоставлено, функциональность будет подключена на
            следующем этапе MVP2.
          </p>
        </section>
      ))}
    </section>
  )
}
