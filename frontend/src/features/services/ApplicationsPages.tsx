import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { apiFetch, ApiClientError } from '../../shared/api/client'
import type { components } from '../../shared/api/schema'
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/StatusStates'

type Application = components['schemas']['ApplicationResponse']
type Page = components['schemas']['ApplicationPage']
export const applicationsKey = ['applications'] as const
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
  const query = useInfiniteQuery({
    queryKey: applicationsKey,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ limit: '20' })
      if (pageParam) params.set('cursor', pageParam)
      return apiFetch<Page>(`/api/v1/applications?${params}`, { authenticated: true, signal })
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    staleTime: Infinity,
    gcTime: Infinity,
  })
  const items = query.data?.pages.flatMap((page) => page.items) ?? []
  return (
    <div>
      <h2>Мои заявления</h2>
      {query.isPending && <LoadingState title="Загружаем заявления…" />}
      {query.isError && (
        <ErrorState
          title="Не удалось загрузить заявления"
          description="Проверьте соединение и повторите попытку."
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
        <table className="applications-table">
          <caption className="sr-only">Ранее отправленные заявления</caption>
          <thead>
            <tr>
              <th>Заявление</th>
              <th>Дата подачи</th>
              <th>Рассмотрение</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  <Link to={`/applications/${item.id}`} state={{ fromApplications: true }}>
                    {item.service.title} · № {item.id}
                  </Link>
                </td>
                <td>
                  <time dateTime={item.created_at}>{formatDate(item.created_at)}</time>
                </td>
                <td>{reviewLabels[item.review_status]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {query.hasNextPage && (
        <button
          className="service-action"
          disabled={query.isFetchingNextPage}
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
    if (query.data) title.current?.focus({ preventScroll: true })
  }, [query.data])
  const item = query.data
  return (
    <section className="section-page service-page application-detail">
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
