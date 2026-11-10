import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { LogoutConfirmation } from './LogoutConfirmation'
const logout = vi.hoisted(() => vi.fn())
vi.mock('./AuthProvider', () => ({ useAuth: () => ({ logout }) }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
it.each(['cancel', 'escape'])('closes on %s without ending the session', async (action) => {
  const onClose = vi.fn()
  const onReturnFocus = vi.fn()
  document.body.style.overflow = 'auto'
  const { unmount } = render(<LogoutConfirmation onClose={onClose} onReturnFocus={onReturnFocus} />)
  const dialog = screen.getByRole('dialog', { name: 'Выйти из аккаунта?' })
  expect(screen.getByRole('button', { name: 'Отмена' })).toHaveFocus()
  expect(document.body.style.overflow).toBe('hidden')
  expect(logout).not.toHaveBeenCalled()
  if (action === 'cancel')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Отмена' }))
  else fireEvent(dialog, new Event('cancel', { cancelable: true }))
  expect(onClose).toHaveBeenCalledOnce()
  expect(onReturnFocus).toHaveBeenCalledOnce()
  expect(logout).not.toHaveBeenCalled()
  unmount()
  expect(document.body.style.overflow).toBe('auto')
  document.body.style.overflow = ''
})
it('calls the existing logout once only after confirmation', async () => {
  render(<LogoutConfirmation onClose={vi.fn()} />)
  const confirm = screen.getByRole('button', { name: 'Выйти' })
  await userEvent.setup().dblClick(confirm)
  expect(logout).toHaveBeenCalledOnce()
})

it('keeps Tab and Shift+Tab within the dialog', async () => {
  const user = userEvent.setup()
  render(<LogoutConfirmation onClose={vi.fn()} />)
  const cancel = screen.getByRole('button', { name: 'Отмена' })
  const confirm = screen.getByRole('button', { name: 'Выйти' })
  await user.tab({ shift: true })
  expect(confirm).toHaveFocus()
  await user.tab()
  expect(cancel).toHaveFocus()
  await user.tab()
  expect(confirm).toHaveFocus()
  expect(logout).not.toHaveBeenCalled()
})
