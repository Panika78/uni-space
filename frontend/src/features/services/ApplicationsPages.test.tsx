import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiClientError } from '../../shared/api/client'
import { ApplicationDetailPage, ApplicationsList } from './ApplicationsPages'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('../../shared/api/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  apiFetch,
}))
afterEach(() => {
  cleanup()
  apiFetch.mockReset()
})
const item = {
  id: '27',
  service: { id: '1', title: 'Справка об обучении', code: 'study_certificate' },
  form_data: { place_of_submission: 'Канцелярия' },
  review_status: 'submitted',
  document_status: 'pending',
  feedback: null,
  created_at: '2026-11-01T12:00:00Z',
  updated_at: '2026-11-01T12:00:00Z',
}
function mount(path = '/services') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      { path: '/services', element: <ApplicationsList /> },
      { path: '/other', element: <p>Другой раздел</p> },
      { path: '/applications/:id', element: <ApplicationDetailPage /> },
    ],
    { initialEntries: [path] },
  )
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { client, router }
}

function expectDeniedList() {
  expect(screen.getByRole('alert')).toHaveTextContent('Доступ к заявлениям запрещён')
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
  expect(screen.queryByRole('link', { name: /№ / })).not.toBeInTheDocument()
  expect(screen.queryByText(/Загружено заявлений/)).not.toBeInTheDocument()
  expect(screen.queryByText('Подано')).not.toBeInTheDocument()
  expect(document.querySelector('time')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Показать ещё' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument()
}

it('shows denied without data or retry on the first list request returning 403', async () => {
  apiFetch.mockRejectedValueOnce(new ApiClientError('forbidden', 'forbidden', 403))
  mount()
  await screen.findByRole('alert')
  expectDeniedList()
})

it('hides cached rows after a forbidden refetch and restores them only after a successful GET', async () => {
  apiFetch
    .mockResolvedValueOnce({ items: [item], next_cursor: 'next' })
    .mockRejectedValueOnce(new ApiClientError('forbidden', 'forbidden', 403))
  const { client } = mount()
  const link = await screen.findByRole('link', { name: /№ 27/ })
  link.focus()
  client.setQueryData(['unrelated'], 'preserved')
  await act(async () => {
    await client.refetchQueries({ queryKey: ['applications'], exact: true })
  })
  await screen.findByRole('alert')
  expectDeniedList()
  expect(screen.getByRole('heading', { name: 'Мои заявления' })).toHaveFocus()
  expect(client.getQueryData(['applications'])).toBeUndefined()
  expect(client.getQueryData(['unrelated'])).toBe('preserved')
  apiFetch.mockRejectedValueOnce(new ApiClientError('server', 'server_error', 500))
  await act(async () => {
    await client.refetchQueries({ queryKey: ['applications'], exact: true })
  })
  await screen.findByText('Не удалось загрузить заявления')
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
  expect(client.getQueryData(['applications'])).toBeUndefined()
  let finish!: (value: unknown) => void
  apiFetch.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
  let refetch!: Promise<void>
  await act(async () => {
    refetch = client.refetchQueries({ queryKey: ['applications'], exact: true })
  })
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
  await act(async () => {
    finish({ items: [item], next_cursor: null })
    await refetch
  })
  await screen.findByRole('link', { name: /№ 27/ })
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('hides all cached pages when appending a third page is forbidden', async () => {
  apiFetch
    .mockResolvedValueOnce({ items: [item], next_cursor: 'second' })
    .mockResolvedValueOnce({ items: [{ ...item, id: '26' }], next_cursor: 'third' })
    .mockRejectedValueOnce(new ApiClientError('forbidden', 'forbidden', 403))
  const { client } = mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Показать ещё' }))
  await screen.findByRole('link', { name: /№ 26/ })
  const more = screen.getByRole('button', { name: 'Показать ещё' })
  more.focus()
  fireEvent.click(more)
  await screen.findByRole('alert')
  expectDeniedList()
  expect(screen.getByRole('heading', { name: 'Мои заявления' })).toHaveFocus()
  expect(client.getQueryData(['applications'])).toBeUndefined()
})

it.each([
  new ApiClientError('server', 'server_error', 500),
  new ApiClientError('offline', 'network_error'),
])('retains the complete stale snapshot and retry after $code', async (failure) => {
  apiFetch
    .mockResolvedValueOnce({ items: [item], next_cursor: 'next' })
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce({ items: [{ ...item, review_status: 'approved' }], next_cursor: null })
  const { client } = mount()
  await screen.findByRole('link', { name: /№ 27/ })
  await act(async () => {
    await client.refetchQueries({ queryKey: ['applications'], exact: true })
  })
  await screen.findByRole('alert')
  expect(screen.getByRole('link', { name: /№ 27/ })).toBeInTheDocument()
  expect(screen.getByText(/Их данные могут быть неактуальны/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Показать ещё' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
  await screen.findByText('Одобрено')
})

it('appends pages and retains the list when returning from separate details', async () => {
  apiFetch
    .mockResolvedValueOnce({ items: [item], next_cursor: 'next' })
    .mockResolvedValueOnce({ items: [{ ...item, id: '26' }], next_cursor: null })
    .mockResolvedValueOnce(item)
    .mockResolvedValueOnce({ items: [item], next_cursor: 'next' })
    .mockResolvedValueOnce({ items: [{ ...item, id: '26' }], next_cursor: null })
  mount()
  await screen.findByRole('link', { name: /№ 27/ })
  fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }))
  await screen.findByRole('link', { name: /№ 26/ })
  expect(apiFetch.mock.calls[1][0]).toBe('/api/v1/applications?limit=20&cursor=next')
  fireEvent.click(screen.getByRole('link', { name: /№ 27/ }))
  const heading = await screen.findByRole('heading', { name: 'Заявление № 27' })
  expect(heading).toHaveFocus()
  expect(screen.getByText('Канцелярия')).toBeInTheDocument()
  expect(screen.getByText('Подано')).toBeInTheDocument()
  expect(screen.getByText('Ожидает подготовки')).toBeInTheDocument()
  expect(screen.queryByText(/PDF|История/)).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('link', { name: /К моим заявлениям/ }))
  await screen.findByRole('link', { name: /№ 26/ })
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(5))
  await waitFor(() => expect(screen.getByRole('link', { name: /№ 27/ })).toHaveFocus())
})
it('restores source row focus if a background list refresh loses it', async () => {
  const refresh = createDeferred<{ items: (typeof item)[]; next_cursor: null }>()
  apiFetch
    .mockResolvedValueOnce({ items: [item], next_cursor: null })
    .mockResolvedValueOnce(item)
    .mockImplementationOnce(() => refresh.promise)
  mount()
  fireEvent.click(await screen.findByRole('link', { name: /№ 27/ }))
  await screen.findByRole('heading', { name: 'Заявление № 27' })
  fireEvent.click(screen.getByRole('link', { name: /К моим заявлениям/ }))
  const link = await screen.findByRole('link', { name: /№ 27/ })
  await waitFor(() => expect(link).toHaveFocus())

  // Model a browser focus reset while React Query refetches cached rows.
  link.blur()
  expect(document.body).toHaveFocus()
  await act(async () => {
    refresh.resolve({ items: [item], next_cursor: null })
    await refresh.promise
  })
  await waitFor(() => expect(screen.getByRole('link', { name: /№ 27/ })).toHaveFocus())
})

