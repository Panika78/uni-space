import { useCallback, useEffect, useRef, useState } from 'react'
import type { FocusEvent } from 'react'
import { Link, NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../features/auth/AuthProvider'
import { UnsavedChangesProvider, type ExitProtectionStatus } from './UnsavedChangesContext'
import { UnavailableState } from '../shared/ui/StatusStates'
import { UniversityBrand } from '../shared/ui/UniversityBrand'

const navigation = [
  { to: '/schedule', label: 'Расписание', icon: '▦' },
  { to: '/academics', label: 'Успеваемость', icon: '▤' },
  { to: '/services', label: 'Услуги и документы', icon: '▧' },
  { to: '/news', label: 'Новости', icon: '▣' },
]

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="student-navigation" aria-label="Разделы кабинета">
      {navigation.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          onClick={onNavigate}
          className={({ isActive }) => `student-navigation__link${isActive ? ' is-active' : ''}`}
          end
          title={item.label}
        >
          <span className="navigation-icon" aria-hidden="true">
            {item.icon}
          </span>
          <span className="navigation-label">{item.label}</span>
        </NavLink>
      ))}
    </nav>
  )
}

function UserMenu({ exitStatus }: { exitStatus: ExitProtectionStatus }) {
  const { logout } = useAuth()
  const [isOpen, setIsOpen] = useState(false)
  const [confirmLogout, setConfirmLogout] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const confirmingRef = useRef(false)

  useEffect(() => {
    if (!confirmLogout) return
    const dialog = dialogRef.current
    dialog?.showModal()
    cancelRef.current?.focus()
    return () => {
      if (dialog?.open) dialog.close()
    }
  }, [confirmLogout])

  const closeConfirmation = () => {
    if (confirmingRef.current) return
    dialogRef.current?.close()
    setConfirmLogout(false)
    triggerRef.current?.focus()
  }

  useEffect(() => {
    if (!isOpen) return
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
  }, [isOpen])

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && containerRef.current?.contains(nextTarget)) return
    setIsOpen(false)
  }

  return (
    <div className="user-menu" ref={containerRef} onBlur={handleBlur}>
      <button
        ref={triggerRef}
        className="avatar-button"
        aria-label="Меню пользователя"
        aria-expanded={isOpen}
        aria-controls="user-menu-panel"
        onClick={() => setIsOpen((open) => !open)}
      >
        <span aria-hidden="true">С</span>
      </button>
      {isOpen && (
        <div className="user-menu__panel" id="user-menu-panel">
          <Link to="/profile" onClick={() => setIsOpen(false)}>
            Мой профиль <span>Скоро</span>
          </Link>
          <Link to="/settings" onClick={() => setIsOpen(false)}>
            Настройки <span>Скоро</span>
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

function MobileDrawer({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
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
      if (event.shiftKey && document.activeElement === first) {
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
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  return (
    <div className="mobile-drawer-layer">
      <button className="drawer-backdrop" aria-label="Закрыть меню" onClick={onClose} />
      <aside
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

export function StudentLayout() {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [exitStatus, setExitStatus] = useState<ExitProtectionStatus>('none')
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const mainContentRef = useRef<HTMLElement>(null)
  const wasDrawerOpen = useRef(false)
  const closeDrawer = useCallback(() => setIsDrawerOpen(false), [])

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
    if (isDrawerOpen) {
      wasDrawerOpen.current = true
    } else if (wasDrawerOpen.current) {
      const isDesktop = window.matchMedia?.('(min-width: 721px)').matches ?? window.innerWidth > 720
      if (isDesktop) mainContentRef.current?.focus()
      else menuButtonRef.current?.focus()
      wasDrawerOpen.current = false
    }
  }, [isDrawerOpen])

  return (
    <div className={`student-shell${isCollapsed ? ' sidebar-collapsed' : ''}`}>
      <aside className="desktop-sidebar" aria-label="Боковая панель">
        <Link className="sidebar-brand-link" to="/schedule" aria-label="РГУЧВ — расписание">
          <UniversityBrand compact={isCollapsed} />
        </Link>
        <Navigation />
        <button
          className="sidebar-collapse"
          onClick={() => setIsCollapsed((collapsed) => !collapsed)}
          aria-label={isCollapsed ? 'Развернуть меню' : 'Свернуть меню'}
          aria-expanded={!isCollapsed}
        >
          <span aria-hidden="true">{isCollapsed ? '»' : '«'}</span>
          <span className="navigation-label">Свернуть меню</span>
        </button>
      </aside>

      <div className="student-main-column">
        <header className="student-topbar">
          <button
            ref={menuButtonRef}
            className="icon-button mobile-menu-trigger"
            aria-label="Открыть меню"
            aria-expanded={isDrawerOpen}
            onClick={() => setIsDrawerOpen(true)}
          >
            <span aria-hidden="true">☰</span>
          </button>
          <span className="topbar-spacer" />
          <span className="topbar-prototype-note" data-testid="prototype-disclaimer">
            Конкурсный прототип
            <br />
            Неофициальный сервис
          </span>
          <Link
            className="notification-link"
            to="/notifications"
            aria-label="Уведомления — функция пока недоступна"
            title="Уведомления — функция пока недоступна"
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
            <span className="notification-label" aria-hidden="true">
              Уведомления
            </span>
          </Link>
          <UserMenu exitStatus={exitStatus} />
        </header>
        <main className="student-content" id="main-content" ref={mainContentRef} tabIndex={-1}>
          <UnsavedChangesProvider value={{ status: exitStatus, setStatus: setExitStatus }}>
            <Outlet />
          </UnsavedChangesProvider>
        </main>
      </div>
      {isDrawerOpen && <MobileDrawer onClose={closeDrawer} />}
    </div>
  )
}

export function UnavailableSection({ title }: { title: string }) {
  return (
    <section className="section-page" aria-labelledby="section-title">
      <p className="section-eyebrow">Студенческий кабинет</p>
      <h1 id="section-title">{title}</h1>
      <UnavailableState
        title="Функция пока недоступна"
        description="Содержимое этого раздела появится в следующих задачах."
      />
    </section>
  )
}
