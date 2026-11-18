import { useEffect, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  apiFetch,
  apiFetchBlob,
  ApiClientError,
  isDefinitiveApiRejection,
} from '../../shared/api/client'
import { useAccessSuspended } from '../../shared/ui/AccessRecovery'
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/StatusStates'
import {
  applicationsApi,
  describeApplicationError,
  getDocumentLabel,
  formatApplicationDate,
  queuePath,
  reviewLabels,
} from './staffApplications'
import { useApplicationQueueSession } from './StaffApplicationQueue'
import type { HistoryPage, ReviewRequest, StaffApplication } from './staffApplications'

type ReviewAction = ReviewRequest['action']
type ConfirmedAction = Exclude<ReviewAction, 'start_review'>
const actionLabels: Record<ReviewAction, string> = {
  start_review: 'Принять в работу',
  approve: 'Завершить',
  reject: 'Отклонить',
  return_for_correction: 'Вернуть на доработку',
}
const formLabels: Record<string, string> = {
  place_of_submission: 'Место предъявления',
  academic_term_id: 'Идентификатор учебного периода',
  academic_term_name: 'Учебный период',
  starts_on: 'Дата начала',
  ends_on: 'Дата окончания',
  basis: 'Основание',
  explanation: 'Пояснение',
  purpose: 'Назначение справки',
}
const basisLabels: Record<string, string> = {
  medical: 'Медицинские показания',
  family: 'Семейные обстоятельства',
  other: 'Иное основание',
}

function getReviewActions(application: StaffApplication): ReviewAction[] {
  if (
    application.service.processing_mode !== 'manual' ||
    application.document_status === 'ready' ||
    ['study_certificate', 'academic_transcript'].includes(application.service.code)
  )
    return []
  switch (application.review_status) {
    case 'submitted':
    case 'resubmitted':
      return ['start_review']
    case 'in_review':
      return ['approve', 'reject', 'return_for_correction']
    default:
      return []
  }
}

function isAccessError(error: unknown) {
  return error instanceof ApiClientError && [401, 403, 404].includes(error.status ?? 0)
}

export function StaffApplicationDetail() {
  const { id } = useParams()
  const { scope } = useApplicationQueueSession()
  if (!id || !/^[1-9][0-9]{0,18}$/.test(id))
    return (
      <ErrorState title="Заявление недоступно" description="Проверьте номер заявления.">
        <Link to={queuePath}>К заявлениям</Link>
      </ErrorState>
    )
  return <ApplicationDetail key={`${scope}:${id}`} id={id} />
}

