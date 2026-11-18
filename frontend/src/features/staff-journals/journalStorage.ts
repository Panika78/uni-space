export const journalStorageKey = 'uni-space.staff-journal'
export const journalDraftLifetime = 30 * 60 * 1000

export function clearJournalStorage() {
  try {
    sessionStorage.removeItem(journalStorageKey)
  } catch {
    // The in-memory journal still works when browser storage is unavailable.
  }
}

export function readJournalStorage(): { scope: string; entries: Record<string, unknown> } | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(journalStorageKey) ?? 'null')
    if (
      value &&
      typeof value.scope === 'string' &&
      value.expires > Date.now() &&
      value.entries &&
      typeof value.entries === 'object' &&
      !Array.isArray(value.entries)
    )
      return value
    clearJournalStorage()
  } catch {
    clearJournalStorage()
  }
  return null
}
