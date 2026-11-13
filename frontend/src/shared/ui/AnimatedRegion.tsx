import { useLayoutEffect, useRef, type ReactNode } from 'react'

/** Animate measured content height without delaying navigation or remounting controls. */
export function AnimatedRegion({
  children,
  className = '',
  contentKey,
}: {
  children: ReactNode
  className?: string
  contentKey: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const container = containerRef.current
    const content = contentRef.current
    if (!container || !content || !window.ResizeObserver || !container.animate) return
    let height = content.getBoundingClientRect().height
    let animation: Animation | undefined
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const handleMotionChange = () => {
      if (media.matches) animation?.cancel()
    }
    media.addEventListener('change', handleMotionChange)
    const observer = new ResizeObserver(() => {
      const next = content.getBoundingClientRect().height
      const current =
        animation?.playState === 'running' ? container.getBoundingClientRect().height : height
      if (next === height) return
      height = next
      animation?.cancel()
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      animation = container.animate([{ height: `${current}px` }, { height: `${next}px` }], {
        duration: 280,
        easing: 'cubic-bezier(.22,1,.36,1)',
      })
    })
    observer.observe(content)
    return () => {
      observer.disconnect()
      media.removeEventListener('change', handleMotionChange)
      animation?.cancel()
    }
  }, [])
  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content?.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const animation = content.animate([{ opacity: 0.35 }, { opacity: 1 }], {
      duration: 220,
      easing: 'ease-out',
    })
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const handleMotionChange = () => {
      if (media.matches) animation.cancel()
    }
    media.addEventListener('change', handleMotionChange)
    return () => {
      media.removeEventListener('change', handleMotionChange)
      animation.cancel()
    }
  }, [contentKey])
  return (
    <div ref={containerRef} className={`animated-region ${className}`}>
      <div ref={contentRef}>{children}</div>
    </div>
  )
}
