import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { StaffNewsPage } from './StaffNewsPage'
import { ApiClientError } from '../../shared/api/client'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('../../shared/api/client', () => ({
  apiFetch,
  ApiClientError: class ApiClientError extends Error {
    status?: number
    code: string
    constructor(message: string, code = 'http_error', status?: number) {
      super(message)
      this.code = code
      this.status = status
    }
  },
}))

const draft = {
  id: '41',
  title: 'Новая официальная новость',
  body: 'Текст\nс переносом',
  author_user_id: '12',
  published_at: null,
  is_published: false,
  version: 1,
}

function renderPage(path = '/staff/news') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/staff/news" element={<StaffNewsPage />} />
          <Route path="/staff/news/:id" element={<StaffNewsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...result, queryClient }
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

  it('shows recent publications beside the new editor and opens them for editing', async () => {
    const published = {
      ...draft,
      is_published: true,
      published_at: '2026-11-15T12:00:00Z',
    }
    apiFetch.mockImplementation((path: string | URL | Request) => {
      if (String(path) === '/api/v1/staff/news?limit=100')
        return Promise.resolve({ items: [published], next_cursor: null })
      if (String(path) === '/api/v1/staff/news/41') return Promise.resolve(published)
      return Promise.resolve({ items: [], next_cursor: null })
    })
    const user = userEvent.setup()
    renderPage('/staff/news/new')
    expect(await screen.findByRole('heading', { name: 'Публикации' })).toBeInTheDocument()
    expect(await screen.findByText(published.title)).toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: 'Редактировать' }))
    expect(await screen.findByRole('heading', { name: published.title })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Снять с публикации' })).toBeInTheDocument()
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
          body: JSON.stringify({ title: 'Исправленный заголовок', body: draft.body, version: 1 }),
        }),
      ),
    )
    expect(await screen.findByText('Изменения сохранены.')).toBeInTheDocument()
  })

  it('shows the newest server content after a successful save leaves the form clean', async () => {
    let itemReads = 0
    const saved = { ...draft, title: 'Saved by editor A', version: 2 }
    const latest = {
      ...saved,
      title: 'Updated by editor B',
      body: 'Latest server body',
      version: 3,
    }
    apiFetch.mockImplementation((path: string | URL | Request, init?: RequestInit) => {
      const requestPath = String(path)
      if (requestPath === '/api/v1/staff/news/41' && init?.method === 'PATCH')
        return Promise.resolve(saved)
      if (requestPath === '/api/v1/staff/news/41') {
        itemReads += 1
        return Promise.resolve(itemReads === 1 ? draft : latest)
      }
      return Promise.resolve({ items: [latest], next_cursor: null })
    })
    const user = userEvent.setup()
    renderPage('/staff/news/41')
    const title = await screen.findByLabelText('Заголовок')
    await user.clear(title)
    await user.type(title, saved.title)
    await user.click(screen.getByRole('button', { name: 'Сохранить черновик' }))

    await waitFor(() => expect(screen.getByLabelText('Заголовок')).toHaveValue(latest.title))
    expect(screen.getByLabelText('Текст новости')).toHaveValue(latest.body)
    expect(screen.getByText('Черновик сохранён.')).toBeInTheDocument()
  })

  it('keeps the edit base version after a background refetch for a second editor', async () => {
    let itemReads = 0
    const updatedByOtherEditor = { ...draft, title: 'Версия второго редактора', version: 2 }
    apiFetch.mockImplementation((path: string | URL | Request, init?: RequestInit) => {
      const requestPath = String(path)
      if (requestPath === '/api/v1/staff/news/41') {
        if (init?.method === 'PATCH')
          return Promise.reject(new ApiClientError('conflict', 'version_conflict', 409))
        itemReads += 1
        return Promise.resolve(itemReads === 1 ? draft : updatedByOtherEditor)
      }
      if (requestPath.startsWith('/api/v1/staff/news'))
        return Promise.resolve({ items: [draft], next_cursor: null })
      return Promise.resolve({ items: [], next_cursor: null })
    })
    const user = userEvent.setup()
    const { queryClient } = renderPage('/staff/news/41')
    const title = await screen.findByLabelText('Заголовок')
    await user.clear(title)
    await user.type(title, 'Правка первого редактора')

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['staff-news', '41'], exact: true })
    })
    expect(await screen.findByLabelText('Заголовок')).toHaveValue('Правка первого редактора')
    expect(queryClient.getQueryData(['staff-news', '41'])).toEqual(updatedByOtherEditor)

    await user.click(screen.getByRole('button', { name: 'Сохранить черновик' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Новость изменил другой сотрудник')
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/v1/staff/news/41',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ title: 'Правка первого редактора', body: draft.body, version: 1 }),
      }),
    )
    expect(apiFetch.mock.calls.filter((call) => call[1]?.method === 'PATCH')).toHaveLength(1)
    expect(screen.getByLabelText('Заголовок')).toHaveValue('Правка первого редактора')
  })

  it('locks the new draft form while a delayed create is pending', async () => {
    let resolveCreate: ((value: typeof draft) => void) | undefined
    apiFetch.mockImplementation((path: string | URL | Request, init?: RequestInit) => {
      if (String(path) === '/api/v1/staff/news' && init?.method === 'POST')
        return new Promise((resolve) => {
          resolveCreate = resolve
        })
      if (String(path) === '/api/v1/staff/news/41')
        return Promise.resolve({ ...draft, title: 'Title', body: 'Версия 1' })
      return Promise.resolve({ items: [], next_cursor: null })
    })
    const user = userEvent.setup()
    renderPage('/staff/news/new')
    await user.type(await screen.findByLabelText('Заголовок'), 'Title')
    await user.type(screen.getByLabelText('Текст новости'), 'Версия 1')
    await user.click(screen.getByRole('button', { name: 'Сохранить черновик' }))
    expect(screen.getByLabelText('Текст новости')).toBeDisabled()
    expect(screen.getByLabelText('Заголовок')).toBeDisabled()
    resolveCreate?.({ ...draft, title: 'Title', body: 'Версия 1' })
    await screen.findByRole('heading', { name: 'Title' })
    expect(screen.getByLabelText('Текст новости')).toHaveValue('Версия 1')
  })

  it('keeps denied create content copyable and prevents resubmitting after 403', async () => {
    apiFetch.mockImplementation((path: string | URL | Request, init?: RequestInit) => {
      if (String(path) === '/api/v1/staff/news' && init?.method === 'POST')
        return Promise.reject(new ApiClientError('forbidden', 'forbidden', 403))
      return Promise.resolve({ items: [], next_cursor: null })
    })
    const user = userEvent.setup()
    renderPage('/staff/news/new')
    await user.type(await screen.findByLabelText('Заголовок'), 'Title to copy')
    await user.type(screen.getByLabelText('Текст новости'), 'Body to copy')
    await user.click(screen.getByRole('button', { name: 'Сохранить черновик' }))

    expect(await screen.findByText('Доступ к созданию новостей запрещён')).toBeInTheDocument()
    const title = screen.getByLabelText('Заголовок')
    const body = screen.getByLabelText('Текст новости')
    expect(title).toHaveValue('Title to copy')
    expect(body).toHaveValue('Body to copy')
    expect(title).toHaveAttribute('readonly')
    expect(body).toHaveAttribute('readonly')
    expect(screen.queryByRole('button', { name: 'Сохранить черновик' })).not.toBeInTheDocument()

    await user.click(title)
    await user.keyboard('{Enter}')
    expect(apiFetch.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1)
    expect(title.closest('form')).toBeNull()
  })

  it('removes protected list data after a confirmed 403 refetch', async () => {
    apiFetch.mockResolvedValue({ items: [draft], next_cursor: null })
    const { queryClient } = renderPage()
    expect(await screen.findByText(draft.title)).toBeInTheDocument()
    act(() => {
      queryClient
        .getQueryCache()
        .find({ queryKey: ['staff-news'] })
        ?.setState({
          error: new ApiClientError('forbidden', 'forbidden', 403),
          status: 'error',
          fetchStatus: 'idle',
        })
    })
    await screen.findByText('У вас отозвано право публикации новостей.')
    expect(screen.queryByText(draft.title)).not.toBeInTheDocument()
    expect(queryClient.getQueryData(['staff-news'])).toBeUndefined()
    expect(screen.queryByRole('link', { name: 'Создать новость' })).not.toBeInTheDocument()
  })

  it('keeps cached list rows visible on an ordinary network failure', async () => {
    apiFetch.mockResolvedValue({ items: [draft], next_cursor: null })
    const { queryClient } = renderPage()
    expect(await screen.findByText(draft.title)).toBeInTheDocument()
    act(() => {
      queryClient
        .getQueryCache()
        .find({ queryKey: ['staff-news'] })
        ?.setState({
          error: new ApiClientError('network', 'network_error', 503),
          status: 'error',
          fetchStatus: 'idle',
        })
    })
    await screen.findByText('Не удалось загрузить список')
    expect(screen.getByText(draft.title)).toBeInTheDocument()
  })

  it('shows distinct publication statuses for drafts, published and unpublished news', async () => {
    const published = {
      ...draft,
      id: '42',
      title: 'Published university update',
      is_published: true,
      published_at: '2026-11-15T12:00:00Z',
    }
    const unpublished = {
      ...draft,
      id: '43',
      title: 'Unpublished university update',
      published_at: '2026-11-14T12:00:00Z',
    }
    apiFetch.mockResolvedValue({ items: [draft, published, unpublished], next_cursor: null })
    renderPage()

    const draftRow = await screen.findByRole('link', { name: /Новая официальная новость/ })
    expect(draftRow).toHaveTextContent('Черновик')
    expect(
      screen.getByRole('link', { name: /Опубликована.*Published university update/ }),
    ).toHaveTextContent('Опубликована')
    expect(
      screen.getByRole('link', { name: /Снята с публикации.*Unpublished university update/ }),
    ).toHaveTextContent('Снята с публикации')
  })

  it('keeps the historical publication date visible as unpublished status after unpublish', async () => {
    const published = { ...draft, is_published: true, published_at: '2026-11-15T12:00:00Z' }
    const unpublished = { ...published, is_published: false, version: 2 }
    apiFetch.mockImplementation((path: string | URL | Request) => {
      if (String(path).endsWith('/unpublish')) return Promise.resolve(unpublished)
      if (String(path) === '/api/v1/staff/news/41') return Promise.resolve(published)
      return Promise.resolve({ items: [unpublished], next_cursor: null })
    })
    const user = userEvent.setup()
    const { queryClient } = renderPage('/staff/news/41')
    await screen.findByText(/Опубликована/)
    await user.click(screen.getByRole('button', { name: 'Снять с публикации' }))

    expect(await screen.findByText('Снята с публикации')).toBeInTheDocument()
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/v1/staff/news/41/unpublish',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(queryClient.getQueryData(['staff-news', '41'])).toEqual(unpublished)
    expect(queryClient.getQueryData(['staff-news', '41'])).toMatchObject({
      is_published: false,
      published_at: published.published_at,
    })
  })

  it('counts and limits titles by Unicode code points', async () => {
    apiFetch.mockResolvedValue({ items: [], next_cursor: null })
    renderPage('/staff/news/new')
    const title = await screen.findByLabelText('Заголовок')
    fireEvent.change(title, { target: { value: '😀'.repeat(100) } })
    expect(screen.getByText('100/200')).toBeInTheDocument()
    fireEvent.change(title, { target: { value: '😀'.repeat(101) } })
    expect(screen.getByText('101/200')).toBeInTheDocument()
    fireEvent.change(title, { target: { value: '😀'.repeat(200) } })
    expect(screen.getByText('200/200')).toBeInTheDocument()
    fireEvent.change(title, { target: { value: '😀'.repeat(201) } })
    expect(title).toHaveValue('😀'.repeat(200))
  })

  it('counts and limits long supplementary-plane news text by code points', async () => {
    apiFetch.mockResolvedValue({ items: [], next_cursor: null })
    renderPage('/staff/news/new')
    const body = await screen.findByLabelText('Текст новости')
    fireEvent.change(body, { target: { value: '😀'.repeat(20_000) } })
    expect(screen.getByText('20000/20 000')).toBeInTheDocument()
    fireEvent.change(body, { target: { value: '😀'.repeat(20_001) } })
    expect(body).toHaveValue('😀'.repeat(20_000))
  })

  it('reports partial publication failure and clears it after a successful save', async () => {
    let version = 1
    apiFetch.mockImplementation((path: string | URL | Request, init?: RequestInit) => {
      if (String(path) === '/api/v1/staff/news/41' && init?.method === 'PATCH') {
        version += 1
        return Promise.resolve({ ...draft, version })
      }
      if (String(path) === '/api/v1/staff/news/41/publish')
        return Promise.reject(new ApiClientError('server error', 'internal_error', 500))
      if (String(path) === '/api/v1/staff/news/41') return Promise.resolve({ ...draft, version })
      return Promise.resolve({ items: [draft], next_cursor: null })
    })
    const user = userEvent.setup()
    renderPage('/staff/news/41')
    const title = await screen.findByLabelText('Заголовок')
    await user.clear(title)
    await user.type(title, 'Saved content')
    await user.click(screen.getByRole('button', { name: 'Опубликовать' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Изменения сохранены, но опубликовать новость не удалось',
    )
    expect(screen.queryByText('Изменения сохранены.')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Сохранить черновик' }))
    expect(await screen.findByText('Черновик сохранён.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each([
    ['PATCH', false, false],
    ['publish', false, true],
    ['unpublish', true, false],
  ] as const)(
    'hides protected editor after a 403 from %s',
    async (operation, published, editFirst) => {
      const item = {
        ...draft,
        is_published: published,
        published_at: published ? '2026-11-15T12:00:00Z' : null,
      }
      apiFetch.mockImplementation((path: string | URL | Request, init?: RequestInit) => {
        const requestPath = String(path)
        if (
          (operation === 'PATCH' &&
            requestPath === '/api/v1/staff/news/41' &&
            init?.method === 'PATCH') ||
          (operation === 'publish' && requestPath.endsWith('/publish')) ||
          (operation === 'unpublish' && requestPath.endsWith('/unpublish'))
        )
          return Promise.reject(new ApiClientError('forbidden', 'forbidden', 403))
        if (requestPath === '/api/v1/staff/news/41') return Promise.resolve(item)
        return Promise.resolve({ items: [item], next_cursor: null })
      })
      const user = userEvent.setup()
      const { queryClient } = renderPage('/staff/news/41')
      await screen.findByLabelText('Текст новости')
      if (editFirst) {
        await user.clear(screen.getByLabelText('Заголовок'))
        await user.type(screen.getByLabelText('Заголовок'), 'Черновое изменение')
      }
      const action =
        operation === 'PATCH'
          ? screen.getByRole('button', { name: 'Сохранить черновик' })
          : operation === 'publish'
            ? screen.getByRole('button', { name: 'Опубликовать' })
            : screen.getByRole('button', { name: 'Снять с публикации' })
      await user.click(action)
      expect(
        await screen.findByText('У вас больше нет права публикации новостей.'),
      ).toBeInTheDocument()
      expect(screen.queryByText(item.title)).not.toBeInTheDocument()
      expect(screen.queryByText(item.body)).not.toBeInTheDocument()
      expect(queryClient.getQueryData(['staff-news', '41'])).toBeUndefined()
    },
  )

  it.each([422, 500])(
    'does not publish or claim saved when PATCH fails with %i',
    async (status) => {
      apiFetch.mockImplementation((path: string | URL | Request, init?: RequestInit) => {
        const requestPath = String(path)
        if (requestPath === '/api/v1/staff/news/41' && init?.method === 'PATCH')
          return Promise.reject(new ApiClientError('save failed', 'save_failed', status))
        if (requestPath === '/api/v1/staff/news/41') return Promise.resolve(draft)
        return Promise.resolve({ items: [draft], next_cursor: null })
      })
      const user = userEvent.setup()
      renderPage('/staff/news/41')
      const title = await screen.findByLabelText('Заголовок')
      await user.clear(title)
      await user.type(title, 'Unsaved title')
      await user.click(screen.getByRole('button', { name: 'Опубликовать' }))
      expect(await screen.findByRole('alert')).toBeInTheDocument()
      expect(screen.getByLabelText('Заголовок')).toHaveValue('Unsaved title')
      expect(screen.queryByText(/Изменения сохранены, но опубликовать/)).not.toBeInTheDocument()
      expect(apiFetch.mock.calls.some((call) => String(call[0]).endsWith('/publish'))).toBe(false)
    },
  )
})
