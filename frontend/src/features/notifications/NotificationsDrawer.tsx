import { useAccessSuspended } from '../../shared/ui/AccessRecovery'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ApiClientError, apiFetch } from '../../shared/api/client'
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

function NotificationRow({
  item,
  busy,
  message,
  onRead,
  onOpen,
}: {
  item: Notification
  busy: boolean
  message?: string
  onRead: () => void
  onOpen: () => void
}) {
  const hasTarget =
    !!item.entity_id &&
    /^[1-9]\d*$/.test(item.entity_id) &&
    ['application', 'course_offering', 'lesson'].includes(item.entity_type ?? '')
  const hasInvalidTarget = !hasTarget && (item.entity_type != null || item.entity_id != null)
  const date = new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Moscow',
  }).format(new Date(item.created_at))
  return (
    <article className={`notification-item${item.read_at === null ? ' is-unread' : ''}`}>
      <p className="notification-item__type">{labels[item.type] ?? 'Уведомление'}</p>
      <h3>{item.title}</h3>
      <p className="notification-item__body">{item.body}</p>
      <time dateTime={item.created_at}>{date}</time>
      {item.read_at === null && <p className="notification-read-status">Не прочитано</p>}
      <div className="notification-actions">
        {hasTarget && (
          <button type="button" disabled={busy} onClick={onOpen}>
            Открыть объект
          </button>
        )}
        {item.read_at === null && (
          <button type="button" disabled={busy} onClick={onRead}>
            Отметить прочитанным
          </button>
        )}
      </div>
      {hasInvalidTarget && !message && <p>Объект недоступен</p>}
      {message && <p role="alert">{message}</p>}
    </article>
  )
}

export function NotificationsDrawer({
  onClose,
  isOpen: requestedOpen = true,
  unreadCount,
  onRefreshCount,
  onNavigate,
}: {
  onClose: () => void
  isOpen?: boolean
  unreadCount?: number
  onRefreshCount?: () => void
  onNavigate?: (path: string) => void
}) {
  const isSuspended = useAccessSuspended()
  const isOpen = requestedOpen && !isSuspended
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
  const [busy, setBusy] = useState<string | null>(null)
  const [messages, setMessages] = useState<Record<string, string>>({})
  const operationRef = useRef<AbortController | null>(null)
  const activeRef = useRef(isOpen)
  useLayoutEffect(() => {
    activeRef.current = isOpen
    if (!isOpen) operationRef.current?.abort()
    return () => {
      activeRef.current = false
      operationRef.current?.abort()
      requestRef.current?.abort()
    }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) operationRef.current?.abort()
    return () => operationRef.current?.abort()
  }, [isOpen])

  async function readNotification(item: Notification, openTarget = false) {
    if (operationRef.current && !operationRef.current.signal.aborted) return
    const controller = new AbortController()
    operationRef.current = controller
    setBusy(item.id)
    setMessages({})
    const current = () =>
      !controller.signal.aborted && activeRef.current && operationRef.current === controller
    try {
      let path: string | undefined
      if (openTarget) {
        const target = await apiFetch<components['schemas']['NotificationTargetResponse']>(
          `/api/v1/notifications/${item.id}/target`,
          {
            authenticated: true,
            signal: controller.signal,
          },
        )
        if (!current()) return
        // Defense in depth: only the contracted internal router destinations.
        if (
          !/^\/(?:applications\/[1-9]\d*|staff\/applications\/[1-9]\d*|academics\/courses\/[1-9]\d*|schedule\?date=\d{4}-\d{2}-\d{2}&mode=day&lesson_id=[1-9]\d*)$/.test(
            target.path,
          )
        )
          throw new ApiClientError('Объект недоступен', 'invalid_target', 404)
        path = target.path
      }
      const result = await apiFetch<components['schemas']['NotificationReadResponse']>(
        `/api/v1/notifications/${item.id}/read`,
        { method: 'PATCH', authenticated: true, signal: controller.signal },
      )
      if (!current()) return
      setItems((previous) =>
        previous.map((row) => (row.id === result.id ? { ...row, read_at: result.read_at } : row)),
      )
      onRefreshCount?.()
      if (path) onNavigate?.(path)
    } catch (cause) {
      if (!current()) return
      setMessages({
        [item.id]:
          cause instanceof ApiClientError && [403, 404].includes(cause.status ?? 0)
            ? 'Объект недоступен'
            : 'Не удалось выполнить действие. Повторите попытку.',
      })
      onRefreshCount?.()
    } finally {
      if (operationRef.current === controller) {
        operationRef.current = null
        setBusy(null)
      }
    }
  }

  async function readAll() {
    if (operationRef.current && !operationRef.current.signal.aborted) return
    const controller = new AbortController()
    operationRef.current = controller
    setBusy('all')
    setMessages({})
    try {
      await apiFetch<components['schemas']['NotificationsReadResponse']>(
        '/api/v1/notifications/read-all',
        {
          method: 'POST',
          authenticated: true,
          signal: controller.signal,
        },
      )
      if (controller.signal.aborted || !activeRef.current) return
      onRefreshCount?.()
      // Reload server timestamps; read-all intentionally does not return them.
      await load()
    } catch {
      if (!controller.signal.aborted && activeRef.current) {
        setMessages({ all: 'Не удалось подтвердить прочтение. Повторите попытку.' })
        onRefreshCount?.()
      }
    } finally {
      if (operationRef.current === controller) {
        operationRef.current = null
        setBusy(null)
      }
    }
  }

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
      setMessages({})
      setBusy(null)
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
      hidden={isSuspended}
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
          {((unreadCount !== undefined && unreadCount > 0) || messages.all) && (
            <button
              className="notification-more"
              type="button"
              disabled={busy !== null}
              onClick={() => void readAll()}
            >
              Отметить все прочитанными
            </button>
          )}
          {messages.all && <p role="alert">{messages.all}</p>}
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
            <NotificationRow
              key={item.id}
              item={item}
              busy={busy !== null}
              message={messages[item.id]}
              onRead={() => void readNotification(item)}
              onOpen={() => void readNotification(item, true)}
            />
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
