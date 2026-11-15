import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { StaffNewsPage } from './StaffNewsPage'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('../../shared/api/client', () => ({
  apiFetch,
  ApiClientError: class ApiClientError extends Error {},
}))

const draft = {
  id: '41',
  title: 'Новая официальная новость',
  body: 'Текст\nс переносом',
  author_user_id: '12',
  published_at: null,
  is_published: false,
}

function renderPage(path = '/staff/news') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/staff/news" element={<StaffNewsPage />} />
          <Route path="/staff/news/:id" element={<StaffNewsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('staff news publishing', () => {
  afterEach(cleanup)
  beforeEach(() => apiFetch.mockReset())

  it('shows an empty real list and opens a new draft editor', async () => {
    apiFetch.mockResolvedValue({ items: [], next_cursor: null })
    const user = userEvent.setup()
    renderPage()
    expect(await screen.findByText('Новостей пока нет')).toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: 'Создать новость' }))
    expect(await screen.findByRole('heading', { name: 'Новая новость' })).toBeInTheDocument()
  })

  it('requests publication only after confirmed draft save', async () => {
    apiFetch.mockImplementation((path: string | URL | Request, init?: RequestInit) => {
      const requestPath = String(path)
      if (requestPath === '/api/v1/staff/news' && init?.method === 'POST')
        return Promise.resolve(draft)
      if (requestPath === '/api/v1/staff/news/41/publish')
        return Promise.resolve({
          ...draft,
          is_published: true,
          published_at: '2026-11-15T12:00:00Z',
        })
      if (requestPath === '/api/v1/staff/news/41') return Promise.resolve(draft)
      if (requestPath.startsWith('/api/v1/staff/news'))
        return Promise.resolve({ items: [draft], next_cursor: null })
      return Promise.resolve({ items: [], next_cursor: null })
    })
    const user = userEvent.setup()
    renderPage('/staff/news/new')
    await user.type(screen.getByLabelText('Заголовок'), draft.title)
    await user.type(screen.getByLabelText('Текст новости'), draft.body)
    await user.click(screen.getByRole('button', { name: 'Сохранить черновик' }))
    await screen.findByRole('heading', { name: draft.title })
    await user.click(screen.getByRole('button', { name: 'Опубликовать' }))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/v1/staff/news/41/publish',
        expect.objectContaining({ method: 'POST', authenticated: true }),
      ),
    )
    expect(await screen.findByText('Новость опубликована.')).toBeInTheDocument()
  })

  it('allows editing an existing university news item', async () => {
    const published = {
      ...draft,
      is_published: true,
      published_at: '2026-11-15T12:00:00Z',
    }
    apiFetch.mockImplementation((path: string | URL | Request, init?: RequestInit) => {
      const requestPath = String(path)
      if (requestPath === '/api/v1/staff/news/41' && init?.method === 'PATCH')
        return Promise.resolve({ ...published, title: 'Исправленный заголовок' })
      if (requestPath === '/api/v1/staff/news/41') return Promise.resolve(published)
      return Promise.resolve({ items: [draft], next_cursor: null })
    })
    const user = userEvent.setup()
    renderPage('/staff/news/41')
    const title = await screen.findByLabelText('Заголовок')
    await waitFor(() => expect(title).toHaveValue(draft.title))
    await user.clear(title)
    await user.type(title, 'Исправленный заголовок')
    await user.click(screen.getByRole('button', { name: 'Сохранить изменения' }))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/v1/staff/news/41',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ title: 'Исправленный заголовок', body: draft.body }),
        }),
      ),
    )
    expect(await screen.findByText('Изменения сохранены.')).toBeInTheDocument()
  })
})
