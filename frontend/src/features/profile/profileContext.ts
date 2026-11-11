import { createContext, useContext } from 'react'
import type { components } from '../../shared/api/schema'
export type Profile = components['schemas']['StudentProfile']
export const ProfileContext = createContext<Profile | null>(null)

export function useStudentProfile() {
  return useContext(ProfileContext)
}

export function getStudentInitials(fullName?: string) {
  return (
    fullName
      ?.trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toLocaleUpperCase('ru'))
      .join('') || '—'
  )
}
