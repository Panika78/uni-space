import { createContext, useContext, useEffect, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { configureApiAuth } from '../../shared/api/client'
import { AuthSession, authStorageKey, authEpochStorageKey } from './authSession'

const AuthContext = createContext<AuthSession | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [session] = useState(() => new AuthSession(queryClient))
  useEffect(() => {
    configureApiAuth(session.beginRequest)
    const handleStorage = (event: StorageEvent) => {
      if (event.key === authStorageKey || event.key === authEpochStorageKey || event.key === null)
        session.synchronize()
    }
    window.addEventListener('storage', handleStorage)
    window.addEventListener('pageshow', session.synchronize)
    window.addEventListener('focus', session.synchronize)
    void session.start()
    return () => {
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener('pageshow', session.synchronize)
      window.removeEventListener('focus', session.synchronize)
    }
  }, [session])
  return <AuthContext.Provider value={session}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const session = useContext(AuthContext)
  if (!session) throw new Error('AuthProvider is required')
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
  return { ...state, login: session.login, logout: session.logout }
}
