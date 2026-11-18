import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { authEpochStorageKey } from '../auth/authSession'
import {
  clearJournalStorage,
  journalDraftLifetime,
  journalStorageKey,
  readJournalStorage,
} from './journalStorage'
import type { JournalAccess } from './journalQueries'

export type Values = Record<string, string | number | boolean | null>
export type Operation = {
  method: 'PUT' | 'PATCH' | 'DELETE'
  body?: Values
  readPath?: string
  expected: Values
}
type Entry = {
  draft?: Record<string, string>
  baseline?: string
  operation?: Operation
  phase?: 'saving' | 'uncertain' | 'error' | 'saved'
  message?: string
}
type Entries = Record<string, Entry>

export function journalScope(access: JournalAccess) {
  return JSON.stringify([localStorage.getItem(authEpochStorageKey) ?? 'initial', ...access])
}

const Edits = createContext<{
  entries: Entries
  update: (key: string, change: (entry: Entry) => Entry) => void
  active: Map<string, AbortController>
} | null>(null)

export function JournalEdits({ access, children }: { access: JournalAccess; children: ReactNode }) {
  const [scope] = useState(() => journalScope(access))
  const [entries, setEntries] = useState<Entries>(() => {
    const saved = readJournalStorage()
    if (saved?.scope !== scope) return {}
    return Object.fromEntries(
      Object.entries(saved.entries as Entries).map(([key, entry]) => [
        key,
        entry.phase === 'saving' ? { ...entry, phase: 'uncertain' } : entry,
      ]),
    )
  })
  const current = useRef(entries)
  const [active] = useState(() => new Map<string, AbortController>())
  const mounted = useRef(false)
  useLayoutEffect(() => {
    mounted.current = true
    const operations = active
    return () => {
      mounted.current = false
      for (const operation of operations.values()) operation.abort()
      operations.clear()
    }
  }, [active])

  function update(key: string, change: (entry: Entry) => Entry) {
    if (!mounted.current || journalScope(access) !== scope) return
    const next = { ...current.current, [key]: change(current.current[key] ?? {}) }
    current.current = next
    setEntries(next)
    const pending = Object.fromEntries(
      Object.entries(next).filter(([, entry]) => entry.draft || entry.operation),
    )
    try {
      if (Object.keys(pending).length) {
        sessionStorage.setItem(
          journalStorageKey,
          JSON.stringify({
            scope,
            entries: pending,
            expires: Date.now() + journalDraftLifetime,
          }),
        )
      } else clearJournalStorage()
    } catch {
      clearJournalStorage()
    }
  }

  const hasPending = Object.values(entries).some((entry) => entry.draft || entry.operation)
  return (
    <Edits.Provider value={{ entries, update, active }}>
      {hasPending && (
        <p role="status">
          Есть несохранённые или неподтверждённые изменения. Перезагрузка сохраняет их в этой
          вкладке на срок до 30 минут.
        </p>
      )}
      {children}
    </Edits.Provider>
  )
}

export function useJournalEdit(key: string) {
  const store = useContext(Edits)
  if (!store) throw new Error('JournalEdits is required')
  return {
    entry: store.entries[key] ?? {},
    update: (change: (entry: Entry) => Entry) => store.update(key, change),
    active: store.active,
  }
}
