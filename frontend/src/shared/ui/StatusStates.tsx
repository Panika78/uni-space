import type { ReactNode } from 'react'

type StateProps = {
  title: string
  description?: string
  children?: ReactNode
}

export function LoadingState({
  title,
  description,
  variant = 'skeleton',
  className = '',
}: StateProps & { variant?: 'compact' | 'skeleton'; className?: string }) {
  return (
    <div
      className={`ui-state ui-state--loading ui-state--${variant} ${className}`.trim()}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="ui-state__indicator" aria-hidden="true" />
      <div className="ui-state__copy">
        <p className="ui-state__title">{title}</p>
        {description && <p className="ui-state__description">{description}</p>}
      </div>
      {variant === 'skeleton' && (
        <div className="ui-state__skeleton" aria-hidden="true">
          <span />
          <span />
        </div>
      )}
    </div>
  )
}

export function EmptyState({ title, description, children }: StateProps) {
  return (
    <section className="ui-state ui-state--empty" role="status" aria-live="polite">
      <span className="ui-state__icon" aria-hidden="true">
        ○
      </span>
      <div className="ui-state__copy">
        <p className="ui-state__title">{title}</p>
        {description && <p className="ui-state__description">{description}</p>}
      </div>
      {children}
    </section>
  )
}

export function ErrorState({
  title,
  description,
  children,
  onRetry,
}: StateProps & { onRetry?: () => void }) {
  return (
    <section className="ui-state ui-state--error" role="alert" aria-live="assertive">
      <span className="ui-state__icon" aria-hidden="true">
        !
      </span>
      <div className="ui-state__copy">
        <p className="ui-state__title">{title}</p>
        {description && <p className="ui-state__description">{description}</p>}
      </div>
      {onRetry && (
        <button className="ui-state__action" type="button" onClick={onRetry}>
          Повторить
        </button>
      )}
      {children}
    </section>
  )
}

export function SuccessState({ title, description, children }: StateProps) {
  return (
    <section className="ui-state ui-state--success" role="status" aria-live="polite">
      <span className="ui-state__icon" aria-hidden="true">
        ✓
      </span>
      <div className="ui-state__copy">
        <p className="ui-state__title">{title}</p>
        {description && <p className="ui-state__description">{description}</p>}
      </div>
      {children}
    </section>
  )
}

export function UnavailableState({ title, description }: StateProps) {
  return (
    <section className="ui-state ui-state--unavailable" role="status" aria-live="polite">
      <span className="ui-state__icon" aria-hidden="true">
        ○
      </span>
      <div className="ui-state__copy">
        <p className="ui-state__title">{title}</p>
        {description && <p className="ui-state__description">{description}</p>}
      </div>
    </section>
  )
}
