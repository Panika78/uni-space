import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

function renderNews(path = '/news') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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
}

afterEach(() => vi.clearAllMocks())

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

  it('renders the empty feed state', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ items: [], next_cursor: null })
    renderNews()
    expect(await screen.findByText('Пока нет опубликованных новостей')).toBeInTheDocument()
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1))
  })
})
