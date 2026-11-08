import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { App } from './App'

describe('application navigation', () => {
  it('renders the home route and navigates without reloading the document', async () => {
    const user = userEvent.setup()
    render(<App />)

    expect(screen.getByRole('heading', { name: 'Добро пожаловать в Uni Space' })).toBeInTheDocument()
    const document = window.document
    await user.click(screen.getByRole('link', { name: 'О проекте' }))

    expect(screen.getByRole('heading', { name: 'Всё важное об учёбе — в одном месте' })).toBeInTheDocument()
    expect(window.document).toBe(document)
  })
})
