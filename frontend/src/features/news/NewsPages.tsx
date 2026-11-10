import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Link, useLocation, useNavigate, useNavigationType, useParams } from 'react-router-dom'
import { useEffect } from 'react'
import { apiFetch, ApiClientError } from '../../shared/api/client'
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/StatusStates'
import type { components } from '../../shared/api/schema'

type NewsPreview = components['schemas']['NewsPreview']
type News = components['schemas']['News']
type NewsPage = components['schemas']['Page_NewsPreview_']

let feedScrollPosition = 0
let shouldRestoreFeedPosition = false

function formatNewsDate(value: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'long',
    timeZone: 'Europe/Moscow',
  }).format(new Date(value))
}

async function getNewsPage(cursor: string | null, signal: AbortSignal): Promise<NewsPage> {
  const params = new URLSearchParams({ limit: '20' })
  if (cursor) params.set('cursor', cursor)
  return apiFetch<NewsPage>(`/api/v1/news?${params}`, { authenticated: true, signal })
}

async function getNews(id: string, signal: AbortSignal): Promise<News> {
  return apiFetch<News>(`/api/v1/news/${encodeURIComponent(id)}`, {
    authenticated: true,
    signal,
  })
}

function getErrorMessage(error: unknown) {
  return error instanceof ApiClientError && error.status === 404
    ? 'Эта новость не найдена или уже недоступна.'
    : 'Не удалось загрузить новости. Проверьте соединение и попробуйте ещё раз.'
}

function NewsRow({ item }: { item: NewsPreview }) {
  return (
    <article className="news-row">
      <time className="news-row__date" dateTime={item.published_at}>
        {formatNewsDate(item.published_at)}
      </time>
      <h2>
        <Link
          to={`/news/${encodeURIComponent(item.id)}`}
          onClick={() => {
            feedScrollPosition = window.scrollY
            shouldRestoreFeedPosition = true
          }}
        >
          {item.title}
        </Link>
      </h2>
      <p>{item.excerpt}</p>
    </article>
  )
}

export function NewsFeedPage() {
  const location = useLocation()
  const navigationType = useNavigationType()
  const query = useInfiniteQuery({
    queryKey: ['news', 'feed'],
    queryFn: ({ pageParam, signal }) => getNewsPage(pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    staleTime: Infinity,
    refetchOnMount: false,
  })

  useEffect(() => {
    if (
      (location.state?.restoreNewsScroll ||
        (navigationType === 'POP' && shouldRestoreFeedPosition)) &&
      query.data
    ) {
      requestAnimationFrame(() => {
        window.scrollTo({ top: feedScrollPosition })
        shouldRestoreFeedPosition = false
      })
    }
  }, [location.state, navigationType, query.data])

  return (
    <section className="section-page news-page" aria-labelledby="news-title">
      <p className="section-eyebrow">Студенческий кабинет</p>
      <h1 id="news-title">Новости</h1>
      {query.isPending && <LoadingState title="Загружаем новости…" />}
      {query.isError && (
        <ErrorState
          title="Новости временно недоступны"
          description={getErrorMessage(query.error)}
          onRetry={() => void query.refetch()}
        />
      )}
      {query.data && query.data.pages[0]?.items.length === 0 && (
        <EmptyState
          title="Пока нет опубликованных новостей"
          description="Новые публикации появятся здесь."
        />
      )}
      {query.data && query.data.pages.some((page) => page.items.length > 0) && (
        <div className="news-feed" aria-label="Лента университетских новостей">
          {query.data.pages
            .flatMap((page) => page.items)
            .map((item) => (
              <NewsRow key={item.id} item={item} />
            ))}
          {query.hasNextPage && (
            <button
              className="news-load-more"
              type="button"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё'}
            </button>
          )}
          {query.isFetchNextPageError && (
            <ErrorState
              title="Не удалось загрузить следующую страницу"
              description={getErrorMessage(query.error)}
              onRetry={() => void query.fetchNextPage()}
            />
          )}
        </div>
      )}
    </section>
  )
}

export function NewsDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const query = useQuery({
    queryKey: ['news', 'item', id],
    queryFn: ({ signal }) => getNews(id, signal),
    staleTime: Infinity,
  })

  return (
    <section className="section-page news-page" aria-labelledby="news-detail-title">
      <Link
        className="news-back-link"
        to="/news"
        state={{ restoreNewsScroll: true }}
        onClick={(event) => {
          if (window.history.state?.idx === 0) {
            event.preventDefault()
            shouldRestoreFeedPosition = true
            navigate('/news', { state: { restoreNewsScroll: true }, replace: true })
          }
        }}
      >
        ← Назад к новостям
      </Link>
      {query.isPending && <LoadingState title="Загружаем новость…" />}
      {query.isError && (
        <ErrorState title="Не удалось открыть новость" description={getErrorMessage(query.error)} />
      )}
      {query.data && <NewsArticle news={query.data} />}
    </section>
  )
}

function NewsArticle({ news }: { news: News }) {
  return (
    <article className="news-article">
      <time className="news-row__date" dateTime={news.published_at}>
        {formatNewsDate(news.published_at)}
      </time>
      <h1 id="news-detail-title">{news.title}</h1>
      <p className="news-article__body">{news.body}</p>
    </article>
  )
}