it('offers retry after an error and shows an empty list', async () => {
  apiFetch
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ items: [], next_cursor: null })
  mount()
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
  await screen.findByText('Вы ещё не подавали заявлений')
})
it('shows detail errors, retry and independent statuses with feedback', async () => {
  apiFetch.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({
    ...item,
    review_status: 'approved',
    document_status: 'failed',
    feedback: 'Комментарий',
  })
  mount('/applications/27')
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
  await screen.findByText('Комментарий')
  expect(screen.getByText('Одобрено')).toBeInTheDocument()
  expect(screen.getByText('Ошибка подготовки')).toBeInTheDocument()
})
it('passes cancellation signals for private queries', async () => {
  apiFetch.mockImplementation(
    (_path, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      ),
  )
  const { client } = mount()
  await screen.findByText('Загружаем заявления…')
  const signal = apiFetch.mock.calls[0][1].signal
  await client.cancelQueries()
  client.clear()
  expect(signal.aborted).toBe(true)
  expect(screen.queryByRole('link', { name: /№ 27/ })).not.toBeInTheDocument()
})

it('refreshes every loaded page with fresh cursors after returning from details', async () => {
  let refreshed = false
  apiFetch.mockImplementation((path: string) => {
    if (path === '/api/v1/applications/27') return Promise.resolve(item)
    if (!path.includes('cursor='))
      return Promise.resolve({
        items: [{ ...item, review_status: refreshed ? 'approved' : 'submitted' }],
        next_cursor: refreshed ? 'fresh' : 'next',
      })
    return Promise.resolve({ items: [{ ...item, id: '26' }], next_cursor: null })
  })
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Показать ещё' }))
  await screen.findByRole('link', { name: /№ 26/ })
  refreshed = true
  fireEvent.click(screen.getByRole('link', { name: /№ 27/ }))
  await screen.findByRole('heading', { name: 'Заявление № 27' })
  fireEvent.click(screen.getByRole('link', { name: /К моим заявлениям/ }))
  await screen.findByText('Одобрено')
  expect(screen.getAllByRole('link', { name: /№ / })).toHaveLength(2)
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(5))
  expect(apiFetch.mock.calls[4][0]).toBe('/api/v1/applications?limit=20&cursor=fresh')
})

