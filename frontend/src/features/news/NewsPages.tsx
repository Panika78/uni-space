import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import type { InfiniteData } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import type { MouseEvent } from 'react'
import { apiFetch, ApiClientError } from '../../shared/api/client'
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/StatusStates'
import type { components } from '../../shared/api/schema'

type NewsPreview = components['schemas']['NewsPreview']
type News = components['schemas']['News']
type NewsPage = components['schemas']['Page_NewsPreview_']
type FeedData = InfiniteData<NewsPage, string | null>

const NEWS_FEED_KEY = ['news', 'feed'] as const
const NEWS_FRESH_MS = 30_000
const NEWS_FEED_GC_MS = 30 * 60_000

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
        <Link to={`/news/${encodeURIComponent(item.id)}`} state={{ fromNewsFeed: true }}>
          {item.title}
        </Link>
      </h2>
      <p>{item.excerpt}</p>
    </article>
  )
}

export function NewsFeedPage() {
  const queryClient = useQueryClient()
  const [refreshError, setRefreshError] = useState(false)
  const [refreshAttempt, setRefreshAttempt] = useState(0)
  const refreshInProgress = useRef(false)
  const query = useInfiniteQuery({
    queryKey: NEWS_FEED_KEY,
    queryFn: ({ pageParam, signal }) => getNewsPage(pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    staleTime: NEWS_FRESH_MS,
    gcTime: NEWS_FEED_GC_MS,
    refetchOnMount: false,
  })

  useEffect(() => {
    const cached = queryClient.getQueryData<FeedData>(NEWS_FEED_KEY)
    const state = queryClient.getQueryState<FeedData>(NEWS_FEED_KEY)
    if (!cached || !state || Date.now() - state.dataUpdatedAt <= NEWS_FRESH_MS) return

    const controller = new AbortController()
    let isActive = true
    refreshInProgress.current = true
    void (async () => {
      const pages: NewsPage[] = []
      const pageParams: (string | null)[] = []
      let cursor: string | null = null
      for (let pageIndex = 0; pageIndex < cached.pages.length; pageIndex += 1) {
        const page = await getNewsPage(cursor, controller.signal)
        pages.push(page)
        pageParams.push(cursor)
        if (!page.next_cursor) break
        cursor = page.next_cursor
      }
      if (isActive) {
        queryClient.setQueryData<FeedData>(
          NEWS_FEED_KEY,
          { pages, pageParams },
          { updatedAt: Date.now() },
        )
      }
    })()
      .catch(() => {
        if (isActive && !controller.signal.aborted) setRefreshError(true)
      })
      .finally(() => {
        if (isActive) refreshInProgress.current = false
      })

    return () => {
      isActive = false
      refreshInProgress.current = false
      controller.abort()
    }
  }, [queryClient, refreshAttempt])

  function handleRefreshRetry() {
    setRefreshError(false)
    setRefreshAttempt((attempt) => attempt + 1)
  }

  return (
    <section className="section-page news-page" aria-labelledby="news-title">
      <p className="section-eyebrow">Студенческий кабинет</p>
      <h1 id="news-title">Новости</h1>
      {query.isPending && <LoadingState title="Загружаем новости…" />}
      {query.isError && !query.data && (
        <ErrorState
          title="Новости временно недоступны"
          description={getErrorMessage(query.error)}
          onRetry={() => void query.refetch()}
        />
      )}
      {refreshError && query.data && (
        <ErrorState
          title="Не удалось обновить новости"
          description="Показаны ранее загруженные публикации. Попробуйте обновить страницу позже."
          onRetry={handleRefreshRetry}
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
              onClick={() => {
                if (!refreshInProgress.current) void query.fetchNextPage()
              }}
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
  const location = useLocation()
  const navigate = useNavigate()
  const query = useQuery({
    queryKey: ['news', 'item', id],
    queryFn: ({ signal }) => getNews(id, signal),
    staleTime: NEWS_FRESH_MS,
    gcTime: NEWS_FEED_GC_MS,
    refetchOnMount: true,
  })

  function handleBack(event: MouseEvent<HTMLAnchorElement>) {
    if (!location.state?.fromNewsFeed) return
    event.preventDefault()
    navigate(-1)
  }

  return (
    <section className="section-page news-page" aria-labelledby="news-detail-title">
      <Link className="news-back-link" to="/news" onClick={handleBack}>
        ← Назад к новостям
      </Link>
      {query.isPending && <LoadingState title="Загружаем новость…" />}
      {query.isError && (
        <ErrorState
          title="Не удалось открыть новость"
          description={getErrorMessage(query.error)}
          onRetry={() => void query.refetch()}
        />
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
