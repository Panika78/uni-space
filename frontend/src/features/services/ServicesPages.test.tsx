import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import {
  cleanup,
  fireEvent,
  render as testingRender,
  screen,
  waitFor,
} from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { apiFetch, ApiClientError } = vi.hoisted(() => {
  class MockApiClientError extends Error {
    status?: number
    code: string
    details: Array<{ field: string | null; code: string }>

    constructor(
      message: string,
      code: string,
      status?: number,
      details: Array<{ field: string | null; code: string }> = [],
    ) {
      super(message)
      this.status = status
      this.code = code
      this.details = details
    }
  }
  return { apiFetch: vi.fn(), ApiClientError: MockApiClientError }
})
vi.mock('../../shared/api/client', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  ApiClientError,
}))

import { ApplicationFormPage, ServicesPage } from './ServicesPages'

function render(ui: ReactNode) {
  return testingRender(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  apiFetch.mockReset()
})
afterEach(cleanup)

it('loads the real service catalog and offers the separate application form', async () => {
  apiFetch.mockResolvedValue({
    items: [{ id: '4', code: 'study_certificate', title: 'Справка об обучении' }],
  })
  const router = createMemoryRouter(
    [
      { path: '/services', element: <ServicesPage /> },
      { path: '/services/:serviceCode', element: <ApplicationFormPage /> },
    ],
    { initialEntries: ['/services'] },
  )
  render(<RouterProvider router={router} />)
  expect(await screen.findByRole('heading', { name: 'Справка об обучении' })).toBeInTheDocument()
  expect(screen.getByRole('article', { name: 'Справка об обучении' })).toBeInTheDocument()
  expect(screen.getByText('Онлайн')).toBeInTheDocument()
  expect(screen.getByText('Документ')).toBeInTheDocument()
  expect(screen.queryByText(/\d+\s*[–-]\s*\d+\s*дня/)).not.toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Подать заявление' })).toHaveAttribute(
    'href',
    '/services/study_certificate',
  )
  expect(apiFetch).toHaveBeenCalledWith('/api/v1/services', { authenticated: true })
})