for (const failure of [
  new ApiClientError('missing', 'not_found', 404),
  new ApiClientError('forbidden', 'forbidden', 403),
  new ApiClientError('offline', 'network_error'),
]) {
  it(`hides cached details after ${failure.code} and recovers after retry`, async () => {
    apiFetch
      .mockResolvedValueOnce({ ...item, feedback: 'Private feedback' })
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(item)
    const { client } = mount('/applications/27')
    await screen.findByText('Private feedback')
    await act(async () => {
      await client.refetchQueries({ queryKey: ['applications', 'detail', '27'] })
    })
    await screen.findByRole('alert')
    expect(client.getQueryData(['applications', 'detail', '27'])).toBeDefined()
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    for (const text of [
      'Канцелярия',
      'Private feedback',
      'Подано',
      'Ожидает подготовки',
      'Справка об обучении',
    ])
      expect(screen.queryByText(text)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    await screen.findByRole('heading', { name: 'Заявление № 27' })
    expect(screen.getByText('Канцелярия')).toBeInTheDocument()
  })
}

it('refreshes cached pages when the list is opened again and keeps old pages if refresh fails', async () => {
  apiFetch
    .mockResolvedValueOnce({ items: [item], next_cursor: 'next' })
    .mockResolvedValueOnce({ items: [{ ...item, id: '26' }], next_cursor: null })
    .mockRejectedValueOnce(new Error('offline'))
  const { router, client } = mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Показать ещё' }))
  await screen.findByRole('link', { name: /№ 26/ })
  await act(async () => {
    await router.navigate('/other')
  })
  await act(async () => {
    await router.navigate('/services')
  })
  await screen.findByRole('alert')
  expect(screen.getByText(/Их данные могут быть неактуальны/)).toBeInTheDocument()
  expect(screen.getAllByRole('link', { name: /№ / })).toHaveLength(2)
  expect(client.getQueryData<{ pages: unknown[] }>(['applications'])?.pages).toHaveLength(2)
  apiFetch
    .mockResolvedValueOnce({
      items: [{ ...item, review_status: 'approved' }],
      next_cursor: 'fresh',
    })
    .mockResolvedValueOnce({ items: [{ ...item, id: '26' }], next_cursor: null })
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
  await screen.findByText('Одобрено')
  expect(screen.getAllByRole('link', { name: /№ / })).toHaveLength(2)
  expect(apiFetch).toHaveBeenCalledTimes(5)
})

it('returns focus to the list heading when the source record disappears after refresh', async () => {
  apiFetch
    .mockResolvedValueOnce({ items: [item], next_cursor: null })
    .mockResolvedValueOnce(item)
    .mockResolvedValueOnce({ items: [], next_cursor: null })
  const { client } = mount()
  fireEvent.click(await screen.findByRole('link', { name: /№ 27/ }))
  await screen.findByRole('heading', { name: 'Заявление № 27' })
  fireEvent.click(screen.getByRole('link', { name: /К моим заявлениям/ }))
  await screen.findByText('Вы ещё не подавали заявлений')
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Мои заявления' })).toHaveFocus())
  expect(screen.queryByRole('link', { name: /№ 27/ })).not.toBeInTheDocument()
  expect(client.getQueryData(['applications', 'return-focus'])).toBeUndefined()
})

it('keeps the previous snapshot if a later refresh page fails and retries the whole selection', async () => {
  const older = { ...item, id: '26' }
  const newest = { ...item, id: '28' }
  apiFetch
    .mockResolvedValueOnce({ items: [item], next_cursor: 'old' })
    .mockResolvedValueOnce({ items: [older], next_cursor: null })
    .mockResolvedValueOnce(item)
    .mockResolvedValueOnce({ items: [newest], next_cursor: 'fresh' })
    .mockRejectedValueOnce(new Error('second page offline'))
    .mockResolvedValueOnce({ items: [newest], next_cursor: 'fresh' })
    .mockResolvedValueOnce({ items: [item, older], next_cursor: null })
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Показать ещё' }))
  await screen.findByRole('link', { name: /№ 26/ })
  fireEvent.click(screen.getByRole('link', { name: /№ 27/ }))
  await screen.findByRole('heading', { name: 'Заявление № 27' })
  fireEvent.click(screen.getByRole('link', { name: /К моим заявлениям/ }))
  await screen.findByRole('alert')
  expect(screen.getAllByRole('link', { name: /№ / }).map((link) => link.textContent)).toEqual([
    'Справка об обучении · № 27',
    'Справка об обучении · № 26',
  ])
  expect(screen.queryByRole('link', { name: /№ 28/ })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
  await screen.findByRole('link', { name: /№ 28/ })
  expect(screen.getAllByRole('link', { name: /№ / }).map((link) => link.textContent)).toEqual([
    'Справка об обучении · № 28',
    'Справка об обучении · № 27',
    'Справка об обучении · № 26',
  ])
  expect(apiFetch).toHaveBeenCalledTimes(7)
  expect(apiFetch.mock.calls[4][0]).toBe('/api/v1/applications?limit=20&cursor=fresh')
  expect(apiFetch.mock.calls[6][0]).toBe('/api/v1/applications?limit=20&cursor=fresh')
})

it('records the private return target without clearing a list refresh error', async () => {
  const failure = new Error('offline')
  apiFetch
    .mockResolvedValueOnce({ items: [item], next_cursor: null })
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(item)
  const { client } = mount()
  await screen.findByRole('link', { name: /№ 27/ })
  await act(async () => {
    await client.refetchQueries({ queryKey: ['applications'], exact: true })
  })
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('link', { name: /№ 27/ }))
  await screen.findByRole('heading', { name: 'Заявление № 27' })
  expect(client.getQueryState(['applications'])?.status).toBe('error')
  expect(client.getQueryState(['applications'])?.error).toBe(failure)
  expect(client.getQueryData(['applications', 'return-focus'])).toMatchObject({ id: '27' })
  client.removeQueries({ queryKey: ['applications'] })
  expect(client.getQueryData(['applications', 'return-focus'])).toBeUndefined()
})

function createApplications(count: number) {
  return Array.from({ length: count }, (_, index) => ({ ...item, id: String(count - index) }))
}
function selectApplicationPage(rows: ReturnType<typeof createApplications>, cursor: string | null) {
  const remaining = cursor ? rows.filter((row) => Number(row.id) < Number(cursor.slice(7))) : rows
  const selected = remaining.slice(0, 20)
  return {
    items: selected,
    next_cursor: remaining.length > 20 ? `cursor-${selected.at(-1)!.id}` : null,
  }
}
function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}
function getVisibleApplicationIds() {
  return screen
    .getAllByRole('link', { name: /№ / })
    .map((link) => link.textContent?.match(/№ (\d+)$/)?.[1])
}

