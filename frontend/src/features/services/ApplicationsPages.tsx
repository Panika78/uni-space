import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { apiFetch, ApiClientError } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'
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
    <nav className="services-tabs" aria-label="Разделы услуг">
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
  const items = query.data?.pages.flatMap((page) => page.items) ?? []
  useEffect(() => {
    const target = returnFocus.current
    if (!target || target.locationKey !== location.key) return
    const link = Array.from(
      table.current?.querySelectorAll<HTMLAnchorElement>('a[data-application-id]') ?? [],
    ).find((link) => link.dataset.applicationId === target.id)
    if (!restoredLink.current && link) {
      link.focus({ preventScroll: true })
      restoredLink.current = link
    } else if (
      !query.isFetching &&
      !link &&
      (!restoredLink.current || document.activeElement === document.body)
    ) {
      heading.current?.focus({ preventScroll: true })
    }
    if (!query.isFetching) {
      returnFocus.current = undefined
      queryClient.removeQueries({ queryKey: returnFocusKey, exact: true })
    }
  }, [location.key, query.data, query.isFetching, queryClient])
  return (
    <div>
      <h2 ref={heading} tabIndex={-1}>
        Мои заявления
      </h2>
      {query.isPending && <LoadingState title="Загружаем заявления…" />}
      {query.isRefetching && (
        <p role="status" className="sr-only">
          Обновляем заявления…
        </p>
      )}
      {query.isError && (
        <ErrorState
          title="Не удалось загрузить заявления"
          description={
            query.data
              ? 'Показаны ранее загруженные заявления. Их данные могут быть неактуальны; повторите загрузку.'
              : 'Проверьте соединение и повторите попытку.'
          }
          onRetry={() =>
            void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())
          }
        />
      )}
      {query.isSuccess && items.length === 0 && (
        <EmptyState
          title="Вы ещё не подавали заявлений"
          description="Выберите услугу в каталоге."
        />
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
                    {item.service.title} · № {item.id}
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
                  <span>{reviewLabels[item.review_status]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {query.hasNextPage && (
        <button
          className="service-action"
          disabled={query.isFetching}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё'}
        </button>
      )}
      <p role="status" className="sr-only">
        Загружено заявлений: {items.length}
      </p>
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
        ← К моим заявлениям
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
        <article>
          <h1 ref={title} tabIndex={-1}>
            Заявление № {item.id}
          </h1>
          <h2>{item.service.title}</h2>
          <dl>
            <dt>Дата подачи</dt>
            <dd>
              <time dateTime={item.created_at}>{formatDate(item.created_at)}</time>
            </dd>
            <dt>Место предоставления</dt>
            <dd>{item.form_data.place_of_submission}</dd>
            <dt>Рассмотрение</dt>
            <dd>{reviewLabels[item.review_status]}</dd>
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
      )}
    </section>
  )
}