function ApplicationDetail({ id }: { id: string }) {
  const endpoint = `${applicationsApi}/${id}`
  const location = useLocation()
  const navigate = useNavigate()
  const suspended = useAccessSuspended()
  const { scope } = useApplicationQueueSession()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [dialog, setDialog] = useState<{ action: ConfirmedAction; version: number } | null>(null)
  const [fileError, setFileError] = useState('')
  const [fileLoading, setFileLoading] = useState(false)
  const activeMutation = useRef<AbortController | null>(null)
  const activeFile = useRef<AbortController | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const didFocus = useRef(false)
  const focusAfterMutation = useRef(false)
  const detail = useQuery({
    queryKey: ['staff-application', scope, id],
    queryFn: ({ signal }) => apiFetch<StaffApplication>(endpoint, { signal, authenticated: true }),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  })
  const history = useInfiniteQuery({
    queryKey: ['staff-application-history', scope, id],
    initialPageParam: '',
    queryFn: ({ signal, pageParam }) =>
      apiFetch<HistoryPage>(
        `${endpoint}/history${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`,
        { signal, authenticated: true },
      ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: detail.isSuccess,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  })

  useEffect(
    () => () => {
      activeMutation.current?.abort()
      const file = activeFile.current
      activeFile.current = null
      file?.abort()
    },
    [],
  )
  useEffect(() => {
    if (suspended || detail.isError || isAccessError(history.error)) activeFile.current?.abort()
  }, [suspended, detail.isError, history.error])
  useEffect(() => {
    if (
      (!didFocus.current || focusAfterMutation.current) &&
      !busy &&
      !suspended &&
      heading.current
    ) {
      heading.current.focus()
      didFocus.current = true
      focusAfterMutation.current = false
    }
  }, [busy, detail.isSuccess, detail.isError, history.isError, suspended])

  async function refreshApplication() {
    const current = await detail.refetch()
    if (!current.isSuccess) return false
    const events = await history.refetch()
    return events.isSuccess
  }

  async function handleRefresh() {
    if (await refreshApplication()) {
      setNeedsRefresh(false)
      setMessage('')
    }
  }

  async function handleMutation(path: 'review' | 'document/retry', body?: ReviewRequest) {
    if (busy || activeMutation.current || needsRefresh || suspended) return
    const request = new AbortController()
    activeMutation.current = request
    setBusy(true)
    setMessage('')
    setDialog(null)
    focusAfterMutation.current = true
    try {
      await apiFetch(`${endpoint}/${path}`, {
        method: 'POST',
        authenticated: true,
        replayAfterRefresh: false,
        signal: request.signal,
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      if (!request.signal.aborted) setNeedsRefresh(!(await refreshApplication()))
    } catch (error) {
      if (request.signal.aborted) return
      if (isDefinitiveApiRejection(error)) {
        setMessage(describeApplicationError(error))
        if (isAccessError(error)) setNeedsRefresh(!(await refreshApplication()))
        else if (error.status === 409) setNeedsRefresh(true)
      } else {
        const refreshed = await refreshApplication()
        if (request.signal.aborted) return
        setNeedsRefresh(!refreshed)
        setMessage(
          refreshed
            ? 'Ответ на действие не получен. Показано текущее состояние с сервера.'
            : 'Исход действия пока неизвестен. Обновите данные перед следующим действием.',
        )
      }
    } finally {
      if (!request.signal.aborted) {
        activeMutation.current = null
        setBusy(false)
      }
    }
  }

  async function handleFile(path: string, name: string, preview = false) {
    if (activeFile.current || suspended) return
    setFileError('')
    const previewTab = preview ? window.open('about:blank', '_blank') : null
    if (preview && !previewTab) {
      setFileError('Разрешите открытие новой вкладки или скачайте PDF.')
      return
    }
    if (previewTab) {
      previewTab.opener = null
      previewTab.document.title = 'Загрузка PDF'
    }
    const request = new AbortController()
    activeFile.current = request
    setFileLoading(true)
    function finishDownload() {
      if (activeFile.current === request) {
        activeFile.current = null
        setFileLoading(false)
      }
    }
    request.signal.addEventListener('abort', finishDownload, { once: true })
    try {
      const blob = await apiFetchBlob(path, {
        authenticated: true,
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]),
      })
      request.signal.throwIfAborted()
      if (
        path.endsWith('/document') &&
        (blob.type !== 'application/pdf' || (await blob.slice(0, 5).text()) !== '%PDF-')
      ) {
        throw new ApiClientError('Сервер вернул повреждённый PDF.', 'invalid_pdf')
      }
      request.signal.throwIfAborted()
      if (previewTab?.closed) return
      const url = URL.createObjectURL(blob)
      if (previewTab) {
        // Chromium hands a blob navigation to its PDF viewer asynchronously.
        try {
          previewTab.location.replace(url)
        } catch (error) {
          URL.revokeObjectURL(url)
          throw error
        }
        const timer = window.setInterval(() => {
          if (previewTab.closed) release()
        }, 1000)
        const deadline = window.setTimeout(release, 60_000)
        function release() {
          window.clearInterval(timer)
          window.clearTimeout(deadline)
          URL.revokeObjectURL(url)
        }
      } else {
        const link = document.createElement('a')
        link.href = url
        link.download = name
        document.body.append(link)
        link.click()
        link.remove()
        window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
    } catch (error) {
      previewTab?.close()
      if (request.signal.aborted) return
      setFileError(describeApplicationError(error))
      if (isAccessError(error)) void refreshApplication()
    } finally {
      request.signal.removeEventListener('abort', finishDownload)
      finishDownload()
    }
  }

  const application = detail.data
  const fileButtonsDisabled = fileLoading || suspended || needsRefresh
  const accessError = detail.error ?? (isAccessError(history.error) ? history.error : null)
  const status = accessError instanceof ApiClientError ? accessError.status : undefined
  const doc = application?.document
  const canRetry =
    application?.review_status === 'approved' &&
    application.service.produces_document &&
    ['pending', 'failed'].includes(application.document_status)
  const events = history.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <section className="section-page application-detail staff-applications">
      <Link
        to={{ pathname: queuePath, search: location.search }}
        state={{ searchKey: location.state?.searchKey }}
        onClick={(event) => {
          if (
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey ||
            !location.state?.fromQueue
          )
            return
          event.preventDefault()
          void navigate(-1)
        }}
      >
        К заявлениям
      </Link>
      {accessError ? (
        <ErrorState
          title="Не удалось открыть заявление"
          description={describeApplicationError(accessError)}
          onRetry={
            status === 401 || status === 403 || status === 404
              ? undefined
              : () => void handleRefresh()
          }
        />
      ) : !application ? (
        <LoadingState title="Загружаем заявление…" />
      ) : (
        <>
          <h1 ref={heading} tabIndex={-1}>
            Заявление № {id}
          </h1>
          <div className="application-detail-card">
            <h2>{application.service.title}</h2>
            <dl>
              <dt>Заявитель</dt>
              <dd>{application.applicant_display_name}</dd>
              <dt>Дата создания</dt>
              <dd>{formatApplicationDate(application.created_at, true)}</dd>
              <dt>Рассмотрение</dt>
              <dd>{reviewLabels[application.review_status]}</dd>
              <dt>Документ</dt>
              <dd>{getDocumentLabel(application)}</dd>
              {application.feedback && (
                <>
                  <dt>
                    {application.review_status === 'rejected'
                      ? 'Причина отказа'
                      : 'Причина возврата'}
                  </dt>
                  <dd>{application.feedback}</dd>
                </>
              )}
            </dl>
            {application.service.code === 'accounting_certificate' &&
              application.review_status === 'in_review' && (
                <p>PDF формируется после одобрения заявления.</p>
              )}
            <div className="staff-applications__actions">
              {getReviewActions(application).map((action) => (
                <button
                  className="ui-state__action"
                  type="button"
                  key={action}
                  disabled={busy || needsRefresh || detail.isFetching}
                  onClick={() =>
                    action === 'start_review'
                      ? void handleMutation('review', {
                          action,
                          expected_version: application.version,
                        })
                      : setDialog({ action, version: application.version })
                  }
                >
                  {actionLabels[action]}
                </button>
              ))}
              {canRetry && (
                <button
                  type="button"
                  className="ui-state__action"
                  disabled={busy || needsRefresh || detail.isFetching}
                  onClick={() => void handleMutation('document/retry')}
                >
                  Повторить выдачу PDF
                </button>
              )}
            </div>
            {busy && <LoadingState title="Проверяем результат…" variant="compact" />}
            {message && <p role="alert">{message}</p>}
            {needsRefresh && (
              <button
                type="button"
                className="ui-state__action"
                disabled={detail.isFetching || history.isFetching}
                onClick={() => void handleRefresh()}
              >
                Обновить данные
              </button>
            )}
          </div>
          <section className="application-detail-card">
            <h2>Данные заявления</h2>
            <dl>
              {Object.entries(application.form_data).map(([key, value]) => (
                <FormField key={key} name={key} value={value} />
              ))}
            </dl>
            <h2>Вложения</h2>
            {application.attachments?.length ? (
              <ul>
                {application.attachments.map((attachment) => (
                  <li key={attachment.id}>
                    <button
                      className="ui-state__action"
                      type="button"
                      disabled={fileButtonsDisabled}
                      onClick={() =>
                        void handleFile(
                          `${applicationsApi}/attachments/${attachment.id}/download`,
                          attachment.original_filename,
                        )
                      }
                    >
                      Скачать {attachment.original_filename}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>Вложений нет.</p>
            )}
            {application.review_status === 'approved' &&
              application.document_status === 'ready' &&
              doc && (
                <>
                  <h2>Выданный PDF</h2>
                  <p>
                    {doc.filename} · {formatApplicationDate(doc.issued_at, true)}
                  </p>
                  <div className="staff-applications__actions">
                    <button
                      type="button"
                      className="ui-state__action"
                      disabled={fileButtonsDisabled}
                      onClick={() => void handleFile(`${endpoint}/document`, doc.filename, true)}
                    >
                      Открыть PDF в новой вкладке
                    </button>
                    <button
                      type="button"
                      className="ui-state__action"
                      disabled={fileButtonsDisabled}
                      onClick={() => void handleFile(`${endpoint}/document`, doc.filename)}
                    >
                      Скачать PDF
                    </button>
                  </div>
                </>
              )}
            {fileLoading && <LoadingState title="Загружаем файл…" variant="compact" />}
            {fileError && <p role="alert">{fileError}</p>}
          </section>
          <section className="application-detail-card">
            <h2>История рассмотрения</h2>
            {history.isPending ? (
              <LoadingState title="Загружаем историю…" variant="compact" />
            ) : history.isError ? (
              <ErrorState
                title="Не удалось загрузить историю"
                description={describeApplicationError(history.error)}
                onRetry={() => void history.refetch()}
              />
            ) : events.length ? (
              <>
                <ol className="staff-applications__history">
                  {events.map((event) => (
                    <li key={event.id}>
                      <time dateTime={event.created_at}>
                        {formatApplicationDate(event.created_at, true)}
                      </time>
                      {' · '}
                      {event.from_status && `${reviewLabels[event.from_status]} → `}
                      {reviewLabels[event.to_status]}
                      {event.comment && (
                        <p className="staff-applications__reason">{event.comment}</p>
                      )}
                    </li>
                  ))}
                </ol>
                {history.hasNextPage && (
                  <button
                    type="button"
                    className="ui-state__action"
                    disabled={history.isFetching}
                    onClick={() => void history.fetchNextPage()}
                  >
                    Показать ещё события
                  </button>
                )}
              </>
            ) : (
              <EmptyState title="История пока пуста" />
            )}
          </section>
          {dialog && !suspended && (
            <ReviewDialog
              key={dialog.action}
              action={dialog.action}
              onClose={() => setDialog(null)}
              onConfirm={(comment) =>
                void handleMutation('review', {
                  action: dialog.action,
                  expected_version: dialog.version,
                  ...(comment ? { comment } : {}),
                })
              }
            />
          )}
        </>
      )}
    </section>
  )
}

function FormField({ name, value }: { name: string; value: unknown }) {
  return (
    <>
      <dt>{formLabels[name] ?? name}</dt>
      <dd>
        {value == null
          ? '—'
          : name === 'basis'
            ? (basisLabels[String(value)] ?? String(value))
            : String(value)}
      </dd>
    </>
  )
}

function ReviewDialog({
  action,
  onClose,
  onConfirm,
}: {
  action: ConfirmedAction
  onClose: () => void
  onConfirm: (comment: string) => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const dialog = ref.current
    const opener = document.activeElement
    dialog?.showModal()
    return () => {
      if (dialog?.open) dialog.close()
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])
  return (
    <dialog
      ref={ref}
      className="staff-applications__dialog"
      aria-labelledby="review-action-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <h2 id="review-action-title">{actionLabels[action]}</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const comment = String(new FormData(event.currentTarget).get('comment') ?? '').trim()
          if (action !== 'approve' && !comment) {
            setError('Укажите причину.')
            event.currentTarget.querySelector('textarea')?.focus()
            return
          }
          onConfirm(comment)
        }}
      >
        {action === 'approve' ? (
          <p>Одобрить заявление?</p>
        ) : (
          <>
            <label htmlFor="review-comment">Причина</label>
            <textarea
              id="review-comment"
              name="comment"
              maxLength={3000}
              rows={4}
              aria-required="true"
              aria-invalid={!!error}
              aria-describedby={error ? 'review-comment-error' : undefined}
            />
            {error && (
              <p id="review-comment-error" role="alert">
                {error}
              </p>
            )}
          </>
        )}
        <div className="staff-applications__actions">
          <button className="ui-state__action" type="button" onClick={onClose}>
            Отмена
          </button>
          <button className="auth-submit" type="submit">
            {actionLabels[action]}
          </button>
        </div>
      </form>
    </dialog>
  )
}