it('blocks the old cursor after first-page refresh failure and recovers all 26 records', async () => {
  let rows = createApplications(25)
  let failRefresh = false
  const cursors: (string | null)[] = []
  apiFetch.mockImplementation((path: string) => {
    const cursor = new URL(path, 'http://localhost').searchParams.get('cursor')
    cursors.push(cursor)
    return !cursor && failRefresh
      ? Promise.reject(new Error('refresh offline'))
      : Promise.resolve(selectApplicationPage(rows, cursor))
  })
  const { router } = mount()
  await screen.findByRole('link', { name: /№ 6$/ })
  rows = [{ ...item, id: '26', created_at: '2026-11-02T12:00:00Z' }, ...rows]
  failRefresh = true
  await act(async () => {
    await router.navigate('/other')
  })
  await act(async () => {
    await router.navigate('/services')
  })
  await screen.findByRole('alert')
  expect(getVisibleApplicationIds()).toEqual(
    createApplications(25)
      .slice(0, 20)
      .map((row) => row.id),
  )
  expect(screen.getByText(/Их данные могут быть неактуальны/)).toBeInTheDocument()
  const before = [...cursors]
  fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }))
  await act(async () => {})
  expect(cursors).toEqual(before)
  expect(screen.getByRole('button', { name: 'Показать ещё' })).toBeDisabled()
  failRefresh = false
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
  await screen.findByRole('link', { name: /№ 26$/ })
  expect(screen.getByRole('button', { name: 'Показать ещё' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }))
  await screen.findByRole('link', { name: /№ 1$/ })
  expect(getVisibleApplicationIds()).toEqual(rows.map((row) => row.id))
  expect(cursors).toEqual([null, null, null, 'cursor-7'])
})

