import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from './AuthProvider'

export function LogoutConfirmation({
  onClose,
  onReturnFocus,
}: {
  onClose: () => void
  onReturnFocus?: () => void
}) {
  const { logout } = useAuth()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const hasConfirmed = useRef(false)
  const titleId = useId()

  useEffect(() => {
    const dialog = dialogRef.current!
    const previousOverflow = document.body.style.overflow
    dialog.showModal()
    document.body.style.overflow = 'hidden'
    return () => {
      dialog.close()
      document.body.style.overflow = previousOverflow
    }
  }, [])

  const closeDialog = () => {
    dialogRef.current?.close()
    onClose()
    onReturnFocus?.()
  }

  return createPortal(
    <dialog
      ref={dialogRef}
      className="logout-dialog"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return
        const buttons = event.currentTarget.querySelectorAll('button')
        const first = buttons[0]
        const last = buttons[buttons.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }}
      onCancel={(event) => {
        event.preventDefault()
        closeDialog()
      }}
    >
      <h2 id={titleId}>Выйти из аккаунта?</h2>
      <div className="logout-dialog__actions">
        <button type="button" autoFocus onClick={closeDialog}>
          Отмена
        </button>
        <button
          type="button"
          onClick={() => {
            if (hasConfirmed.current) return
            hasConfirmed.current = true
            closeDialog()
            void logout()
          }}
        >
          Выйти
        </button>
      </div>
    </dialog>,
    document.body,
  )
}
