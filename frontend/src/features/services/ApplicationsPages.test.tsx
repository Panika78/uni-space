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
  expect(screen.getByRole('link', { name: /№ 27/ })).toHaveFocus()
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
  expect(screen.getByRole('heading', { name: 'Мои заявления' })).toHaveFocus()
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
