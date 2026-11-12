import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
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
  expect(apiFetch).toHaveBeenCalledTimes(3)
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
