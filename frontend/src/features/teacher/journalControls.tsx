type SavePhase = 'saving' | 'saved' | 'error'
export type SaveState = {
  phase: SavePhase
  uncertain?: boolean
  message?: string
  value?: number | null
  retry?: () => void
}

export const statuses = [
  { value: 'attended', label: '✓', title: 'Присутствовал' },
  { value: 'absent', label: 'Н', title: 'Отсутствовал' },
  { value: 'unmarked', label: '—', title: 'Нет отметки' },
] as const

export function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Moscow',
  }).format(new Date(value))
}

export function SaveLabel({ state, onRetry }: { state?: SaveState; onRetry?: () => void }) {
  if (!state) return null
  if (state.phase === 'saving')
    return (
      <span className="journal-save" role="status">
        Сохраняется
      </span>
    )
  if (state.phase === 'saved')
    return (
      <span className="journal-save journal-save--saved" role="status">
        Сохранено
      </span>
    )
  return (
    <span className="journal-save journal-save--error" role="status">
      {state.message ?? 'Ошибка, повторить'}{' '}
      {onRetry && (
        <button type="button" className="journal-inline-action" onClick={onRetry}>
          {state.uncertain ? 'Проверить сохранение' : 'Повторить'}
        </button>
      )}
    </span>
  )
}