it('does not open the study certificate form for an unknown service path', () => {
  const router = createMemoryRouter(
    [{ path: '/services/:serviceCode', element: <ApplicationFormPage /> }],
    { initialEntries: ['/services/unknown_service'] },
  )
  render(<RouterProvider router={router} />)
  expect(screen.getByRole('heading', { name: 'Услуга недоступна' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Вернуться к каталогу' })).toHaveAttribute(
    'href',
    '/services',
  )
})

it('focuses the required field and submits once with trimmed Unicode text', async () => {
  apiFetch.mockResolvedValueOnce({
    id: '73',
    service: { id: '4', code: 'study_certificate', title: 'Справка об обучении' },
    form_data: { place_of_submission: '東京' },
    review_status: 'submitted',
    document_status: 'pending',
    feedback: null,
    created_at: '2026-11-10T00:00:00Z',
    updated_at: '2026-11-10T00:00:00Z',
  })
  const router = createMemoryRouter(
    [{ path: '/services/:serviceCode', element: <ApplicationFormPage /> }],
    { initialEntries: ['/services/study_certificate'] },
  )
  render(<RouterProvider router={router} />)
  fireEvent.click(screen.getByRole('button', { name: 'Отправить заявление' }))
  expect(screen.getByLabelText(/Место предоставления/)).toHaveFocus()
  fireEvent.change(screen.getByLabelText(/Место предоставления/), { target: { value: '  東京  ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Отправить заявление' }))
  await waitFor(() => expect(screen.getByText('№ 73')).toBeInTheDocument())
  expect(apiFetch).toHaveBeenCalledTimes(1)
  expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({
    service_code: 'study_certificate',
    form_data: { place_of_submission: '東京' },
  })
})

it('does not automatically retry an application when the response is lost', async () => {
  apiFetch.mockRejectedValueOnce(new Error('response lost'))
  const router = createMemoryRouter(
    [{ path: '/services/:serviceCode', element: <ApplicationFormPage /> }],
    { initialEntries: ['/services/study_certificate'] },
  )
  render(<RouterProvider router={router} />)
  fireEvent.change(screen.getByLabelText(/Место предоставления/), {
    target: { value: 'Деканат' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Отправить заявление' }))
  expect(await screen.findByText(/заявление могло сохраниться/i)).toBeInTheDocument()
  expect(apiFetch).toHaveBeenCalledTimes(1)
})

it('treats an invalid 201 response as an unknown result without retrying', async () => {
  apiFetch.mockRejectedValueOnce(
    new ApiClientError('Сервер вернул ответ в неизвестном формате', 'invalid_response', 201),
  )
  const router = createMemoryRouter(
    [{ path: '/services/:serviceCode', element: <ApplicationFormPage /> }],
    { initialEntries: ['/services/study_certificate'] },
  )
  render(<RouterProvider router={router} />)
  fireEvent.change(screen.getByLabelText(/Место предоставления/), {
    target: { value: 'Деканат' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Отправить заявление' }))

  expect(await screen.findByRole('alert')).toHaveTextContent(/заявление могло сохраниться/i)
  expect(screen.queryByText(/Номер заявления:/)).not.toBeInTheDocument()
  expect(apiFetch).toHaveBeenCalledTimes(1)
})

it('does not show a confirmation for a malformed successful response', async () => {
  apiFetch.mockResolvedValueOnce({ id: 'not-an-application-id' })
  const router = createMemoryRouter(
    [{ path: '/services/:serviceCode', element: <ApplicationFormPage /> }],
    { initialEntries: ['/services/study_certificate'] },
  )
  render(<RouterProvider router={router} />)
  fireEvent.change(screen.getByLabelText(/Место предоставления/), {
    target: { value: 'Деканат' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Отправить заявление' }))

  expect(await screen.findByRole('alert')).toHaveTextContent(/заявление могло сохраниться/i)
  expect(screen.queryByText(/Номер заявления:/)).not.toBeInTheDocument()
  expect(apiFetch).toHaveBeenCalledTimes(1)
})

it('shows server validation under the field and focuses it', async () => {
  apiFetch.mockRejectedValueOnce(
    new ApiClientError('Проверьте введённые данные', 'validation_error', 422, [
      { field: 'form_data.place_of_submission', code: 'invalid_value' },
    ]),
  )
  const router = createMemoryRouter(
    [{ path: '/services/:serviceCode', element: <ApplicationFormPage /> }],
    { initialEntries: ['/services/study_certificate'] },
  )
  render(<RouterProvider router={router} />)
  const field = screen.getByLabelText(/Место предоставления/)
  fireEvent.change(field, { target: { value: 'valid locally' } })
  fireEvent.click(screen.getByRole('button', { name: 'Отправить заявление' }))
  expect(await screen.findByText('Проверьте значение: от 1 до 300 символов.')).toBeInTheDocument()
  expect(field).toHaveAttribute('aria-invalid', 'true')
  await waitFor(() => expect(field).toHaveFocus())
})

it('uses Python whitespace and Unicode code point boundaries in the form', async () => {
  apiFetch.mockResolvedValueOnce({
    id: '75',
    service: { id: '4', code: 'study_certificate', title: 'Справка об обучении' },
    form_data: { place_of_submission: 'A'.repeat(299) + '😀' },
    review_status: 'submitted',
    document_status: 'pending',
    feedback: null,
    created_at: '2026-11-10T00:00:00Z',
    updated_at: '2026-11-10T00:00:00Z',
  })
  const router = createMemoryRouter(
    [{ path: '/services/:serviceCode', element: <ApplicationFormPage /> }],
    { initialEntries: ['/services/study_certificate'] },
  )
  render(<RouterProvider router={router} />)
  const field = screen.getByLabelText(/Место предоставления/)
  expect(field).toHaveAttribute('required')
  expect(field).toHaveAttribute('aria-required', 'true')
  expect(screen.getByText('Знак * обозначает обязательное поле.')).toBeInTheDocument()
  fireEvent.change(field, { target: { value: '\u0085' + 'A'.repeat(299) + '😀\u0085' } })
  fireEvent.click(screen.getByRole('button', { name: 'Отправить заявление' }))
  expect(await screen.findByText('№ 75')).toBeInTheDocument()
  expect(JSON.parse(apiFetch.mock.calls[0][1].body).form_data.place_of_submission).toBe(
    'A'.repeat(299) + '😀',
  )
})

it('returns from a timed out POST to the editable form without retrying or claiming failure', async () => {
  const timeoutController = new AbortController()
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal)
  apiFetch.mockImplementationOnce(
    (_url: string, options: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        })
      }),
  )
  const router = createMemoryRouter(
    [{ path: '/services/:serviceCode', element: <ApplicationFormPage /> }],
    { initialEntries: ['/services/study_certificate'] },
  )
  render(<RouterProvider router={router} />)
  const field = screen.getByLabelText(/Место предоставления/)
  fireEvent.change(field, { target: { value: 'Офис' } })
  fireEvent.click(screen.getByRole('button', { name: 'Отправить заявление' }))
  expect(apiFetch).toHaveBeenCalledTimes(1)
  expect(AbortSignal.timeout).toHaveBeenCalledWith(30_000)
  expect(apiFetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  timeoutController.abort(new DOMException('Timed out', 'TimeoutError'))
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Отправить заявление' })).toBeEnabled()
  })
  expect(screen.getByRole('alert')).toHaveTextContent(/могло сохраниться/i)
  expect(apiFetch).toHaveBeenCalledTimes(1)
  vi.restoreAllMocks()
})

it('sends only one request while submission is pending', async () => {
  let resolveResponse: (value: unknown) => void = () => undefined
  apiFetch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveResponse = resolve
      }),
  )
  const router = createMemoryRouter(
    [{ path: '/services/:serviceCode', element: <ApplicationFormPage /> }],
    { initialEntries: ['/services/study_certificate'] },
  )
  render(<RouterProvider router={router} />)
  fireEvent.change(screen.getByLabelText(/Место предоставления/), {
    target: { value: 'Деканат' },
  })
  const submit = screen.getByRole('button', { name: 'Отправить заявление' })
  fireEvent.click(submit)
  fireEvent.click(submit)
  expect(apiFetch).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Отправляем…' })).toBeDisabled()
  resolveResponse({
    id: '74',
    service: { id: '4', code: 'study_certificate', title: 'Справка об обучении' },
    form_data: { place_of_submission: 'Деканат' },
    review_status: 'submitted',
    document_status: 'pending',
    feedback: null,
    created_at: '2026-11-10T00:00:00Z',
    updated_at: '2026-11-10T00:00:00Z',
  })
  expect(await screen.findByText('№ 74')).toBeInTheDocument()
})

it('blocks router and Back navigation while a POST is pending and allows waiting', async () => {
  let resolveResponse: (value: unknown) => void = () => undefined
  apiFetch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveResponse = resolve
      }),
  )
  const router = createMemoryRouter(
    [
      { path: '/services/:serviceCode', element: <ApplicationFormPage /> },
      { path: '/schedule', element: <h1>Расписание</h1> },
    ],
    { initialEntries: ['/schedule', '/services/study_certificate'], initialIndex: 1 },
  )
  render(<RouterProvider router={router} />)
  fireEvent.change(screen.getByLabelText(/Место предоставления/), {
    target: { value: 'Деканат' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Отправить заявление' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Отправляем…' })).toBeDisabled())

  await router.navigate('/schedule')
  expect(
    await screen.findByRole('dialog', { name: 'Запрос уже отправлен. Покинуть форму?' }),
  ).toBeInTheDocument()
  expect(screen.getByText(/уход не отменит запрос/i)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Продолжить заполнение' }))
  expect(router.state.location.pathname).toBe('/services/study_certificate')

  await router.navigate(-1)
  expect(
    await screen.findByRole('dialog', { name: 'Запрос уже отправлен. Покинуть форму?' }),
  ).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Продолжить заполнение' }))
  resolveResponse({
    id: '76',
    service: { id: '4', code: 'study_certificate', title: 'Справка об обучении' },
    form_data: { place_of_submission: 'Деканат' },
    review_status: 'submitted',
    document_status: 'pending',
    feedback: null,
    created_at: '2026-11-10T00:00:00Z',
    updated_at: '2026-11-10T00:00:00Z',
  })
  expect(await screen.findByText('№ 76')).toBeInTheDocument()
  expect(apiFetch).toHaveBeenCalledTimes(1)
})

it('does not clear the new account cache when an old POST is aborted', async () => {
  let reject!: (reason: unknown) => void
  apiFetch.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail
      }),
  )
  const client = new QueryClient()
  const router = createMemoryRouter(
    [{ path: '/services/:serviceCode', element: <ApplicationFormPage /> }],
    { initialEntries: ['/services/study_certificate'] },
  )
  const view = testingRender(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  fireEvent.change(screen.getByLabelText(/Место предоставления/), {
    target: { value: 'Old account' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Отправить заявление' }))
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1))
  view.unmount()
  client.clear()
  client.setQueryData(['applications'], { items: [{ id: 'new-account' }] })
  reject(new DOMException('Obsolete session', 'AbortError'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(client.getQueryData(['applications'])).toEqual({ items: [{ id: 'new-account' }] })
})
