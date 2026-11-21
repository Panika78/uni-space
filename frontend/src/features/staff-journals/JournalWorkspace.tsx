import { useRef, type KeyboardEvent, type ReactNode } from 'react'

export function JournalPageHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string
  title: string
  description: string
}) {
  return (
    <>
      <p className="section-eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p className="service-subtitle">{description}</p>
    </>
  )
}

export function JournalCard({
  heading,
  description,
  children,
}: {
  heading: string
  description?: string
  children: ReactNode
}) {
  return (
    <section className="journal-workspace-card" aria-label={heading}>
      <header className="journal-workspace-card__header">
        <div>
          <h2>{heading}</h2>
          {description && <p>{description}</p>}
        </div>
      </header>
      {children}
    </section>
  )
}

export function JournalCourseSection({
  heading,
  status,
  children,
}: {
  heading: string
  status?: string
  children: ReactNode
}) {
  return (
    <section className="journal-course-section" aria-label={heading}>
      <header className="journal-course-section__header">
        <h2>{heading}</h2>
        {status && <span className="journal-course-section__status">● {status}</span>}
      </header>
      {children}
    </section>
  )
}

export type JournalTabOption = { id: string; label: string }

export function JournalTabs({
  ariaLabel,
  idPrefix,
  options,
  selected,
  onSelect,
}: {
  ariaLabel: string
  idPrefix: string
  options: readonly JournalTabOption[]
  selected: string
  onSelect: (id: string) => void
}) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const currentIndex = options.findIndex((option) => option.id === selected)
    const offset = event.key === 'ArrowRight' ? 1 : -1
    const nextIndex = (currentIndex + offset + options.length) % options.length
    const next = options[nextIndex]
    if (!next) return
    onSelect(next.id)
    tabRefs.current[nextIndex]?.focus()
  }
  return (
    <div className="journal-tabs" role="tablist" aria-label={ariaLabel} onKeyDown={handleKeyDown}>
      {options.map((option, index) => (
        <button
          ref={(node) => {
            tabRefs.current[index] = node
          }}
          key={option.id}
          type="button"
          role="tab"
          id={`${idPrefix}-tab-${option.id}`}
          aria-controls={`${idPrefix}-panel-${option.id}`}
          aria-selected={selected === option.id}
          tabIndex={selected === option.id ? 0 : -1}
          onClick={() => onSelect(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function JournalTabPanel({
  idPrefix,
  tabId,
  children,
}: {
  idPrefix: string
  tabId: string
  children: ReactNode
}) {
  return (
    <div
      id={`${idPrefix}-panel-${tabId}`}
      role="tabpanel"
      aria-labelledby={`${idPrefix}-tab-${tabId}`}
      tabIndex={0}
      className="journal-tab-panel"
    >
      {children}
    </div>
  )
}
