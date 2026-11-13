import { useLayoutEffect, useRef, useState } from 'react'

/** Keep only an inert visual exit frame; focus and modal locks follow isOpen immediately. */
export function useOverlayPresence(isOpen: boolean, direction: 'left' | 'right' | 'menu') {
  const [present, setPresent] = useState(isOpen)
  const rootRef = useRef<HTMLDivElement>(null)
  const canAnimate =
    typeof Element.prototype.animate === 'function' &&
    !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (isOpen && !present) setPresent(true)
  if (!canAnimate && !isOpen && present) setPresent(false)
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    if (!canAnimate) return
    const panel = root.querySelector<HTMLElement>('[data-motion-panel]') ?? root
    const offset =
      direction === 'menu'
        ? 'translateY(-5px)'
        : `translateX(${direction === 'left' ? '-105%' : '105%'})`
    const options = { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' as const }
    const animations = [
      panel.animate(
        isOpen
          ? [{ transform: offset }, { transform: 'none' }]
          : [{ transform: 'none' }, { transform: offset }],
        options,
      ),
      root.animate(
        isOpen ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }],
        options,
      ),
    ]
    let cancelled = false
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const handleMotionChange = () => {
      if (!media.matches) return
      animations.forEach((animation) => animation.cancel())
      if (!isOpen) setPresent(false)
    }
    media.addEventListener('change', handleMotionChange)
    void Promise.all(animations.map((animation) => animation.finished))
      .then(() => {
        if (!cancelled && !isOpen) setPresent(false)
      })
      .catch(() => {})
    return () => {
      cancelled = true
      media.removeEventListener('change', handleMotionChange)
      animations.forEach((animation) => animation.cancel())
    }
  }, [isOpen, present, direction, canAnimate])
  return { present: canAnimate ? present : isOpen, rootRef }
}
