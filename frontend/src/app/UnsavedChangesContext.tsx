import { createContext, useContext } from 'react'

export type ExitProtectionStatus = 'none' | 'draft' | 'submitting' | 'uncertain'

interface UnsavedChangesState {
  status: ExitProtectionStatus
  setStatus: (status: ExitProtectionStatus) => void
}

const UnsavedChangesContext = createContext<UnsavedChangesState>({
  status: 'none',
  setStatus: () => undefined,
})

export const UnsavedChangesProvider = UnsavedChangesContext.Provider
export const useUnsavedChanges = () => useContext(UnsavedChangesContext)
