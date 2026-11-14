import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { InfiniteData } from '@tanstack/react-query'
import { useCallback, useEffect, useRef } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import type { MouseEvent } from 'react'
import { apiFetch, ApiClientError } from '../../shared/api/client'
import { Icon } from '../../shared/ui/Icon'
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/StatusStates'
import type { components } from '../../shared/api/schema'

type NewsPreview = components['schemas']['NewsPreview']
type News = components['schemas']['News']
type NewsPage = components['schemas']['Page_NewsPreview_']
type FeedData = InfiniteData<NewsPage, string | null>

const NEWS_FEED_KEY = ['news', 'feed'] as const
const NEWS_FRESH_MS = 30_000
const NEWS_ITEM_GC_MS = 30 * 60_000

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
      <Link
        className="news-row__link"
        to={`/news/${encodeURIComponent(item.id)}`}
        state={{ fromNewsFeed: true }}
      >
        <time className="news-row__date" dateTime={item.published_at}>
          {formatNewsDate(item.published_at)}
        </time>
        <h2>{item.title}</h2>
        <p>{item.excerpt}</p>
        <span className="news-row__arrow" aria-hidden="true">
          <Icon name="right" />
        </span>
      </Link>
    </article>
  )
}

export function NewsFeedPage() {
  const queryClient = useQueryClient()
  const refreshInProgress = useRef(false)
  const refreshController = useRef<AbortController | null>(null)
  const query = useInfiniteQuery({
    queryKey: NEWS_FEED_KEY,
    queryFn: ({ pageParam, signal }) => getNewsPage(pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    staleTime: NEWS_FRESH_MS,
    gcTime: Infinity,
    refetchOnMount: false,
  })
  const refreshMutation = useMutation({
    mutationFn: async ({ pageCount, signal }: { pageCount: number; signal: AbortSignal }) => {
      const pages: NewsPage[] = []
      const pageParams: (string | null)[] = []
      let cursor: string | null = null
      for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
        const page = await getNewsPage(cursor, signal)
        pages.push(page)
        pageParams.push(cursor)
        if (!page.next_cursor) break
        cursor = page.next_cursor
      }
      return { pages, pageParams }
    },
    onSuccess: (data) => {
      queryClient.setQueryData<FeedData>(NEWS_FEED_KEY, data, { updatedAt: Date.now() })
    },
  })
  const mutateRefresh = refreshMutation.mutateAsync

  const startFeedRefresh = useCallback(
    (pageCount: number) => {
      const controller = new AbortController()
      refreshController.current = controller
      refreshInProgress.current = true
      void mutateRefresh({ pageCount, signal: controller.signal })
        .catch(() => undefined)
        .finally(() => {
          if (refreshController.current === controller) {
            refreshController.current = null
            refreshInProgress.current = false
          }
        })
      return controller
    },
    [mutateRefresh],
  )

  useEffect(() => {
    const cached = queryClient.getQueryData<FeedData>(NEWS_FEED_KEY)
    const state = queryClient.getQueryState<FeedData>(NEWS_FEED_KEY)
    if (!cached || !state || Date.now() - state.dataUpdatedAt <= NEWS_FRESH_MS) return

    const controller = startFeedRefresh(cached.pages.length)

    return () => {
      controller.abort()
      if (refreshController.current === controller) {
        refreshController.current = null
        refreshInProgress.current = false
      }
    }
  }, [queryClient, startFeedRefresh])

  function handleRefreshRetry() {
    const cached = queryClient.getQueryData<FeedData>(NEWS_FEED_KEY)
    if (!cached || refreshInProgress.current) return
    refreshMutation.reset()
    startFeedRefresh(cached.pages.length)
  }

  return (
    <section className="section-page news-page" aria-labelledby="news-title">
      <p className="section-eyebrow">Студенческий кабинет</p>
      <h1 id="news-title">Новости</h1>
      <p className="service-subtitle">Университетские объявления и важная информация</p>
      {query.isPending && <LoadingState title="Загружаем новости…" />}
      {query.isError && !query.data && (
        <ErrorState
          title="Новости временно недоступны"
          description={getErrorMessage(query.error)}
          onRetry={() => void query.refetch()}
        />
      )}
      {refreshMutation.isError && query.data && (
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
        <>
          <div className="news-feed" aria-label="Лента университетских новостей">
            {query.data.pages
              .flatMap((page) => page.items)
              .map((item) => (
                <NewsRow key={item.id} item={item} />
              ))}
          </div>
          {query.hasNextPage && (
            <button
              className="news-load-more"
              type="button"
              disabled={query.isFetchingNextPage || refreshMutation.isPending}
              onClick={() => {
                if (refreshInProgress.current || refreshMutation.isPending) return
                void query.fetchNextPage()
              }}
            >
              <span className="news-load-more__line" aria-hidden="true" />
              <span>
                {refreshMutation.isPending
                  ? 'Обновляем…'
                  : query.isFetchingNextPage
                    ? 'Загружаем…'
                    : 'Показать ещё'}
              </span>
              <span className="news-load-more__line" aria-hidden="true" />
            </button>
          )}
          {query.isFetchNextPageError && (
            <ErrorState
              title="Не удалось загрузить следующую страницу"
              description={getErrorMessage(query.error)}
              onRetry={() => void query.fetchNextPage()}
            />
          )}
        </>
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
    gcTime: NEWS_ITEM_GC_MS,
    refetchOnMount: true,
  })

  function handleBack(event: MouseEvent<HTMLAnchorElement>) {
    if (
      !location.state?.fromNewsFeed ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return
    event.preventDefault()
    navigate(-1)
  }

  return (
    <section className="section-page news-page" aria-labelledby="news-detail-title">
      <Link className="news-back-link" to="/news" onClick={handleBack}>
        <Icon name="left" /> Назад к новостям
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
      <h1 id="news-detail-title" className="news-article__title">
        {news.title}
      </h1>
      <span className="news-article__rule" aria-hidden="true" />
      <p className="news-article__body">{news.body}</p>
    </article>
  )
}