it('blocks pagination after a second refresh page fails and deduplicates full-refresh retry', async () => {
  let rows = createApplications(45)
  let failRefresh = false
  let retryGate: ReturnType<
    typeof createDeferred<ReturnType<typeof selectApplicationPage>>
  > | null = null
  const secondRetryGate = createDeferred<ReturnType<typeof selectApplicationPage>>()
  const cursors: (string | null)[] = []
  apiFetch.mockImplementation((path: string) => {
    const cursor = new URL(path, 'http://localhost').searchParams.get('cursor')
    cursors.push(cursor)
    if (!cursor && retryGate) return retryGate.promise
    if (cursor && failRefresh) return Promise.reject(new Error('second refresh page offline'))
    if (cursor === 'cursor-27' && retryGate) return secondRetryGate.promise
    return Promise.resolve(selectApplicationPage(rows, cursor))
  })
  const { router } = mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Показать ещё' }))
  await screen.findByRole('link', { name: /№ 6$/ })
  rows = [{ ...item, id: '46', created_at: '2026-11-02T12:00:00Z' }, ...rows]
  failRefresh = true
  await act(async () => {
    await router.navigate('/other')
  })
  await act(async () => {
    await router.navigate('/services')
  })
  await screen.findByRole('alert')
  expect(getVisibleApplicationIds()).toEqual(
    createApplications(45)
      .slice(0, 40)
      .map((row) => row.id),
  )
  const before = [...cursors]
  fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }))
  await act(async () => {})
  expect(cursors).toEqual(before)
  failRefresh = false
  retryGate = createDeferred()
  act(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }))
  })
  await waitFor(() => expect(cursors).toHaveLength(before.length + 1))
  expect(apiFetch.mock.calls.at(-1)?.[1].signal.aborted).toBe(false)
  await act(async () => {
    retryGate!.resolve(selectApplicationPage(rows, null))
    await retryGate!.promise
  })
  await waitFor(() => expect(cursors).toHaveLength(before.length + 2))
  expect(getVisibleApplicationIds()).toEqual(
    createApplications(45)
      .slice(0, 40)
      .map((row) => row.id),
  )
  expect(screen.getByRole('button', { name: 'Показать ещё' })).toBeDisabled()
  await act(async () => {
    secondRetryGate.resolve(selectApplicationPage(rows, 'cursor-27'))
    await secondRetryGate.promise
  })
  await screen.findByRole('link', { name: /№ 46$/ })
  expect(getVisibleApplicationIds()).toEqual(rows.slice(0, 40).map((row) => row.id))
  fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }))
  await screen.findByRole('link', { name: /№ 1$/ })
  expect(getVisibleApplicationIds()).toEqual(rows.map((row) => row.id))
  expect(cursors).toEqual([null, 'cursor-26', null, 'cursor-27', null, 'cursor-27', 'cursor-7'])
})

it('retries only the failed next page once without losing the valid first page', async () => {
  const rows = createApplications(25)
  const gate = createDeferred<ReturnType<typeof selectApplicationPage>>()
  const cursors: (string | null)[] = []
  apiFetch.mockImplementation((path: string) => {
    const cursor = new URL(path, 'http://localhost').searchParams.get('cursor')
    cursors.push(cursor)
    if (!cursor) return Promise.resolve(selectApplicationPage(rows, null))
    if (cursors.length === 2) return Promise.reject(new Error('next page offline'))
    return gate.promise
  })
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Показать ещё' }))
  await screen.findByRole('alert')
  expect(getVisibleApplicationIds()).toEqual(rows.slice(0, 20).map((row) => row.id))
  expect(screen.getByText('Не удалось загрузить следующую страницу')).toBeInTheDocument()
  expect(screen.getByText(/Их данные могут быть неактуальны/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Показать ещё' })).toBeEnabled()
  act(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }))
  })
  await waitFor(() => expect(cursors).toHaveLength(3))
  expect(apiFetch.mock.calls.at(-1)?.[1].signal.aborted).toBe(false)
  await act(async () => {
    gate.resolve(selectApplicationPage(rows, 'cursor-6'))
    await gate.promise
  })
  await screen.findByRole('link', { name: /№ 1$/ })
  expect(getVisibleApplicationIds()).toEqual(rows.map((row) => row.id))
  expect(cursors).toEqual([null, 'cursor-6', 'cursor-6'])
})
