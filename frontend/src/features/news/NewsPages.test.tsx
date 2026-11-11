import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (initialFeed) {
    const { updatedAt, ...data } = initialFeed
    queryClient.setQueryData(['news', 'feed'], data, { updatedAt })
  }
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
  vi.clearAllMocks()
})

describe('university news pages', () => {
  it('renders content literally and opens the full text page', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(page).mockResolvedValueOnce(item)
    renderNews()

    const title = await screen.findByRole('link', { name: '<img src=x onerror=alert(1)>' })
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

  it('shows a clear not-found state for an unavailable direct link', async () => {
    const error = new ApiClientError('not found', 'not_found', 404)
    vi.mocked(apiFetch).mockRejectedValueOnce(error)
    renderNews('/news/404')
    expect(await screen.findByText('Не удалось открыть новость')).toBeInTheDocument()
    expect(screen.getByText('Эта новость не найдена или уже недоступна.')).toBeInTheDocument()
  })

  it('allows retrying a temporary detail request failure', async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(item)
    renderNews('/news/21')
    expect(await screen.findByText('Не удалось открыть новость')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    expect(await screen.findByRole('heading', { name: item.title })).toBeInTheDocument()
    expect(apiFetch).toHaveBeenCalledTimes(2)
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
    const articleLink = await screen.findByRole('link', { name: 'Страница вторая' })
    fireEvent.click(articleLink)
    expect(await screen.findByRole('heading', { name: 'Страница вторая' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: '← Назад к новостям' }))

    expect(await screen.findByRole('link', { name: 'Страница первая' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Страница вторая' })).toBeInTheDocument()
    expect(apiFetch).toHaveBeenCalledTimes(3)
  })

  it('refreshes stale cached pages sequentially without losing loaded page count', async () => {
    const oldPage = {
      items: [{ ...page.items[0], id: 'old-1', title: 'Снятая публикация' }],
      next_cursor: 'old-cursor',
    }
    const oldPage2 = {
      items: [{ ...page.items[0], id: 'old-2', title: 'Старая страница 2' }],
      next_cursor: null,
    }
    const refreshedPage1 = {
      items: [{ ...page.items[0], id: 'new-1', title: 'Новая публикация' }],
      next_cursor: 'fresh-cursor',
    }
    const refreshedPage2 = {
      items: [{ ...page.items[0], id: 'new-2', title: 'Актуальная страница 2' }],
      next_cursor: null,
    }
    vi.mocked(apiFetch).mockResolvedValueOnce(refreshedPage1).mockResolvedValueOnce(refreshedPage2)
    renderNews('/news', {
      pages: [oldPage, oldPage2],
      pageParams: [null, 'old-cursor'],
      updatedAt: Date.now() - 60_000,
    })

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
