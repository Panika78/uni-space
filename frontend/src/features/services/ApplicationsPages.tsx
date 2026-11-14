import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { apiFetch, ApiClientError } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'
import { Icon } from '../../shared/ui/Icon'
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/StatusStates'

type Application = components['schemas']['ApplicationResponse']
type Page = components['schemas']['ApplicationPage']
type ReturnFocus = { id: string; locationKey: string }
export const applicationsKey = ['applications'] as const
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
  const queryClient = useQueryClient()
  const location = useLocation()
  const heading = useRef<HTMLHeadingElement>(null)
  const table = useRef<HTMLTableElement>(null)
  const tableId = useId()
  // The private return target is cleared with applications on POST/auth changes.
  // Keep it separate so recording focus cannot change a failed list's API state.
  const returnFocus = useRef(queryClient.getQueryData<ReturnFocus>(returnFocusKey))
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
  const isDenied = query.error instanceof ApiClientError && query.error.status === 403
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
    const target = returnFocus.current
    if (!target || target.locationKey !== location.key) return
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
          if (!restoredLink.current || (!query.isFetching && focusWasLost)) {
            link.focus({ preventScroll: true })
            restoredLink.current = link
          }
        } else if (!query.isFetching) {
          const shouldFocusHeading = !restoredLink.current || focusWasLost
          if (shouldFocusHeading) heading.current?.focus({ preventScroll: true })
        }
      })
    })
    if (!query.isFetching) {
      returnFocus.current = undefined
      queryClient.removeQueries({ queryKey: returnFocusKey, exact: true })
    }
    return () => {
      window.cancelAnimationFrame(firstFrame)
      if (secondFrame) window.cancelAnimationFrame(secondFrame)
    }
  }, [location.key, query.data, query.isFetching, isDenied, queryClient])
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
      (document.activeElement === document.body ||
        heading.current?.parentElement?.contains(document.activeElement))
    )
      heading.current?.focus({ preventScroll: true })
  }, [isDenied, queryClient])
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
          title="Доступ к заявлениям запрещён"
          description="У вас нет доступа к списку заявлений. Обратитесь к администратору."
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
                        locationKey: location.key,
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
export function ApplicationDetailPage() {
  const { id = '' } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const title = useRef<HTMLHeadingElement>(null)
  const query = useQuery({
    queryKey: [...applicationsKey, 'detail', id],
    queryFn: ({ signal }) =>
      apiFetch<Application>(`/api/v1/applications/${encodeURIComponent(id)}`, {
        authenticated: true,
        signal,
      }),
  })
  useEffect(() => {
    if (query.isSuccess) title.current?.focus({ preventScroll: true })
  }, [query.data, query.isSuccess])
  const item = query.isSuccess ? query.data : undefined
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
          }
        }}
      >
        <Icon name="left" /> К моим заявлениям
      </Link>
      {query.isPending && <LoadingState title="Загружаем заявление…" />}
      {query.isError && (
        <ErrorState
          title={
            query.error instanceof ApiClientError && query.error.status === 404
              ? 'Заявление не найдено'
              : query.error instanceof ApiClientError && query.error.status === 403
                ? 'Доступ к заявлению запрещён'
                : 'Не удалось открыть заявление'
          }
          description="Проверьте адрес или повторите попытку."
          onRetry={() => void query.refetch()}
        />
      )}
      {item && (
        <div>
          <p className="section-eyebrow">Услуги и документы</p>
          <h1 ref={title} tabIndex={-1}>
            Заявление № {item.id}
          </h1>
          <p className="service-subtitle">{item.service.title}</p>
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
              <dt>Место предоставления</dt>
              <dd>{item.form_data.place_of_submission}</dd>
              <dt>Рассмотрение</dt>
              <dd>
                <span className={`application-status application-status--${item.review_status}`}>
                  {reviewLabels[item.review_status]}
                </span>
              </dd>
              <dt>Документ</dt>
              <dd>{documentLabels[item.document_status]}</dd>
              {item.feedback !== null && (
                <>
                  <dt>Обратная связь</dt>
                  <dd>{item.feedback}</dd>
                </>
              )}
            </dl>
          </article>
        </div>
      )}
    </section>
  )
}
