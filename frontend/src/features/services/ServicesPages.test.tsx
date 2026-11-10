import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('../../shared/api/client', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  ApiClientError: class ApiClientError extends Error {
    status?: number
    code = 'network_error'
  },
}))

import { ApplicationFormPage, ServicesPage } from './ServicesPages'

beforeEach(() => apiFetch.mockReset())
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
