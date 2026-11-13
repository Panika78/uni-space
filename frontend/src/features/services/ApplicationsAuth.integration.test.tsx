import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { apiFetch } from '../../shared/api/client'
import { createQueryClient } from '../../app/queryClient'
import { AuthProvider, useAuth } from '../auth/AuthProvider'
import { ApplicationDetailPage, ApplicationsList } from './ApplicationsPages'

function Harness({ detail }: { detail: boolean }) {
  const auth = useAuth()
  return auth.status === 'authenticated' ? (
    <>
      <button onClick={() => void auth.logout()}>Выйти</button>
      <button
        onClick={() =>
          void apiFetch('/api/v1/users/me', { authenticated: true }).catch(() => undefined)
        }
      >
        Проверить сессию
      </button>
      {detail ? <ApplicationDetailPage /> : <ApplicationsList />}
    </>
  ) : (
    <>
      <button onClick={() => void auth.login({ login: 'a', password: 'fictional' })}>
        Войти A
      </button>
      <button onClick={() => void auth.login({ login: 'b', password: 'fictional' })}>
        Войти B
      </button>
    </>
  )
}
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('navigator', {
    ...navigator,
    locks: {
      request: async (
        _name: string,
        options: LockOptions | (() => Promise<unknown>),
        callback?: () => Promise<unknown>,
      ) => (typeof options === 'function' ? options : callback!)(),
    },
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
for (const detail of [false, true]) {
  for (const mode of ['logout', 'revocation']) {
    it(`clears ${detail ? 'detail' : 'list'} on ${mode} and ignores delayed A responses after B login`, async () => {
      let resolveA!: (response: Response) => void
      const delayed = new Promise<Response>((resolve) => {
        resolveA = resolve
      })
      let requestedA = false
      const item = {
        id: '2',
        service: { id: '1', code: 'study_certificate', title: 'Заявление B' },
        form_data: { place_of_submission: 'Только B' },
        review_status: 'submitted',
        document_status: 'pending',
        feedback: null,
        created_at: '2026-11-01T12:00:00Z',
        updated_at: '2026-11-01T12:00:00Z',
      }
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const path = new URL(String(input), location.href).pathname
          if (path.endsWith('/auth/refresh'))
            return Response.json(
              { error: { code: 'invalid_refresh', message: '', details: [] } },
              { status: 401 },
            )
          if (path.endsWith('/auth/login'))
            return Response.json({
              access_token: JSON.parse(String(init?.body)).login,
              token_type: 'bearer',
              expires_in: 600,
            })
          if (path.endsWith('/users/me'))
            return Response.json(
              { error: { code: 'session_invalid', message: '', details: [] } },
              { status: 401 },
            )
          if (path.endsWith('/auth/logout')) return Response.json({ session_revoked: true })
          if (new Headers(init?.headers).get('Authorization') === 'Bearer a') {
            requestedA = true
            return delayed
          }
          return Response.json(detail ? item : { items: [item], next_cursor: null })
        }),
      )
      const client = createQueryClient()
      render(
        <QueryClientProvider client={client}>
          <AuthProvider>
            <MemoryRouter>
              <Harness detail={detail} />
            </MemoryRouter>
          </AuthProvider>
        </QueryClientProvider>,
      )
      fireEvent.click(await screen.findByRole('button', { name: 'Войти A' }))
      await waitFor(() => expect(requestedA).toBe(true))
      fireEvent.click(
        screen.getByRole('button', { name: mode === 'logout' ? 'Выйти' : 'Проверить сессию' }),
      )
      await screen.findByRole('button', { name: 'Войти B' })
      expect(client.getQueryCache().getAll()).toHaveLength(0)
      fireEvent.click(screen.getByRole('button', { name: 'Войти B' }))
      await screen.findByText(detail ? 'Только B' : /Заявление B/)
      const privateA = { ...item, service: { ...item.service, title: 'Private A' } }
      await act(async () => {
        resolveA(Response.json(detail ? privateA : { items: [privateA], next_cursor: null }))
        await delayed
      })
      expect(screen.queryByText('Private A')).not.toBeInTheDocument()
      expect(
        JSON.stringify(
          client
            .getQueryCache()
            .getAll()
            .map((query) => query.state.data),
        ),
      ).not.toContain('Private A')
    })
  }
}
