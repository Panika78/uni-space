import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../shared/api/client'

type Notification = { id: string; type: string; title: string; body: string; created_at: string }
type Page = { items: Notification[]; next_cursor: string | null }

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

export function NotificationsDrawer({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const requestRef = useRef<AbortController | null>(null)
  const [items, setItems] = useState<Notification[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [error, setError] = useState(false)
  const [moreError, setMoreError] = useState(false)

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
        panelRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      )
      const first = focusable[0]
      const last = focusable.at(-1)
      if (!first || !last) {
        event.preventDefault()
        panelRef.current?.focus()
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
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

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
      setIsLoading(false)
      setIsLoadingMore(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => {
      window.clearTimeout(timer)
      requestRef.current?.abort()
    }
  }, [load])

  return (
    <div className="notification-drawer-layer">
      <button
        className="notification-backdrop"
        aria-label="Закрыть уведомления"
        onClick={onClose}
      />
      <aside
        ref={panelRef}
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
    </div>
  )
}
