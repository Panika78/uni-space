import { authEpochStorageKey } from '../features/auth/authSession'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../shared/api/client'
import type { components } from '../shared/api/schema'
import { useAccessSuspended } from '../shared/ui/AccessRecovery'
import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { FocusEvent, ReactNode } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../features/auth/AuthProvider'
import { UnsavedChangesProvider, type ExitProtectionStatus } from './UnsavedChangesContext'
import { UniversityBrand } from '../shared/ui/UniversityBrand'
import { NotificationsDrawer } from '../features/notifications/NotificationsDrawer'
import { Icon } from '../shared/ui/Icon'
import { useOverlayPresence } from '../shared/ui/useOverlayPresence'

export type NavigationItem = {
  to: string
  label: string
  icon:
    | 'calendar'
    | 'graduation'
    | 'file'
    | 'book'
    | 'user'
    | 'clipboard'
    | 'chart'
    | 'checklist'
    | 'users'
    | 'groups'
    | 'news'
  disabled?: boolean
}
const ShellContext = createContext<{
  navigation: readonly NavigationItem[]
  student: boolean
  home: string
  initials: string
  notificationScope: string
}>({
  navigation: [],
  student: false,
  home: '/cabinet',
  initials: '—',
  notificationScope: 'unscoped',
})

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const { navigation } = useContext(ShellContext)
  const { pathname, hash, search } = useLocation()
  return (
    <nav className="student-navigation" aria-label="Разделы кабинета">
      {navigation.map((item) => {
        if (item.disabled)
          return (
            <span
              key={item.label}
              className="student-navigation__link is-disabled"
              aria-disabled="true"
              title={`${item.label} — В разработке`}
            >
              <span className="navigation-icon" aria-hidden="true">
                <Icon name={item.icon} />
              </span>
              <span className="navigation-label">{item.label}</span>
              <span className="navigation-status">В разработке</span>
            </span>
          )
        const [targetPath, targetSearch] = item.to.split('?')
        const isQueryMatch =
          targetSearch &&
          pathname === targetPath &&
          [...new URLSearchParams(targetSearch)].every(
            ([key, value]) => new URLSearchParams(search).get(key) === value,
          )
        const isActive =
          isQueryMatch ||
          `${pathname}${hash}` === item.to ||
          pathname === item.to ||
          pathname.startsWith(`${item.to}/`) ||
          (item.to === '/services' && pathname.startsWith('/applications/'))
        return (
          <Link
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            className={`student-navigation__link${isActive ? ' is-active' : ''}`}
            aria-current={isActive ? 'page' : undefined}
            title={item.label}
          >
            <span className="navigation-icon" aria-hidden="true">
              <Icon name={item.icon} />
            </span>
            <span className="navigation-label">{item.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}

export function UserMenu({
  logoutOnly = false,
  exitStatus = 'none',
  student = true,
}: {
  student?: boolean
  logoutOnly?: boolean
  exitStatus?: ExitProtectionStatus
}) {
  const isSuspended = useAccessSuspended()
  const { initials } = useContext(ShellContext)
  const { logout } = useAuth()
  const [isOpen, setIsOpen] = useState(false)
  const { present: isMenuPresent, rootRef: menuPanelRef } = useOverlayPresence(isOpen, 'menu')
  const [confirmLogout, setConfirmLogout] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const confirmingRef = useRef(false)

  useLayoutEffect(() => {
    if (!confirmLogout || isSuspended) return
    const dialog = dialogRef.current
    dialog?.showModal()
    cancelRef.current?.focus()
    return () => {
      if (dialog?.open) dialog.close()
    }
  }, [confirmLogout, isSuspended])

  const closeConfirmation = () => {
    if (confirmingRef.current) return
    dialogRef.current?.close()
    setConfirmLogout(false)
    triggerRef.current?.focus()
  }

  useEffect(() => {
    if (!isOpen || isSuspended) return
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, isSuspended])

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && containerRef.current?.contains(nextTarget)) return
    setIsOpen(false)
  }

  return (
    <div className="user-menu" ref={containerRef} onBlur={handleBlur}>
      {logoutOnly ? (
        <button ref={triggerRef} type="button" onClick={() => setConfirmLogout(true)}>
          Выйти
        </button>
      ) : (
        <button
          ref={triggerRef}
          className="avatar-button"
          aria-label="Меню пользователя"
          aria-expanded={isOpen}
          aria-controls="user-menu-panel"
          onClick={() => setIsOpen((open) => !open)}
        >
          <span aria-hidden="true">{initials}</span>
        </button>
      )}
      {isMenuPresent && (
        <div
          ref={menuPanelRef}
          inert={!isOpen}
          aria-hidden={!isOpen || undefined}
          className="user-menu__panel"
          id="user-menu-panel"
        >
          {student && (
            <Link to="/profile" onClick={() => setIsOpen(false)}>
              Мой профиль
            </Link>
          )}
          <Link to="/settings" onClick={() => setIsOpen(false)}>
            Настройки
          </Link>
          <button
            onClick={() => {
              setIsOpen(false)
              setConfirmLogout(true)
            }}
          >
            Выйти
          </button>
        </div>
      )}
      {confirmLogout && (
        <dialog
          ref={dialogRef}
          className="logout-dialog"
          aria-labelledby="logout-dialog-title"
          onCancel={(event) => {
            event.preventDefault()
            closeConfirmation()
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Tab') return
            const first = cancelRef.current
            const last =
              dialogRef.current?.querySelector<HTMLButtonElement>('.logout-dialog__confirm')
            if (
              event.shiftKey &&
              (document.activeElement === first || document.activeElement === event.currentTarget)
            ) {
              event.preventDefault()
              last?.focus()
            } else if (
              !event.shiftKey &&
              (document.activeElement === last || document.activeElement === event.currentTarget)
            ) {
              event.preventDefault()
              first?.focus()
            }
          }}
        >
          <h2 id="logout-dialog-title">
            {exitStatus === 'draft'
              ? 'Потерять введённые данные и выйти?'
              : exitStatus === 'submitting' || exitStatus === 'uncertain'
                ? 'Выйти без подтверждения результата?'
                : 'Выйти из аккаунта?'}
          </h2>
          {exitStatus === 'draft' && (
            <p>Заявление ещё не отправлено; введённые данные будут потеряны.</p>
          )}
          {exitStatus === 'submitting' && (
            <p>
              Запрос уже отправлен и может сохранить заявление. Уход не отменит запрос; вы можете
              потерять подтверждение и номер.
            </p>
          )}
          {exitStatus === 'uncertain' && (
            <p>
              Ответ не получен. Заявление могло сохраниться, но подтверждение и номер будут
              потеряны.
            </p>
          )}
          <div className="logout-dialog__actions">
            <button ref={cancelRef} type="button" onClick={closeConfirmation}>
              Отмена
            </button>
            <button
              className="logout-dialog__confirm"
              type="button"
              onClick={() => {
                if (confirmingRef.current) return
                confirmingRef.current = true
                dialogRef.current?.close()
                setConfirmLogout(false)
                void logout()
              }}
            >
              {exitStatus === 'draft'
                ? 'Выйти без сохранения'
                : exitStatus === 'none'
                  ? 'Выйти'
                  : 'Выйти без подтверждения'}
            </button>
          </div>
        </dialog>
      )}
    </div>
  )
}

function MobileDrawer({ onClose, isOpen }: { onClose: () => void; isOpen: boolean }) {
  const isSuspended = useAccessSuspended()
  const { present, rootRef } = useOverlayPresence(isOpen, 'left')
  const closeRef = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    if (!isOpen || isSuspended) return
    const background = document.querySelector<HTMLElement>('.student-main-column')
    const sidebar = document.querySelector<HTMLElement>('.desktop-sidebar')
    const previousInert = [background?.inert, sidebar?.inert]
    if (background) background.inert = true
    if (sidebar) sidebar.inert = true
    closeRef.current?.focus()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(
        document.querySelectorAll<HTMLElement>(
          '.mobile-drawer button, .mobile-drawer a[href], .mobile-drawer [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute('disabled'))
      const first = focusable[0]
      const last = focusable.at(-1)
      if (!first || !last) return
      if (!document.querySelector('.mobile-drawer')?.contains(document.activeElement)) {
        event.preventDefault()
        first.focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      if (background) background.inert = previousInert[0] ?? false
      if (sidebar) sidebar.inert = previousInert[1] ?? false
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose, isOpen, isSuspended])

  if (!present) return null

  return (
    <div
      ref={rootRef}
      className="mobile-drawer-layer"
      inert={!isOpen}
      aria-hidden={!isOpen || undefined}
    >
      <button className="drawer-backdrop" aria-label="Закрыть меню" onClick={onClose} />
      <aside
        data-motion-panel
        className="mobile-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Мобильная навигация"
      >
        <div className="mobile-drawer__top">
          <UniversityBrand />
          <button
            ref={closeRef}
            className="icon-button drawer-close"
            aria-label="Закрыть меню"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <Navigation onNavigate={onClose} />
      </aside>
    </div>
  )
}

export function CabinetLayout({
  navigation,
  student = false,
  home,
  initials = '—',
  notificationScope = home,
  children,
}: {
  navigation: readonly NavigationItem[]
  student?: boolean
  home: string
  initials?: string
  notificationScope?: string
  children?: ReactNode
}) {
  return (
    <ShellContext.Provider value={{ navigation, student, home, initials, notificationScope }}>
      <CabinetShell>{children}</CabinetShell>
    </ShellContext.Provider>
  )
}

function CabinetShell({ children }: { children?: ReactNode }) {
  const isSuspended = useAccessSuspended()
  const { student, home, notificationScope } = useContext(ShellContext)
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [exitStatus, setExitStatus] = useState<ExitProtectionStatus>('none')
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const notificationTriggerRef = useRef<HTMLButtonElement>(null)
  const mainContentRef = useRef<HTMLElement>(null)
  const wasDrawerOpen = useRef(false)
  const location = useLocation()
  const navigate = useNavigate()
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false)
  const showNotifications = isNotificationsOpen || location.pathname === '/notifications'
  const countClient = useQueryClient()
  const countEpoch = localStorage.getItem(authEpochStorageKey) ?? 'initial'
  const countGeneration = useRef<AbortController | null>(null)
  useLayoutEffect(() => {
    const controller = new AbortController()
    countGeneration.current = controller
    if (isSuspended) controller.abort()
    return () => controller.abort()
  }, [countEpoch, notificationScope, isSuspended])
  const count = useQuery({
    queryKey: ['notifications-unread-count', countEpoch, notificationScope],
    queryFn: ({ signal }) =>
      apiFetch<components['schemas']['NotificationUnreadCount']>(
        '/api/v1/notifications/unread-count',
        {
          authenticated: true,
          signal,
        },
      ),
    enabled: !isSuspended,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  })
  const { refetch: refetchCount } = count
  const refreshCount = useCallback(() => {
    const generation = countGeneration.current
    if (!generation || generation.signal.aborted) return
    // Cancel even an initial request without cached data: refetch alone reuses it.
    void countClient
      .cancelQueries({
        queryKey: ['notifications-unread-count', countEpoch, notificationScope],
        exact: true,
      })
      .then(() => {
        if (!generation.signal.aborted && countGeneration.current === generation)
          void refetchCount()
      })
  }, [countClient, countEpoch, notificationScope, refetchCount])
  useEffect(() => {
    if (showNotifications && !isSuspended) refreshCount()
  }, [showNotifications, isSuspended, refreshCount])
  useEffect(() => {
    if (isSuspended) return
    window.addEventListener('focus', refreshCount)
    window.addEventListener('pageshow', refreshCount)
    return () => {
      window.removeEventListener('focus', refreshCount)
      window.removeEventListener('pageshow', refreshCount)
    }
  }, [isSuspended, refreshCount])
  const unreadCount =
    !isSuspended && count.isSuccess && !count.isFetching ? count.data.count : undefined
  const navigateFromNotification = useCallback(
    (path: string) => {
      setIsNotificationsOpen(false)
      navigate(path)
    },
    [navigate],
  )
  const closeDrawer = useCallback(() => setIsDrawerOpen(false), [])
  const openNotifications = useCallback(() => {
    setIsDrawerOpen(false)
    setIsNotificationsOpen(true)
  }, [])
  const closeNotifications = useCallback(() => {
    setIsNotificationsOpen(false)
    if (location.pathname === '/notifications') navigate(home, { replace: true })
    window.setTimeout(() => {
      const trigger = notificationTriggerRef.current
      if (trigger && !trigger.closest('[hidden], [inert]')) trigger.focus()
    }, 0)
  }, [location.pathname, navigate, home])

  useEffect(() => closeDrawer, [location.key, closeDrawer])

  useEffect(() => {
    const desktopViewport = window.matchMedia?.('(min-width: 721px)')
    if (!desktopViewport) return

    const handleViewportChange = (event: MediaQueryListEvent) => {
      if (event.matches) closeDrawer()
    }
    desktopViewport.addEventListener('change', handleViewportChange)
    return () => desktopViewport.removeEventListener('change', handleViewportChange)
  }, [closeDrawer])

  useEffect(() => {
    if (isSuspended) return
    if (isDrawerOpen) {
      wasDrawerOpen.current = true
    } else if (wasDrawerOpen.current) {
      const isDesktop = window.matchMedia?.('(min-width: 721px)').matches ?? window.innerWidth > 720
      if (isDesktop) mainContentRef.current?.focus()
      else menuButtonRef.current?.focus()
      wasDrawerOpen.current = false
    }
  }, [isDrawerOpen, isSuspended])

  return (
    <div
      className={`student-shell${student ? ' student-shell--student' : ''}${isCollapsed ? ' sidebar-collapsed' : ''}`}
    >
      <aside className="desktop-sidebar" aria-label="Боковая панель">
        <Link className="sidebar-brand-link" to={home} aria-label="РГУЧВ — кабинет">
          <UniversityBrand compact={isCollapsed} />
        </Link>
        <Navigation />
        <button
          className="sidebar-collapse"
          onClick={() => setIsCollapsed((collapsed) => !collapsed)}
          aria-label={isCollapsed ? 'Развернуть меню' : 'Свернуть меню'}
          aria-expanded={!isCollapsed}
        >
          <Icon name={isCollapsed ? 'right' : 'left'} />
          <span className="navigation-label">Свернуть меню</span>
        </button>
      </aside>

      <div className="student-main-column">
        <div className="ambient-canvas" aria-hidden="true">
          <span className="ambient-orbit" />
        </div>
        <header className="student-topbar">
          <button
            ref={menuButtonRef}
            className="icon-button mobile-menu-trigger"
            aria-label="Открыть меню"
            aria-expanded={isDrawerOpen}
            onClick={() => setIsDrawerOpen(true)}
          >
            <Icon name="menu" />
          </button>
          <span className="topbar-prototype-note" data-testid="prototype-disclaimer">
            Конкурсный прототип
            <br />
            Неофициальный сервис
          </span>
          <span className="topbar-spacer" />
          {
            <button
              ref={notificationTriggerRef}
              className="notification-link"
              type="button"
              aria-label="Уведомления"
              aria-expanded={showNotifications}
              aria-controls="notification-drawer-title"
              onClick={openNotifications}
            >
              <svg
                aria-hidden="true"
                className="notification-icon"
                viewBox="0 0 24 24"
                fill="none"
                focusable="false"
              >
                <path
                  d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span
                className="notification-count"
                role="status"
                aria-label={
                  unreadCount !== undefined
                    ? `Непрочитанных: ${unreadCount}`
                    : count.isError
                      ? 'Не удалось загрузить счётчик уведомлений'
                      : 'Обновляем счётчик уведомлений'
                }
              >
                {unreadCount !== undefined
                  ? unreadCount > 0
                    ? unreadCount
                    : null
                  : count.isError
                    ? '!'
                    : '…'}
              </span>
              <span className="notification-label" aria-hidden="true">
                Уведомления
              </span>
            </button>
          }
          <UserMenu student={student} exitStatus={exitStatus} />
        </header>
        <main className="student-content" id="main-content" ref={mainContentRef} tabIndex={-1}>
          {children !== undefined ? (
            student ? (
              <UnsavedChangesProvider value={{ status: exitStatus, setStatus: setExitStatus }}>
                {children}
              </UnsavedChangesProvider>
            ) : (
              children
            )
          ) : (
            <UnsavedChangesProvider value={{ status: exitStatus, setStatus: setExitStatus }}>
              <Outlet />
            </UnsavedChangesProvider>
          )}
          {!(student && location.pathname === '/schedule') && (
            <footer className="mvp2-screen-footer">
              Uni Space · Конкурсный прототип · Неофициальный сервис
            </footer>
          )}
        </main>
      </div>
      <MobileDrawer isOpen={isDrawerOpen} onClose={closeDrawer} />
      <NotificationsDrawer
        isOpen={showNotifications}
        onClose={closeNotifications}
        unreadCount={unreadCount}
        onRefreshCount={refreshCount}
        onNavigate={navigateFromNotification}
      />
    </div>
  )
}
