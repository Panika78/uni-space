import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewsDetailPage, NewsFeedPage } from './NewsPages'
import { apiFetch, ApiClientError } from '../../shared/api/client'

vi.mock('../../shared/api/client', () => ({
  apiFetch: vi.fn(),
  ApiClientError: class ApiClientError extends Error {
    status?: number
    constructor(message: string, code: string, status?: number) {
      super(message)
      this.status = status
      this.name = 'ApiClientError'
      void code
    }
  },
}))

const page = {
  items: [
    {
      id: '21',
      title: '<img src=x onerror=alert(1)>',
      excerpt: 'Короткий анонс',
      published_at: '2026-11-10T12:00:00Z',
    },
  ],
  next_cursor: null,
}
const item = { ...page.items[0], body: 'Первая строка\n<script>alert(1)</script>' }

function renderNews(
  path = '/news',
  initialFeed?: {
    pages: Array<{ items: typeof page.items; next_cursor: string | null }>
    pageParams: (string | null)[]
    updatedAt?: number
  },
  initialDetail?: { newsId?: string; news: typeof item },
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (initialFeed) {
    const { updatedAt, ...data } = initialFeed
    queryClient.setQueryData(['news', 'feed'], data, { updatedAt })
  }
  if (initialDetail)
    queryClient.setQueryData(['news', 'item', initialDetail.newsId ?? '21'], initialDetail.news, {
      updatedAt: Date.now() - 60_000,
    })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/news" element={<NewsFeedPage />} />
          <Route path="/news/:id" element={<NewsDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return queryClient
}

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe('university news pages', () => {
  it('renders content literally and opens the full text page', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(page).mockResolvedValueOnce(item)
    renderNews()

    const title = await screen.findByRole('link', { name: /onerror=alert\(1\)/ })
    expect(title.querySelector('time')).toHaveAttribute('dateTime', page.items[0].published_at)
    expect(title.querySelector('h2')).toHaveTextContent(page.items[0].title)
    expect(title.querySelector('p')).toHaveTextContent(page.items[0].excerpt)
    expect(title.querySelector('.news-row__arrow')).toHaveAttribute('aria-hidden', 'true')
    expect(title.closest('.news-feed')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).not.toBeInTheDocument()
    expect(document.querySelector('img')).not.toBeInTheDocument()
    fireEvent.click(title)
    expect(
      await screen.findByRole('heading', { name: '<img src=x onerror=alert(1)>' }),
    ).toBeInTheDocument()
    expect(document.querySelector('.news-article__body')?.textContent).toBe(
      'Первая строка\n<script>alert(1)</script>',
    )
    expect(document.querySelector('script')).not.toBeInTheDocument()
  })

  it('shows unavailable without retry or article for a first GET returning 404', async () => {
    const error = new ApiClientError('not found', 'not_found', 404)
    vi.mocked(apiFetch).mockRejectedValueOnce(error)
    renderNews('/news/404')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Новость не найдена или больше недоступна',
    )
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument()
  })

  it('shows denied without retry or article for a first GET returning 403', async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new ApiClientError('forbidden', 'forbidden', 403))
    renderNews('/news/403')
    expect(await screen.findByRole('alert')).toHaveTextContent('Доступ к новости запрещён')
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument()
  })

  it.each([
    [403, 'Доступ к новости запрещён'],
    [404, 'Новость не найдена или больше недоступна'],
  ])('hides and removes a cached article after HTTP %i', async (status, title) => {
    const httpStatus = Number(status)
    vi.mocked(apiFetch).mockRejectedValueOnce(
      new ApiClientError('unavailable', httpStatus === 403 ? 'forbidden' : 'not_found', httpStatus),
    )
    const queryClient = renderNews('/news/21', undefined, { news: item })
    expect(await screen.findByText(title)).toBeInTheDocument()
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: item.title })).not.toBeInTheDocument()
    expect(screen.queryByText(item.body)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument()
    await waitFor(() => expect(queryClient.getQueryData(['news', 'item', '21'])).toBeUndefined())
  })

  it('hides a cached article after 401 and leaves logout to the central session handler', async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(
      new ApiClientError('session invalid', 'session_invalid', 401),
    )
    renderNews('/news/21', undefined, { news: item })
    expect(await screen.findByText('Сессия завершена')).toBeInTheDocument()
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument()
  })

  it.each([
    [500, new ApiClientError('server', 'server_error', 500)],
    ['network', new Error('offline')],
  ])('keeps a cached article with a stale-data warning after %s', async (_failure, error) => {
    const queryClient = renderNews('/news/21', undefined, { news: item })
    vi.mocked(apiFetch).mockRejectedValueOnce(error)
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось открыть новость')
    expect(screen.getByRole('article')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: item.title })).toBeInTheDocument()
    expect(
      screen.getByText(/Показана ранее загруженная версия; её данные могут быть неактуальны/),
    ).toBeInTheDocument()
    expect(queryClient.getQueryState(['news', 'item', '21'])?.status).toBe('error')
    expect(queryClient.getQueryData(['news', 'item', '21'])).toEqual(item)
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument()
  })

  it('shows an updated article after availability is restored and retry succeeds', async () => {
    const updated = { ...item, title: 'Актуальная публикация', body: 'Новый текст' }
    vi.mocked(apiFetch).mockRejectedValueOnce(new ApiClientError('gone', 'not_found', 404))
    const queryClient = renderNews('/news/21', undefined, { news: item })
    expect(await screen.findByText('Новость не найдена или больше недоступна')).toBeInTheDocument()
    vi.mocked(apiFetch).mockResolvedValueOnce(updated)
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['news', 'item', '21'], exact: true })
    })
    expect(await screen.findByRole('heading', { name: updated.title })).toBeInTheDocument()
    expect(await screen.findByText(updated.body)).toBeInTheDocument()
    expect(queryClient.getQueryData(['news', 'item', '21'])).toEqual(updated)
  })

  it('allows retrying a temporary detail request failure', async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(item)
    renderNews('/news/21')
    expect(await screen.findByText('Не удалось открыть новость')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    expect(await screen.findByRole('heading', { name: item.title })).toBeInTheDocument()
    expect(apiFetch).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['HTTP 500', new ApiClientError('server', 'server_error', 500)],
    ['network error', new Error('offline')],
  ])(
    'shows a retryable error without an article when the first GET has a %s',
    async (_kind, error) => {
      vi.mocked(apiFetch).mockRejectedValueOnce(error)
      renderNews('/news/21')
      expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось открыть новость')
      expect(screen.queryByRole('article')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument()
    },
  )

  it('keeps modified and non-primary return clicks under native browser handling', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(page).mockResolvedValueOnce(item)
    renderNews()
    fireEvent.click(await screen.findByRole('link', { name: /onerror=alert\(1\)/ }))
    await screen.findByRole('heading', { name: '<img src=x onerror=alert(1)>' })
    const backLink = screen.getByRole('link', { name: 'Назад к новостям' })

    for (const modifiers of [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ]) {
      expect(fireEvent.click(backLink, modifiers)).toBe(true)
      expect(backLink).toHaveAttribute('href', '/news')
      expect(
        screen.getByRole('heading', { name: '<img src=x onerror=alert(1)>' }),
      ).toBeInTheDocument()
    }
  })

  it('renders the empty feed state', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ items: [], next_cursor: null })
    renderNews()
    expect(await screen.findByText('Пока нет опубликованных новостей')).toBeInTheDocument()
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1))
  })

  it('keeps every loaded page when returning from an article through browser history', async () => {
    const firstPage = {
      items: [{ ...page.items[0], id: 'first', title: 'Страница первая' }],
      next_cursor: 'next-page',
    }
    const secondPage = {
      items: [{ ...page.items[0], id: 'second', title: 'Страница вторая' }],
      next_cursor: null,
    }
    const article = { ...secondPage.items[0], body: 'Полный текст' }
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage)
      .mockResolvedValueOnce(article)
    renderNews()

    fireEvent.click(await screen.findByRole('button', { name: 'Показать ещё' }))
    const articleLink = await screen.findByRole('link', { name: /Страница вторая/ })
    fireEvent.click(articleLink)
    expect(await screen.findByRole('heading', { name: 'Страница вторая' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'Назад к новостям' }))

    expect(await screen.findByRole('link', { name: /Страница первая/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Страница вторая/ })).toBeInTheDocument()
    expect(apiFetch).toHaveBeenCalledTimes(3)
  })

  it('refreshes stale cached pages sequentially without losing loaded page count', async () => {
    const oldPage = {
      items: [{ ...page.items[0], id: 'old-1', title: 'Снятая публикация' }],
      next_cursor: 'old-cursor',
    }
    const oldPage2 = {
      items: [{ ...page.items[0], id: 'old-2', title: 'Старая страница 2' }],
      next_cursor: 'old-cursor-2',
    }
    const refreshedPage1 = {
      items: [{ ...page.items[0], id: 'new-1', title: 'Новая публикация' }],
      next_cursor: 'fresh-cursor',
    }
    const refreshedPage2 = {
      items: [{ ...page.items[0], id: 'new-2', title: 'Актуальная страница 2' }],
      next_cursor: null,
    }
    let resolveFirstPage: (value: typeof refreshedPage1) => void = () => undefined
    vi.mocked(apiFetch)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstPage = resolve
          }),
      )
      .mockResolvedValueOnce(refreshedPage2)
    const queryClient = renderNews('/news', {
      pages: [oldPage, oldPage2],
      pageParams: [null, 'old-cursor'],
      updatedAt: Date.now() - 60_000,
    })
    expect(
      Date.now() - (queryClient.getQueryState(['news', 'feed'])?.dataUpdatedAt ?? 0),
    ).toBeGreaterThan(30_000)

    const loadMore = await screen.findByRole('button', { name: 'Обновляем…' })
    expect(loadMore).toBeDisabled()
    fireEvent.click(loadMore)
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryCache().find({ queryKey: ['news', 'feed'] })?.options.gcTime).toBe(
      Infinity,
    )
    resolveFirstPage(refreshedPage1)
    expect(await screen.findByText('Новая публикация')).toBeInTheDocument()
    expect(await screen.findByText('Актуальная страница 2')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('Снятая публикация')).not.toBeInTheDocument())
    expect(apiFetch).toHaveBeenNthCalledWith(
      1,
      '/api/v1/news?limit=20',
      expect.objectContaining({ authenticated: true }),
    )
    expect(apiFetch).toHaveBeenNthCalledWith(
      2,
      '/api/v1/news?limit=20&cursor=fresh-cursor',
      expect.objectContaining({ authenticated: true }),
    )
  })

  it('shows only one error when loading the next page fails', async () => {
    const firstPage = { ...page, next_cursor: 'next-cursor' }
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('offline'))
    renderNews('/news', { pages: [firstPage], pageParams: [null], updatedAt: Date.now() })
    fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }))

    await screen.findByText('Не удалось загрузить следующую страницу')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })
})
