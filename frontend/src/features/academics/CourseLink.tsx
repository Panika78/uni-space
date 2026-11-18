import { useEffect, useRef, type ComponentProps } from 'react'
import { Link, useLocation } from 'react-router-dom'

const returnPositions = new Map<string, { scroll: number; selector: string }>()

export function CourseLink({
  courseId,
  tab,
  returnSelector,
  ...props
}: Omit<ComponentProps<typeof Link>, 'to' | 'state'> & {
  courseId: string
  tab?: 'assessments'
  returnSelector: string
}) {
  const location = useLocation()
  return (
    <Link
      {...props}
      to={`/academics/courses/${encodeURIComponent(courseId)}${tab ? '?tab=' + tab : ''}`}
      state={{ courseSource: location.pathname }}
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return
        returnPositions.set(location.key, { scroll: window.scrollY, selector: returnSelector })
        if (returnPositions.size > 50) {
          const oldest = returnPositions.keys().next().value
          if (oldest !== undefined) returnPositions.delete(oldest)
        }
      }}
    />
  )
}

export function useCourseReturnPosition(isReady: boolean) {
  const { key } = useLocation()
  const restoredKey = useRef<string | null>(null)
  useEffect(() => {
    const point = returnPositions.get(key)
    if (!isReady || !point || restoredKey.current === key) return
    let cancelled = false
    let frame = 0
    function restore() {
      if (!point || cancelled) return
      const heading = document.querySelector<HTMLElement>('.section-page h1')
      const animations = Array.from(
        heading?.closest<HTMLElement>('.section-page')?.getAnimations?.({ subtree: true }) ?? [],
      ).filter((animation) => animation.playState === 'running')
      if (animations.length) {
        void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
          if (!cancelled) frame = requestAnimationFrame(restore)
        })
        return
      }
      const targets = Array.from(document.querySelectorAll<HTMLElement>(point.selector))
      const target = targets.find((element) => element.getClientRects().length > 0) ?? heading
      restoredKey.current = key
      target?.focus({ preventScroll: true })
      window.scrollTo({ top: point.scroll, behavior: 'instant' })
    }
    frame = requestAnimationFrame(restore)
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [isReady, key])
}
