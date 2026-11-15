import { createContext, useContext, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { ApiClientError } from '../api/client'

const AccessSuspendedContext = createContext(false)
export const useAccessSuspended = () => useContext(AccessSuspendedContext)

export function isTemporaryAccessError(error: unknown) {
  return error instanceof ApiClientError && (error.status === undefined || error.status >= 500)
}

// Only retain a previously authorized tree during a temporary read failure.
// The access guards unmount this boundary on denial or auth generation change.
// Keep effects/state alive: in-flight POST results and the router/beforeunload
// protections must survive. Focus/modal effects explicitly observe suspension.
export function AccessRecovery({
  blocked,
  fallback,
  children,
}: {
  blocked: boolean
  fallback: ReactNode
  children: ReactNode
}) {
  const parentSuspended = useAccessSuspended()
  const content = useRef<HTMLDivElement>(null)
  const recovery = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const wasBlocked = useRef(false)
  useLayoutEffect(() => {
    if (parentSuspended) return
    if (blocked) {
      if (!wasBlocked.current) {
        previousFocus.current ??=
          document.activeElement instanceof HTMLElement ? document.activeElement : null
      }
      // Modal/portal layout effects release their locks before this parent effect.
      recovery.current?.focus({ preventScroll: true })
    } else if (wasBlocked.current) {
      const target = previousFocus.current
      if (!content.current?.contains(document.activeElement)) {
        if (
          target?.isConnected &&
          !target.closest('[hidden], [inert]') &&
          !target.matches(':disabled')
        )
          target.focus({ preventScroll: true })
        else
          content.current
            ?.querySelector<HTMLElement>('main[tabindex]')
            ?.focus({ preventScroll: true })
      }
      previousFocus.current = null
    }
    wasBlocked.current = blocked
  }, [blocked, parentSuspended])
  return (
    <>
      <AccessSuspendedContext.Provider value={blocked || parentSuspended}>
        <div
          ref={content}
          onFocusCapture={(event) => {
            if (!blocked && !parentSuspended) previousFocus.current = event.target
          }}
          className="access-recovery-content"
          hidden={blocked}
          inert={blocked}
          aria-hidden={blocked || undefined}
        >
          {children}
        </div>
      </AccessSuspendedContext.Provider>
      {blocked && (
        <div ref={recovery} tabIndex={-1} role="region" aria-label="Восстановление доступа">
          {fallback}
        </div>
      )}
    </>
  )
}
