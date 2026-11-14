import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '../../shared/api/client'
import { NotificationsDrawer } from './NotificationsDrawer'

vi.mock('../../shared/api/client', () => ({ apiFetch: vi.fn() }))

const notification = {
  id: '1',
  type: 'future_type',
  title: '<img src=x onerror=alert(1)>',
  body: '<script>alert(1)</script>\n' + '長'.repeat(400),
  created_at: '2026-11-10T10:00:00Z',
}

describe('NotificationsDrawer', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockResolvedValue({ items: [notification], next_cursor: null })
  })
  afterEach(() => {
    document.body.style.overflow = ''
  })

  it('loads private text, traps focus, locks background scroll, and closes with Escape', async () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const onClose = vi.fn()
    const view = render(<NotificationsDrawer onClose={onClose} />)
    await screen.findByText('Уведомление')
    expect(screen.getByText(notification.title)).toBeTruthy()
    expect(document.querySelector('.notification-item__body')?.textContent).toBe(notification.body)
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('script')).toBeNull()
    expect(document.body.style.overflow).toBe('hidden')
    const close = screen.getAllByRole('button', { name: 'Закрыть уведомления' }).at(-1)!
    expect(close).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(close).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
    view.unmount()
    trigger.focus()
    expect(trigger).toHaveFocus()
    expect(document.body.style.overflow).toBe('')
    trigger.remove()
  })

  it('retries a failed first page and loads later pages without duplicate IDs', async () => {
    vi.mocked(apiFetch)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [notification], next_cursor: 'cursor-1' })
      .mockResolvedValueOnce({
        items: [notification, { ...notification, id: '2' }],
        next_cursor: null,
      })
    render(<NotificationsDrawer onClose={() => undefined} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Повторить' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Показать ещё' }))
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(2))
    expect(screen.getAllByRole('article')).toHaveLength(2)
  })

  it('shows an empty state when the server has no notifications', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ items: [], next_cursor: null })
    render(<NotificationsDrawer onClose={() => undefined} />)
    expect(await screen.findByText('Пока нет уведомлений.')).toBeInTheDocument()
  })

  it.each(['UTC', 'Asia/Tokyo'])(
    'shows Moscow time when the browser timezone is %s',
    async (timezone) => {
      const originalTimezone = process.env.TZ
      process.env.TZ = timezone
      const createdAt = '2026-11-19T23:30:00Z'
      vi.mocked(apiFetch).mockResolvedValueOnce({
        items: [{ ...notification, created_at: createdAt }],
        next_cursor: null,
      })

      try {
        render(<NotificationsDrawer onClose={() => undefined} />)
        const timestamp = await screen.findByText(
          new Intl.DateTimeFormat('ru-RU', {
            dateStyle: 'medium',
            timeStyle: 'short',
            timeZone: 'Europe/Moscow',
          }).format(new Date(createdAt)),
        )
        expect(timestamp).toHaveAttribute('dateTime', createdAt)
        expect(timestamp).toHaveTextContent('20 нояб. 2026 г., 02:30')

        const localTime = new Intl.DateTimeFormat('ru-RU', {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(createdAt))
        expect(localTime).not.toBe(timestamp.textContent)
      } finally {
        if (originalTimezone === undefined) delete process.env.TZ
        else process.env.TZ = originalTimezone
      }
    },
  )

  it('aborts a delayed response when the drawer is unmounted', async () => {
    let resolveFirst!: (page: { items: (typeof notification)[]; next_cursor: null }) => void
    let resolveSecond!: (page: { items: (typeof notification)[]; next_cursor: null }) => void
    vi.mocked(apiFetch)
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)))

    function Harness() {
      const [open, setOpen] = useState(true)
      return open ? (
        <NotificationsDrawer onClose={() => setOpen(false)} />
      ) : (
        <button onClick={() => setOpen(true)}>Открыть снова</button>
      )
    }

    render(<Harness />)
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1))
    const firstSignal = vi.mocked(apiFetch).mock.calls[0][1]?.signal
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Открыть снова' }))
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2))
    expect(firstSignal?.aborted).toBe(true)

    resolveFirst({
      items: [{ ...notification, id: 'old', title: 'Old account' }],
      next_cursor: null,
    })
    await Promise.resolve()
    expect(screen.queryByText('Old account')).not.toBeInTheDocument()
    resolveSecond({
      items: [{ ...notification, id: 'new', title: 'Current account' }],
      next_cursor: null,
    })
    expect(await screen.findByText('Current account')).toBeInTheDocument()
    expect(screen.queryByText('Old account')).not.toBeInTheDocument()
  })

  it('ignores an aborted response after closing and reopening the mounted drawer', async () => {
    let resolveOld!: (page: { items: (typeof notification)[]; next_cursor: null }) => void
    vi.mocked(apiFetch)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve
          }),
      )
      .mockResolvedValueOnce({
        items: [{ ...notification, title: 'Свежие уведомления' }],
        next_cursor: null,
      })
    const view = render(<NotificationsDrawer isOpen onClose={() => undefined} />)
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1))
    view.rerender(<NotificationsDrawer isOpen={false} onClose={() => undefined} />)
    expect(vi.mocked(apiFetch).mock.calls[0][1]?.signal?.aborted).toBe(true)
    view.rerender(<NotificationsDrawer isOpen onClose={() => undefined} />)
    expect(await screen.findByText('Свежие уведомления')).toBeInTheDocument()
    resolveOld({ items: [{ ...notification, title: 'Старый ответ' }], next_cursor: null })
    await waitFor(() => expect(screen.queryByText('Старый ответ')).not.toBeInTheDocument())
    expect(screen.getByText('Свежие уведомления')).toBeInTheDocument()
  })
})
