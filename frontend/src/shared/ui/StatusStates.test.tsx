import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EmptyState,
  ErrorState,
  LoadingState,
  SuccessState,
  UnavailableState,
} from './StatusStates'

afterEach(cleanup)

describe('reusable status states', () => {
  it('announces loading politely and marks the region busy', () => {
    render(<LoadingState title="Загрузка расписания" />)
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
  })

  it('distinguishes an empty result from an unavailable feature', () => {
    const { rerender } = render(<EmptyState title="Нет занятий" description="На эту дату." />)
    expect(screen.getByRole('status')).toHaveTextContent('Нет занятий')
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite')
    rerender(<UnavailableState title="Функция пока недоступна" />)
    expect(screen.getByRole('status')).toHaveTextContent('Функция пока недоступна')
    expect(screen.getByRole('status')).not.toHaveTextContent('Нет занятий')
  })

  it('announces errors and offers a safe retry only when a handler exists', async () => {
    const user = userEvent.setup()
    const retry = vi.fn()
    const { rerender } = render(<ErrorState title="Не удалось загрузить" onRetry={retry} />)
    expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'assertive')
    await user.click(screen.getByRole('button', { name: 'Повторить' }))
    expect(retry).toHaveBeenCalledOnce()
    rerender(<ErrorState title="Ошибка без повтора" />)
    expect(screen.queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument()
  })

  it('announces successful completion politely', () => {
    render(<SuccessState title="Сохранено" />)
    expect(screen.getByRole('status')).toHaveTextContent('Сохранено')
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite')
  })
})
