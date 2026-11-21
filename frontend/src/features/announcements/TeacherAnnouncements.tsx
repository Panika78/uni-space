import { useState, useRef, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { apiFetch, isDefinitiveApiRejection } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'
import {
  AnnouncementFeed,
  announcementKeys,
  useAnnouncements,
  type Announcement,
  type AnnouncementScope,
} from './AnnouncementFeed'

type Draft = components['schemas']['TeacherAnnouncementCreate']
type Attempt = { draft: Draft; key: string }

const publicationTimeoutMs = 15_000

type JournalContext = { userId: string; courseId: string; groupId: string; expanded?: boolean }

export function TeacherAnnouncements({ expanded = false, ...context }: JournalContext) {
  const [hasOpened, setHasOpened] = useState(false)
  if (expanded)
    return (
      <section className="journal-announcements journal-announcements--workspace">
        <h2>Опубликовать объявление</h2>
        <TeacherAnnouncementPanel {...context} />
      </section>
    )
  return (
    <details
      className="journal-announcements"
      onToggle={(event) => {
        if (event.currentTarget.open) setHasOpened(true)
      }}
    >
      <summary>Объявления</summary>
      {hasOpened && <TeacherAnnouncementPanel {...context} />}
    </details>
  )
}

function TeacherAnnouncementPanel({ userId, courseId, groupId }: JournalContext) {
  const scope: AnnouncementScope = { role: 'teacher', userId, courseId, groupId }
  const feed = useAnnouncements(scope)
  const client = useQueryClient()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [important, setImportant] = useState(false)
  const [allGroups, setAllGroups] = useState(false)
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState<Attempt>()
  const [status, setStatus] = useState('')
  const locked = useRef(false)
  const canPublish = feed.isSuccess
  const canPublishToAll = canPublish && feed.data.pages[0]?.canPublishToAll === true

  function confirmPublication() {
    setTitle('')
    setBody('')
    setImportant(false)
    setAllGroups(false)
    setAttempt(undefined)
    setStatus('Объявление опубликовано.')
    void client.invalidateQueries({ queryKey: announcementKeys(scope) })
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (locked.current || attempt || !canPublish || (allGroups && !canPublishToAll)) return
    const draft = {
      group_id: allGroups ? null : groupId,
      title: title.trim(),
      body,
      is_important: important,
    }
    if (!draft.title || [...draft.title].length > 200 || !body.trim() || [...body].length > 20000) {
      setStatus('Введите заголовок до 200 символов и текст до 20 000 символов.')
      return
    }
    await publish({ draft, key: crypto.randomUUID() })
  }

  async function publish(operation: Attempt) {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setStatus('')
    try {
      const published = await apiFetch<Announcement>(
        `/api/v1/teaching/courses/${courseId}/announcements`,
        {
          method: 'POST',
          authenticated: true,
          headers: { 'Idempotency-Key': operation.key },
          signal: AbortSignal.timeout(publicationTimeoutMs),
          body: JSON.stringify(operation.draft),
        },
      )
      if (
        !published?.id ||
        published.course_offering_id !== courseId ||
        published.group_id !== operation.draft.group_id
      ) {
        throw new Error('Unexpected publication response')
      }
      confirmPublication()
    } catch (error) {
      if (isDefinitiveApiRejection(error)) {
        setAttempt(undefined)
        setStatus(
          error.status === 422
            ? 'Сервер отклонил данные. Проверьте форму.'
            : 'Публикация недоступна. Проверьте назначение.',
        )
        void feed.refetch()
      } else {
        setAttempt(operation)
        setStatus('Результат публикации неизвестен. Повторите публикацию.')
      }
    } finally {
      locked.current = false
      setBusy(false)
    }
  }

  return (
    <>
      <form onSubmit={(event) => void handleSubmit(event)}>
        <fieldset disabled={busy || !!attempt}>
          <legend>Публикация объявления</legend>
          <label>
            Аудитория
            <select
              value={allGroups ? 'all' : 'group'}
              onChange={(event) => setAllGroups(event.target.value === 'all')}
            >
              <option value="group">Текущая группа</option>
              <option value="all" disabled={!canPublishToAll}>
                Все группы проведения
              </option>
            </select>
          </label>
          <label>
            Заголовок
            <input required value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            Текст объявления
            <textarea
              required
              rows={4}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
          <label className="announcement-check">
            <input
              type="checkbox"
              checked={important}
              onChange={(event) => setImportant(event.target.checked)}
            />
            Важное
          </label>
          <button type="submit" disabled={!canPublish || (allGroups && !canPublishToAll)}>
            {busy && !attempt ? 'Публикуем…' : 'Опубликовать'}
          </button>
        </fieldset>
        <p role="status">{status}</p>
        {attempt && (
          <button type="button" disabled={busy} onClick={() => void publish(attempt)}>
            Повторить публикацию
          </button>
        )}
      </form>
      <section className="announcement-feed-panel">
        <h2>Недавние объявления</h2>
        <AnnouncementFeed scope={scope} />
      </section>
    </>
  )
}
