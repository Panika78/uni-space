import { useAccessSuspended } from '../../shared/ui/AccessRecovery'
import {
  type InfiniteData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { apiFetch, apiFetchBlob, ApiClientError } from '../../shared/api/client'
import { AdditionalApplicationForm, formatRussianDate } from './AdditionalApplicationForm'
import {
  applicationDetailKey,
  applicationHistoryKey,
  applicationPath,
  applicationsKey,
  getApplicationHistory,
  isApplicationAccessError,
  type Application,
} from './applicationQueries'
import type { components } from '../../shared/api/schema'
import { Icon } from '../../shared/ui/Icon'
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/StatusStates'

type Page = components['schemas']['ApplicationPage']
type ReturnFocus = { id: string }
const returnFocusKey = [...applicationsKey, 'return-focus'] as const
const reviewLabels: Record<Application['review_status'], string> = {
  submitted: 'Подано',
  in_review: 'На рассмотрении',
  needs_correction: 'Требуется доработка',
  resubmitted: 'Подано повторно',
  approved: 'Одобрено',
  rejected: 'Отклонено',
}
const documentLabels: Record<Application['document_status'], string> = {
  not_required: 'Не требуется',
  pending: 'Ожидает подготовки',
  ready: 'Готов',
  failed: 'Ошибка подготовки',
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Moscow',
  }).format(new Date(value))
}
export function ServicesTabs({ applications = false }: { applications?: boolean }) {
  return (
    <nav
      className="services-tabs"
      data-selected={applications ? 'applications' : 'catalog'}
      aria-label="Разделы услуг"
    >
      <Link to="/services" aria-current={!applications ? 'page' : undefined}>
        Каталог услуг
      </Link>
      <Link to="/services?tab=applications" aria-current={applications ? 'page' : undefined}>
        Мои заявления
      </Link>
    </nav>
  )
}
export function ApplicationsList() {
  const isSuspended = useAccessSuspended()
  const queryClient = useQueryClient()
  const location = useLocation()
  const heading = useRef<HTMLHeadingElement>(null)
  const table = useRef<HTMLTableElement>(null)
  const tableId = useId()
  // The private return target is cleared with applications on POST/auth changes.
  // Keep it separate so recording focus cannot change a failed list's API state.
  const restoredLink = useRef<HTMLAnchorElement | null>(null)
  const query = useInfiniteQuery({
    queryKey: applicationsKey,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ limit: '20' })
      if (pageParam) params.set('cursor', pageParam)
      return apiFetch<Page>(`/api/v1/applications?${params}`, { authenticated: true, signal })
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    // InfiniteQuery refreshes all loaded pages sequentially, taking each next
    // cursor from the newly fetched page rather than from the old snapshot.
    staleTime: 0,
    refetchOnMount: 'always',
    retryOnMount: true,
    gcTime: Infinity,
  })
  const denied = isApplicationAccessError(query.error) ? query.error : null
  const isDenied = denied !== null
  const items = isDenied ? [] : (query.data?.pages.flatMap((page) => page.items) ?? [])
  // A failed refresh leaves the old snapshot/cursors intact. Only a complete
  // refetch can make that snapshot eligible for further pagination again.
  const canLoadMore = !isDenied && query.hasNextPage && !query.isFetching && !query.isRefetchError
  function handleLoadMore() {
    if (!canLoadMore) return
    void query.fetchNextPage({ cancelRefetch: false })
  }
  function handleRetry() {
    if (isDenied || query.isFetching) return
    if (query.isFetchNextPageError) handleLoadMore()
    else void query.refetch({ cancelRefetch: false })
  }
  useEffect(() => {
    if (isSuspended) return
    const target = queryClient.getQueryData<ReturnFocus>(returnFocusKey)
    if (!target) return
    const link = Array.from(
      table.current?.querySelectorAll<HTMLAnchorElement>('a[data-application-id]') ?? [],
    ).find((link) => link.dataset.applicationId === target.id)
    // History navigation can reset focus to BODY after React commits the list.
    // Wait through that browser restoration, then repair focus only if it was lost.
    let secondFrame = 0
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const focusWasLost = document.activeElement === document.body
        if (link) {
          if (!restoredLink.current || focusWasLost) {
            link.focus({ preventScroll: true })
            restoredLink.current = link
          }
        } else if (!query.isFetching) {
          const shouldFocusHeading = !restoredLink.current || focusWasLost
          if (shouldFocusHeading) heading.current?.focus({ preventScroll: true })
        }
        if (!query.isFetching) {
          queryClient.removeQueries({ queryKey: returnFocusKey, exact: true })
        }
      })
    })
    return () => {
      window.cancelAnimationFrame(firstFrame)
      if (secondFrame) window.cancelAnimationFrame(secondFrame)
    }
  }, [location.key, query.data, query.isFetching, isDenied, queryClient, isSuspended])
  useEffect(() => {
    // Discard only this forbidden snapshot, retaining the 403 error state.
    // A later 500 (including after remount) must not reveal the old rows again.
    if (isDenied)
      queryClient
        .getQueryCache()
        .find({ queryKey: applicationsKey, exact: true })
        ?.setState({ data: undefined, dataUpdatedAt: 0 })
    if (
      isDenied &&
      !isSuspended &&
      (document.activeElement === document.body ||
        heading.current?.parentElement?.contains(document.activeElement))
    )
      heading.current?.focus({ preventScroll: true })
  }, [isDenied, queryClient, isSuspended])
  return (
    <div>
      <h2 className="applications-list-heading" ref={heading} tabIndex={-1}>
        Мои заявления
      </h2>
      {query.isPending && <LoadingState title="Загружаем заявления…" />}
      {!isDenied && query.isRefetching && (
        <p role="status" className="sr-only">
          Обновляем заявления…
        </p>
      )}
      {isDenied ? (
        <ErrorState
          title={
            denied?.status === 403
              ? 'Доступ к заявлениям запрещён'
              : getAccessErrorTitle(query.error)
          }
          description={
            denied?.status === 401
              ? 'Войдите в систему заново.'
              : 'У вас нет доступа к списку заявлений.'
          }
        />
      ) : (
        query.isError && (
          <ErrorState
            title={
              query.isFetchNextPageError
                ? 'Не удалось загрузить следующую страницу'
                : 'Не удалось загрузить заявления'
            }
            description={
              query.isFetchNextPageError
                ? 'Ранее загруженные заявления сохранены. Их данные могут быть неактуальны; повторите загрузку следующей страницы.'
                : query.data
                  ? 'Показаны ранее загруженные заявления. Их данные могут быть неактуальны; повторите загрузку.'
                  : 'Проверьте соединение и повторите попытку.'
            }
            onRetry={handleRetry}
          />
        )
      )}
      {query.isSuccess && items.length === 0 && (
        <div className="applications-empty">
          <EmptyState
            icon={<Icon name="file" />}
            title="Вы ещё не подавали заявлений"
            description="Выберите услугу в каталоге и отправьте заявление онлайн. Здесь появится его статус."
          />
          <Link className="service-action" to="/services">
            Перейти в каталог услуг
          </Link>
        </div>
      )}
      {items.length > 0 && (
        <table
          ref={table}
          className="applications-table"
          role="table"
          aria-busy={query.isRefetching}
        >
          <caption className="sr-only">Ранее отправленные заявления</caption>
          <thead role="rowgroup">
            <tr role="row">
              <th id={`${tableId}-application`} scope="col">
                Заявление
              </th>
              <th id={`${tableId}-date`} scope="col">
                Дата подачи
              </th>
              <th id={`${tableId}-review`} scope="col">
                Рассмотрение
              </th>
              <th id={`${tableId}-document`} scope="col">
                Документ
              </th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {items.map((item) => (
              <tr key={item.id} role="row">
                <td role="cell" headers={`${tableId}-application`}>
                  <Link
                    data-application-id={item.id}
                    to={`/applications/${item.id}`}
                    state={{ fromApplications: true }}
                    onClick={(event) => {
                      if (
                        event.button !== 0 ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey
                      )
                        return
                      queryClient.setQueryDefaults(returnFocusKey, { gcTime: Infinity })
                      queryClient.setQueryData<ReturnFocus>(returnFocusKey, {
                        id: item.id,
                      })
                    }}
                  >
                    <span className="service-icon-small" aria-hidden="true">
                      <Icon name="file" />
                    </span>
                    <span>
                      {item.service.title} · № {item.id}
                    </span>
                    <span className="application-row-arrow" aria-hidden="true">
                      <Icon name="right" />
                    </span>
                  </Link>
                </td>
                <td role="cell" headers={`${tableId}-date`}>
                  <span className="application-field-label" aria-hidden="true">
                    Дата подачи
                  </span>
                  <time dateTime={item.created_at}>{formatDate(item.created_at)}</time>
                </td>
                <td role="cell" headers={`${tableId}-review`}>
                  <span className="application-field-label" aria-hidden="true">
                    Рассмотрение
                  </span>
                  <span className={`application-status application-status--${item.review_status}`}>
                    {reviewLabels[item.review_status]}
                  </span>
                </td>
                <td role="cell" headers={`${tableId}-document`}>
                  <span className="application-field-label" aria-hidden="true">
                    Документ
                  </span>
                  {item.document_status === 'ready' ? 'PDF выдан' : getDocumentStatus(item)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!isDenied && query.hasNextPage && (
        <button className="service-action" disabled={!canLoadMore} onClick={handleLoadMore}>
          {query.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё'}
        </button>
      )}
      {!isDenied && (
        <p role="status" className="sr-only">
          Загружено заявлений: {items.length}
        </p>
      )}
    </div>
  )
}
function getDocumentStatus(item: Application) {
  if (item.review_status === 'rejected' && item.document_status === 'pending') return 'Не выдан'
  return documentLabels[item.document_status]
}

function getAccessErrorTitle(cause: unknown) {
  if (!(cause instanceof ApiClientError)) return 'Не удалось открыть заявление'
  if (cause.status === 401) return 'Сеанс завершён'
  if (cause.status === 403) return 'Доступ к заявлению запрещён'
  if (cause.status === 404) return 'Заявление не найдено'
  if (cause.status === 503) return 'Сервис временно недоступен'
  return 'Не удалось открыть заявление'
}

function getFormValue(key: string, value: unknown) {
  if (value == null || value === '') return '—'
  if (typeof value !== 'string') return String(value)
  if (key === 'starts_on' || key === 'ends_on') return formatRussianDate(value) || value
  if (key === 'basis') {
    const labels: Record<string, string> = {
      medical: 'Медицинское',
      family: 'Семейные обстоятельства',
      other: 'Иное',
    }
    return labels[value] ?? value
  }
  return value
}

export function ApplicationDetailPage() {
  const { id = '' } = useParams()
  return <ApplicationDetail key={id} id={id} />
}

function ApplicationDetail({ id }: { id: string }) {
  const isSuspended = useAccessSuspended()
  const location = useLocation()
  const navigate = useNavigate()
  const client = useQueryClient()
  const title = useRef<HTMLHeadingElement>(null)
  const editButton = useRef<HTMLButtonElement>(null)
  const confirmationMessage = useRef<HTMLParagraphElement>(null)
  const [editing, setEditing] = useState(false)
  const [confirmation, setConfirmation] = useState<{
    id: string
    version: number
    filesUnverified?: boolean
  } | null>(null)
  const [actionAccessError, setActionAccessError] = useState<ApiClientError | null>(null)
  const [fileError, setFileError] = useState('')
  const [needsDocumentRefresh, setNeedsDocumentRefresh] = useState(false)
  const [busyFile, setBusyFile] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const path = applicationPath(id)
  const query = useQuery({
    queryKey: applicationDetailKey(id),
    queryFn: ({ signal }) => apiFetch<Application>(path, { authenticated: true, signal }),
    refetchOnMount: 'always',
  })
  const history = useInfiniteQuery({
    queryKey: applicationHistoryKey(id),
    queryFn: ({ pageParam, signal }) => getApplicationHistory(id, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: query.isSuccess && !actionAccessError,
    refetchOnMount: 'always',
  })
  const accessError =
    actionAccessError ??
    (isApplicationAccessError(query.error) ? query.error : null) ??
    (isApplicationAccessError(history.error) ? history.error : null)
  const item = !accessError && (query.isSuccess || editing) ? query.data : undefined
  const canEdit =
    item?.review_status === 'needs_correction' &&
    item.service.processing_mode === 'manual' &&
    ['academic_leave', 'accounting_certificate'].includes(item.service.code)
  useEffect(() => {
    if (item && !isSuspended && document.activeElement === document.body) {
      title.current?.focus({ preventScroll: true })
    }
  }, [item, isSuspended])
  useEffect(() => {
    if (confirmation && !isSuspended) confirmationMessage.current?.focus()
  }, [confirmation, isSuspended])
  useEffect(() => () => request.current?.abort(), [])
  useEffect(() => {
    if (!accessError) return
    request.current?.abort()
    for (const queryKey of [applicationDetailKey(id), applicationHistoryKey(id), applicationsKey]) {
      void client.cancelQueries({ queryKey, exact: true })
      if (queryKey === applicationsKey && accessError.status === 404) {
        // Loss of access to one record must not discard other loaded pages.
        client.setQueryData<InfiniteData<Page>>(
          queryKey,
          (current) =>
            current && {
              ...current,
              pages: current.pages.map((page) => ({
                ...page,
                items: page.items.filter((entry) => entry.id !== id),
              })),
            },
        )
      } else {
        client.getQueryCache().find({ queryKey, exact: true })?.setState({
          data: undefined,
          dataUpdatedAt: 0,
        })
      }
    }
  }, [accessError, client, id])

  async function refreshCorrection(signal?: AbortSignal) {
    // Refetch through the current observers so an unmounted/auth-cancelled
    // request cannot populate a new session's private cache.
    const [latest, refreshedHistory] = await Promise.all([
      query.refetch({ throwOnError: true }),
      history.refetch({ throwOnError: true }),
    ])
    if (!latest.data || latest.data.id !== id || !refreshedHistory.data) {
      throw new ApiClientError('Некорректный ответ', 'invalid_response')
    }
    void client.invalidateQueries({ queryKey: applicationsKey, exact: true })
    const item = latest.data
    const data = refreshedHistory.data
    const events = data.pages.flatMap((page) => page.items)
    let cursor = data.pages.at(-1)?.next_cursor
    while (signal && cursor) {
      const page = await getApplicationHistory(id, cursor, signal)
      events.push(...page.items)
      cursor = page.next_cursor
    }
    return { item, events: cursor == null ? events : [] }
  }

  async function retryDetail() {
    const latest = await query.refetch({ cancelRefetch: false })
    if (latest.isSuccess) {
      setActionAccessError(null)
      if (isApplicationAccessError(history.error)) void history.refetch({ cancelRefetch: false })
    }
  }

  function syncApplication(result: Application) {
    const detailKey = applicationDetailKey(id)
    void client.cancelQueries({ queryKey: detailKey, exact: true }, { revert: false })
    const newest = (current: Application | undefined) =>
      current && current.version > result.version ? current : result
    client.setQueryData<Application>(detailKey, newest)
    client.setQueryData<InfiniteData<Page>>(
      applicationsKey,
      (current) =>
        current && {
          ...current,
          pages: current.pages.map((page) => ({
            ...page,
            items: page.items.map((entry) => (entry.id === id ? newest(entry) : entry)),
          })),
        },
    )
    void client.invalidateQueries({ queryKey: applicationsKey, exact: true })
    void client.invalidateQueries({ queryKey: applicationHistoryKey(id), exact: true })
  }

  async function verifyDocument() {
    try {
      const { item: latest } = await refreshCorrection()
      setNeedsDocumentRefresh(false)
      return latest
    } catch (cause) {
      if (isApplicationAccessError(cause)) setActionAccessError(cause)
      setNeedsDocumentRefresh(true)
      return null
    }
  }

  async function downloadFile(filePath: string, filename: string, fileId: string, preview = false) {
    if (request.current || isSuspended) return
    const popup = preview ? window.open('about:blank', '_blank') : null
    if (preview && !popup) {
      setFileError(
        'Браузер заблокировал новую вкладку. Разрешите всплывающие окна или скачайте PDF.',
      )
      return
    }
    if (popup) popup.opener = null
    const controller = new AbortController()
    request.current = controller
    setBusyFile(fileId)
    setFileError('')
    try {
      const blob = await apiFetchBlob(filePath, {
        authenticated: true,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
      })
      controller.signal.throwIfAborted()
      if (fileId === 'document' && blob.type !== 'application/pdf') {
        throw new ApiClientError('PDF недоступен', 'invalid_response', 503)
      }
      if (popup?.closed) return
      const url = URL.createObjectURL(blob)
      try {
        if (popup) {
          popup.location.replace(url)
        } else {
          const link = document.createElement('a')
          link.href = url
          link.download = filename
          link.click()
        }
      } finally {
        // The new tab or download must have time to consume the URL.
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      }
    } catch (cause) {
      popup?.close()
      if (controller.signal.aborted) return
      if (isApplicationAccessError(cause) && (fileId === 'document' || cause.status !== 404)) {
        setActionAccessError(cause)
      } else if (isApplicationAccessError(cause)) {
        setFileError('Вложение недоступно. Обновите заявление.')
        void query.refetch()
      } else if (cause instanceof ApiClientError && cause.status === 503) {
        setFileError(
          fileId === 'document'
            ? 'Выданный PDF временно недоступен (503). Попробуйте открыть его позже.'
            : 'Файл временно недоступен (503). Попробуйте скачать его позже.',
        )
      } else {
        setFileError('Не удалось получить файл. Проверьте соединение и повторите попытку.')
      }
    } finally {
      request.current = null
      setBusyFile(null)
    }
  }

  async function generateDocument(action: 'process' | 'retry') {
    if (request.current || isSuspended || needsDocumentRefresh) return
    const controller = new AbortController()
    request.current = controller
    setBusyFile('document')
    setFileError('')
    try {
      const result = await apiFetch<Application>(`${path}/document/${action}`, {
        method: 'POST',
        authenticated: true,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
      })
      if (result?.id !== id || result.review_status !== 'approved') {
        throw new ApiClientError('Некорректное подтверждение', 'invalid_response')
      }
      syncApplication(result)
    } catch (cause) {
      if (controller.signal.aborted) return
      if (isApplicationAccessError(cause)) {
        setActionAccessError(cause)
        return
      }
      const latest = await verifyDocument()
      if (controller.signal.aborted || latest?.document_status === 'ready') return
      setFileError(
        cause instanceof ApiClientError && cause.code === 'application_data_invalid'
          ? 'Сохранённые данные заявления не подходят для формирования документа. Обновите заявление.'
          : cause instanceof ApiClientError && cause.status === 409
            ? 'Статус заявления изменился. Проверьте доступные действия.'
            : latest?.document_status === 'failed'
              ? 'Подготовка PDF завершилась ошибкой. Можно повторить формирование.'
              : 'Не удалось подтвердить формирование документа. Проверьте состояние заявления перед повтором.',
      )
    } finally {
      request.current = null
      setBusyFile(null)
    }
  }
  const historyItems = history.data?.pages.flatMap((page) => page.items) ?? []
  const metadata = item?.document
  const documentAction =
    item?.service.produces_document && item.service.code !== 'academic_leave'
      ? item.review_status === 'approved' && ['pending', 'failed'].includes(item.document_status)
        ? 'retry'
        : item.review_status === 'submitted' &&
            item.document_status === 'pending' &&
            ['study_certificate', 'academic_transcript'].includes(item.service.code) &&
            item.service.processing_mode === 'automatic'
          ? 'process'
          : null
      : null
  return (
    <section className="section-page service-page application-detail" aria-busy={query.isFetching}>
      <Link
        to="/services?tab=applications"
        onClick={(event) => {
          if (
            location.state?.fromApplications &&
            event.button === 0 &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.shiftKey &&
            !event.altKey
          ) {
            event.preventDefault()
            navigate(-1)
            let frames = 0
            const restoreSourceFocus = () => {
              const source = Array.from(
                document.querySelectorAll<HTMLAnchorElement>(
                  '.applications-table a[data-application-id]',
                ),
              ).find((link) => link.dataset.applicationId === id)
              if (source) {
                source.focus({ preventScroll: true })
                return
              }
              if (frames++ < 120) window.requestAnimationFrame(restoreSourceFocus)
            }
            window.requestAnimationFrame(() => window.requestAnimationFrame(restoreSourceFocus))
          }
        }}
      >
        <Icon name="left" /> К моим заявлениям
      </Link>
      {query.isPending && <LoadingState title="Загружаем заявление…" />}
      {(accessError || query.isError) && (
        <ErrorState
          title={getAccessErrorTitle(accessError ?? query.error)}
          description={
            accessError
              ? 'Проверьте адрес или войдите под своим аккаунтом.'
              : 'Проверьте соединение и повторите попытку.'
          }
          onRetry={() => void retryDetail()}
        />
      )}
      {item && (
        <div>
          <p className="section-eyebrow">Услуги и документы</p>
          <h1 ref={title} tabIndex={-1}>
            Заявление № {item.id}
          </h1>
          <p className="service-subtitle">{item.service.title}</p>
          {(item.attachments ?? []).length > 0 && (
            <section className="application-detail-card" aria-labelledby="attachments-title">
              <h2 id="attachments-title">Текущие подтверждающие файлы</h2>
              <ul>
                {(item.attachments ?? []).map((attachment) => (
                  <li key={attachment.id}>
                    {attachment.original_filename} —{' '}
                    {(attachment.size_bytes / (1024 * 1024)).toFixed(2)} МБ{' '}
                    <button
                      type="button"
                      disabled={busyFile !== null}
                      onClick={() =>
                        void downloadFile(
                          `/api/v1/applications/attachments/${encodeURIComponent(attachment.id)}/download`,
                          attachment.original_filename,
                          attachment.id,
                        )
                      }
                    >
                      {busyFile === attachment.id ? 'Скачиваем…' : 'Скачать'}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <article className="application-detail-card">
            <div className="service-card-heading">
              <span className="service-icon-small" aria-hidden="true">
                <Icon name="file" />
              </span>
              <div>
                <h2>{item.service.title}</h2>
                <p>Данные поданного заявления</p>
              </div>
            </div>
            <dl>
              <dt>Дата подачи</dt>
              <dd>
                <time dateTime={item.created_at}>{formatDate(item.created_at)}</time>
              </dd>
              {Object.entries(item.form_data).map(([key, value]) => {
                const labels: Record<string, string> = {
                  place_of_submission: 'Место предоставления',
                  basis: 'Основание',
                  starts_on: 'Дата начала',
                  ends_on: 'Дата окончания',
                  explanation: 'Пояснение',
                  purpose: 'Цель получения',
                  academic_term_name: 'Учебный период',
                  academic_term_id: 'Идентификатор периода',
                }
                return (
                  <div className="application-form-data" key={key}>
                    <dt>{labels[key] ?? key}</dt>
                    <dd>{getFormValue(key, value)}</dd>
                  </div>
                )
              })}
              <dt>Рассмотрение</dt>
              <dd>
                <span className={`application-status application-status--${item.review_status}`}>
                  {reviewLabels[item.review_status]}
                </span>
              </dd>
              <dt>Документ</dt>
              <dd>{getDocumentStatus(item)}</dd>
              <dt>Версия</dt>
              <dd>{item.version}</dd>
              {item.feedback !== null && (
                <>
                  <dt>Обратная связь</dt>
                  <dd>{item.feedback}</dd>
                </>
              )}
            </dl>
          </article>
          {confirmation && (
            <p
              className={
                confirmation.filesUnverified ? 'application-detail-card' : 'application-success'
              }
              ref={confirmationMessage}
              tabIndex={-1}
              role="status"
            >
              {confirmation.filesUnverified
                ? `История подтверждает повторную подачу заявления № ${confirmation.id}. Версия подачи ${confirmation.version}. Проверьте текущие вложения: содержимое файлов из прерванной отправки не проверено.`
                : `Заявление № ${confirmation.id} подано повторно. Версия ${confirmation.version}.`}
            </p>
          )}
          {canEdit && !editing && (
            <button
              className="service-action"
              ref={editButton}
              disabled={!query.isSuccess || query.isFetching}
              onClick={() => setEditing(true)}
            >
              Исправить заявление
            </button>
          )}
          {editing && (
            <AdditionalApplicationForm
              service={item.service}
              correction={{
                item,
                isCurrent: query.isSuccess,
                historyIsCurrent: history.isSuccess && !history.isFetching,
                refresh: refreshCorrection,
                onSuccess: (result, submittedVersion, filesUnverified) => {
                  syncApplication(result)
                  setConfirmation({ id: result.id, version: submittedVersion, filesUnverified })
                  setEditing(false)
                },
                onAccessError: setActionAccessError,
                onCancel: () => {
                  setEditing(false)
                  requestAnimationFrame(() => (editButton.current ?? title.current)?.focus())
                },
              }}
            />
          )}
          <section className="application-detail-card" aria-labelledby="history-title">
            <h2 id="history-title">История рассмотрения</h2>
            <p>
              <strong>Текущий этап — {reviewLabels[item.review_status]}</strong>
            </p>
            {history.isPending && <LoadingState title="Загружаем историю…" />}
            {history.isError && (
              <ErrorState
                title="Не удалось загрузить историю"
                description="Проверьте соединение и повторите попытку."
                onRetry={() =>
                  void (history.isFetchNextPageError
                    ? history.fetchNextPage({ cancelRefetch: false })
                    : history.refetch({ cancelRefetch: false }))
                }
              />
            )}
            {history.isSuccess && !historyItems.length && <p>Событий пока нет.</p>}
            {historyItems.length > 0 && (
              <ol className="application-timeline">
                {historyItems.map((event) => (
                  <li key={event.id}>
                    <time dateTime={event.created_at}>{formatDate(event.created_at)}</time>
                    <strong>
                      {event.from_status ? `${reviewLabels[event.from_status]} → ` : ''}
                      {reviewLabels[event.to_status]}
                    </strong>
                    {event.actor_user_id && <span>Участник № {event.actor_user_id}</span>}
                    {event.comment && <p>{event.comment}</p>}
                  </li>
                ))}
              </ol>
            )}
            {history.hasNextPage && (
              <button
                className="service-action service-action--light"
                disabled={history.isFetching || history.isRefetchError}
                onClick={() => void history.fetchNextPage({ cancelRefetch: false })}
              >
                {history.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё события'}
              </button>
            )}
          </section>
          {((metadata && item.review_status === 'approved' && item.document_status === 'ready') ||
            documentAction) && (
            <section className="application-detail-card" aria-labelledby="document-title">
              <h2 id="document-title">{metadata ? 'Выданный PDF' : 'Документ'}</h2>
              {metadata && (
                <dl>
                  <dt>Номер документа</dt>
                  <dd>{metadata.id}</dd>
                  <dt>Файл</dt>
                  <dd>{metadata.filename}</dd>
                  <dt>Дата выдачи</dt>
                  <dd>
                    <time dateTime={metadata.issued_at}>{formatDate(metadata.issued_at)}</time>
                  </dd>
                </dl>
              )}
              <div className="form-actions">
                {metadata && (
                  <>
                    <button
                      className="service-action"
                      disabled={busyFile !== null}
                      onClick={() =>
                        void downloadFile(`${path}/document`, metadata.filename, 'document', true)
                      }
                    >
                      Открыть PDF в новой вкладке
                    </button>
                    <button
                      className="service-action service-action--light"
                      disabled={busyFile !== null}
                      onClick={() =>
                        void downloadFile(`${path}/document`, metadata.filename, 'document')
                      }
                    >
                      Скачать PDF
                    </button>
                  </>
                )}
                {documentAction && (
                  <button
                    className="service-action"
                    disabled={
                      busyFile !== null || query.isFetching || query.isError || needsDocumentRefresh
                    }
                    onClick={() => void generateDocument(documentAction)}
                  >
                    {documentAction === 'process'
                      ? 'Сформировать документ'
                      : 'Повторить формирование'}
                  </button>
                )}
              </div>
              {busyFile === 'document' && <p role="status">Выполняем запрос…</p>}
            </section>
          )}
          {fileError && <p role="alert">{fileError}</p>}
          {needsDocumentRefresh && (
            <button
              className="service-action service-action--light"
              type="button"
              disabled={query.isFetching || history.isFetching}
              onClick={() => void verifyDocument()}
            >
              Проверить состояние документа
            </button>
          )}
        </div>
      )}
    </section>
  )
}
