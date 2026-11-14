import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { apiFetch } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'
import { useOverlayPresence } from '../../shared/ui/useOverlayPresence'

type Notification = components['schemas']['NotificationResponse']
type Page = components['schemas']['NotificationPage']

const labels: Record<string, string> = {
  schedule_changed: 'Изменение расписания',
  assessment_created: 'Новая работа',
  application_updated: 'Изменение заявления',
  document_ready: 'Документ готов',
}

function NotificationRow({ item }: { item: Notification }) {
  const date = new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Moscow',
  }).format(new Date(item.created_at))
  return (
    <article className="notification-item">
      <p className="notification-item__type">{labels[item.type] ?? 'Уведомление'}</p>
      <h3>{item.title}</h3>
      <p className="notification-item__body">{item.body}</p>
      <time dateTime={item.created_at}>{date}</time>
    </article>
  )
}

export function NotificationsDrawer({
  onClose,
  isOpen = true,
}: {
  onClose: () => void
  isOpen?: boolean
}) {
  const { present, rootRef } = useOverlayPresence(isOpen, 'right')
  const panelRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const lastFocusedRef = useRef<HTMLElement | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const [items, setItems] = useState<Notification[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [error, setError] = useState(false)
  const [moreError, setMoreError] = useState(false)

  useLayoutEffect(() => {
    if (!isOpen) return
    closeRef.current?.focus()
    const previousOverflow = document.body.style.overflow
    const root = document.getElementById('root')
    const wasRootInert = root?.inert ?? false
    if (root) root.inert = true
    document.body.style.overflow = 'hidden'
    const focusableElements = () =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => !element.closest('[hidden], [inert]'))
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
      if (event.key !== 'Tab') return
      const focusable = focusableElements()
      const first = focusable[0]
      const last = focusable.at(-1)
      const activeElement = document.activeElement as HTMLElement | null
      if (!first || !last) {
        event.preventDefault()
        panelRef.current?.focus()
      } else if (
        !panelRef.current?.contains(document.activeElement) ||
        !focusable.includes(activeElement as HTMLElement)
      ) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    const observer = new MutationObserver(() => {
      const lastFocused = lastFocusedRef.current
      if (lastFocused && (!lastFocused.isConnected || lastFocused.matches(':disabled'))) {
        closeRef.current?.focus()
      }
    })
    if (panelRef.current)
      observer.observe(panelRef.current, { subtree: true, childList: true, attributes: true })
    return () => {
      observer.disconnect()
      document.body.style.overflow = previousOverflow
      if (root) root.inert = wasRootInert
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose, isOpen])

  const load = useCallback(async (nextCursor?: string) => {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    if (nextCursor) setIsLoadingMore(true)
    else setIsLoading(true)
    setError(false)
    setMoreError(false)
    try {
      const query = new URLSearchParams({ limit: '20' })
      if (nextCursor) query.set('cursor', nextCursor)
      const page = await apiFetch<Page>(`/api/v1/notifications?${query}`, {
        authenticated: true,
        signal: controller.signal,
      })
      if (controller.signal.aborted || requestRef.current !== controller) return
      setItems((previous) =>
        nextCursor
          ? [
              ...previous,
              ...page.items.filter((item) => !previous.some((row) => row.id === item.id)),
            ]
          : page.items,
      )
      setCursor(page.next_cursor)
    } catch (cause) {
      if (
        controller.signal.aborted ||
        (cause instanceof DOMException && cause.name === 'AbortError')
      )
        return
      if (nextCursor) setMoreError(true)
      else setError(true)
    } finally {
      if (!controller.signal.aborted && requestRef.current === controller) {
        setIsLoading(false)
        setIsLoadingMore(false)
      }
    }
  }, [])

  useEffect(() => {
    if (!isOpen) return
    const timer = window.setTimeout(() => {
      setItems([])
      setCursor(null)
      void load()
    }, 0)
    return () => {
      window.clearTimeout(timer)
      requestRef.current?.abort()
    }
  }, [load, isOpen])

  if (!present) return null

  return createPortal(
    <div
      ref={rootRef}
      className="notification-drawer-layer"
      inert={!isOpen}
      aria-hidden={!isOpen || undefined}
    >
      <button
        className="notification-backdrop"
        aria-label="Закрыть уведомления"
        tabIndex={-1}
        onClick={onClose}
      />
      <aside
        data-motion-panel
        ref={panelRef}
        onFocusCapture={(event) => {
          lastFocusedRef.current = event.target as HTMLElement
        }}
        className="notification-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="notification-drawer-title"
        tabIndex={-1}
      >
        <header className="notification-drawer__header">
          <div>
            <p className="section-eyebrow">Личный центр</p>
            <h2 id="notification-drawer-title">Уведомления</h2>
          </div>
          <button
            ref={closeRef}
            className="icon-button"
            aria-label="Закрыть уведомления"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="notification-drawer__content" aria-live="polite">
          {isLoading && <p className="notification-message">Загружаем уведомления…</p>}
          {error && (
            <div className="notification-message" role="alert">
              <p>Не удалось загрузить уведомления.</p>
              <button type="button" onClick={() => void load()}>
                Повторить
              </button>
            </div>
          )}
          {!isLoading && !error && items.length === 0 && (
            <p className="notification-message">Пока нет уведомлений.</p>
          )}
          {items.map((item) => (
            <NotificationRow key={item.id} item={item} />
          ))}
          {moreError && (
            <p className="notification-message" role="alert">
              Не удалось загрузить следующую страницу.
            </p>
          )}
          {!isLoading && cursor && (
            <button
              className="notification-more"
              type="button"
              disabled={isLoadingMore}
              onClick={() => void load(cursor)}
            >
              {isLoadingMore ? 'Загружаем…' : moreError ? 'Повторить загрузку' : 'Показать ещё'}
            </button>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  )
}
