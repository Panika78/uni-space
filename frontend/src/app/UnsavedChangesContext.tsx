import { createContext, useContext } from 'react'

interface UnsavedChangesState {
  hasUnsavedChanges: boolean
  setHasUnsavedChanges: (hasUnsavedChanges: boolean) => void
}

const UnsavedChangesContext = createContext<UnsavedChangesState>({
  hasUnsavedChanges: false,
  setHasUnsavedChanges: () => undefined,
})

export const UnsavedChangesProvider = UnsavedChangesContext.Provider
export const useUnsavedChanges = () => useContext(UnsavedChangesContext)
